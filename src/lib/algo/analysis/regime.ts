import type { Candle, Regime } from "../types";
import { adx, atr, bollinger, ema, last, slope } from "../indicators/index";
import { clamp, percentile } from "../util/math";

/**
 * Market-regime classification.
 *
 * The strategy weights its components differently depending on regime: trend
 * components matter in a trend, mean-reversion and structure matter in a range,
 * and position sizing is cut when volatility spikes.
 */
export function classifyRegime(candles: Candle[]): Regime {
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1) ?? 0;

  const adxResult = adx(candles, 14);
  const adxValue = last(adxResult.adx, 0);
  const plusDi = last(adxResult.plusDi, 0);
  const minusDi = last(adxResult.minusDi, 0);

  const atrValues = atr(candles, 14);
  const atrValue = last(atrValues, 0);
  const atrPct = price > 0 ? atrValue / price : 0;

  // Compare current volatility with its own recent distribution: "volatile" is
  // relative to the symbol, not an absolute percentage.
  const recentAtrPct = atrValues
    .slice(-120)
    .map((a, i) => {
      const c = candles[candles.length - Math.min(120, atrValues.length) + i];
      return Number.isFinite(a) && c && c.close > 0 ? a / c.close : NaN;
    })
    .filter((v) => Number.isFinite(v));
  const highVolThreshold = percentile(recentAtrPct, 0.85);
  const isVolatile =
    recentAtrPct.length > 20 && highVolThreshold > 0 && atrPct > highVolThreshold;

  const emaFast = ema(closes, 21);
  const emaSlow = ema(closes, 55);
  const trendUp = last(emaFast, 0) > last(emaSlow, 0);
  const priceSlope = slope(closes, 30);

  const bb = bollinger(closes, 20, 2);
  const width = last(bb.width, 0);
  const widthHistory = bb.width.slice(-120).filter((v) => Number.isFinite(v));
  const squeeze =
    widthHistory.length > 20 && width < percentile(widthHistory, 0.25);

  // ADX ≥ 25 is the conventional trend threshold; 20 is the grey zone.
  const trending = adxValue >= 22 && Math.abs(priceSlope) > 0.0002;

  let kind: Regime["kind"];
  let strength: number;

  if (isVolatile && adxValue < 25) {
    kind = "volatile";
    strength = clamp(atrPct / Math.max(highVolThreshold, 1e-9) - 1, 0, 1);
  } else if (trending && (trendUp || plusDi > minusDi)) {
    kind = "trending_up";
    strength = clamp((adxValue - 20) / 30, 0, 1);
  } else if (trending && (!trendUp || minusDi > plusDi)) {
    kind = "trending_down";
    strength = clamp((adxValue - 20) / 30, 0, 1);
  } else {
    kind = "ranging";
    strength = clamp(1 - adxValue / 25, 0, 1) * (squeeze ? 1 : 0.8);
  }

  // A trending classification that disagrees with DI direction is weak.
  if (kind === "trending_up" && minusDi > plusDi) strength *= 0.5;
  if (kind === "trending_down" && plusDi > minusDi) strength *= 0.5;

  return { kind, strength: clamp(strength, 0, 1), adx: adxValue, atrPct };
}

/** Multiplier applied to a component's weight given the current regime. */
export function regimeWeight(
  regime: Regime,
  component: "trend" | "momentum" | "meanReversion" | "structure" | "volume",
): number {
  switch (regime.kind) {
    case "trending_up":
    case "trending_down":
      return {
        trend: 1.3,
        momentum: 1.15,
        meanReversion: 0.5,
        structure: 1.0,
        volume: 1.0,
      }[component];
    case "ranging":
      return {
        trend: 0.6,
        momentum: 0.8,
        meanReversion: 1.4,
        structure: 1.25,
        volume: 0.9,
      }[component];
    case "volatile":
      return {
        trend: 0.8,
        momentum: 0.7,
        meanReversion: 0.6,
        structure: 1.1,
        volume: 1.2,
      }[component];
  }
}
