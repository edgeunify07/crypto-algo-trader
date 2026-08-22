import type { Trade, BacktestResult } from "../backtest";

export interface ExtendedMetrics {
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  deflatedSharpe: number;
  alpha: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownDuration: number;
  longestLosingStreak: number;
  exposurePct: number;
  costPctOfGross: number;
  monthlyReturns: Record<string, number>;
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function downsideStd(arr: number[]): number {
  const neg = arr.filter((x) => x < 0);
  return std(neg.length ? neg : [0]);
}

/** Bailey & López de Prado deflated Sharpe (simplified). */
export function deflatedSharpe(sharpe: number, numTrials: number, skew = 0, kurt = 3): number {
  if (numTrials <= 1) return sharpe;
  const euler = 0.5772156649;
  const z = sharpe * Math.sqrt(numTrials - 1);
  const penalty = Math.sqrt(2 * Math.log(numTrials)) - (euler + Math.log(Math.log(numTrials))) / (2 * Math.sqrt(2 * Math.log(numTrials)));
  return (z - penalty) / Math.sqrt(numTrials);
}

export function computeExtendedMetrics(
  result: BacktestResult,
  numTrials = 1,
): ExtendedMetrics {
  const curve = result.equityCurve;
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev > 0) returns.push((curve[i].equity - prev) / prev);
  }

  const trades = result.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  const annFactor = Math.sqrt(365 * 24); // hourly-ish scaling fallback
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annFactor : 0;
  const sortino = downsideStd(returns) > 0 ? (mean(returns) / downsideStd(returns)) * annFactor : 0;

  const years =
    curve.length > 1 ? (curve[curve.length - 1].time - curve[0].time) / (365.25 * 86400) : 0;
  const cagr =
    years > 0 && result.startEquity > 0
      ? (Math.pow(result.endEquity / result.startEquity, 1 / years) - 1) * 100
      : result.totalReturnPct;

  const calmar = result.maxDrawdownPct > 0 ? cagr / result.maxDrawdownPct : 0;
  const alpha = result.totalReturnPct - result.buyHoldReturnPct;

  let maxDdDur = 0;
  let ddStart = 0;
  let peak = curve[0]?.equity ?? 0;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].equity >= peak) {
      if (ddStart > 0) maxDdDur = Math.max(maxDdDur, curve[i].time - ddStart);
      peak = curve[i].equity;
      ddStart = 0;
    } else if (ddStart === 0) ddStart = curve[i].time;
  }

  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  }

  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalCosts = result.totalFeesPaid + result.totalSlippagePaid + result.totalTdsPaid;

  const monthlyReturns: Record<string, number> = {};
  for (let i = 1; i < curve.length; i++) {
    const d = new Date(curve[i].time * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const prev = curve[i - 1].equity;
    if (prev > 0) monthlyReturns[key] = (monthlyReturns[key] ?? 0) + (curve[i].equity - prev) / prev;
  }

  const barsInMarket = trades.reduce((s, t) => s + (t.exitBar - t.entryBar), 0);

  return {
    cagr,
    sharpe,
    sortino,
    calmar,
    deflatedSharpe: deflatedSharpe(sharpe, numTrials),
    alpha,
    profitFactor: result.profitFactor,
    expectancy: result.expectancy,
    avgWin,
    avgLoss,
    maxDrawdownDuration: maxDdDur,
    longestLosingStreak: maxStreak,
    exposurePct: curve.length ? (barsInMarket / curve.length) * 100 : 0,
    costPctOfGross: grossPnl > 0 ? (totalCosts / grossPnl) * 100 : 0,
    monthlyReturns,
  };
}

export function breakEvenEdgePerTrade(feeRate: number, slippageRate: number, tradesPerDay: number): number {
  const roundTrip = 2 * (feeRate + slippageRate);
  return (roundTrip * tradesPerDay) / Math.max(tradesPerDay, 1);
}
