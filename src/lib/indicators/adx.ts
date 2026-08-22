import { wilderSmooth } from "./common";

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/** ADX(period) with +DI / -DI. Returns arrays aligned to bar index (starts at 2*period). */
export function adx(highs: number[], lows: number[], closes: number[], period = 14): AdxResult {
  const n = closes.length;
  if (n < period * 2) return { adx: [], plusDi: [], minusDi: [] };

  const tr: number[] = [highs[0] - lows[0]];
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];

  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }

  const atr = wilderSmooth(tr, period);
  const smoothPlus = wilderSmooth(plusDm, period);
  const smoothMinus = wilderSmooth(minusDm, period);

  const plusDi: number[] = [];
  const minusDi: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < atr.length; i++) {
    const pdi = atr[i] === 0 ? 0 : (100 * smoothPlus[i]) / atr[i];
    const mdi = atr[i] === 0 ? 0 : (100 * smoothMinus[i]) / atr[i];
    plusDi.push(pdi);
    minusDi.push(mdi);
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }

  const adxLine = wilderSmooth(dx, period);
  const offset = period - 1;

  return {
    adx: adxLine,
    plusDi: plusDi.slice(offset),
    minusDi: minusDi.slice(offset),
  };
}

export function adxAtBar(adxSeries: number[], barIndex: number, period: number): number | null {
  // adx series starts at bar 2*period - 1 approximately
  const startBar = 2 * period - 1;
  const idx = barIndex - startBar;
  if (idx < 0 || idx >= adxSeries.length) return null;
  return adxSeries[idx];
}

/** ATR(period) aligned to closes. */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return wilderSmooth(tr, period);
}

export function atrAtBar(atrSeries: number[], barIndex: number, period: number): number | null {
  const idx = barIndex - (period - 1);
  if (idx < 0 || idx >= atrSeries.length) return null;
  return atrSeries[idx];
}

export type Regime = "trending" | "ranging" | "transition";

export function regimeFromAdx(adxVal: number | null, trending = 25, ranging = 20): Regime {
  if (adxVal == null) return "transition";
  if (adxVal > trending) return "trending";
  if (adxVal < ranging) return "ranging";
  return "transition";
}
