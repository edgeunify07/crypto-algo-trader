import type { Candle, CandleInterval } from "../types";
import { intervalMs } from "./intervalMs";

export interface DataQualityReport {
  candleCount: number;
  coverageFrom: number | null; // unix seconds
  coverageTo: number | null;
  gaps: { afterTime: number; missingBars: number }[];
  duplicateTimestamps: number;
  zeroVolumeBars: number;
  frozenPriceBars: number;
  ok: boolean;
  warnings: string[];
}

/** Run data-quality checks before every backtest. */
export function checkCandleQuality(candles: Candle[], interval: CandleInterval): DataQualityReport {
  const warnings: string[] = [];
  const step = intervalMs(interval) / 1000;

  if (candles.length === 0) {
    return {
      candleCount: 0,
      coverageFrom: null,
      coverageTo: null,
      gaps: [],
      duplicateTimestamps: 0,
      zeroVolumeBars: 0,
      frozenPriceBars: 0,
      ok: false,
      warnings: ["No candle data available"],
    };
  }

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const gaps: { afterTime: number; missingBars: number }[] = [];
  let duplicateTimestamps = 0;
  let zeroVolumeBars = 0;
  let frozenPriceBars = 0;

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.volume === 0) zeroVolumeBars++;
    if (c.open === c.high && c.high === c.low && c.low === c.close && c.volume === 0) {
      frozenPriceBars++;
    }
    if (i > 0) {
      if (sorted[i].time === sorted[i - 1].time) duplicateTimestamps++;
      const delta = sorted[i].time - sorted[i - 1].time;
      if (delta > step * 1.5) {
        const missing = Math.round(delta / step) - 1;
        gaps.push({ afterTime: sorted[i - 1].time, missingBars: missing });
      }
    }
  }

  if (gaps.length > 0) warnings.push(`${gaps.length} gap(s) detected in candle series`);
  if (duplicateTimestamps > 0) warnings.push(`${duplicateTimestamps} duplicate timestamp(s)`);
  if (zeroVolumeBars > sorted.length * 0.05) {
    warnings.push(`${zeroVolumeBars} zero-volume bars (${((zeroVolumeBars / sorted.length) * 100).toFixed(1)}%)`);
  }
  if (frozenPriceBars > 0) warnings.push(`${frozenPriceBars} frozen-price (flat OHLC) bars`);

  return {
    candleCount: sorted.length,
    coverageFrom: sorted[0].time,
    coverageTo: sorted[sorted.length - 1].time,
    gaps,
    duplicateTimestamps,
    zeroVolumeBars,
    frozenPriceBars,
    ok: gaps.length === 0 && duplicateTimestamps === 0,
    warnings,
  };
}

/** Verify requested window is covered by available candles. */
export function checkCoverage(
  candles: Candle[],
  startTime?: number,
  endTime?: number,
): { ok: boolean; message?: string } {
  if (!startTime && !endTime) return { ok: true };
  if (candles.length === 0) return { ok: false, message: "No data for requested window" };
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const from = sorted[0].time;
  const to = sorted[sorted.length - 1].time;
  if (startTime && from > startTime) {
    return { ok: false, message: `Data starts at ${new Date(from * 1000).toISOString()}, after requested start` };
  }
  if (endTime && to < endTime) {
    return { ok: false, message: `Data ends at ${new Date(to * 1000).toISOString()}, before requested end` };
  }
  return { ok: true };
}
