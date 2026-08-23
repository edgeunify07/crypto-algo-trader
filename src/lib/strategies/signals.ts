import type { Candle } from "../types";

/** Strong bullish close: close in top 25% of bar range with volume. */
export function strongBullClose(candles: Candle[], index: number): boolean {
  const bar = candles[index];
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const closePos = (bar.close - bar.low) / range;
  return closePos >= 0.75 && bar.close > bar.open;
}
