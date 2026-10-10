import { runBacktest, type BacktestResult, type SymbolData } from "./engine.js";
import { computeMetrics, fitnessScore, type PerformanceMetrics } from "./metrics.js";
import { config } from "../config.js";
import type { StrategyParams } from "../strategy/params.js";
import type { AccountSnapshot, ClosedTrade, Timeframe } from "../types.js";

export interface WalkForwardFold {
  index: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  result: BacktestResult;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** Metrics over the concatenated out-of-sample trades. */
  aggregate: PerformanceMetrics;
  fitness: number;
  /** Fraction of folds that were profitable — the consistency check. */
  foldConsistency: number;
}

/** Time range covered by the step timeframe's candles, across all symbols. */
function dataRange(
  data: SymbolData[],
  stepTimeframe: Timeframe,
): { earliest: number; latest: number } {
  let earliest = Infinity;
  let latest = -Infinity;
  for (const symbol of data) {
    const candles = symbol.byTimeframe.get(stepTimeframe);
    if (!candles || candles.length === 0) continue;
    const first = candles[0];
    const last = candles.at(-1);
    if (first) earliest = Math.min(earliest, first.openTime);
    if (last) latest = Math.max(latest, last.closeTime);
  }
  return { earliest, latest };
}

/**
 * Anchored walk-forward validation.
 *
 * A single train/test split is easy to get lucky on. Walk-forward runs the
 * parameters across several consecutive out-of-sample windows and reports both
 * the combined metrics and how consistent they were, which is what separates a
 * genuine edge from a curve fit.
 *
 * Note this validates *one* parameter set across time — it does not re-optimise
 * per fold. The improvement loop handles proposing new parameters; this answers
 * "does this set hold up across different market conditions?".
 */
export function walkForward(
  data: SymbolData[],
  params: StrategyParams,
  options: {
    folds?: number;
    startingCash?: number;
    stepTimeframe?: Timeframe;
    /** Bars of history before each test window, for indicator warm-up. */
    warmupBars?: number;
  } = {},
): WalkForwardResult {
  const { folds = 4, startingCash = config.account.startingCash } = options;

  // The fold boundaries must follow the clock the simulation actually advances
  // on. Taking the union of every timeframe would stretch the range to the
  // daily series' multi-year history and put most folds before the step
  // timeframe's data even begins.
  const stepTimeframe =
    options.stepTimeframe ??
    config.tradeTimeframes.find((tf) =>
      data.some((d) => (d.byTimeframe.get(tf)?.length ?? 0) > 0),
    ) ??
    "1h";

  const { earliest, latest } = dataRange(data, stepTimeframe);
  if (!Number.isFinite(earliest) || !Number.isFinite(latest) || latest <= earliest) {
    return {
      folds: [],
      aggregate: computeMetrics([], [], startingCash),
      fitness: -1,
      foldConsistency: 0,
    };
  }

  // Reserve the first 40% as warm-up/in-sample; split the rest into folds.
  const testStart = earliest + (latest - earliest) * 0.4;
  const foldSpan = (latest - testStart) / folds;

  const results: WalkForwardFold[] = [];
  const allTrades: ClosedTrade[] = [];
  const allCurve: AccountSnapshot[] = [];

  for (let i = 0; i < folds; i++) {
    const testFrom = testStart + foldSpan * i;
    const testTo = i === folds - 1 ? latest : testStart + foldSpan * (i + 1);

    const result = runBacktest(data, {
      params,
      startingCash,
      from: testFrom,
      to: testTo,
      stepTimeframe,
    });

    results.push({
      index: i,
      trainFrom: earliest,
      trainTo: testFrom,
      testFrom,
      testTo,
      result,
    });
    allTrades.push(...result.trades);
    allCurve.push(...result.curve);
  }

  allCurve.sort((a, b) => a.time - b.time);
  const aggregate = computeMetrics(allTrades, allCurve, startingCash);
  const profitableFolds = results.filter((f) => f.result.metrics.totalPnl > 0).length;

  return {
    folds: results,
    aggregate,
    fitness: fitnessScore(aggregate, config.improve.minTrades),
    foldConsistency: folds === 0 ? 0 : profitableFolds / folds,
  };
}
