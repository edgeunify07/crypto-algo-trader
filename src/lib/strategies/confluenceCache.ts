import type { Candle } from "../types";
import { closes, highs, lows, volumes, ema, sma } from "../indicators/common";
import { adx, atr } from "../indicators/adx";
import { rmi } from "../indicators/rmi";
import { findPivots, structureState, type Pivot, type StructureState } from "../indicators/structure";

/**
 * Per-candle-array memoization for the confluence engine.
 *
 * The engine used to recompute every indicator SERIES (ema/sma/rmi/adx/atr/rvol/
 * vwap) and re-run findPivots on `candles.slice(0, index+1)` for EVERY bar. Each
 * of those is O(index), so a full backtest was O(n^2) — a one-year scan took ~90s
 * and multi-year was infeasible.
 *
 * Every one of those indicators is *causal*: the value at bar `b` depends only on
 * bars `[0..b]`, and the recurrence seed (the SMA of the first `period` values) is
 * identical regardless of how much history follows. So computing each series ONCE
 * over the full array and reading it by absolute bar index yields bit-identical
 * values to the old "slice-and-recompute" path — at O(1) per read instead of O(n).
 *
 * The cache is keyed by the candle array's identity (WeakMap) and invalidated if
 * its length changes, so the live bot (which appends bars) stays correct.
 */

interface LtfCache {
  n: number;
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  ema: Map<number, Float64Array>;
  sma: Map<number, Float64Array>;
  rmi: Map<string, Float64Array>;
  adx: Map<number, Float64Array>;
  atrForBar: Map<number, Float64Array>;
  rvol: Map<number, Float64Array>;
  pivots: Map<number, Pivot[]>;
  cumPV: Float64Array | null;
  cumVol: Float64Array | null;
}

const store = new WeakMap<Candle[], LtfCache>();

function cacheFor(candles: Candle[]): LtfCache {
  const hit = store.get(candles);
  if (hit && hit.n === candles.length) return hit;
  const c: LtfCache = {
    n: candles.length,
    closes: closes(candles),
    highs: highs(candles),
    lows: lows(candles),
    volumes: volumes(candles),
    ema: new Map(),
    sma: new Map(),
    rmi: new Map(),
    adx: new Map(),
    atrForBar: new Map(),
    rvol: new Map(),
    pivots: new Map(),
    cumPV: null,
    cumVol: null,
  };
  store.set(candles, c);
  return c;
}

/** Place `series[i]` at absolute bar `firstBar + i`; bars before that stay NaN. */
function align(series: number[], firstBar: number, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < series.length; i++) {
    const b = firstBar + i;
    if (b >= 0 && b < n) out[b] = series[i];
  }
  return out;
}

function emaArr(cache: LtfCache, period: number): Float64Array {
  let s = cache.ema.get(period);
  if (!s) { s = align(ema(cache.closes, period), period - 1, cache.n); cache.ema.set(period, s); }
  return s;
}
function smaArr(cache: LtfCache, period: number): Float64Array {
  let s = cache.sma.get(period);
  if (!s) { s = align(sma(cache.closes, period), period - 1, cache.n); cache.sma.set(period, s); }
  return s;
}
function rmiArr(cache: LtfCache, length: number, momentum: number): Float64Array {
  const key = `${length}:${momentum}`;
  let s = cache.rmi.get(key);
  if (!s) {
    s = align(rmi(cache.closes, length, momentum), momentum + length - 1, cache.n);
    // Replicate rmi()'s off-by-one warmup guard exactly. rmi() bails with [] when
    // `closes.length < length + momentum + 1`, so the old per-bar path (which sliced
    // `closes(candles, index)`) could NOT surface the first computable value at bar
    // `momentum + length - 1` — at that bar the slice is one candle short. The
    // whole-array precompute *would* expose it, so null that single bar to match.
    const firstBar = momentum + length - 1;
    if (firstBar >= 0 && firstBar < cache.n) s[firstBar] = NaN;
    cache.rmi.set(key, s);
  }
  return s;
}
function adxArr(cache: LtfCache, period: number): Float64Array {
  let s = cache.adx.get(period);
  if (!s) { s = align(adx(cache.highs, cache.lows, cache.closes, period).adx, 2 * period - 1, cache.n); cache.adx.set(period, s); }
  return s;
}
function atrArr(cache: LtfCache, period: number): Float64Array {
  let s = cache.atrForBar.get(period);
  if (!s) { s = align(atr(cache.highs, cache.lows, cache.closes, period), period - 1, cache.n); cache.atrForBar.set(period, s); }
  return s;
}
function rvolArr(cache: LtfCache, period: number): Float64Array {
  let s = cache.rvol.get(period);
  if (!s) {
    const smaVol = align(sma(cache.volumes, period), period - 1, cache.n);
    const out = new Float64Array(cache.n).fill(1);
    for (let i = 0; i < cache.n; i++) {
      const base = smaVol[i];
      out[i] = !Number.isNaN(base) && base > 0 ? cache.volumes[i] / base : 1;
    }
    s = out;
    cache.rvol.set(period, s);
  }
  return s;
}

// ---- public reads (bar-indexed, O(1)) --------------------------------------

