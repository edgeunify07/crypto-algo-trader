import fs from "node:fs";
import { config } from "../config.js";
import { fetchKlines, fetch24hTickers } from "../binance/rest.js";
import { dataPath, ensureDir } from "../util/fsStore.js";
import { createLogger } from "../util/logger.js";
import type { Candle, Timeframe } from "../types.js";
import { TIMEFRAME_MS } from "../types.js";
import type { SymbolData } from "./engine.js";

const log = createLogger("loader");

/**
 * Historical data loading with a disk cache.
 *
 * Backtests get re-run constantly during the improvement loop, so re-fetching
 * from Binance each time would be both slow and a good way to get rate-limited.
 * Cached files are keyed by symbol/timeframe and extended rather than refetched.
 */
function cacheFile(symbol: string, timeframe: Timeframe): string {
  return dataPath("klines", `${symbol}-${timeframe}.json`);
}

function readCache(symbol: string, timeframe: Timeframe): Candle[] {
  const file = cacheFile(symbol, timeframe);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Candle[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCache(symbol: string, timeframe: Timeframe, candles: Candle[]): void {
  const file = cacheFile(symbol, timeframe);
  ensureDir(dataPath("klines"));
  fs.writeFileSync(file, JSON.stringify(candles));
}

/** Merge two candle lists, de-duplicating by open time. */
function merge(a: Candle[], b: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of [...a, ...b]) byTime.set(candle.openTime, candle);
  return [...byTime.values()].sort((x, y) => x.openTime - y.openTime);
}

export async function loadCandles(
  symbol: string,
  timeframe: Timeframe,
  bars: number,
  options: { useCache?: boolean } = {},
): Promise<Candle[]> {
  const { useCache = true } = options;
  const cached = useCache ? readCache(symbol, timeframe) : [];

  const newest = cached.at(-1);
  const interval = TIMEFRAME_MS[timeframe];
  const now = Date.now();

  // Cache covers the requested window and is fresh: use it as-is.
  const freshEnough = newest !== undefined && now - newest.closeTime < interval * 2;
  if (freshEnough && cached.length >= bars) {
    return cached.slice(-bars);
  }

  // Otherwise fetch what's missing and merge.
  const needed = freshEnough
    ? bars - cached.length
    : newest === undefined
      ? bars
      : Math.min(bars, Math.ceil((now - newest.closeTime) / interval) + 5);

  const fetched = await fetchKlines(symbol, timeframe, Math.max(needed, 50));
  const merged = merge(cached, fetched);
  if (useCache && merged.length > 0) writeCache(symbol, timeframe, merged);
  return merged.slice(-bars);
}

export interface LoadOptions {
  symbols: string[];
  timeframes: Timeframe[];
  bars: number;
  useCache?: boolean;
  concurrency?: number;
}

/** Load every symbol/timeframe combination needed for a backtest. */
export async function loadSymbolData(options: LoadOptions): Promise<SymbolData[]> {
  const { symbols, timeframes, bars, useCache = true, concurrency = 4 } = options;

  const volumes = new Map<string, number>();
  try {
    for (const t of await fetch24hTickers()) volumes.set(t.symbol, t.quoteVolume);
  } catch (err) {
    log.warn("could not fetch 24h volumes; entry volume filters will see 0", err);
  }

  const out: SymbolData[] = [];
  for (const symbol of symbols) {
    const byTimeframe = new Map<Timeframe, Candle[]>();
    // Timeframes for one symbol load concurrently; symbols load sequentially so
    // the request-weight limiter has a predictable shape.
    const queue = [...timeframes];
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const tf = queue.shift();
        if (!tf) return;
        try {
          // Slow timeframes need proportionally less history in wall-clock
          // terms, but the engine still wants enough bars to warm indicators up.
          const candles = await loadCandles(symbol, tf, bars, { useCache });
          if (candles.length > 0) byTimeframe.set(tf, candles);
        } catch (err) {
          log.warn(`failed to load ${symbol} ${tf}`, err);
        }
      }
    });
    await Promise.all(workers);

    if (byTimeframe.size > 0) {
      out.push({
        symbol,
        byTimeframe,
        quoteVolume24h: volumes.get(symbol) ?? 0,
      });
      log.info(
        `loaded ${symbol}: ${[...byTimeframe.entries()].map(([tf, c]) => `${tf}:${c.length}`).join(" ")}`,
      );
    }
  }
  return out;
}

/** Split loaded data into in-sample and out-of-sample halves by time. */
export function splitData(
  data: SymbolData[],
  validationFraction = config.improve.validationFraction,
  stepTimeframe?: Timeframe,
): { train: SymbolData[]; validate: SymbolData[]; splitTime: number } {
  // Split on the trading clock, not the union of every timeframe — the daily
  // series spans years while an intraday step timeframe may span weeks.
  const clockTimeframe =
    stepTimeframe ??
    config.tradeTimeframes.find((tf) =>
      data.some((d) => (d.byTimeframe.get(tf)?.length ?? 0) > 0),
    ) ??
    "1h";

  let earliest = Infinity;
  let latest = -Infinity;
  for (const symbol of data) {
    const candles = symbol.byTimeframe.get(clockTimeframe);
    if (!candles || candles.length === 0) continue;
    const first = candles[0];
    const last = candles.at(-1);
    if (first) earliest = Math.min(earliest, first.openTime);
    if (last) latest = Math.max(latest, last.closeTime);
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    return { train: data, validate: [], splitTime: 0 };
  }

  const splitTime = latest - (latest - earliest) * validationFraction;

  const slice = (keep: (candle: Candle) => boolean): SymbolData[] =>
    data
      .map((symbol) => {
        const byTimeframe = new Map<Timeframe, Candle[]>();
        for (const [tf, candles] of symbol.byTimeframe) {
          const kept = candles.filter(keep);
          if (kept.length > 0) byTimeframe.set(tf, kept);
        }
        return { ...symbol, byTimeframe };
      })
      .filter((s) => s.byTimeframe.size > 0);

  return {
    // Validation keeps the warm-up history it needs, but the engine's `from`
    // bound stops it trading before the split.
    train: slice((c) => c.closeTime <= splitTime),
    validate: data,
    splitTime,
  };
}
