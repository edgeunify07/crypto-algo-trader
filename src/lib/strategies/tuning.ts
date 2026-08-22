/**
 * Grid-search tuner — maximize net return after fees with positive expectancy.
 * Run: npm run tune
 */
import { getHistoricalCandles } from "../data/historical";
import { DEFAULT_CONFLUENCE_PARAMS, DEFAULT_SCALP_PARAMS } from "./confluence";
import { defaultHtfFor } from "./registry";
import { prepareConfluenceStrategy } from "./confluenceStrategy";
import { backtestContextKey } from "../universe";
import { backtest, BINANCE_SPOT_COSTS } from "../backtest";
import { backtestScalp } from "../backtest/scalpEngine";
import { fetchAggTrades } from "../data/aggTrades";
import { confluenceSwing, confluenceScalp } from "./registry";
import type { BacktestResult } from "../backtest";

export interface TuneResult {
  params: Record<string, number>;
  score: number;
  totalReturnPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  numTrades: number;
  expectancy: number;
}

/** Prefer positive net return after fees, then WR / PF, with enough trades. */
function grade(r: BacktestResult): number {
  const trades = r.numTrades;
  if (trades < 4) return -200;
  if (r.expectancy <= 0) return -50 + r.totalReturnPct;
  const pf = r.profitFactor === Infinity ? 4 : Math.min(r.profitFactor, 4);
  const wr = r.winRate;
  const ddPenalty = r.maxDrawdownPct * 0.25;
  const feeDrag = r.totalFeesPaid / Math.max(r.startEquity, 1) * 100;
  return (
    r.totalReturnPct * 1.5 +
    wr * 0.15 +
    pf * 3 +
    r.expectancy * 8 -
    ddPenalty -
    feeDrag * 0.5 +
    (trades >= 6 && trades <= 30 ? 4 : 0)
  );
}

async function prepare(symbol: string, interval: "15m" | "1m", candles: Awaited<ReturnType<typeof getHistoricalCandles>>["candles"]) {
  const htf = defaultHtfFor(interval, interval === "1m");
  const { candles: htfCandles } = await getHistoricalCandles({
    symbol,
    interval: htf,
    startTime: candles[0]?.time,
    endTime: candles[candles.length - 1]?.time,
    useCache: true,
  });
  prepareConfluenceStrategy(backtestContextKey(symbol), candles, htfCandles, htf);
}

export async function tuneSwing(symbol = "BTCUSDT", startEquity = 100): Promise<TuneResult[]> {
  const { candles } = await getHistoricalCandles({ symbol, interval: "15m", limit: 1000, useCache: true });
  const ctxKey = backtestContextKey(symbol);
  await prepare(symbol, "15m", candles);

  const grid: Record<string, number>[] = [];
  for (const entryThreshold of [5, 6, 7, 8, 9]) {
    for (const minConfirmFactors of [2, 3]) {
      for (const minConfidence of [70, 80, 85]) {
        for (const [emaFast, emaSlow] of [[9, 21], [12, 26]] as const) {
          for (const minRvol of [1.0, 1.2, 1.4]) {
            for (const requireTrending of [0, 1]) {
              for (const allowRangingMr of [0, 1]) {
                grid.push({
                  ...DEFAULT_CONFLUENCE_PARAMS,
                  mode: 0,
                  entryThreshold,
                  minConfirmFactors,
                  minConfidence,
                  requireCoreFactors: 1,
                  requireTrending,
                  emaFast,
                  emaSlow,
                  smaFast: emaFast,
                  smaSlow: emaSlow,
                  minRvol,
                  allowRangingMr,
                  rmiBullTrend: 55,
                  rmiBearTrend: 45,
                });
              }
            }
          }
        }
      }
    }
  }

  const results: TuneResult[] = [];
  for (const params of grid) {
    const r = backtest(confluenceSwing, candles, params, startEquity, BINANCE_SPOT_COSTS, ctxKey);
    results.push({
      params,
      score: grade(r),
      totalReturnPct: r.totalReturnPct,
      winRate: r.winRate,
      profitFactor: r.profitFactor === Infinity ? 99 : r.profitFactor,
      maxDrawdownPct: r.maxDrawdownPct,
      numTrades: r.numTrades,
      expectancy: r.expectancy,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

export async function tuneScalp(symbol = "ETHUSDT", startEquity = 100): Promise<TuneResult[]> {
  const { candles } = await getHistoricalCandles({ symbol, interval: "1m", limit: 500, useCache: true });
  const ctxKey = backtestContextKey(symbol);
  await prepare(symbol, "1m", candles);

  let aggTrades: Awaited<ReturnType<typeof fetchAggTrades>> = [];
  try {
    aggTrades = await fetchAggTrades(symbol, candles[0].time * 1000, candles[candles.length - 1].time * 1000);
  } catch { /* kline fallback */ }

  const grid: Record<string, number>[] = [];
  for (const entryThreshold of [4, 5, 6, 7]) {
    for (const minConfirmFactors of [2, 3]) {
      for (const minRvol of [1.1, 1.3, 1.5]) {
        for (const [targetPct, stopPct] of [[0.0025, 0.0012], [0.003, 0.0015], [0.004, 0.002]] as const) {
          grid.push({
            ...DEFAULT_CONFLUENCE_PARAMS,
            ...DEFAULT_SCALP_PARAMS,
            mode: 1,
            entryThreshold,
            minConfirmFactors,
            minConfidence: 75,
            requireCoreFactors: 1,
            requireTrending: 0,
            minRvol,
            targetPct,
            stopPct,
          });
        }
      }
    }
  }

  const results: TuneResult[] = [];
  for (const params of grid) {
    const r = backtestScalp(confluenceScalp, candles, params, {
      startEquity,
      interval: "1m",
      aggTrades,
      klineOnly: aggTrades.length === 0,
      maxHoldBars: 12,
      contextKey: ctxKey,
    });
    results.push({
      params,
      score: grade(r),
      totalReturnPct: r.totalReturnPct,
      winRate: r.winRate,
      profitFactor: r.profitFactor === Infinity ? 99 : r.profitFactor,
      maxDrawdownPct: r.maxDrawdownPct,
      numTrades: r.numTrades,
      expectancy: r.expectancy,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}
