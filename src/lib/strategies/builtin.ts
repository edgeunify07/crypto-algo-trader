import { SMA, RSI, EMA } from "technicalindicators";
import type { Strategy } from "./types";
import { closes } from "./types";

/**
 * Built-in strategy library. Each is a pure, bar-by-bar decision function.
 * Add your own by pushing another object into STRATEGIES (or via the same
 * `Strategy` interface elsewhere) — the backtester and live engine pick it up
 * automatically.
 */

const smaCrossover: Strategy = {
  id: "sma-crossover",
  name: "SMA Crossover",
  description:
    "Go long when the fast simple moving average crosses above the slow one; exit when it crosses back below. Classic trend-following.",
  params: { fast: 9, slow: 21 },
  next(ctx, params) {
    const { candles, index } = ctx;
    const fast = Math.max(2, Math.floor(params.fast));
    const slow = Math.max(fast + 1, Math.floor(params.slow));
    if (index < slow) return "hold";
    const series = closes(candles, index);
    const f = SMA.calculate({ period: fast, values: series });
    const s = SMA.calculate({ period: slow, values: series });
    const fPrev = f[f.length - 2];
    const fNow = f[f.length - 1];
    const sPrev = s[s.length - 2];
    const sNow = s[s.length - 1];
    if (fPrev <= sPrev && fNow > sNow) return "buy";
    if (fPrev >= sPrev && fNow < sNow) return "sell";
    return "hold";
  },
};

const rsiReversion: Strategy = {
  id: "rsi-reversion",
  name: "RSI Mean Reversion",
  description:
    "Buy when RSI drops below the oversold threshold, sell when it climbs above overbought. Counter-trend / range strategy.",
  params: { period: 14, oversold: 30, overbought: 70 },
  next(ctx, params) {
    const { candles, index } = ctx;
    const period = Math.max(2, Math.floor(params.period));
    if (index < period + 1) return "hold";
    const series = closes(candles, index);
    const rsi = RSI.calculate({ period, values: series });
    const now = rsi[rsi.length - 1];
    if (now == null) return "hold";
    if (now < params.oversold) return "buy";
    if (now > params.overbought) return "sell";
    return "hold";
  },
};

const emaMomentum: Strategy = {
  id: "ema-momentum",
  name: "EMA Momentum",
  description:
    "Stay long while price holds above a rising EMA; exit when price closes below it. Simple momentum filter.",
  params: { period: 34 },
  next(ctx, params) {
    const { candles, index } = ctx;
    const period = Math.max(2, Math.floor(params.period));
    if (index < period + 1) return "hold";
    const series = closes(candles, index);
    const ema = EMA.calculate({ period, values: series });
    const emaNow = ema[ema.length - 1];
    const price = series[series.length - 1];
    if (price > emaNow && ctx.position === "flat") return "buy";
    if (price < emaNow && ctx.position === "long") return "sell";
    return "hold";
  },
};

export const STRATEGIES: Strategy[] = [smaCrossover, rsiReversion, emaMomentum];

export function getStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}
