import type { Candle, Pivot } from "../types.js";
import { atr } from "./index.js";

/**
 * ZigZag swing detection.
 *
 * A new pivot is confirmed once price reverses by at least `threshold` from the
 * running extreme. The threshold is expressed in ATR multiples rather than a
 * fixed percentage so the same settings behave sensibly on BTC and on a
 * low-priced altcoin, and across 1m and 1w charts.
 *
 * Pivots are strictly alternating high/low and are only emitted once confirmed,
 * so the series never repaints for anything except the final (provisional)
 * pivot, which `confirmedOnly` can drop.
 */
export function findPivots(
  candles: Candle[],
  options: {
    /** Reversal size in ATR multiples. */
    atrMultiple?: number;
    atrPeriod?: number;
    /** Floor on the reversal size as a fraction of price. */
    minPctMove?: number;
    /** Drop the trailing provisional pivot. */
    confirmedOnly?: boolean;
  } = {},
): Pivot[] {
  const {
    atrMultiple = 2,
    atrPeriod = 14,
    minPctMove = 0.005,
    confirmedOnly = false,
  } = options;

  if (candles.length < atrPeriod + 2) return [];

  const atrValues = atr(candles, atrPeriod);
  const pivots: Pivot[] = [];

  /** Reversal distance required at bar `i`, in price units. */
  const threshold = (i: number): number => {
    const a = atrValues[i] as number;
    const price = (candles[i] as Candle).close;
    const atrBased = Number.isFinite(a) ? a * atrMultiple : price * minPctMove;
    return Math.max(atrBased, price * minPctMove);
  };

  // Seed from the first bar; direction is unknown until the first reversal.
  let extremeIndex = 0;
  let extremePrice = (candles[0] as Candle).close;
  let direction: "up" | "down" | null = null;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i] as Candle;
    const limit = threshold(i);

    if (direction === "up") {
      if (candle.high >= extremePrice) {
        extremePrice = candle.high;
        extremeIndex = i;
      } else if (extremePrice - candle.low >= limit) {
        // Confirmed swing high at the running extreme.
        pivots.push({
          index: extremeIndex,
          time: (candles[extremeIndex] as Candle).openTime,
          price: extremePrice,
          type: "high",
        });
        direction = "down";
        extremePrice = candle.low;
        extremeIndex = i;
      }
    } else if (direction === "down") {
      if (candle.low <= extremePrice) {
        extremePrice = candle.low;
        extremeIndex = i;
      } else if (candle.high - extremePrice >= limit) {
        pivots.push({
          index: extremeIndex,
          time: (candles[extremeIndex] as Candle).openTime,
          price: extremePrice,
          type: "low",
        });
        direction = "up";
        extremePrice = candle.high;
        extremeIndex = i;
      }
    } else {
      // Establish the initial direction from the first qualifying move.
      if (candle.high - extremePrice >= limit) {
        pivots.push({
          index: extremeIndex,
          time: (candles[extremeIndex] as Candle).openTime,
          price: (candles[extremeIndex] as Candle).low,
          type: "low",
        });
        direction = "up";
        extremePrice = candle.high;
        extremeIndex = i;
      } else if (extremePrice - candle.low >= limit) {
        pivots.push({
          index: extremeIndex,
          time: (candles[extremeIndex] as Candle).openTime,
          price: (candles[extremeIndex] as Candle).high,
          type: "high",
        });
        direction = "down";
        extremePrice = candle.low;
        extremeIndex = i;
      }
    }
  }

  // Trailing provisional pivot at the running extreme.
  if (!confirmedOnly && direction !== null) {
    pivots.push({
      index: extremeIndex,
      time: (candles[extremeIndex] as Candle).openTime,
      price: extremePrice,
      type: direction === "up" ? "high" : "low",
    });
  }

  return pivots;
}

/**
 * Williams fractals — short-term swing points used for stop placement, where
 * ZigZag pivots are too coarse.
 */
export function findFractals(
  candles: Candle[],
  lookback = 2,
): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i] as Candle;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const other = candles[j] as Candle;
      if (other.high >= c.high) isHigh = false;
      if (other.low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: c.openTime, price: c.high, type: "high" });
    if (isLow) lows.push({ index: i, time: c.openTime, price: c.low, type: "low" });
  }
  return { highs, lows };
}

/**
 * Cluster nearby pivot prices into support/resistance levels. Levels touched
 * more often, and more recently, carry more weight.
 */
export function clusterLevels(
  pivots: Pivot[],
  currentPrice: number,
  tolerance = 0.005,
): { price: number; touches: number; weight: number; lastTouch: number }[] {
  if (pivots.length === 0) return [];
  const clusters: { prices: number[]; times: number[] }[] = [];

  for (const pivot of pivots) {
    const match = clusters.find((c) => {
      const avg = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
      return Math.abs(pivot.price - avg) / avg <= tolerance;
    });
    if (match) {
      match.prices.push(pivot.price);
      match.times.push(pivot.time);
    } else {
      clusters.push({ prices: [pivot.price], times: [pivot.time] });
    }
  }

  const newest = Math.max(...pivots.map((p) => p.time));
  const oldest = Math.min(...pivots.map((p) => p.time));
  const span = Math.max(1, newest - oldest);

  return clusters
    .map((c) => {
      const price = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
      const lastTouch = Math.max(...c.times);
      const recency = (lastTouch - oldest) / span;
      const touchWeight = Math.min(1, c.prices.length / 4);
      // Levels far from price are less actionable.
      const proximity =
        currentPrice > 0
          ? Math.max(0, 1 - Math.abs(price - currentPrice) / (currentPrice * 0.15))
          : 0;
      return {
        price,
        touches: c.prices.length,
        weight: Math.min(1, 0.5 * touchWeight + 0.25 * recency + 0.25 * proximity),
        lastTouch,
      };
    })
    .sort((a, b) => b.weight - a.weight);
}
