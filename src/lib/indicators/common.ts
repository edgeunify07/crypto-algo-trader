import type { Candle } from "../types";

export function closes(candles: Candle[], end = candles.length - 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= end && i < candles.length; i++) out.push(candles[i].close);
  return out;
}

export function highs(candles: Candle[], end = candles.length - 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= end && i < candles.length; i++) out.push(candles[i].high);
  return out;
}

export function lows(candles: Candle[], end = candles.length - 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= end && i < candles.length; i++) out.push(candles[i].low);
  return out;
}

export function volumes(candles: Candle[], end = candles.length - 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= end && i < candles.length; i++) out.push(candles[i].volume);
  return out;
}

/** Wilder's smoothing: first value = SMA(period), then smooth. */
export function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out.push(s / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
