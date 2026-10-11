import { analyseTimeframe } from "@/lib/algo/screener/analyse";
import type { StrategyParams } from "@/lib/algo/strategy/params";
import {
  TIMEFRAME_MS,
  type Candle,
  type Timeframe,
  type TimeframeAnalysis,
} from "@/lib/algo/types";
import { clamp, weightedAverage } from "@/lib/algo/util/math";
import { commission, initialMargin, liquidationPrice, unrealisedPnl } from "@/lib/futures/fees";

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

/**
 * Move a fill price against the trader by `bps`.
 *
 * Buying fills a little higher than quoted, selling a little lower, which is
 * the one direction slippage ever goes. `side` is the position's direction,
 * and `entering` says which way the order runs: opening a long buys, closing
 * one sells.
 */
export function slip(
  price: number,
  side: "long" | "short",
  entering: boolean,
  bps: number,
): number {
  if (!(bps > 0)) return price;
  const buying = entering === (side === "long");
  return price * (1 + (buying ? 1 : -1) * (bps / 10_000));
}

/**
 * Where a stop or liquidation actually fills.
 *
 * A trigger the bar opened beyond was never available at its price. Filling
 * there regardless credits the account with a trade that could not have
 * happened — and it does so on precisely the bars that gap, which are the
 * ones that do the damage. The fill is the worse of the trigger and the
 * open, and then slipped for trading into the move that set it off.
 */
export function triggerFillPrice(
  trigger: number,
  barOpen: number,
  side: "long" | "short",
  bps: number,
): number {
  const gapped = side === "long" ? Math.min(trigger, barOpen) : Math.max(trigger, barOpen);
  return slip(gapped, side, false, bps);
}

function lastClosedIndex(candles: Candle[], time: number, hint: number): number {
  let i = Math.max(0, hint);
  while (i < candles.length && (candles[i] as Candle).closeTime <= time) i++;
  return i - 1;
}

