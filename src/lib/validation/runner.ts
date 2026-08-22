import { backtest, BINANCE_SPOT_COSTS, type BacktestResult } from "../backtest";
import { computeExtendedMetrics, deflatedSharpe } from "../backtest/metrics";
import type { Strategy } from "../strategies/types";
import type { Candle } from "../types";

export interface ValidationConfig {
  isRatio?: number;
  numTrials?: number;
  mcRuns?: number;
  walkForwardTrain?: number;
  walkForwardTest?: number;
}

export interface ValidationResult {
  inSample: BacktestResult & { metrics: ReturnType<typeof computeExtendedMetrics> };
  outOfSample: BacktestResult & { metrics: ReturnType<typeof computeExtendedMetrics> };
  walkForward: { windows: number; oosReturnPct: number; oosSharpe: number };
  monteCarlo: { runs: number; medianMaxDd: number; p95MaxDd: number; medianEquity: number };
  deflatedSharpe: number;
  pbo: number;
}

function splitChronological(candles: Candle[], isRatio: number): [Candle[], Candle[]] {
  const cut = Math.floor(candles.length * isRatio);
  return [candles.slice(0, cut), candles.slice(cut)];
}

/** Monte Carlo: shuffle trade PnLs to estimate drawdown distribution. */
function monteCarlo(trades: { pnl: number }[], startEquity: number, runs: number) {
  const maxDds: number[] = [];
  const finalEquities: number[] = [];
  for (let r = 0; r < runs; r++) {
    const shuffled = [...trades].sort(() => Math.random() - 0.5);
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
  const mid = Math.floor(runs / 2);
  const p95 = Math.floor(runs * 0.95);
  return {
    runs,
    medianMaxDd: maxDds[mid] ?? 0,
    p95MaxDd: maxDds[p95] ?? maxDds[maxDds.length - 1] ?? 0,
    medianEquity: finalEquities[mid] ?? startEquity,
  };
}

/** Simplified walk-forward: rolling train/test windows. */
function walkForward(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  trainBars: number,
  testBars: number,
  startEquity: number,
): { windows: number; oosReturnPct: number; oosSharpe: number } {
  let oosEquity = startEquity;
  const oosReturns: number[] = [];
  let windows = 0;
  for (let start = 0; start + trainBars + testBars <= candles.length; start += testBars) {
    const testSlice = candles.slice(start + trainBars, start + trainBars + testBars);
    const r = backtest(strategy, testSlice, params, oosEquity, BINANCE_SPOT_COSTS);
    const ret = r.totalReturnPct / 100;
    oosReturns.push(ret);
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

/** Simplified PBO: fraction of random splits where OOS underperforms median. */
function estimatePbo(isResults: number[], oosResults: number[]): number {
  if (!oosResults.length) return 0;
  const median = [...isResults].sort((a, b) => a - b)[Math.floor(isResults.length / 2)] ?? 0;
  const under = oosResults.filter((r) => r < median).length;
  return under / oosResults.length;
}

export function runValidation(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  startEquity = 10_000,
  cfg: ValidationConfig = {},
): ValidationResult {
  const isRatio = cfg.isRatio ?? 0.7;
  const numTrials = cfg.numTrials ?? 1;
  const mcRuns = cfg.mcRuns ?? 500;
  const trainBars = cfg.walkForwardTrain ?? Math.floor(candles.length * 0.5);
  const testBars = cfg.walkForwardTest ?? Math.floor(candles.length * 0.1);

  const [isCandles, oosCandles] = splitChronological(candles, isRatio);
  const isResult = backtest(strategy, isCandles, params, startEquity, BINANCE_SPOT_COSTS);
  const oosResult = backtest(strategy, oosCandles, params, startEquity, BINANCE_SPOT_COSTS);

  const isMetrics = computeExtendedMetrics(isResult, numTrials);
  const oosMetrics = computeExtendedMetrics(oosResult, numTrials);

  const wf = walkForward(strategy, candles, params, trainBars, testBars, startEquity);
  const mc = monteCarlo(isResult.trades, startEquity, mcRuns);

  return {
    inSample: { ...isResult, metrics: isMetrics },
    outOfSample: { ...oosResult, metrics: oosMetrics },
    walkForward: wf,
    monteCarlo: mc,
    deflatedSharpe: deflatedSharpe(isMetrics.sharpe, numTrials),
    pbo: estimatePbo([isResult.totalReturnPct], [oosResult.totalReturnPct]),
  };
}
