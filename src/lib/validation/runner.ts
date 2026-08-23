import { backtest, BINANCE_SPOT_COSTS, LIVE_EXIT_POLICY, type BacktestResult, type ExitPolicy } from "../backtest";
import { computeExtendedMetrics } from "../backtest/metrics";
import { prepareStrategyData } from "../engine/signals";
import type { Strategy } from "../strategies/types";
import type { Candle, CandleInterval } from "../types";

export interface ValidationConfig {
  isRatio?: number;
  numTrials?: number;
  mcRuns?: number;
  walkForwardTrain?: number;
  walkForwardTest?: number;
  exitPolicy?: ExitPolicy;
}

export interface ValidationResult {
  inSample: BacktestResult & { metrics: ReturnType<typeof computeExtendedMetrics> };
  outOfSample: BacktestResult & { metrics: ReturnType<typeof computeExtendedMetrics> };
  walkForward: { windows: number; oosReturnPct: number; oosSharpe: number };
  monteCarlo: { runs: number; medianMaxDd: number; p95MaxDd: number; medianEquity: number };
  deflatedSharpe: number;
  pbo: number;
  warnings: string[];
}

function splitChronological(candles: Candle[], isRatio: number): [Candle[], Candle[]] {
  const cut = Math.floor(candles.length * isRatio);
  return [candles.slice(0, cut), candles.slice(cut)];
}

/**
 * Backtest a candle SLICE with a context rebuilt on that exact slice.
 *
 * Required for correctness: confluence signals read `cctx.ltfCandles[index]` from
 * the stored context and ignore the candle array handed to backtest(). Passing a
 * suffix slice against a full-history context evaluates signals from a different
 * time period than the prices they fill at — silently producing garbage.
 */
async function backtestSlice(
  strategy: Strategy,
  symbol: string,
  interval: CandleInterval,
  slice: Candle[],
  params: Record<string, number>,
  startEquity: number,
  key: string,
  exitPolicy?: ExitPolicy,
): Promise<BacktestResult> {
  await prepareStrategyData(strategy.id, symbol, interval, slice, key);
  return backtest(strategy, slice, params, startEquity, BINANCE_SPOT_COSTS, key, exitPolicy);
}

