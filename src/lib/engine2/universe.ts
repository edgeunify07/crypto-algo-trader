import { fetchFuturesTickers } from "@/lib/futures/rest";
import { KEYS, kv } from "@/lib/store/kv";

/**
 * The tradable universe: the top N USDⓈ-M perpetuals by 24h quote volume.
 *
 * Recomputed once per UTC day and cached, so every tick within a day trades a
 * stable set. Re-ranking on every tick would churn the universe intraday and
 * open positions in a symbol that drops out minutes later.
 */

export interface UniverseEntry {
  symbol: string;
  quoteVolume24h: number;
  lastPrice: number;
  priceChangePercent: number;
}

export interface UniverseSnapshot {
  /** UTC day this ranking is for, as YYYY-MM-DD. */
  day: string;
  resolvedAt: number;
  entries: UniverseEntry[];
}

export const UNIVERSE_SIZE = Number(process.env.UNIVERSE_SIZE ?? "10");

/** Pairs that are not useful to trade even when volume is high. */
const EXCLUDED = new Set(
  (process.env.EXCLUDE_SYMBOLS ?? "USDCUSDT,BUSDUSDT,FDUSDUSDT,TUSDUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

export function utcDay(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

export async function resolveUniverse(
  options: { force?: boolean; size?: number } = {},
): Promise<UniverseSnapshot> {
  const { force = false, size = UNIVERSE_SIZE } = options;
  const store = kv();
  const today = utcDay();

  if (!force) {
    const cached = await store.get<UniverseSnapshot>(KEYS.universe);
    if (cached && cached.day === today && cached.entries.length > 0) return cached;
  }

  const tickers = await fetchFuturesTickers();
  const entries = tickers
    .filter(
      (t) =>
        t.symbol.endsWith("USDT") &&
        !EXCLUDED.has(t.symbol) &&
        Number.isFinite(t.quoteVolume) &&
        t.quoteVolume > 0 &&
        t.lastPrice > 0,
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, size)
    .map((t) => ({
      symbol: t.symbol,
      quoteVolume24h: t.quoteVolume,
      lastPrice: t.lastPrice,
      priceChangePercent: t.priceChangePercent,
    }));

  const snapshot: UniverseSnapshot = {
    day: today,
    resolvedAt: Date.now(),
    entries,
  };
  // Expire a little after the UTC day rolls, so a stale ranking cannot persist.
  await store.set(KEYS.universe, snapshot, 36 * 3600);
  return snapshot;
}
