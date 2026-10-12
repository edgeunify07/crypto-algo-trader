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

import { riskLimits } from "./limits";
export { riskLimits, type TickRiskLimits } from "./limits";

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
  /**
   * Which entry gate is currently stopping a trade, and how far off it is.
   * Without this the dashboard can only say "no trade", which is
   * indistinguishable from the engine being broken.
   */
  gates: {
    name: string;
    required: number | string;
    actual: number | string;
    passed: boolean;
  }[];
  blockedBy: string | null;
  /**
   * The scalp engine's own read of this symbol.
   *
   * Separate from the fields above, which are the swing engine's. One row
   * showing one set of numbers could only ever describe one of the two
   * engines, and the dashboard would be quietly silent about whichever it
   * left out.
   */
  scalp: {
    score: number;
    confidence: number;
    alignment: number;
    direction: string;
    gates: { name: string; required: number | string; actual: number | string; passed: boolean }[];
    blockedBy: string | null;
  } | null;
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

/**
 * Move a fill price against the trader by `bps`.
 *
 * Mirrors the backtester exactly. A paper account filled at the mark is a
 * paper account that flatters itself: no order ever gets the mark, and the
 * difference always runs one way. `entering` says which way the order runs —
 * opening a long buys, closing one sells.
 */
function slip(price: number, side: Side, entering: boolean, bps: number): number {
  if (!(bps > 0)) return price;
  const buying = entering === (side === "long");
  return price * (1 + (buying ? 1 : -1) * (bps / 10_000));
}