export function aggregate(
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

/**
 * Which symbols the engine would have been allowed to trade at each step.
 *
 * The live engine rebuilds its universe every UTC day from the top-N
 * perpetuals by 24h quote volume. Replaying it over a pool fixed at *today's*
 * ranking quietly asks a different question: those are the coins that already
 * had the month's biggest moves, so the strategy is scored only on the
 * survivors and the return it reports is one no live account could have
 * earned. Ranking on the volume that had actually printed by each step gives
 * the backtest the same partial information the engine had.
 *
 * The pool is still drawn from today's listings, so a symbol that was
 * delisted mid-window is missing entirely. That residual bias is why the
 * dashboard says which pool a run used rather than presenting the number bare.
 */
export function pointInTimeUniverse(
  data: BacktestInput[],
  stepTimeframe: Timeframe,
  clock: number[],
  size: number,
): Map<number, Set<string>> {
  const WINDOW_MS = 24 * 3_600_000;

  // Prefix sums plus a cursor that only moves forward, so ranking every step
  // costs one pass over the bars rather than one scan per step.
  const series = data.map((d) => {
    const candles = d.byTimeframe.get(stepTimeframe) ?? [];
    const prefix = new Float64Array(candles.length + 1);
    for (let i = 0; i < candles.length; i++) {
      prefix[i + 1] = (prefix[i] as number) + ((candles[i] as Candle).quoteVolume || 0);
    }
    return { symbol: d.symbol, candles, prefix, end: 0, start: 0 };
  });

  const eligible = new Map<number, Set<string>>();
  const ranked: { symbol: string; volume: number }[] = [];

  for (const now of clock) {
    ranked.length = 0;
    const floor = now - WINDOW_MS;
    for (const s of series) {
      while (s.end < s.candles.length && (s.candles[s.end] as Candle).closeTime <= now) s.end++;
      while (s.start < s.end && (s.candles[s.start] as Candle).closeTime <= floor) s.start++;
      // No bars yet means the symbol had not started trading — not eligible,
      // rather than eligible with zero volume.
      if (s.end === 0) continue;
      ranked.push({
        symbol: s.symbol,
        volume: (s.prefix[s.end] as number) - (s.prefix[s.start] as number),
      });
    }
    ranked.sort((a, b) => b.volume - a.volume);
    eligible.set(now, new Set(ranked.slice(0, size).map((r) => r.symbol)));
  }
  return eligible;
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
    /**
     * Re-rank the symbols by trailing 24h volume at every step and only allow
     * entries in the top `universeSize`, mirroring the live engine's daily
     * universe. Leave unset to trade everything passed in.
     */
    universeSize?: number;
    /**
     * Stop opening positions at this drawdown from peak equity, as the live
     * engine does. Without it the backtest keeps sizing off a shrinking
     * balance straight through a losing stretch that production would have
     * sat out, and reports a drawdown deeper than the deployed strategy can
     * reach.
     */
    maxDrawdownHalt?: number;
    /** Notional ceiling as a multiple of equity, matching the risk manager. */
    maxPositionFraction?: number;
    /** Override the fill-cost assumptions; defaults to the strategy's own. */
    execution?: StrategyParams["execution"];
  } = {},
): BacktestResult {
  const {
    stepTimeframe = "1h",
    startingBalance = 100,
    leverage = 3,
    riskPerTrade = 0.02,
    maxOpenPositions = Number(process.env.MAX_OPEN_POSITIONS ?? "3"),
    maxDrawdownHalt = Number(process.env.MAX_DRAWDOWN ?? "0.3"),
    execution = params.execution,
    maxPositionFraction = Number(process.env.MAX_POSITION_FRACTION ?? "1.5"),
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
    targets: { price: number; fraction: number; hit: boolean; scalp?: boolean }[];
    liq: number;
    extreme: number;
    entryFee: number;
    funding: number;
    openedAt: number;
    lastFundingAt: number;
    timeframe: Timeframe;
    /** Opened as a high-conviction scalp: fixed target, short clock. */
    scalp: boolean;
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

  const eligible =
    options.universeSize !== undefined && options.universeSize < data.length
      ? pointInTimeUniverse(data, stepTimeframe, clock, options.universeSize)
      : null;

  const state = new Map<
    string,
    { hints: Map<Timeframe, number>; cache: Map<Timeframe, { i: number; a: TimeframeAnalysis | null }>; open: Open | null }
  >(data.map((d) => [d.symbol, { hints: new Map(), cache: new Map(), open: null }]));

  let totalFees = 0;
  let totalFunding = 0;
  // Equity as of the previous step's close, which is what a new position is
  // sized against — the live engine sizes off marked equity, not free cash.
  let equityNowRef = startingBalance;

  // Latest close per symbol, refreshed as the clock advances. Equity, the
  // drawdown halt and the forced sweep all price against it, so it has to be
  // written on every step — an earlier version declared it and never did,
  // which quietly closed wiped-out positions at their entry price and so
  // reported no loss on them at all.
  const markBySymbol = new Map<string, number>();

  // Set once the account hits `maxDrawdownHalt`; cleared after it recovers
  // clearly, not on the first step back under, matching the live engine.
  let halted = false;

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
      markBySymbol.set(d.symbol, (stepCandles[idx] as Candle).close);
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

        const triggerFill = (trigger: number, bps: number) =>
          triggerFillPrice(trigger, nextBar.open, open.side, bps);

        // Liquidation first, then stop, then targets.
        const liqHit =
          open.side === "long" ? nextBar.low <= open.liq : nextBar.high >= open.liq;
        if (liqHit) {
          close(d.symbol, st, triggerFill(open.liq, execution.stopSlippageBps), "liquidation", 1, nextBar.closeTime);
          continue;
        }
        const stopHit =
          open.side === "long" ? nextBar.low <= open.stop : nextBar.high >= open.stop;
        if (stopHit) {
          close(d.symbol, st, triggerFill(open.stop, execution.stopSlippageBps), "stop_loss", 1, nextBar.closeTime);
          continue;
        }
        for (const tp of open.targets) {
          if (tp.hit) continue;
          const reached =
            open.side === "long" ? nextBar.high >= tp.price : nextBar.low <= tp.price;
          if (reached) {
            tp.hit = true;
            close(
              d.symbol,
              st,
              tp.price,
              tp.scalp ? "scalp_target" : "take_profit",
              tp.fraction,
              nextBar.closeTime,
            );
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
          /**
           * Trailing is a swing exit and it is skipped on a scalp: a trail
           * set in ATR multiples sits well inside a fixed 5% target, so it
           * would reliably cut the trade short of the only exit it was
           * opened for. Break-even still applies — that one cannot take less
           * than the entry.
           */
          if (
            !open.scalp &&
            params.exit.trailStartR > 0 &&
            r >= params.exit.trailStartR &&
            anchor.atr > 0
          ) {
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
          close(d.symbol, st, slip(nextBar.close, open.side, false, execution.slippageBps), "signal_flip", 1, nextBar.closeTime);
          continue;
        }
        const barsHeld = Math.floor((now - open.openedAt) / TIMEFRAME_MS[open.timeframe]);
        const holdLimit = open.scalp ? params.scalp.maxHoldBars : params.exit.maxHoldBars;
        if (barsHeld >= holdLimit) {
          close(
            d.symbol,
            st,
            slip(nextBar.close, open.side, false, execution.slippageBps),
            open.scalp ? "scalp_timeout" : "max_hold",
            1,
            nextBar.closeTime,
          );
        }
        continue;
      }

      // --- entry on the next bar's open ---
      if (bankrupt || halted) continue;
      // Gates entries only: a position already open is managed to its exit
      // even if its symbol drops out of the ranking, which is what the live
      // engine does too.
      if (eligible && !eligible.get(now)?.has(d.symbol)) continue;
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

      const quoted = nextBar.open;
      /**
       * A scalp when the blend is unusually sure. It takes a tighter stop as
       * well as a fixed target: keeping the swing stop would size the
       * position down to hold the same risk over a move it only needs a
       * fraction of, and the trade would never pay for its fees.
       */
      const isScalp =
        params.scalp.enabled && blended.confidence >= params.scalp.minConfidence;
      // Crossing the spread to get in, before anything is sized off the price.
      const price = slip(quoted, side, true, execution.slippageBps);
      const stopMultiple = isScalp
        ? params.scalp.atrStopMultiple
        : params.exit.atrStopMultiple;
      const stopDistance = anchor.atr * stopMultiple;
      if (!(stopDistance > 0) || !(price > 0)) continue;
      if (stopDistance / price > 0.9 / leverage) continue;

      const equityNow = equityNowRef;
      let qty = (equityNow * riskPerTrade) / stopDistance;
      // Notional ceiling, as the live risk manager applies it.
      if (qty * price > equityNow * maxPositionFraction) {
        qty = (equityNow * maxPositionFraction) / price;
      }
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
        targets: isScalp
          ? [
              {
                // The whole position, at a fixed move — "close it" rather
                // than a ladder that leaves a runner behind.
                price:
                  side === "long"
                    ? price * (1 + params.scalp.targetPct)
                    : price * (1 - params.scalp.targetPct),
                fraction: params.scalp.closeFraction,
                hit: false,
                scalp: true,
              },
              // Whatever the scalp leaves behind rides the swing ladder.
              ...(params.scalp.closeFraction < 1
                ? params.exit.takeProfitRMultiples.map((r, i) => ({
                    price: side === "long" ? price + stopDistance * r : price - stopDistance * r,
                    fraction:
                      (params.exit.takeProfitFractions[i] ?? 0) * (1 - params.scalp.closeFraction),
                    hit: false,
                  })).filter((t) => t.fraction > 0)
                : []),
            ]
          : params.exit.takeProfitRMultiples
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
        scalp: isScalp,
      };
    }

    /**
     * Equity: free balance, plus each position's posted margin and whatever
     * it is currently worth. Marking only balance plus margin — which this
     * did before — hides an open loss until the position closes, so the
     * drawdown it reported was always shallower than the account's.
     */
    let marked = balance;
    for (const [sym, st] of state) {
      if (!st.open) continue;
      const mark = markBySymbol.get(sym) ?? st.open.entry;
      marked +=
        st.open.margin +
        unrealisedPnl({ side: st.open.side, entryPrice: st.open.entry, quantity: st.open.qty, markPrice: mark });
    }
    equityNowRef = Math.max(0, marked);
    peak = Math.max(peak, marked);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - marked) / peak);

    // The live engine stops opening positions here and only resumes once the
    // account has recovered clearly, rather than on the first step back under
    // the threshold.
    const dd = peak > 0 ? (peak - marked) / peak : 0;
    if (dd >= maxDrawdownHalt) halted = true;
    else if (halted && dd < maxDrawdownHalt * 0.8) halted = false;

    // A real account stops here: margin call, everything closed, no more
    // trading. Letting the balance run negative produced returns beyond -100%,
    // which is not a loss anyone can actually take.
    if (!bankrupt && marked <= 0) {
      bankrupt = true;
      for (const [sym, st] of state) {
        if (!st.open) continue;
        close(sym, st, markBySymbol.get(sym) ?? st.open.entry, "liquidation", 1, now);
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
