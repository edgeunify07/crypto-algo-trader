import { getTopTickers } from "./binance/marketData";

/** Core liquid USDT pairs always included in universe scans. */
export const CORE_UNIVERSE = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
  "MATICUSDT",
  "LTCUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "UNIUSDT",
] as const;

/**
 * Resolve trading universe: top N by 24h quote volume, merged with core pairs.
 * Caps at `limit` to keep scan latency reasonable.
 */
export async function resolveUniverse(limit = 20): Promise<string[]> {
  const set = new Set<string>(CORE_UNIVERSE.slice(0, Math.min(8, limit)));
  try {
    const top = await getTopTickers(Math.max(limit, 20));
    for (const row of top) {
      if (set.size >= limit) break;
      if (row.symbol.endsWith("USDT") && row.quoteVolume > 5_000_000) {
        set.add(row.symbol.toUpperCase());
      }
    }
  } catch {
    /* fall back to core list */
  }
  return [...set].slice(0, limit);
}

export function liveContextKey(symbol: string): string {
  return `live:${symbol.toUpperCase()}`;
}

export function backtestContextKey(symbol: string): string {
  return `backtest:${symbol.toUpperCase()}`;
}
