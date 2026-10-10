import { analyseTimeframe } from "@/lib/algo/screener/analyse";
import type { StrategyParams } from "@/lib/algo/strategy/params";
import {
  TIMEFRAME_MS,
  type Candle,
  type Timeframe,
  type TimeframeAnalysis,
} from "@/lib/algo/types";
import { clamp, weightedAverage } from "@/lib/algo/util/math";
import { commission, initialMargin, liquidationPrice } from "@/lib/futures/fees";

/**
 * Compact futures backtester used by the self-improvement loop.
 *
 * This is a deliberately smaller engine than the research backtester in
 * `algo-screener/`: it has to finish inside a serverless function's time
 * budget, so it steps on one timeframe, holds one position at a time per
 * symbol, and skips walk-forward. What it does keep is the part that decides
 * whether a result is trustworthy:
 *
 *  - no lookahead (decide on bar i, fill on bar i+1's open),
 *  - a bar touching both stop and target resolves at the stop,
 *  - real taker fees and liquidation on every trade.
 *
 * Funding is applied per 8h boundary at a flat assumed rate, because historical
 * per-symbol funding would need another API call per symbol per window and the
 * effect on a scalp is small; this is stated rather than hidden because it is
 * the one cost here that is an approximation.
 */

export interface BacktestInput {
  symbol: string;
  byTimeframe: Map<Timeframe, Candle[]>;
}

export interface BacktestTrade {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  /** Margin committed to the slice being closed — the most it can lose. */
  margin: number;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  rMultiple: number;
  exitReason: string;
  timeframe: Timeframe;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  startingBalance: number;
  finalEquity: number;
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  expectancy: number;
  totalFees: number;
  totalFunding: number;
  liquidations: number;
  fitness: number;
  from: number;
  to: number;
}

const ASSUMED_FUNDING_RATE = Number(process.env.BACKTEST_FUNDING_RATE ?? "0.0001");

function lastClosedIndex(candles: Candle[], time: number, hint: number): number {
  let i = Math.max(0, hint);
  while (i < candles.length && (candles[i] as Candle).closeTime <= time) i++;
  return i - 1;
}

function aggregate(
  perTimeframe: Map<Timeframe, TimeframeAnalysis>,
  params: StrategyParams,
) {
  const entries = [...perTimeframe.entries()];
  const w = (tf: Timeframe) => params.timeframeWeights[tf] ?? 1;

  const score = clamp(
    weightedAverage(
      entries.map(([tf, a]) => ({ value: a.score, weight: w(tf) * Math.max(a.confidence, 0.05) })),
    ),
    -1,
    1,
  );
  const confidence = clamp(
    weightedAverage(entries.map(([tf, a]) => ({ value: a.confidence, weight: w(tf) }))),
    0,
    1,
  );
  const direction = score > 0.1 ? "long" : score < -0.1 ? "short" : "flat";

  let agreeing = 0;
  let total = 0;
  for (const [tf, a] of entries) {
    total += w(tf);
    if (direction === "flat") continue;
    if (a.direction === direction) agreeing += w(tf);
    else if (a.direction !== "flat") agreeing -= w(tf) * 0.5;
  }

  return {
    score,
    confidence,
    alignment: total === 0 ? 0 : clamp(agreeing / total, 0, 1),
    direction,
    anchor: entries.find(([tf]) => tf === entries[0]?.[0])?.[1] ?? null,
  };
}