export async function runTick(options: RunTickOptions = {}): Promise<TickResult> {
  const startedAt = Date.now();
  const store = kv();
  const notes: string[] = [];

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
  // After the parameters load, because that is where the limits live.
  const limits = riskLimits(params);

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
      // Carried onto the trade so the two books can be read apart: a scalp
      // that is stopped out exits as stop_loss like anything else.
      scalp: position.scalp ?? false,
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
      closePosition(
        position,
        slip(position.liquidationPrice, position.side, false, params.execution.stopSlippageBps),
        "liquidation",
        1,
      );
      notes.push(
        `${position.symbol}: LIQUIDATED at ${position.liquidationPrice.toFixed(6)}`,
      );
    }
  }
  positions = positions.filter((p) => p.quantity > 1e-12);

  // --- 3. Analyse the universe ----------------------------------------
  const screener: ScreenerRowLite[] = [];
  const analyses = new Map<string, ReturnType<typeof aggregate>>();
  /** The scalp engine's own read of each symbol, from its own timeframes. */
  const scalpAnalyses = new Map<string, ReturnType<typeof aggregate>>();

  for (const symbol of managed) {
    const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
    for (const tf of ANALYSIS_TIMEFRAMES) {
      const candles = candleMap.get(`${symbol}:${tf}`);
      if (!candles || candles.length < 60) continue;
      const analysis = analyseTimeframe(symbol, tf, candles, params);
      if (analysis) perTimeframe.set(tf, analysis);
    }
    if (perTimeframe.size === 0) continue;

    /**
     * Two engines, two blends, mirroring the backtester exactly.
     *
     * Each reads only its own timeframes, so a scalp signal is not the swing
     * signal seen through a shorter lens.
     */
    const subset = (tfs: readonly string[]) => {
      const m = new Map<Timeframe, TimeframeAnalysis>();
      for (const tf of tfs) {
        const a = perTimeframe.get(tf as Timeframe);
        if (a) m.set(tf as Timeframe, a);
      }
      return m;
    };
    const swingTfs = subset(params.entry.timeframes);
    if (swingTfs.size === 0) continue;

    const blended = aggregate(swingTfs, params);
    analyses.set(symbol, blended);

    const scalpTfs = params.scalp.enabled ? subset(params.scalp.timeframes) : new Map();
    if (scalpTfs.size > 0) scalpAnalyses.set(symbol, aggregate(scalpTfs, params));

    const anchorTf = blended.anchor?.timeframe ?? ANALYSIS_TIMEFRAMES[0]!;
    const entry = universe.entries.find((e) => e.symbol === symbol);

    // Evaluate every entry condition, in the same order the entry logic does,
    // so the UI can show exactly what is being waited on.
    const anchorForGates = blended.anchor;
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    const gates: ScreenerRowLite["gates"] = [
      {
        name: "signal strength",
        required: params.entry.minScore.toFixed(2),
        actual: Math.abs(blended.score).toFixed(2),
        passed: Math.abs(blended.score) >= params.entry.minScore,
      },
      {
        name: "confidence",
        required: pct(params.entry.minConfidence),
        actual: pct(blended.confidence),
        passed: blended.confidence >= params.entry.minConfidence,
      },
      {
        name: "timeframe alignment",
        required: pct(params.entry.minAlignment),
        actual: pct(blended.alignment),
        passed: blended.alignment >= params.entry.minAlignment,
      },
      {
        name: "direction",
        required: "long or short",
        actual: blended.direction,
        passed: blended.direction !== "flat",
      },
    ];

    /**
     * The agreement gates only mean something once there is a direction to
     * agree with. With a flat blend they rendered as "Gann agrees: short,
     * needs flat" — a check that cannot pass, phrased as though the market
     * owed it something, next to a direction gate already saying the real
     * reason. Nothing is waiting on Gann here.
     */
    const directional = blended.direction !== "flat";

    if (params.entry.requireElliottAgreement && anchorForGates && directional) {
      gates.push({
        name: "Elliott agrees",
        required: blended.direction,
        actual: anchorForGates.elliott.bias,
        passed:
          anchorForGates.elliott.pattern !== "none" &&
          anchorForGates.elliott.bias === blended.direction,
      });
    }
    if (params.entry.requireGannAgreement && anchorForGates && directional) {
      gates.push({
        name: "Gann agrees",
        required: blended.direction,
        actual: anchorForGates.gann.bias,
        passed: anchorForGates.gann.bias === blended.direction,
      });
    }
    if (params.entry.avoidGannTimeCycle && anchorForGates && directional) {
      const { nearestCycle, distance, barsSinceAnchor } = anchorForGates.gann.timeCycle;
      const window = Math.max(1, Math.round(nearestCycle * 0.05));
      const inWindow = nearestCycle > 0 && barsSinceAnchor > 0 && distance <= window;
      gates.push({
        name: "outside Gann reversal window",
        required: `>${window} bars from ${nearestCycle}`,
        actual: `${distance} bars away`,
        passed: !inWindow,
      });
    }

    const blockedBy = gates.find((g) => !g.passed)?.name ?? null;

    // The same four checks, read off the scalp's own blend against its own
    // thresholds, so each engine is answerable for its own numbers.
    const sb = scalpAnalyses.get(symbol);
    const scalpRead = sb
      ? (() => {
          const g: ScreenerRowLite["gates"] = [
            {
              name: "signal strength",
              required: params.scalp.minScore.toFixed(2),
              actual: Math.abs(sb.score).toFixed(2),
              passed: Math.abs(sb.score) >= params.scalp.minScore,
            },
            {
              name: "confidence",
              required: pct(params.scalp.minConfidence),
              actual: pct(sb.confidence),
              passed: sb.confidence >= params.scalp.minConfidence,
            },
            {
              name: "timeframe alignment",
              required: pct(params.scalp.minAlignment),
              actual: pct(sb.alignment),
              passed: sb.alignment >= params.scalp.minAlignment,
            },
            {
              name: "direction",
              required: "long or short",
              actual: sb.direction,
              passed: sb.direction !== "flat",
            },
          ];
          return {
            score: sb.score,
            confidence: sb.confidence,
            alignment: sb.alignment,
            direction: sb.direction,
            gates: g,
            blockedBy: g.find((x) => !x.passed)?.name ?? null,
          };
        })()
      : null;

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
      gates,
      blockedBy,
      scalp: scalpRead,
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
      // A stop trades into the move that triggered it, so it is priced more
      // pessimistically than a calm exit.
      closePosition(
        position,
        slip(position.stopLoss, position.side, false, params.execution.stopSlippageBps),
        "stop_loss",
        1,
      );
      continue;
    }

    // Take-profit ladder.
    for (const tp of position.takeProfits) {
      if (tp.hit || tp.fraction <= 0) continue;
      const reached = position.side === "long" ? mark >= tp.price : mark <= tp.price;
      if (reached) {
        tp.hit = true;
        closePosition(
          position,
          tp.price,
          tp.scalp ? "scalp_target" : "take_profit",
          tp.fraction,
        );
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
      /**
       * Trailing is skipped on a scalp. A trail measured in ATR multiples
       * sits well inside a fixed percentage target, so it would reliably cut
       * the trade short of the one exit it was opened for. Break-even below
       * still applies — that can never take less than the entry.
       */
      if (
        !position.scalp &&
        params.exit.trailStartR > 0 &&
        rEarned >= params.exit.trailStartR &&
        atr > 0
      ) {
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
        closePosition(
          position,
          slip(mark, position.side, false, params.execution.slippageBps),
          "signal_flip",
          1,
        );
        continue;
      }
    }

    // Time stop, measured in bars of the position's own timeframe.
    const barsHeld = Math.floor(
      (now - position.openedAt) / TIMEFRAME_MS[position.timeframe],
    );
    const holdLimit = position.scalp ? params.scalp.maxHoldBars : params.exit.maxHoldBars;
    if (barsHeld >= holdLimit) {
      closePosition(
        position,
        slip(mark, position.side, false, params.execution.slippageBps),
        position.scalp ? "scalp_timeout" : "max_hold",
        1,
      );
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

    /**
     * Record why a candidate that passed the signal checks still did not
     * trade.
     *
     * The screener runs before any sizing, so its gate list only covers
     * signal quality — and the dashboard, reading that list, told people
     * "all entry conditions met, trades on the next tick" about symbols this
     * loop then rejected for a reason it never mentioned. The promise never
     * came true and nothing said why.
     *
     * Rather than recompute the sizing rules in the screener, where they
     * could drift out of step with these, the code that makes the decision
     * records it: every rejection below adds the real reason to that
     * symbol's row.
     */
    const rowBySymbol = new Map(screener.map((r) => [r.symbol, r]));
    const reject = (symbol: string, name: string, required: string, actual: string) => {
      const row = rowBySymbol.get(symbol);
      if (!row) return;
      row.gates.push({ name, required, actual, passed: false });
      row.blockedBy = name;
    };

    const ranked = screener
      .filter((r) => !r.hasPosition && r.direction !== "flat")
      .filter((r) => symbols.includes(r.symbol)) // only today's top-N
      .sort(
        (a, b) =>
          Math.abs(b.score) * b.confidence * (0.5 + b.alignment) -
          Math.abs(a.score) * a.confidence * (0.5 + a.alignment),
      );

    for (const row of ranked) {
      if (positions.length >= limits.maxOpenPositions) {
        // Everything still queued is waiting for a slot, not for a signal.
        reject(
          row.symbol,
          "free position slot",
          `under ${limits.maxOpenPositions} open`,
          `${positions.length} open`,
        );
        continue;
      }

      const blended = analyses.get(row.symbol);
      const scalpBlend = scalpAnalyses.get(row.symbol);

      /**
       * Which engine, if either, wants this symbol.
       *
       * A symbol holds one position, so when both want it the swing engine
       * takes it and the scalp trades what is left over. Offered the other
       * way round, the scalp's looser gates meant it wanted nearly every
       * symbol and the swing book all but disappeared.
       */
      const scalpSlots = positions.filter((p) => p.scalp).length;
      const swingSlots = positions.length - scalpSlots;

      const swingWants =
        !!blended &&
        !!blended.anchor &&
        swingSlots < limits.maxOpenPositions &&
        blended.direction !== "flat" &&
        Math.abs(blended.score) >= params.entry.minScore &&
        blended.confidence >= params.entry.minConfidence &&
        blended.alignment >= params.entry.minAlignment;

      const scalpWants =
        params.scalp.enabled &&
        !!scalpBlend &&
        !!scalpBlend.anchor &&
        scalpSlots < params.scalp.maxOpen &&
        scalpBlend.direction !== "flat" &&
        Math.abs(scalpBlend.score) >= params.scalp.minScore &&
        scalpBlend.confidence >= params.scalp.minConfidence &&
        scalpBlend.alignment >= params.scalp.minAlignment;

      if (!swingWants && !scalpWants) continue;
      const isScalp = !swingWants && scalpWants;
      const signal = (isScalp ? scalpBlend : blended) as NonNullable<typeof blended>;
      const anchor = signal.anchor;
      if (!anchor) continue;

      const side: Side = signal.direction === "long" ? "long" : "short";
      if (side === "short" && !params.entry.allowShorts) continue;

      // Elliott / Gann gates, when enabled. The swing engine's only: a scalp
      // is too short for a wave count or a Gann cycle to say much about it.
      if (!isScalp) {
        if (params.entry.requireElliottAgreement) {
          if (anchor.elliott.pattern === "none" || anchor.elliott.bias !== side) continue;
        }
        if (params.entry.requireGannAgreement && anchor.gann.bias !== side) continue;
        if (params.entry.avoidGannTimeCycle) {
          const { nearestCycle, distance, barsSinceAnchor } = anchor.gann.timeCycle;
          const window = Math.max(1, Math.round(nearestCycle * 0.05));
          if (nearestCycle > 0 && barsSinceAnchor > 0 && distance <= window) continue;
        }
      }

      const quoted = markBySymbol[row.symbol];
      if (!(quoted > 0) || !(anchor.atr > 0)) {
        reject(row.symbol, "market data", "a mark price and ATR", "missing");
        continue;
      }
      /**
       * The price this would actually be filled at, not the mark.
       *
       * Everything below — the stop, the targets, the size, the liquidation
       * price — is derived from this, so crossing the spread here is what
       * makes the whole position honest rather than just its P&L.
       */
      const mark = slip(quoted, side, true, params.execution.slippageBps);

      // Stop from ATR, then sized so the stop costs exactly riskPerTrade.
      const stopDistance =
        anchor.atr * (isScalp ? params.scalp.atrStopMultiple : params.exit.atrStopMultiple);
      const stopLoss = side === "long" ? mark - stopDistance : mark + stopDistance;
      if (!(stopDistance > 0)) {
        reject(row.symbol, "stop distance", "above zero", "zero");
        continue;
      }
      /**
       * A stop wider than the liquidation distance would never be reached —
       * the position is wiped out first — so the trade is not takeable at
       * this leverage. On a volatile small-cap with a 4h anchor this is the
       * usual reason a symbol passes every signal check and still never
       * trades, which is worth saying out loud rather than skipping.
       */
      const stopRoom = 0.9 / limits.leverage;
      if (stopDistance / mark > stopRoom) {
        reject(
          row.symbol,
          "stop fits leverage",
          `under ${(stopRoom * 100).toFixed(0)}% of price`,
          `${((stopDistance / mark) * 100).toFixed(1)}%`,
        );
        continue;
      }

      /**
       * Size is the smaller of two answers to different questions.
       *
       * `capitalPerTrade` asks how much of the account this position should
       * commit as margin; `riskPerTrade` asks how much may be lost if the
       * stop is hit. Only the second was applied here, so a tight stop bought
       * an enormous position — the backtester has always taken the smaller of
       * the two, which meant the simulation and the live account were sizing
       * by different rules and the backtest did not describe what production
       * would do.
       */
      const byRisk = (currentEquity * limits.riskPerTrade) / stopDistance;
      const byCapital = (currentEquity * limits.capitalPerTrade * limits.leverage) / mark;
      let quantity = Math.min(byRisk, byCapital);

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
        reject(
          row.symbol,
          "size above exchange minimum",
          `${minNotional} USDT`,
          `${notional.toFixed(2)} USDT`,
        );
        continue;
      }

      const margin = initialMargin(notional, limits.leverage);
      const entryFee = commission(notional, "taker");
      if (margin + entryFee > account.balance) {
        reject(
          row.symbol,
          "margin available",
          `${(margin + entryFee).toFixed(2)} USDT`,
          `${account.balance.toFixed(2)} USDT free`,
        );
        continue;
      }

      account.balance -= margin + entryFee;
      account.totalFees += entryFee;

      const takeProfits = isScalp
        ? [
            {
              // The whole position at a fixed move: "take the 5% and close",
              // not a ladder that leaves a runner behind.
              price:
                side === "long"
                  ? mark * (1 + params.scalp.targetPct)
                  : mark * (1 - params.scalp.targetPct),
              fraction: params.scalp.closeFraction,
              hit: false,
              scalp: true,
            },
            // Whatever the scalp leaves behind rides the swing ladder.
            ...(params.scalp.closeFraction < 1
              ? params.exit.takeProfitRMultiples.map((r, i) => ({
                  price: side === "long" ? mark + stopDistance * r : mark - stopDistance * r,
                  fraction:
                    (params.exit.takeProfitFractions[i] ?? 0) * (1 - params.scalp.closeFraction),
                  hit: false,
                })).filter((tp) => tp.fraction > 0)
              : []),
          ]
        : params.exit.takeProfitRMultiples
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
        style: isScalp ? "scalp" : (STYLE_BY_TIMEFRAME[anchor.timeframe] ?? "swing"),
        scalp: isScalp,
        paramsVersion,
        // Read off whichever blend opened this, not always the swing one.
        reasons: [
          isScalp
            ? `${side} ${row.symbol} scalp on ${params.scalp.timeframes.join("/")} — ` +
              `target ${(params.scalp.targetPct * 100).toFixed(1)}%, ` +
              `${(params.scalp.closeFraction * 100).toFixed(0)}% of it, ` +
              `out within ${params.scalp.maxHoldBars} bars`
            : `${side} ${row.symbol} ${anchor.timeframe} (${STYLE_BY_TIMEFRAME[anchor.timeframe] ?? "swing"})`,
          `score ${signal.score.toFixed(2)}, alignment ${(signal.alignment * 100).toFixed(0)}%, ${anchor.regime.kind}`,
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
