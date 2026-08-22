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
  "LTCUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "UNIUSDT",
  "APTUSDT",
] as const;

const STABLE_OR_FIAT = /^(USDC|USD1|FDUSD|TUSD|BUSD|DAI|EUR|AEUR|USDP|USDE|USDT)USDT$/i;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/i;

export function isTradableSpotSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (!s.endsWith("USDT")) return false;
  if (STABLE_OR_FIAT.test(s)) return false;
  if (LEVERAGED.test(s)) return false;
  if (s.includes("USD") && s !== "BTCUSDT" && /^[A-Z0-9]*USD[A-Z0-9]*USDT$/.test(s) && !CORE_UNIVERSE.includes(s as typeof CORE_UNIVERSE[number])) {
    // skip odd USD* stables like USD1USDT already handled; keep majors
  }
  return true;
}

/**
 * Resolve trading universe: top N by 24h quote volume, merged with core pairs.
 * Caps at `limit` (default 20). Excludes stablecoins.
 */
export async function resolveUniverse(limit = 20): Promise<string[]> {
  const set = new Set<string>();
  for (const s of CORE_UNIVERSE) {
    if (set.size >= limit) break;
    set.add(s);
  }
  try {
    const top = await getTopTickers(Math.max(limit * 2, 40));
    for (const row of top) {
      if (set.size >= limit) break;
      const sym = row.symbol.toUpperCase();
      if (isTradableSpotSymbol(sym) && row.quoteVolume > 5_000_000) {
        set.add(sym);
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