/** EMA value at `index`, or NaN if undefined there (mirrors `!ef.length`). */
export function emaAt(candles: Candle[], index: number, period: number): number {
  return emaArr(cacheFor(candles), period)[index];
}
export function smaAt(candles: Candle[], index: number, period: number): number {
  return smaArr(cacheFor(candles), period)[index];
}
/** RMI value at `index`, or null if undefined (mirrors `rmiAtBar` returning null). */
export function rmiValueAt(candles: Candle[], index: number, length: number, momentum: number): number | null {
  const v = rmiArr(cacheFor(candles), length, momentum)[index];
  return Number.isNaN(v) ? null : v;
}
/** ADX value at `index`, or null if undefined (mirrors `adxAtBar` returning null). */
export function adxValueAt(candles: Candle[], index: number, period: number): number | null {
  const v = adxArr(cacheFor(candles), period)[index];
  return Number.isNaN(v) ? null : v;
}
/** ATR-for-bar at `index`; 0 when undefined (mirrors `atrForBar`'s `?? 0`). */
export function atrForBarAt(candles: Candle[], index: number, period: number): number {
  const v = atrArr(cacheFor(candles), period)[index];
  return Number.isNaN(v) ? 0 : v;
}
/** Relative volume at `index` (period defaults to 20 as in the original). */
export function rvolAt(candles: Candle[], index: number, period = 20): number {
  return rvolArr(cacheFor(candles), period)[index];
}

/** VWAP over `[0..index]`, cached cumulatively (same left-to-right sum order). */
export function vwapAtCached(candles: Candle[], index: number): number {
  const cache = cacheFor(candles);
  if (!cache.cumPV) {
    const pv = new Float64Array(cache.n);
    const vol = new Float64Array(cache.n);
    let cpv = 0, cvol = 0;
    for (let i = 0; i < cache.n; i++) {
      const bar = candles[i];
      cpv += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
      cvol += bar.volume;
      pv[i] = cpv;
      vol[i] = cvol;
    }
    cache.cumPV = pv;
    cache.cumVol = vol;
  }
  const vol = cache.cumVol![index];
  return vol > 0 ? cache.cumPV![index] / vol : candles[index].close;
}

// ---- EMA/SMA cross helpers (cache-backed equivalents of strategies/signals) --

export function smaBullCrossAt(candles: Candle[], index: number, fast: number, slow: number): boolean {
  if (index < slow + 1) return false;
  const cache = cacheFor(candles);
  const f = smaArr(cache, fast), s = smaArr(cache, slow);
  const fNow = f[index], fPrev = f[index - 1], sNow = s[index], sPrev = s[index - 1];
  if (Number.isNaN(fNow) || Number.isNaN(fPrev) || Number.isNaN(sNow) || Number.isNaN(sPrev)) return false;
  return fPrev <= sPrev && fNow > sNow;
}
export function smaBearCrossAt(candles: Candle[], index: number, fast: number, slow: number): boolean {
  if (index < slow + 1) return false;
  const cache = cacheFor(candles);
  const f = smaArr(cache, fast), s = smaArr(cache, slow);
  const fNow = f[index], fPrev = f[index - 1], sNow = s[index], sPrev = s[index - 1];
  if (Number.isNaN(fNow) || Number.isNaN(fPrev) || Number.isNaN(sNow) || Number.isNaN(sPrev)) return false;
  return fPrev >= sPrev && fNow < sNow;
}
export function emaBullStackAt(candles: Candle[], index: number, fast: number, slow: number): boolean {
  const cache = cacheFor(candles);
  const efNow = emaArr(cache, fast)[index], esNow = emaArr(cache, slow)[index];
  if (Number.isNaN(efNow) || Number.isNaN(esNow)) return false;
  return efNow > esNow && cache.closes[index] > efNow;
}

/**
 * Cache-backed twin of `breakoutConfirmed`: identical logic, but the relative-
 * volume check reads the memoized rvol series instead of rebuilding it (the
 * only O(index) part of the original). Both use period-20 rvol.
 */
export function breakoutConfirmedAt(
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
  return rvolAt(candles, index) >= minRvol;
}

// ---- pivots / structure / SR (precompute once, read a prefix) ----------------

function pivotsFor(candles: Candle[], lookback: number): Pivot[] {
  const cache = cacheFor(candles);
  let p = cache.pivots.get(lookback);
  if (!p) { p = findPivots(candles, lookback); cache.pivots.set(lookback, p); }
  return p;
}

/**
 * Count of pivots confirmed by bar `index`. A pivot at position `i` needs
 * `lookback` bars on each side, so it is only visible once `i + lookback <= index`
 * — exactly the set `findPivots(candles.slice(0, index+1))` would return.
 */
function visibleCut(pivots: Pivot[], index: number, lookback: number): number {
  const maxIdx = index - lookback;
  let lo = 0, hi = pivots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pivots[mid].index <= maxIdx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** structureState over the pivots visible at `index` (identical to slice path). */
export function structureStateAt(candles: Candle[], index: number, lookback: number): StructureState {
  const piv = pivotsFor(candles, lookback);
  const cut = visibleCut(piv, index, lookback);
  if (cut === 0) return "neutral";
  // structureState only inspects the last 6 pivots, so a 6-element tail suffices.
  const tail = piv.slice(Math.max(0, cut - 6), cut);
  return structureState(tail, index);
}

/** Pivots visible at `index`, for S/R clustering (identical to slice path). */
export function visiblePivots(candles: Candle[], index: number, lookback: number): Pivot[] {
  const piv = pivotsFor(candles, lookback);
  return piv.slice(0, visibleCut(piv, index, lookback));
}
