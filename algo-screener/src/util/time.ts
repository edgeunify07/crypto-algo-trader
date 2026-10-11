import { TIMEFRAME_MS, type Timeframe } from "../types.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start of the bar containing `time` for the given timeframe. */
export function barOpenTime(time: number, timeframe: Timeframe): number {
  const ms = TIMEFRAME_MS[timeframe];
  // Weekly bars open on Monday 00:00 UTC; the epoch was a Thursday.
  if (timeframe === "1w") {
    const offset = 4 * 86_400_000;
    return Math.floor((time + offset) / ms) * ms - offset;
  }
  return Math.floor(time / ms) * ms;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function isoDate(time: number): string {
  return new Date(time).toISOString().replace("T", " ").slice(0, 19);
}
