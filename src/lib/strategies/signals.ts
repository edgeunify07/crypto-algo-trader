import type { Candle } from "../types";
import { sma, ema, closes } from "../indicators/common";

/** Detect fresh bullish SMA cross (fast crossed above slow this bar). */
export function smaBullCross(candles: Candle[], index: number, fast: number, slow: number): boolean {
  if (index < slow + 1) return false;
  const c = closes(candles, index);
  const f = sma(c, fast);
  const s = sma(c, slow);
  if (f.length < 2 || s.length < 2) return false;
  const fNow = f[f.length - 1];
  const fPrev = f[f.length - 2];
  const sNow = s[s.length - 1];
  const sPrev = s[s.length - 2];
  return fPrev <= sPrev && fNow > sNow;
}

/** Detect fresh bearish SMA cross — exit signal. */
export function smaBearCross(candles: Candle[], index: number, fast: number, slow: number): boolean {
  if (index < slow + 1) return false;
  const c = closes(candles, index);
  const f = sma(c, fast);
  const s = sma(c, slow);
  if (f.length < 2 || s.length < 2) return false;
  const fNow = f[f.length - 1];
  const fPrev = f[f.length - 2];
  const sNow = s[s.length - 1];
  const sPrev = s[s.length - 2];
  return fPrev >= sPrev && fNow < sNow;
}

/** EMA stack bullish: fast > slow and price > fast. */
export function emaBullStack(candles: Candle[], index: number, fast: number, slow: number): boolean {
  const c = closes(candles, index);
  const ef = ema(c, fast);
  const es = ema(c, slow);
  if (!ef.length || !es.length) return false;
  return ef[ef.length - 1] > es[es.length - 1] && c[c.length - 1] > ef[ef.length - 1];
}

/** Strong bullish close: close in top 25% of bar range with volume. */
export function strongBullClose(candles: Candle[], index: number): boolean {
  const bar = candles[index];
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  const closePos = (bar.close - bar.low) / range;
  return closePos >= 0.75 && bar.close > bar.open;
}
