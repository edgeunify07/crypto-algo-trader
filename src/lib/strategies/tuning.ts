/**
 * Grid-search tuner — primary objective: win rate (≥80% preferred), then PF / expectancy.
 * Run: npm run tune
 */
import { getHistoricalCandles } from "../data/historical";
import { DEFAULT_CONFLUENCE_PARAMS, DEFAULT_SCALP_PARAMS } from "./confluence";
import { BACKTEST_KEY, defaultHtfFor } from "./registry";
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

/** Heavily weight win rate — user target 80–90%. */
function grade(r: BacktestResult): number {
  const trades = r.numTrades;
  if (trades < 3) return -200;
  const wr = r.winRate;
  const pf = r.profitFactor === Infinity ? 5 : Math.min(r.profitFactor, 5);
  const ddPenalty = r.maxDrawdownPct * 0.2;
  const wrScore =
    wr >= 90 ? 40 :
    wr >= 80 ? 32 :
    wr >= 70 ? 22 :
    wr >= 60 ? 12 :
    wr >= 50 ? 5 :
    wr * 0.05;
  const expBonus = r.expectancy > 0 ? 3 : -5;
  const tradeBonus = trades >= 5 && trades <= 25 ? 2 : trades > 40 ? -3 : 0;
  return wrScore + pf * 2 + r.totalReturnPct * 0.08 - ddPenalty + expBonus + tradeBonus;
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
  await prepare(symbol, "15m", candles);

  const grid: Record<string, number>[] = [];
  for (const entryThreshold of [8, 10, 12, 14]) {
    for (const minConfirmFactors of [3, 4, 5]) {
      for (const minConfidence of [85, 90, 95]) {
        for (const [emaFast, emaSlow] of [[12, 26], [9, 21]] as const) {
          for (const minRvol of [1.3, 1.5, 1.8]) {
            for (const requireTrending of [1]) {
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
                allowRangingMr: 0,
                rmiBullTrend: 58,
                rmiBearTrend: 42,
              });
            }
          }
        }
      }
    }
  }

  const results: TuneResult[] = [];
  for (const params of grid) {
    const r = backtest(confluenceSwing, candles, params, startEquity, BINANCE_SPOT_COSTS);
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
  return results.sort((a, b) => {
    if (Math.abs(b.winRate - a.winRate) > 0.5) return b.winRate - a.winRate;
    return b.score - a.score;
  });
}

export async function tuneScalp(symbol = "ETHUSDT", startEquity = 100): Promise<TuneResult[]> {
  const { candles } = await getHistoricalCandles({ symbol, interval: "1m", limit: 500, useCache: true });
  await prepare(symbol, "1m", candles);

  let aggTrades: Awaited<ReturnType<typeof fetchAggTrades>> = [];
  try {
    aggTrades = await fetchAggTrades(symbol, candles[0].time * 1000, candles[candles.length - 1].time * 1000);
  } catch { /* kline fallback */ }

  const grid: Record<string, number>[] = [];
  for (const entryThreshold of [6, 8, 10]) {
    for (const minConfirmFactors of [2, 3]) {
      for (const minRvol of [1.4, 1.6]) {
        for (const [targetPct, stopPct] of [[0.0018, 0.0012], [0.002, 0.0015], [0.0025, 0.0015]] as const) {
          grid.push({
            ...DEFAULT_CONFLUENCE_PARAMS,
            ...DEFAULT_SCALP_PARAMS,
            mode: 1,
            entryThreshold,
            minConfirmFactors,
            minConfidence: 90,
            requireCoreFactors: 1,
            requireTrending: 1,
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
  return results.sort((a, b) => {
    if (Math.abs(b.winRate - a.winRate) > 0.5) return b.winRate - a.winRate;
    return b.score - a.score;
  });
}
