import fs from "node:fs/promises";
import path from "node:path";
import { publicGet } from "../binance/client";
import type { Candle, CandleInterval } from "../types";
import { intervalMs } from "./intervalMs";

export const DATA_SOURCE = "binance-spot-mainnet" as const;

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function mapKline(k: BinanceKline): Candle {
  return {
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Math.floor(k[6] / 1000),
    quoteVolume: Number(k[7]),
    tradeCount: k[8],
    takerBuyBaseVol: Number(k[9]),
    takerBuyQuoteVol: Number(k[10]),
  };
}

function dedupeSort(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

const CACHE_DIR = path.join(process.cwd(), ".data", "candles");

function cachePath(symbol: string, interval: CandleInterval): string {
  return path.join(CACHE_DIR, `${symbol.toUpperCase()}_${interval}.json`);
}

interface CacheFile {
  symbol: string;
  interval: CandleInterval;
  source: typeof DATA_SOURCE;
  updatedAt: string;
  candles: Candle[];
}

async function readCache(symbol: string, interval: CandleInterval): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath(symbol, interval), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(symbol: string, interval: CandleInterval, candles: Candle[]): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file: CacheFile = {
    symbol: symbol.toUpperCase(),
    interval,
    source: DATA_SOURCE,
    updatedAt: new Date().toISOString(),
    candles: dedupeSort(candles),
  };
  await fs.writeFile(cachePath(symbol, interval), JSON.stringify(file));
}

/** Paginate Binance klines between startMs and endMs (mainnet public data). */
export async function fetchCandlesRange(
  symbol: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let cursor = startMs;
  const sym = symbol.toUpperCase();

  while (cursor < endMs) {
    const batch = await publicGet<BinanceKline[]>("/api/v3/klines", {
      symbol: sym,
      interval,
      startTime: cursor,
      endTime: endMs,
      limit: 1000,
    });
    if (batch.length === 0) break;
    all.push(...batch.map(mapKline));
    const lastCloseMs = batch[batch.length - 1][6];
    const next = lastCloseMs + 1;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < 1000) break;
  }

  return dedupeSort(all);
}

export interface HistoricalFetchOptions {
  symbol: string;
  interval: CandleInterval;
  startTime?: number;
  endTime?: number;
  limit?: number;
  useCache?: boolean;
}

export interface HistoricalFetchResult {
  candles: Candle[];
  source: typeof DATA_SOURCE;
  fromCache: boolean;
  updatedAt: string;
}

/**
 * Load historical candles for backtesting. Always uses mainnet public data.
 * Persists to `.data/candles/` and fetches only deltas on subsequent runs.
 */
export async function getHistoricalCandles(opts: HistoricalFetchOptions): Promise<HistoricalFetchResult> {
  const { symbol, interval, startTime, endTime, limit = 1000, useCache = true } = opts;
  const nowMs = Date.now();
  const endMs = endTime ? endTime * 1000 : nowMs;

  let merged: Candle[] = [];
  let fromCache = false;

  if (useCache) {
    const file = await readCache(symbol, interval);
    if (file?.candles?.length) {
      merged = file.candles;
      fromCache = true;
    }
  }

  let startMs: number;
  if (startTime) {
    startMs = startTime * 1000;
  } else if (merged.length > 0) {
    // Delta fetch: from last cached bar to now
    const last = merged[merged.length - 1];
    startMs = ((last.closeTime ?? last.time) * 1000) + 1;
  } else {
    startMs = endMs - limit * intervalMs(interval);
  }

  // Fetch older history if cache doesn't cover requested start
  if (startTime && merged.length > 0 && merged[0].time * 1000 > startMs) {
    const older = await fetchCandlesRange(symbol, interval, startMs, merged[0].time * 1000 - 1);
    merged = dedupeSort([...older, ...merged]);
  }

  // Fetch delta / full range
  if (merged.length === 0) {
    merged = await fetchCandlesRange(symbol, interval, startMs, endMs);
  } else if (startMs < endMs) {
    const delta = await fetchCandlesRange(symbol, interval, startMs, endMs);
    merged = dedupeSort([...merged, ...delta]);
  }

  if (useCache && merged.length > 0) {
    await writeCache(symbol, interval, merged);
  }

  // Trim to requested window
  let result = merged;
  if (startTime) result = result.filter((c) => c.time >= startTime);
  if (endTime) result = result.filter((c) => c.time <= endTime);
  if (!startTime && !endTime && limit) result = result.slice(-limit);

  return {
    candles: dedupeSort(result),
    source: DATA_SOURCE,
    fromCache,
    updatedAt: new Date().toISOString(),
  };
}
