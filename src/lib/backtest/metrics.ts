import type { Trade, BacktestResult } from "../backtest";

export interface ExtendedMetrics {
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  /** Probability in [0,1] that the true Sharpe is > 0, discounted for best-of-N selection. */
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

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation). */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Expected maximum Sharpe produced by pure luck across `numTrials` independent
 * trials, in units of the Sharpe estimator's standard error.
 * Bailey & López de Prado: (1-γ)·Z⁻¹(1 - 1/N) + γ·Z⁻¹(1 - 1/(N·e)).
 */
export function expectedMaxSharpeZ(numTrials: number): number {
  if (numTrials <= 1) return 0;
  const euler = 0.5772156649015329;
  return (1 - euler) * normInv(1 - 1 / numTrials) + euler * normInv(1 - 1 / (numTrials * Math.E));
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado): the probability in [0,1] that
 * the true Sharpe is positive, after discounting the best-of-N selection effect.
 *
 * `sharpe` must be the PER-OBSERVATION Sharpe (not annualised) and `numObs` the
 * number of return observations, or the units do not cancel.
 *
 * This MUST decrease as `numTrials` grows — trying more configurations makes any
 * given winner less credible. The previous implementation did the opposite: its
 * penalty shrank as 1/sqrt(N) while the signal term grew, so a 10,000-config grid
 * search reported a DSR approaching the raw Sharpe. That made overfitting look
 * like skill, which is exactly backwards for picking a real-money config.
 */
export function deflatedSharpe(
  sharpe: number,
  numTrials: number,
  numObs: number,
  skew = 0,
  kurt = 3,
): number {
  if (!Number.isFinite(sharpe) || numObs < 3) return 0;
  // Standard error of the Sharpe estimator under non-normal returns.
  const varTerm = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe;
  const sigmaSr = Math.sqrt(Math.max(varTerm, 1e-12) / (numObs - 1));
  if (!(sigmaSr > 0)) return 0;
  // Sharpe the best of N random trials would reach by luck.
  const sr0 = sigmaSr * expectedMaxSharpeZ(Math.max(1, numTrials));
  return normCdf((sharpe - sr0) / sigmaSr);
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
  const sharpePerObs = std(returns) > 0 ? mean(returns) / std(returns) : 0;
  const sharpe = sharpePerObs * annFactor;
  const sortino = downsideStd(returns) > 0 ? (mean(returns) / downsideStd(returns)) * annFactor : 0;

  // Actual higher moments of the return distribution — crypto returns are far
  // from normal, and the DSR standard error correction depends on them.
  const rMean = mean(returns);
  const rStd = std(returns);
  let skew = 0;
  let kurt = 3;
  if (rStd > 0 && returns.length >= 4) {
    const n = returns.length;
    skew = returns.reduce((s, x) => s + ((x - rMean) / rStd) ** 3, 0) / n;
    kurt = returns.reduce((s, x) => s + ((x - rMean) / rStd) ** 4, 0) / n;
  }

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
    deflatedSharpe: deflatedSharpe(sharpePerObs, numTrials, returns.length, skew, kurt),
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
