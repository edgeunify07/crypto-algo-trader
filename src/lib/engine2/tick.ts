import { analyseTimeframe } from "@/lib/algo/screener/analyse";
import { DEFAULT_PARAMS, type StrategyParams } from "@/lib/algo/strategy/params";
import {
  TIMEFRAME_MS,
  type Timeframe,
  type TimeframeAnalysis,
} from "@/lib/algo/types";
import { clamp, weightedAverage } from "@/lib/algo/util/math";
import {
  commission,
  fundingPayment,
  fundingSettlementsBetween,
  initialMargin,
  liquidationPrice,
  roundQuantity,
} from "@/lib/futures/fees";
import { fetchFuturesExchangeInfo, fetchMarkPrices } from "@/lib/futures/rest";
import { KEYS, kv } from "@/lib/store/kv";
import {
  DEFAULT_LEVERAGE,
  STARTING_BALANCE,
  drawdown,
  equity,
  newAccount,
  newId,
  unrealisedTotal,
  type AccountState,
  type EquityPoint,
  type ExitReason,
  type FuturesPosition,
  type FuturesTrade,
  type Side,
  type TradeStyle,
} from "@/lib/store/account";
import { getManyCandles } from "./candles";
import { resolveUniverse } from "./universe";

/**
 * One complete trading step, self-contained and stateless.
 *
 * Everything a persistent loop would hold in memory is loaded from KV at the
 * start and written back at the end, so an invocation can run on any instance,
 * cold or warm. The order of operations matters and mirrors how a real
 * exchange settles: funding first, then liquidation, then stops and targets,
 * then new entries — so a position cannot be opened with margin that a pending
 * liquidation was about to consume.
 */

export const ANALYSIS_TIMEFRAMES: Timeframe[] = (
  process.env.ANALYSIS_TIMEFRAMES ?? "5m,15m,1h,4h,1d"
)
  .split(",")
  .map((s) => s.trim() as Timeframe);

/** Timeframes that may anchor a trade, and the style each implies. */
const STYLE_BY_TIMEFRAME: Partial<Record<Timeframe, TradeStyle>> = {
  "5m": "scalp",
  "15m": "scalp",
  "30m": "scalp",
  "1h": "swing",
  "4h": "swing",
  "1d": "swing",
};

export interface TickRiskLimits {
  maxOpenPositions: number;
  maxDrawdown: number;
  /** Fraction of equity risked per trade. */
  riskPerTrade: number;
  /** Cap on one position's notional as a fraction of equity. */
  maxPositionFraction: number;
  leverage: number;
}

export function riskLimits(): TickRiskLimits {
  return {
    maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS ?? "3"),
    maxDrawdown: Number(process.env.MAX_DRAWDOWN ?? "0.3"),
    riskPerTrade: Number(process.env.RISK_PER_TRADE ?? "0.02"),
    maxPositionFraction: Number(process.env.MAX_POSITION_FRACTION ?? "1.5"),
    leverage: DEFAULT_LEVERAGE,
  };
}

export interface ScreenerRowLite {
  symbol: string;
  price: number;
  markPrice: number;
  score: number;
  confidence: number;
  alignment: number;
  direction: "long" | "short" | "flat";
  anchorTimeframe: Timeframe;
  style: TradeStyle;
  quoteVolume24h: number;
  fundingRate: number;
  hasPosition: boolean;
  timeframes: Record<
    string,
    {
      score: number;
      confidence: number;
      direction: string;
      regime: string;
      elliott: { pattern: string; wave: string; bias: string; confidence: number };
      gann: { bias: string; confidence: number; barsSinceAnchor: number; nearestCycle: number };
    }
  >;
}

export interface TickResult {
  at: number;
  durationMs: number;
  universe: string[];
  analysed: number;
  opened: { symbol: string; side: Side; reason: string }[];
  closed: { symbol: string; reason: ExitReason; netPnl: number }[];
  fundingApplied: number;
  account: AccountState;
  positions: FuturesPosition[];
  equity: number;
  screener: ScreenerRowLite[];
  notes: string[];
  durable: boolean;
}