/** Monte Carlo: resample trade PnLs to estimate the drawdown distribution. */
function monteCarlo(trades: { pnl: number }[], startEquity: number, runs: number) {
  const maxDds: number[] = [];
  const finalEquities: number[] = [];
  for (let r = 0; r < runs; r++) {
    // Fisher-Yates — `sort(() => Math.random() - 0.5)` is not a uniform shuffle.
    const shuffled = [...trades];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let eq = startEquity;
    let peak = eq;
    let maxDd = 0;
    for (const t of shuffled) {
      eq += t.pnl;
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    maxDds.push(maxDd);
    finalEquities.push(eq);
  }
  maxDds.sort((a, b) => a - b);
  finalEquities.sort((a, b) => a - b);
  return {
    runs,
    medianMaxDd: maxDds[Math.floor(runs / 2)] ?? 0,
    p95MaxDd: maxDds[Math.floor(runs * 0.95)] ?? maxDds[maxDds.length - 1] ?? 0,
    medianEquity: finalEquities[Math.floor(runs / 2)] ?? startEquity,
  };
}

/** Rolling walk-forward. Each test window gets its own rebuilt context. */
async function walkForward(
  strategy: Strategy,
  symbol: string,
  interval: CandleInterval,
  candles: Candle[],
  params: Record<string, number>,
  trainBars: number,
  testBars: number,
  startEquity: number,
  exitPolicy?: ExitPolicy,
): Promise<{ windows: number; oosReturnPct: number; oosSharpe: number }> {
  let oosEquity = startEquity;
  const oosReturns: number[] = [];
  let windows = 0;
  for (let start = 0; start + trainBars + testBars <= candles.length; start += testBars) {
    const testSlice = candles.slice(start + trainBars, start + trainBars + testBars);
    if (testSlice.length < 30) break;
    const r = await backtestSlice(
      strategy, symbol, interval, testSlice, params, oosEquity, `wf:${symbol}:${interval}:${start}`, exitPolicy,
    );
    oosReturns.push(r.totalReturnPct / 100);
    oosEquity = r.endEquity;
    windows++;
  }
  const mean = oosReturns.length ? oosReturns.reduce((a, b) => a + b, 0) / oosReturns.length : 0;
  const std =
    oosReturns.length > 1
      ? Math.sqrt(oosReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / (oosReturns.length - 1))
      : 0;
  return {
    windows,
    oosReturnPct: oosEquity > 0 ? ((oosEquity - startEquity) / startEquity) * 100 : 0,
    oosSharpe: std > 0 ? (mean / std) * Math.sqrt(oosReturns.length) : 0,
  };
}

function estimatePbo(isResults: number[], oosResults: number[]): number {
  if (!oosResults.length) return 0;
  const median = [...isResults].sort((a, b) => a - b)[Math.floor(isResults.length / 2)] ?? 0;
  return oosResults.filter((r) => r < median).length / oosResults.length;
}

/**
 * Walk-forward / OOS validation. Requires symbol+interval so each slice can get
 * its own strategy context (see backtestSlice).
 */
export async function runValidation(
  strategy: Strategy,
  symbol: string,
  interval: CandleInterval,
  candles: Candle[],
  params: Record<string, number>,
  startEquity = 10_000,
  cfg: ValidationConfig = {},
): Promise<ValidationResult> {
  const isRatio = cfg.isRatio ?? 0.7;
  const numTrials = cfg.numTrials ?? 1;
  const mcRuns = cfg.mcRuns ?? 500;
  const trainBars = cfg.walkForwardTrain ?? Math.floor(candles.length * 0.5);
  const testBars = cfg.walkForwardTest ?? Math.floor(candles.length * 0.1);
  const exitPolicy = cfg.exitPolicy ?? LIVE_EXIT_POLICY;
  const warnings: string[] = [];

  const [isCandles, oosCandles] = splitChronological(candles, isRatio);

  const isResult = await backtestSlice(
    strategy, symbol, interval, isCandles, params, startEquity, `val:is:${symbol}:${interval}`, exitPolicy,
  );
  const oosResult = await backtestSlice(
    strategy, symbol, interval, oosCandles, params, startEquity, `val:oos:${symbol}:${interval}`, exitPolicy,
  );

  const isMetrics = computeExtendedMetrics(isResult, numTrials);
  const oosMetrics = computeExtendedMetrics(oosResult, numTrials);

  const wf = await walkForward(
    strategy, symbol, interval, candles, params, trainBars, testBars, startEquity, exitPolicy,
  );
  const mc = monteCarlo(isResult.trades, startEquity, mcRuns);

  // A validation with almost no trades is not a validation. Say so loudly rather
  // than returning a clean-looking result.
  if (oosResult.numTrades === 0) {
    warnings.push("Out-of-sample produced ZERO trades — this result validates nothing.");
  } else if (oosResult.numTrades < 10) {
    warnings.push(
      `Only ${oosResult.numTrades} out-of-sample trades — win rate and expectancy are not statistically meaningful (need >=10, ideally >=30).`,
    );
  }
  if (isResult.numTrades < 10) {
    warnings.push(`Only ${isResult.numTrades} in-sample trades — parameters are fit on very little evidence.`);
  }
  if (oosResult.totalReturnPct < oosResult.buyHoldReturnPct) {
    warnings.push(
      `Out-of-sample UNDERPERFORMED buy & hold (${oosResult.totalReturnPct.toFixed(2)}% vs ${oosResult.buyHoldReturnPct.toFixed(2)}%) — the strategy added risk without adding return.`,
    );
  }

  return {
    inSample: { ...isResult, metrics: isMetrics },
    outOfSample: { ...oosResult, metrics: oosMetrics },
    walkForward: wf,
    monteCarlo: mc,
    // Reuse the metrics-computed DSR: it needs the per-observation Sharpe and the
    // observation count, which computeExtendedMetrics already has. Passing the
    // ANNUALISED sharpe here (as this used to) mixes units and inflates the result.
    deflatedSharpe: isMetrics.deflatedSharpe,
    pbo: estimatePbo([isResult.totalReturnPct], [oosResult.totalReturnPct]),
    warnings,
  };
}
