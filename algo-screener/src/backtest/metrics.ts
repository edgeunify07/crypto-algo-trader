import type { AccountSnapshot, ClosedTrade, Timeframe } from "../types.js";
import { mean, stdev } from "../util/math.js";

export interface PerformanceMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalReturn: number;
  /** Annualised, risk-free rate assumed zero. */
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  profitFactor: number;
  /** Mean R multiple per trade. */
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldHours: number;
  feesPaid: number;
  /** Equity at the end of the run. */
  finalEquity: number;
  /** Return / max drawdown — the headline risk-adjusted number. */
  calmar: number;
  /** Longest run of consecutive losers. */
  maxConsecutiveLosses: number;
}

export const EMPTY_METRICS: PerformanceMetrics = {
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalPnl: 0,
  totalReturn: 0,
  sharpe: 0,
  sortino: 0,
  maxDrawdown: 0,
  profitFactor: 0,
  expectancy: 0,
  avgWin: 0,
  avgLoss: 0,
  largestWin: 0,
  largestLoss: 0,
  avgHoldHours: 0,
  feesPaid: 0,
  finalEquity: 0,
  calmar: 0,
  maxConsecutiveLosses: 0,
};

/** Periods per year, inferred from the equity-curve sampling interval. */
function annualisationFactor(curve: readonly AccountSnapshot[]): number {
  if (curve.length < 3) return 1;
  const first = curve[0] as AccountSnapshot;
  const last = curve[curve.length - 1] as AccountSnapshot;
  const span = last.time - first.time;
  if (span <= 0) return 1;
  const periodMs = span / (curve.length - 1);
  const periodsPerYear = (365 * 24 * 3600 * 1000) / periodMs;
  return Math.sqrt(Math.max(1, periodsPerYear));
}

export function computeMetrics(
  trades: readonly ClosedTrade[],
  curve: readonly AccountSnapshot[],
  startingEquity: number,
): PerformanceMetrics {
  if (trades.length === 0 && curve.length === 0) {
    return { ...EMPTY_METRICS, finalEquity: startingEquity };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);

  const finalEquity =
    curve.length > 0
      ? (curve[curve.length - 1] as AccountSnapshot).equity
      : startingEquity + totalPnl;

  // Period returns from the equity curve.
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = (curve[i - 1] as AccountSnapshot).equity;
    const cur = (curve[i] as AccountSnapshot).equity;
    if (prev > 0) returns.push((cur - prev) / prev);
  }

  const meanReturn = mean(returns);
  const volatility = stdev(returns);
  const downside = stdev(returns.filter((r) => r < 0));
  const factor = annualisationFactor(curve);

  // Max drawdown over the equity curve.
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const snap of curve) {
    peak = Math.max(peak, snap.equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - snap.equity) / peak);
    }
  }

  let consecutive = 0;
  let maxConsecutive = 0;
  for (const trade of trades) {
    if (trade.pnl <= 0) {
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }

  const totalReturn = startingEquity > 0 ? (finalEquity - startingEquity) / startingEquity : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    totalPnl,
    totalReturn,
    sharpe: volatility === 0 ? 0 : (meanReturn / volatility) * factor,
    sortino: downside === 0 ? 0 : (meanReturn / downside) * factor,
    maxDrawdown,
    // An all-winning run has no finite profit factor; report the gross profit
    // scale instead of Infinity so downstream scoring stays numeric.
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 10 : 0) : grossProfit / grossLoss,
    expectancy: trades.length === 0 ? 0 : mean(trades.map((t) => t.rMultiple)),
    avgWin: wins.length === 0 ? 0 : mean(wins.map((t) => t.pnl)),
    avgLoss: losses.length === 0 ? 0 : mean(losses.map((t) => t.pnl)),
    largestWin: wins.length === 0 ? 0 : Math.max(...wins.map((t) => t.pnl)),
    largestLoss: losses.length === 0 ? 0 : Math.min(...losses.map((t) => t.pnl)),
    avgHoldHours:
      trades.length === 0
        ? 0
        : mean(trades.map((t) => (t.closedAt - t.openedAt) / 3_600_000)),
    feesPaid: trades.reduce((a, t) => a + t.fees, 0),
    finalEquity,
    calmar: maxDrawdown === 0 ? (totalReturn > 0 ? 10 : 0) : totalReturn / maxDrawdown,
    maxConsecutiveLosses: maxConsecutive,
  };
}

/**
 * Single number used to rank candidate parameter sets.
 *
 * It deliberately blends risk-adjusted return with drawdown and trade count:
 * optimising raw return alone reliably produces over-fitted, 3-trade strategies
 * that fall apart out of sample.
 */
export function fitnessScore(
  metrics: PerformanceMetrics,
  minTrades: number,
): number {
  if (metrics.trades < minTrades) {
    // Heavily penalised but not zeroed, so the LLM can still see the gradient.
    return metrics.totalReturn * 0.1 - 1;
  }

  const sharpeTerm = Math.tanh(metrics.sharpe / 2) * 1.0;
  const calmarTerm = Math.tanh(metrics.calmar / 3) * 0.8;
  const expectancyTerm = Math.tanh(metrics.expectancy) * 0.6;
  const profitFactorTerm = Math.tanh((metrics.profitFactor - 1) / 1.5) * 0.6;
  const drawdownPenalty = metrics.maxDrawdown * 1.5;
  // Reward having enough trades to be statistically meaningful, with
  // diminishing returns past ~100.
  const sampleBonus = Math.min(0.3, Math.log10(metrics.trades / minTrades + 1) * 0.3);

  return (
    sharpeTerm +
    calmarTerm +
    expectancyTerm +
    profitFactorTerm +
    sampleBonus -
    drawdownPenalty
  );
}

/** Break the trade list down by a key — used in the LLM performance report. */
export function groupMetrics<K extends string | number>(
  trades: readonly ClosedTrade[],
  keyOf: (trade: ClosedTrade) => K,
): Map<K, { trades: number; winRate: number; totalPnl: number; expectancy: number }> {
  const groups = new Map<K, ClosedTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const bucket = groups.get(key);
    if (bucket) bucket.push(trade);
    else groups.set(key, [trade]);
  }

  const out = new Map<
    K,
    { trades: number; winRate: number; totalPnl: number; expectancy: number }
  >();
  for (const [key, bucket] of groups) {
    const wins = bucket.filter((t) => t.pnl > 0).length;
    out.set(key, {
      trades: bucket.length,
      winRate: bucket.length === 0 ? 0 : wins / bucket.length,
      totalPnl: bucket.reduce((a, t) => a + t.pnl, 0),
      expectancy: mean(bucket.map((t) => t.rMultiple)),
    });
  }
  return out;
}

export function metricsByTimeframe(
  trades: readonly ClosedTrade[],
): Map<Timeframe, ReturnType<typeof groupMetrics> extends Map<infer _K, infer V> ? V : never> {
  return groupMetrics(trades, (t) => t.timeframe) as never;
}