/** Blend per-timeframe analyses into one directional view. */
function aggregate(
  perTimeframe: Map<Timeframe, TimeframeAnalysis>,
  params: StrategyParams,
): {
  score: number;
  confidence: number;
  alignment: number;
  direction: "long" | "short" | "flat";
  anchor: TimeframeAnalysis | null;
} {
  const entries = [...perTimeframe.entries()];
  if (entries.length === 0) {
    return { score: 0, confidence: 0, alignment: 0, direction: "flat", anchor: null };
  }

  const tfWeight = (tf: Timeframe) => params.timeframeWeights[tf] ?? 1;

  const score = clamp(
    weightedAverage(
      entries.map(([tf, a]) => ({
        value: a.score,
        weight: tfWeight(tf) * Math.max(a.confidence, 0.05),
      })),
    ),
    -1,
    1,
  );
  const confidence = clamp(
    weightedAverage(entries.map(([tf, a]) => ({ value: a.confidence, weight: tfWeight(tf) }))),
    0,
    1,
  );
  const direction = score > 0.1 ? "long" : score < -0.1 ? "short" : "flat";

  let agreeing = 0;
  let total = 0;
  for (const [tf, a] of entries) {
    const w = tfWeight(tf);
    total += w;
    if (direction === "flat") continue;
    if (a.direction === direction) agreeing += w;
    else if (a.direction !== "flat") agreeing -= w * 0.5;
  }
  const alignment = total === 0 ? 0 : clamp(agreeing / total, 0, 1);

  // The anchor is the strongest aligned timeframe that may carry a trade.
  const candidates = entries
    .filter(([tf, a]) => STYLE_BY_TIMEFRAME[tf] && (direction === "flat" || a.direction === direction))
    .sort((a, b) => Math.abs(b[1].score) * tfWeight(b[0]) - Math.abs(a[1].score) * tfWeight(a[0]));
  const anchor = (candidates[0] ?? entries[0])?.[1] ?? null;

  return { score, confidence, alignment, direction, anchor };
}

export interface RunTickOptions {
  /** Override params (used by the backtest-driven improvement path). */
  params?: StrategyParams;
  paramsVersion?: string;
  /** Skip opening new positions; still manages open ones. */
  manageOnly?: boolean;
}

