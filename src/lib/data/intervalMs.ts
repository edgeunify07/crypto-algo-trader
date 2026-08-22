import type { CandleInterval } from "../types";

/** Binance kline interval → duration in milliseconds (UTC). */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}
