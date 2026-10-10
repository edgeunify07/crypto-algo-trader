import type { Candle } from "../types";
import { mean, stdev } from "../util/math";

/**
 * Indicator implementations return arrays aligned to the input series, with
 * `NaN` in the warm-up region. Keeping the alignment makes it safe to index by
 * bar position when combining indicators.
 */

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i] as number;
    if (i >= period) running -= values[i - period] as number;
    if (i >= period - 1) out[i] = running / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with an SMA so the first printed value isn't dominated by one bar.
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (used by RSI, ATR and ADX). */
export function wilderSmooth(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i] as number;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + (values[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const change = (values[i] as number) - (values[i - 1] as number);
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }
  const avgGain = wilderSmooth(gains.slice(1), period);
  const avgLoss = wilderSmooth(losses.slice(1), period);
  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i] as number;
    const l = avgLoss[i] as number;
    if (!Number.isFinite(g) || !Number.isFinite(l)) continue;
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as Candle;
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const prevClose = (candles[i - 1] as Candle).close;
    out[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  return wilderSmooth(trueRange(candles), period);
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) => {
    const f = fastEma[i] as number;
    const s = slowEma[i] as number;
    return Number.isFinite(f) && Number.isFinite(s) ? f - s : NaN;
  });
  const firstValid = line.findIndex((v) => Number.isFinite(v));
  const signal = new Array<number>(values.length).fill(NaN);
  if (firstValid >= 0) {
    const signalEma = ema(line.slice(firstValid), signalPeriod);
    for (let i = 0; i < signalEma.length; i++) {
      signal[firstValid + i] = signalEma[i] as number;
    }
  }
  const histogram = line.map((v, i) => {
    const s = signal[i] as number;
    return Number.isFinite(v) && Number.isFinite(s) ? v - s : NaN;
  });
  return { macd: line, signal, histogram };
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

export function adx(candles: Candle[], period = 14): AdxResult {
  const len = candles.length;
  const plusDm = new Array<number>(len).fill(0);
  const minusDm = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    const cur = candles[i] as Candle;
    const prev = candles[i - 1] as Candle;
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilderSmooth(trueRange(candles), period);
  const plus = wilderSmooth(plusDm, period);
  const minus = wilderSmooth(minusDm, period);

  const plusDi = new Array<number>(len).fill(NaN);
  const minusDi = new Array<number>(len).fill(NaN);
  const dx = new Array<number>(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    const t = tr[i] as number;
    const p = plus[i] as number;
    const m = minus[i] as number;
    if (!Number.isFinite(t) || t === 0 || !Number.isFinite(p) || !Number.isFinite(m)) {
      continue;
    }
    plusDi[i] = (100 * p) / t;
    minusDi[i] = (100 * m) / t;
    const sumDi = (plusDi[i] as number) + (minusDi[i] as number);
    dx[i] = sumDi === 0 ? 0 : (100 * Math.abs((plusDi[i] as number) - (minusDi[i] as number))) / sumDi;
  }

  // ADX is Wilder-smoothed DX, starting from the first valid DX value.
  const firstDx = dx.findIndex((v) => Number.isFinite(v));
  const adxOut = new Array<number>(len).fill(NaN);
  if (firstDx >= 0) {
    const smoothed = wilderSmooth(dx.slice(firstDx), period);
    for (let i = 0; i < smoothed.length; i++) adxOut[firstDx + i] = smoothed[i] as number;
  }
  return { adx: adxOut, plusDi, minusDi };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  /** (upper - lower) / middle — the squeeze detector. */
  width: number[];
}

export function bollinger(
  values: number[],
  period = 20,
  multiplier = 2,
): BollingerResult {
  const middle = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  const width = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const sd = stdev(window);
    const mid = middle[i] as number;
    if (!Number.isFinite(mid)) continue;
    upper[i] = mid + multiplier * sd;
    lower[i] = mid - multiplier * sd;
    width[i] = mid === 0 ? 0 : ((upper[i] as number) - (lower[i] as number)) / mid;
  }
  return { upper, middle, lower, width };
}

/** On-balance volume — confirms whether a move carries participation. */
export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i] as Candle;
    const prev = candles[i - 1] as Candle;
    const direction = cur.close > prev.close ? 1 : cur.close < prev.close ? -1 : 0;
    out[i] = (out[i - 1] as number) + direction * cur.volume;
  }
  return out;
}

/** Linear-regression slope of the last `period` values, normalised by price. */
export function slope(values: number[], period: number): number {
  const window = values.slice(-period).filter((v) => Number.isFinite(v));
  if (window.length < 2) return 0;
  const n = window.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(window);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * ((window[i] as number) - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  const raw = num / den;
  return yMean === 0 ? 0 : raw / yMean;
}

/** Last finite value of an indicator array, or `fallback`. */
export function last(values: number[], fallback = NaN): number {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i] as number;
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/** Value `offset` bars back from the end. */
export function at(values: number[], offset: number): number {
  const idx = values.length - 1 - offset;
  if (idx < 0) return NaN;
  return values[idx] as number;
}