export function runFuturesBacktest(
  data: BacktestInput[],
  params: StrategyParams,
  options: {
    stepTimeframe?: Timeframe;
    startingBalance?: number;
    leverage?: number;
    riskPerTrade?: number;
    /**
     * Must match the live engine's limit. Without it the backtest happily runs
     * one position per symbol while production caps concurrency, so the
     * simulated account carries several times the real exposure and its
     * results describe a strategy that is not the one being deployed.
     */
    maxOpenPositions?: number;
    windowBars?: number;
    /** Only trade bars closing at or after this time (warm-up still uses earlier bars). */
    from?: number;
    /** Only trade bars closing at or before this time. */
    to?: number;
  } = {},
): BacktestResult {
  const {
    stepTimeframe = "1h",
    startingBalance = 100,
    leverage = 3,
    riskPerTrade = 0.02,
    maxOpenPositions = Number(process.env.MAX_OPEN_POSITIONS ?? "3"),
    windowBars = 260,
  } = options;

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let liquidations = 0;
  let bankrupt = false;
  const trades: BacktestTrade[] = [];

  interface Open {
    side: "long" | "short";
    qty: number;
    entry: number;
    margin: number;
    stop: number;
    targets: { price: number; fraction: number; hit: boolean }[];
    liq: number;
    extreme: number;
    entryFee: number;
    funding: number;
    openedAt: number;
    lastFundingAt: number;
    timeframe: Timeframe;
  }

  // The clock is restricted to the requested window, but the analysis windows
  // still read bars from before it — that is what makes an out-of-sample test
  // honest: indicators are warm, yet no trade is taken outside the window.
  const { from, to } = options;
  const clockTimes = new Set<number>();
  for (const d of data) {
    for (const c of d.byTimeframe.get(stepTimeframe) ?? []) {
      if (from !== undefined && c.closeTime < from) continue;
      if (to !== undefined && c.closeTime > to) continue;
      clockTimes.add(c.closeTime);
    }
  }
  const clock = [...clockTimes].sort((a, b) => a - b);
  if (clock.length < 20) {
    return {
      trades: [], startingBalance, finalEquity: startingBalance, totalReturn: 0,
      winRate: 0, profitFactor: 0, maxDrawdown: 0, expectancy: 0, totalFees: 0,
      totalFunding: 0, liquidations: 0, fitness: -1, from: 0, to: 0,
    };
  }

  const state = new Map<
    string,
    { hints: Map<Timeframe, number>; cache: Map<Timeframe, { i: number; a: TimeframeAnalysis | null }>; open: Open | null }
  >(data.map((d) => [d.symbol, { hints: new Map(), cache: new Map(), open: null }]));

  let totalFees = 0;
  let totalFunding = 0;

  // Latest close per symbol, refreshed as the clock advances; used to price
  // the forced liquidation sweep if the account is wiped out.
  const bySymbolStep = new Map<string, number[]>();

  const close = (
    symbol: string,
    st: { open: Open | null },
    exitPrice: number,
    reason: string,
    fraction: number,
    time: number,
  ) => {
    const open = st.open;
    if (!open) return;
    const qty = Math.min(open.qty, open.qty * Math.min(1, fraction));
    if (!(qty > 0)) return;
    const share = qty / open.qty;

    const exitFee = commission(exitPrice * qty, "taker");
    const entryFeeShare = open.entryFee * share;
    const fundingShare = open.funding * share;
    const marginShare = open.margin * share;

    const gross =
      open.side === "long"
        ? (exitPrice - open.entry) * qty
        : (open.entry - exitPrice) * qty;
    const fundingCost = -fundingShare;
    const net = gross - exitFee - entryFeeShare - fundingCost;

    balance += marginShare + gross - exitFee - entryFeeShare;
    totalFees += exitFee + entryFeeShare;
    totalFunding += fundingCost;

    const risk = Math.abs(open.entry - open.stop);
    trades.push({
      symbol,
      side: open.side,
      quantity: qty,
      margin: marginShare,
      openedAt: open.openedAt,
      closedAt: time,
      entryPrice: open.entry,
      exitPrice,
      grossPnl: gross,
      fees: exitFee + entryFeeShare,
      funding: fundingCost,
      netPnl: net,
      rMultiple: risk > 0 ? gross / (risk * qty) : 0,
      exitReason: reason,
      timeframe: open.timeframe,
    });
    if (reason === "liquidation") liquidations++;

    open.qty -= qty;
    open.margin -= marginShare;
    open.entryFee -= entryFeeShare;
    open.funding -= fundingShare;
    if (open.qty <= 1e-12) st.open = null;
  };

  for (let step = 0; step < clock.length - 1; step++) {
    const now = clock[step] as number;

    for (const d of data) {
      const st = state.get(d.symbol);
      if (!st) continue;
      const stepCandles = d.byTimeframe.get(stepTimeframe) ?? [];
      const idx = lastClosedIndex(stepCandles, now, st.hints.get(stepTimeframe) ?? 0);
      st.hints.set(stepTimeframe, Math.max(0, idx));
      if (idx < 0) continue;
      const nextBar = stepCandles[idx + 1];
      if (!nextBar) continue;

      // Re-analyse only timeframes that printed a new closed bar.
      const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
      for (const [tf, candles] of d.byTimeframe) {
        const i = lastClosedIndex(candles, now, st.hints.get(tf) ?? 0);
        st.hints.set(tf, Math.max(0, i));
        if (i < 0) continue;
        const cached = st.cache.get(tf);
        if (cached && cached.i === i) {
          if (cached.a) perTimeframe.set(tf, cached.a);
          continue;
        }
        const a = analyseTimeframe(
          d.symbol, tf, candles.slice(Math.max(0, i - windowBars + 1), i + 1), params,
        );
        st.cache.set(tf, { i, a });
        if (a) perTimeframe.set(tf, a);
      }
      if (perTimeframe.size === 0) continue;
      const blended = aggregate(perTimeframe, params);
      const anchor = blended.anchor;

      // --- manage open position on the next bar ---
      if (st.open) {
        const open = st.open;
        open.extreme =
          open.side === "long"
            ? Math.max(open.extreme, nextBar.high)
            : Math.min(open.extreme, nextBar.low);

        // Liquidation first, then stop, then targets.
        const liqHit =
          open.side === "long" ? nextBar.low <= open.liq : nextBar.high >= open.liq;
        if (liqHit) {
          close(d.symbol, st, open.liq, "liquidation", 1, nextBar.closeTime);
          continue;
        }
        const stopHit =
          open.side === "long" ? nextBar.low <= open.stop : nextBar.high >= open.stop;
        if (stopHit) {
          close(d.symbol, st, open.stop, "stop_loss", 1, nextBar.closeTime);
          continue;
        }
        for (const tp of open.targets) {
          if (tp.hit) continue;
          const reached =
            open.side === "long" ? nextBar.high >= tp.price : nextBar.low <= tp.price;
          if (reached) {
            tp.hit = true;
            close(d.symbol, st, tp.price, "take_profit", tp.fraction, nextBar.closeTime);
          }
        }
        if (!st.open) continue;

        // Funding across 8h boundaries.
        const boundaries = Math.floor(
          (nextBar.closeTime - open.lastFundingAt) / (8 * 3600_000),
        );
        if (boundaries > 0) {
          const payment =
            (open.side === "long" ? -1 : 1) *
            open.qty * nextBar.close * ASSUMED_FUNDING_RATE * boundaries;
          open.funding += payment;
          open.margin += payment;
          open.lastFundingAt += boundaries * 8 * 3600_000;
        }

        // Trailing / break-even.
        const risk = Math.abs(open.entry - open.stop);
        if (risk > 0 && anchor) {
          const favourable =
            open.side === "long" ? open.extreme - open.entry : open.entry - open.extreme;
          const r = favourable / risk;
          let next = open.stop;
          if (params.exit.breakEvenR > 0 && r >= params.exit.breakEvenR) {
            next = open.side === "long" ? Math.max(next, open.entry) : Math.min(next, open.entry);
          }
          if (params.exit.trailStartR > 0 && r >= params.exit.trailStartR && anchor.atr > 0) {
            const trail =
              open.side === "long"
                ? open.extreme - anchor.atr * params.exit.trailAtrMultiple
                : open.extreme + anchor.atr * params.exit.trailAtrMultiple;
            next = open.side === "long" ? Math.max(next, trail) : Math.min(next, trail);
          }
          if ((open.side === "long" && next > open.stop) || (open.side === "short" && next < open.stop)) {
            open.stop = next;
          }
        }

        // Signal flip and time stop.
        const against = open.side === "long" ? -blended.score : blended.score;
        if (params.exit.exitOnScoreFlip > 0 && against >= params.exit.exitOnScoreFlip) {
          close(d.symbol, st, nextBar.close, "signal_flip", 1, nextBar.closeTime);
          continue;
        }
        const barsHeld = Math.floor((now - open.openedAt) / TIMEFRAME_MS[open.timeframe]);
        if (barsHeld >= params.exit.maxHoldBars) {
          close(d.symbol, st, nextBar.close, "max_hold", 1, nextBar.closeTime);
        }
        continue;
      }

      // --- entry on the next bar's open ---
      if (bankrupt) continue;
      // Concurrency cap, matching the live risk manager.
      const openCount = [...state.values()].filter((x) => x.open !== null).length;
      if (openCount >= maxOpenPositions) continue;
      if (!anchor || blended.direction === "flat") continue;
      if (Math.abs(blended.score) < params.entry.minScore) continue;
      if (blended.confidence < params.entry.minConfidence) continue;
      if (blended.alignment < params.entry.minAlignment) continue;

      const side = blended.direction === "long" ? "long" : "short";
      if (side === "short" && !params.entry.allowShorts) continue;
      if (params.entry.requireElliottAgreement &&
          (anchor.elliott.pattern === "none" || anchor.elliott.bias !== side)) continue;
      if (params.entry.requireGannAgreement && anchor.gann.bias !== side) continue;

      const price = nextBar.open;
      const stopDistance = anchor.atr * params.exit.atrStopMultiple;
      if (!(stopDistance > 0) || !(price > 0)) continue;
      if (stopDistance / price > 0.9 / leverage) continue;

      const equityNow = balance;
      let qty = (equityNow * riskPerTrade) / stopDistance;
      const margin = initialMargin(qty * price, leverage);
      if (margin > balance * 0.9) qty = (balance * 0.9 * leverage) / price;
      const notional = qty * price;
      if (!(qty > 0) || notional < 5) continue;

      const realMargin = initialMargin(notional, leverage);
      const entryFee = commission(notional, "taker");
      if (realMargin + entryFee > balance) continue;

      balance -= realMargin + entryFee;
      totalFees += entryFee;

      st.open = {
        side,
        qty,
        entry: price,
        margin: realMargin,
        stop: side === "long" ? price - stopDistance : price + stopDistance,
        targets: params.exit.takeProfitRMultiples
          .map((r, i) => ({
            price: side === "long" ? price + stopDistance * r : price - stopDistance * r,
            fraction: params.exit.takeProfitFractions[i] ?? 0,
            hit: false,
          }))
          .filter((t) => t.fraction > 0),
        liq: liquidationPrice({ side, entryPrice: price, quantity: qty, leverage, symbol: d.symbol }),
        extreme: price,
        entryFee,
        funding: 0,
        openedAt: nextBar.closeTime,
        lastFundingAt: nextBar.closeTime,
        timeframe: anchor.timeframe,
      };
    }

    // Track drawdown on realised balance plus posted margin.
    let marked = balance;
    for (const st of state.values()) if (st.open) marked += st.open.margin;
    peak = Math.max(peak, marked);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - marked) / peak);

    // A real account stops here: margin call, everything closed, no more
    // trading. Letting the balance run negative produced returns beyond -100%,
    // which is not a loss anyone can actually take.
    if (!bankrupt && marked <= 0) {
      bankrupt = true;
      for (const [sym, st] of state) {
        if (!st.open) continue;
        const last = (bySymbolStep.get(sym) ?? [])[0];
        close(sym, st, last ?? st.open.entry, "liquidation", 1, now);
      }
      balance = Math.max(0, balance);
    }
  }

  // Close anything still open at the final price.
  const finalTime = clock.at(-1) as number;
  for (const d of data) {
    const st = state.get(d.symbol);
    if (!st?.open) continue;
    const last = (d.byTimeframe.get(stepTimeframe) ?? []).at(-1);
    close(d.symbol, st, last?.close ?? st.open.entry, "end_of_data", 1, finalTime);
  }

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const totalReturn = (balance - startingBalance) / startingBalance;
  const expectancy =
    trades.length === 0 ? 0 : trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length;
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 10 : 0) : grossProfit / grossLoss;

  // Fitness deliberately punishes drawdown and liquidation hard: on a $100
  // account a single liquidation is unrecoverable in a way a drawdown is not.
  const fitness =
    trades.length < 10
      ? totalReturn * 0.1 - 1
      : Math.tanh(totalReturn * 4) +
        Math.tanh(expectancy) * 0.6 +
        Math.tanh((profitFactor - 1) / 1.5) * 0.6 -
        maxDrawdown * 2 -
        liquidations * 0.5;

  return {
    trades,
    startingBalance,
    finalEquity: balance,
    totalReturn,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    profitFactor,
    maxDrawdown,
    expectancy,
    totalFees,
    totalFunding,
    liquidations,
    fitness,
    from: clock[0] as number,
    to: finalTime,
  };
}
