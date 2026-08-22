import type { Candle } from "../types";
import { atr, atrAtBar } from "./adx";
import { closes, highs, lows, sma, volumes } from "./common";

export type StructureState = "uptrend" | "downtrend" | "neutral";

export interface Pivot {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
}

/** Williams-style fractal pivots (2 bars each side by default). */
export function findPivots(candles: Candle[], lookback = 2): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= h || candles[i + j].high > h) isHigh = false;
      if (candles[i - j].low <= l || candles[i + j].low < l) isLow = false;
    }
    if (isHigh) pivots.push({ index: i, time: candles[i].time, price: h, type: "high" });
    if (isLow) pivots.push({ index: i, time: candles[i].time, price: l, type: "low" });
  }
  return pivots;
}

export function structureState(pivots: Pivot[], upToIndex: number): StructureState {
  const recent = pivots.filter((p) => p.index <= upToIndex).slice(-6);
  const highs = recent.filter((p) => p.type === "high");
  const lows = recent.filter((p) => p.type === "low");
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) return "uptrend";
    if (lh && ll) return "downtrend";
  }
  return "neutral";
}

export interface SrZone {
  low: number;
  high: number;
  strength: number;
  touches: number;
}

/** Cluster pivot levels into S/R zones (max 3 active). */
export function clusterZones(pivots: Pivot[], atrVal: number, maxZones = 3): SrZone[] {
  if (pivots.length === 0 || atrVal <= 0) return [];
  const width = atrVal * 0.5;
  const levels = pivots.map((p) => p.price).sort((a, b) => a - b);
  const zones: SrZone[] = [];
  let cluster: number[] = [levels[0]];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - cluster[cluster.length - 1] <= width) cluster.push(levels[i]);
    else {
      const mid = cluster.reduce((a, b) => a + b, 0) / cluster.length;
      zones.push({ low: mid - width / 2, high: mid + width / 2, strength: cluster.length, touches: cluster.length });
      cluster = [levels[i]];
    }
  }
  const mid = cluster.reduce((a, b) => a + b, 0) / cluster.length;
  zones.push({ low: mid - width / 2, high: mid + width / 2, strength: cluster.length, touches: cluster.length });
  return zones.sort((a, b) => b.strength - a.strength).slice(0, maxZones);
}

export function donchianHigh(candles: Candle[], period: number, index: number): number {
  const start = Math.max(0, index - period + 1);
  let m = -Infinity;
  for (let i = start; i <= index; i++) m = Math.max(m, candles[i].high);
  return m;
}

export function donchianLow(candles: Candle[], period: number, index: number): number {
  const start = Math.max(0, index - period + 1);
  let m = Infinity;
  for (let i = start; i <= index; i++) m = Math.min(m, candles[i].low);
  return m;
}

export function rvol(candles: Candle[], index: number, period = 20): number {
  const vols = volumes(candles, index);
  const ma = sma(vols, period);
  if (!ma.length) return 1;
  const v = candles[index].volume;
  const baseline = ma[ma.length - 1];
  return baseline > 0 ? v / baseline : 1;
}

export function isBullishEngulfing(candles: Candle[], index: number): boolean {
  if (index < 1) return false;
  const prev = candles[index - 1];
  const cur = candles[index];
  return prev.close < prev.open && cur.close > cur.open && cur.open <= prev.close && cur.close >= prev.open;
}

export function breakoutConfirmed(
  candles: Candle[],
  index: number,
  level: number,
  direction: "long" | "short",
  atrVal: number,
  minRvol = 1.5,
): boolean {
  const c = candles[index];
  const dist = direction === "long" ? c.close - level : level - c.close;
  if (dist < 0.5 * atrVal) return false;
  if (direction === "long" ? c.close <= level : c.close >= level) return false;
  return rvol(candles, index) >= minRvol;
}

export function nearSupport(price: number, zones: SrZone[]): boolean {
  return zones.some((z) => price >= z.low && price <= z.high);
}

export function atrForBar(candles: Candle[], index: number, period = 14): number {
  const series = atr(highs(candles, index), lows(candles, index), closes(candles, index), period);
  return atrAtBar(series, index, period) ?? 0;
}