export async function runTick(options: RunTickOptions = {}): Promise<TickResult> {
  const startedAt = Date.now();
  const store = kv();
  const notes: string[] = [];
  const limits = riskLimits();

  // --- Load state ------------------------------------------------------
  const [storedAccount, storedPositions, storedParams] = await Promise.all([
    store.get<AccountState>(KEYS.account),
    store.get<FuturesPosition[]>(KEYS.positions),
    store.get<{ version: string; params: StrategyParams }>(KEYS.params),
  ]);

  const account: AccountState = storedAccount ?? newAccount(STARTING_BALANCE);
  let positions: FuturesPosition[] = storedPositions ?? [];
  const params = options.params ?? storedParams?.params ?? DEFAULT_PARAMS;
  const paramsVersion =
    options.paramsVersion ?? storedParams?.version ?? "default-v1";

  // --- Market data -----------------------------------------------------
  const universe = await resolveUniverse();
  const symbols = universe.entries.map((e) => e.symbol);
  // Positions in symbols that dropped out of today's top-10 must still be
  // managed to the exit, so their symbols are always included.
  const managed = [...new Set([...symbols, ...positions.map((p) => p.symbol)])];

  const [marks, candleMap] = await Promise.all([
    fetchMarkPrices(),
    getManyCandles(
      managed.flatMap((symbol) =>
        ANALYSIS_TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
      ),
    ),
  ]);

  const markBySymbol: Record<string, number> = {};
  const fundingBySymbol: Record<string, number> = {};
  for (const m of marks) {
    markBySymbol[m.symbol] = m.markPrice;
    fundingBySymbol[m.symbol] = m.lastFundingRate;
  }

  const opened: TickResult["opened"] = [];
  const closed: TickResult["closed"] = [];
  const trades: FuturesTrade[] = [];
  let fundingApplied = 0;

  /** Close all or part of a position and book the trade. */
  const closePosition = (
    position: FuturesPosition,
    exitPrice: number,
    reason: ExitReason,
    fraction: number,
  ): void => {
    const qty = Math.min(position.quantity, position.quantity * Math.min(1, fraction));
    if (!(qty > 0)) return;

    const share = qty / position.quantity;
    const exitNotional = exitPrice * qty;
    const exitFee = commission(exitNotional, "taker");
    const entryFeeShare = position.entryFee * share;
    const fundingShare = position.fundingPaid * share;
    const marginShare = position.margin * share;

    const grossPnl =
      position.side === "long"
        ? (exitPrice - position.entryPrice) * qty
        : (position.entryPrice - exitPrice) * qty;

    // Funding is a signed cash flow; as a cost it is its negation.
    const fundingCost = -fundingShare;
    const netPnl = grossPnl - exitFee - entryFeeShare - fundingCost;

    // Margin comes back, plus whatever the position actually made.
    account.balance += marginShare + grossPnl - exitFee - entryFeeShare;
    account.realisedPnl += netPnl;
    account.totalFees += exitFee + entryFeeShare;
    account.totalFunding += fundingCost;

    const riskPerUnit = Math.abs(position.entryPrice - position.stopLoss);
    trades.push({
      id: newId("t"),
      symbol: position.symbol,
      side: position.side,
      style: position.style,
      timeframe: position.timeframe,
      quantity: qty,
      entryPrice: position.entryPrice,
      exitPrice,
      leverage: position.leverage,
      openedAt: position.openedAt,
      closedAt: Date.now(),
      grossPnl,
      entryFee: entryFeeShare,
      exitFee,
      fundingCost,
      netPnl,
      netPnlPct: marginShare > 0 ? netPnl / marginShare : 0,
      rMultiple: riskPerUnit > 0 ? grossPnl / (riskPerUnit * qty) : 0,
      exitReason: reason,
      paramsVersion: position.paramsVersion,
    });
    closed.push({ symbol: position.symbol, reason, netPnl });

    position.quantity -= qty;
    position.margin -= marginShare;
    position.entryFee -= entryFeeShare;
    position.fundingPaid -= fundingShare;
  };

  // --- 1. Funding settlement ------------------------------------------
  // Applied before anything else, exactly as the exchange does: funding can
  // push a position into liquidation on its own.
  const now = Date.now();
  for (const position of positions) {
    const since = position.lastFundingAt || position.openedAt;
    const settlements = fundingSettlementsBetween(since, now);
    if (settlements.length === 0) continue;

    const mark = markBySymbol[position.symbol] ?? position.entryPrice;
    const rate = fundingBySymbol[position.symbol] ?? 0;
    // Each missed settlement is charged at the current rate. Replaying from
    // `lastFundingAt` means a tick that was down for hours still settles every
    // boundary it slept through, rather than silently skipping them.
    const perSettlement = fundingPayment({
      side: position.side,
      quantity: position.quantity,
      markPrice: mark,
      fundingRate: rate,
    });
    const total = perSettlement * settlements.length;
    position.fundingPaid += total;
    position.lastFundingAt = settlements.at(-1) as number;
    // Funding settles against the margin posted, not free balance.
    position.margin += total;
    fundingApplied += total;
    if (settlements.length > 0) {
      notes.push(
        `${position.symbol}: ${settlements.length} funding settlement(s), ${total >= 0 ? "+" : ""}${total.toFixed(4)} USDT`,
      );
    }
  }

  // --- 2. Liquidation --------------------------------------------------
  for (const position of positions) {
    const mark = markBySymbol[position.symbol];
    if (!(mark > 0)) continue;
    const hit =
      position.side === "long"
        ? mark <= position.liquidationPrice
        : mark >= position.liquidationPrice;
    if (hit) {
      // A liquidation takes the whole margin; the fill is at the liq price.
      closePosition(position, position.liquidationPrice, "liquidation", 1);
      notes.push(
        `${position.symbol}: LIQUIDATED at ${position.liquidationPrice.toFixed(6)}`,
      );
    }
  }
  positions = positions.filter((p) => p.quantity > 1e-12);

  // --- 3. Analyse the universe ----------------------------------------
  const screener: ScreenerRowLite[] = [];
  const analyses = new Map<string, ReturnType<typeof aggregate>>();

  for (const symbol of managed) {
    const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
    for (const tf of ANALYSIS_TIMEFRAMES) {
      const candles = candleMap.get(`${symbol}:${tf}`);
      if (!candles || candles.length < 60) continue;
      const analysis = analyseTimeframe(symbol, tf, candles, params);
      if (analysis) perTimeframe.set(tf, analysis);
    }
    if (perTimeframe.size === 0) continue;

    const blended = aggregate(perTimeframe, params);
    analyses.set(symbol, blended);

    const anchorTf = blended.anchor?.timeframe ?? ANALYSIS_TIMEFRAMES[0]!;
    const entry = universe.entries.find((e) => e.symbol === symbol);
    screener.push({
      symbol,
      price: blended.anchor?.price ?? markBySymbol[symbol] ?? 0,
      markPrice: markBySymbol[symbol] ?? 0,
      score: blended.score,
      confidence: blended.confidence,
      alignment: blended.alignment,
      direction: blended.direction,
      anchorTimeframe: anchorTf,
      style: STYLE_BY_TIMEFRAME[anchorTf] ?? "swing",
      quoteVolume24h: entry?.quoteVolume24h ?? 0,
      fundingRate: fundingBySymbol[symbol] ?? 0,
      hasPosition: positions.some((p) => p.symbol === symbol),
      timeframes: Object.fromEntries(
        [...perTimeframe.entries()].map(([tf, a]) => [
          tf,
          {
            score: a.score,
            confidence: a.confidence,
            direction: a.direction,
            regime: a.regime.kind,
            elliott: {
              pattern: a.elliott.pattern,
              wave: a.elliott.currentWave,
              bias: a.elliott.bias,
              confidence: a.elliott.confidence,
            },
            gann: {
              bias: a.gann.bias,
              confidence: a.gann.confidence,
              barsSinceAnchor: a.gann.timeCycle.barsSinceAnchor,
              nearestCycle: a.gann.timeCycle.nearestCycle,
            },
          },
        ]),
      ),
    });
  }

  // --- 4. Manage open positions ---------------------------------------
  for (const position of positions) {
    const mark = markBySymbol[position.symbol];
    if (!(mark > 0)) continue;

    position.extreme =
      position.side === "long"
        ? Math.max(position.extreme, mark)
        : Math.min(position.extreme, mark);

    const blended = analyses.get(position.symbol);
    const atr = blended?.anchor?.atr ?? 0;
    const riskPerUnit = Math.abs(position.entryPrice - position.stopLoss);

    // Stop loss.
    const stopHit =
      position.side === "long" ? mark <= position.stopLoss : mark >= position.stopLoss;
    if (stopHit) {
      closePosition(position, position.stopLoss, "stop_loss", 1);
      continue;
    }

    // Take-profit ladder.
    for (const tp of position.takeProfits) {
      if (tp.hit || tp.fraction <= 0) continue;
      const reached = position.side === "long" ? mark >= tp.price : mark <= tp.price;
      if (reached) {
        tp.hit = true;
        closePosition(position, tp.price, "take_profit", tp.fraction);
      }
    }
    if (position.quantity <= 1e-12) continue;

    // Break-even and trailing stop.
    if (riskPerUnit > 0) {
      const favourable =
        position.side === "long"
          ? position.extreme - position.entryPrice
          : position.entryPrice - position.extreme;
      const rEarned = favourable / riskPerUnit;
      let nextStop = position.stopLoss;

      if (params.exit.breakEvenR > 0 && rEarned >= params.exit.breakEvenR) {
        nextStop =
          position.side === "long"
            ? Math.max(nextStop, position.entryPrice)
            : Math.min(nextStop, position.entryPrice);
      }
      if (params.exit.trailStartR > 0 && rEarned >= params.exit.trailStartR && atr > 0) {
        const trail =
          position.side === "long"
            ? position.extreme - atr * params.exit.trailAtrMultiple
            : position.extreme + atr * params.exit.trailAtrMultiple;
        nextStop = position.side === "long" ? Math.max(nextStop, trail) : Math.min(nextStop, trail);
      }
      // Only ever tighten.
      if (
        (position.side === "long" && nextStop > position.stopLoss) ||
        (position.side === "short" && nextStop < position.stopLoss)
      ) {
        position.stopLoss = nextStop;
      }
    }

    // Signal flip.
    if (blended && params.exit.exitOnScoreFlip > 0) {
      const against = position.side === "long" ? -blended.score : blended.score;
      if (against >= params.exit.exitOnScoreFlip) {
        closePosition(position, mark, "signal_flip", 1);
        continue;
      }
    }

    // Time stop, measured in bars of the position's own timeframe.
    const barsHeld = Math.floor(
      (now - position.openedAt) / TIMEFRAME_MS[position.timeframe],
    );
    if (barsHeld >= params.exit.maxHoldBars) {
      closePosition(position, mark, "max_hold", 1);
    }
  }
  positions = positions.filter((p) => p.quantity > 1e-12);

  // --- 5. Account health ----------------------------------------------
  const currentEquity = equity(account, positions, markBySymbol);
  account.peakEquity = Math.max(account.peakEquity, currentEquity);
  const dd = drawdown(account, currentEquity);

  if (dd >= limits.maxDrawdown) {
    account.haltedReason = `max drawdown ${(dd * 100).toFixed(1)}% reached`;
  } else if (account.haltedReason && dd < limits.maxDrawdown * 0.8) {
    // Resume only after recovering clearly, not on the first tick back under.
    account.haltedReason = null;
  }

  // --- 6. New entries --------------------------------------------------
  if (!options.manageOnly && !account.haltedReason) {
    const info = await fetchFuturesExchangeInfo().catch(() => new Map());

    const ranked = screener
      .filter((r) => !r.hasPosition && r.direction !== "flat")
      .filter((r) => symbols.includes(r.symbol)) // only today's top-N
      .sort(
        (a, b) =>
          Math.abs(b.score) * b.confidence * (0.5 + b.alignment) -
          Math.abs(a.score) * a.confidence * (0.5 + a.alignment),
      );

    for (const row of ranked) {
      if (positions.length >= limits.maxOpenPositions) break;

      const blended = analyses.get(row.symbol);
      const anchor = blended?.anchor;
      if (!anchor || !blended) continue;

      if (Math.abs(blended.score) < params.entry.minScore) continue;
      if (blended.confidence < params.entry.minConfidence) continue;
      if (blended.alignment < params.entry.minAlignment) continue;

      const side: Side = blended.direction === "long" ? "long" : "short";
      if (side === "short" && !params.entry.allowShorts) continue;

      // Elliott / Gann gates, when enabled.
      if (params.entry.requireElliottAgreement) {
        if (anchor.elliott.pattern === "none" || anchor.elliott.bias !== side) continue;
      }
      if (params.entry.requireGannAgreement && anchor.gann.bias !== side) continue;
      if (params.entry.avoidGannTimeCycle) {
        const { nearestCycle, distance, barsSinceAnchor } = anchor.gann.timeCycle;
        const window = Math.max(1, Math.round(nearestCycle * 0.05));
        if (nearestCycle > 0 && barsSinceAnchor > 0 && distance <= window) continue;
      }

      const mark = markBySymbol[row.symbol];
      if (!(mark > 0) || !(anchor.atr > 0)) continue;

      // Stop from ATR, then sized so the stop costs exactly riskPerTrade.
      const stopDistance = anchor.atr * params.exit.atrStopMultiple;
      const stopLoss = side === "long" ? mark - stopDistance : mark + stopDistance;
      if (!(stopDistance > 0)) continue;
      // A stop wider than the liquidation distance would never be reached.
      if (stopDistance / mark > 0.9 / limits.leverage) continue;

      const riskCapital = currentEquity * limits.riskPerTrade;
      let quantity = riskCapital / stopDistance;

      // Respect the notional cap and the margin actually available.
      const maxNotional = currentEquity * limits.maxPositionFraction;
      if (quantity * mark > maxNotional) quantity = maxNotional / mark;

      // Margin is deducted from `balance` at open, so balance *is* free collateral.
      const free = account.balance;
      const neededMargin = initialMargin(quantity * mark, limits.leverage);
      if (neededMargin > free * 0.95) {
        quantity = (free * 0.95 * limits.leverage) / mark;
      }

      const symbolInfo = info.get(row.symbol);
      if (symbolInfo) quantity = roundQuantity(quantity, symbolInfo.stepSize);
      const notional = quantity * mark;
      const minNotional = symbolInfo?.minNotional ?? 5;

      if (!(quantity > 0) || notional < minNotional) {
        notes.push(
          `${row.symbol}: skipped — size ${notional.toFixed(2)} USDT is below the ${minNotional} minimum`,
        );
        continue;
      }

      const margin = initialMargin(notional, limits.leverage);
      const entryFee = commission(notional, "taker");
      if (margin + entryFee > account.balance) continue;

      account.balance -= margin + entryFee;
      account.totalFees += entryFee;

      const takeProfits = params.exit.takeProfitRMultiples
        .map((r, i) => ({
          price: side === "long" ? mark + stopDistance * r : mark - stopDistance * r,
          fraction: params.exit.takeProfitFractions[i] ?? 0,
          hit: false,
        }))
        .filter((tp) => tp.fraction > 0);

      const position: FuturesPosition = {
        id: newId("p"),
        symbol: row.symbol,
        side,
        quantity,
        entryPrice: mark,
        margin,
        leverage: limits.leverage,
        openedAt: now,
        stopLoss,
        takeProfits,
        liquidationPrice: liquidationPrice({
          side,
          entryPrice: mark,
          quantity,
          leverage: limits.leverage,
          symbol: row.symbol,
        }),
        extreme: mark,
        entryFee,
        fundingPaid: 0,
        lastFundingAt: now,
        timeframe: anchor.timeframe,
        style: STYLE_BY_TIMEFRAME[anchor.timeframe] ?? "swing",
        paramsVersion,
        reasons: [
          `${side} ${row.symbol} ${anchor.timeframe} (${STYLE_BY_TIMEFRAME[anchor.timeframe] ?? "swing"})`,
          `score ${blended.score.toFixed(2)}, alignment ${(blended.alignment * 100).toFixed(0)}%, ${anchor.regime.kind}`,
          `Elliott ${anchor.elliott.pattern}/${anchor.elliott.currentWave} bias ${anchor.elliott.bias} (${(anchor.elliott.confidence * 100).toFixed(0)}%)`,
          `Gann ${anchor.gann.bias}, bar ${anchor.gann.timeCycle.barsSinceAnchor} of ${anchor.gann.timeCycle.nearestCycle} cycle`,
        ],
      };
      positions.push(position);
      opened.push({ symbol: row.symbol, side, reason: position.reasons[0] ?? "" });
    }
  } else if (account.haltedReason) {
    notes.push(`entries halted: ${account.haltedReason}`);
  }

  // --- 7. Persist -------------------------------------------------------
  const finalEquity = equity(account, positions, markBySymbol);
  account.peakEquity = Math.max(account.peakEquity, finalEquity);
  account.tickCount += 1;
  account.lastTickAt = now;
  account.updatedAt = now;

  const equityPoint: EquityPoint = {
    t: now,
    equity: finalEquity,
    balance: account.balance,
    unrealised: unrealisedTotal(positions, markBySymbol),
    positions: positions.length,
  };

  await Promise.all([
    store.set(KEYS.account, account),
    store.set(KEYS.positions, positions),
    store.set(KEYS.screener, screener, 600),
    store.push(KEYS.equity, equityPoint, 2000),
    ...trades.map((t) => store.push(KEYS.trades, t, 1000)),
  ]);

  return {
    at: now,
    durationMs: Date.now() - startedAt,
    universe: symbols,
    analysed: screener.length,
    opened,
    closed,
    fundingApplied,
    account,
    positions,
    equity: finalEquity,
    screener: screener.sort(
      (a, b) => Math.abs(b.score) * b.confidence - Math.abs(a.score) * a.confidence,
    ),
    notes,
    durable: store.isDurable,
  };
}
