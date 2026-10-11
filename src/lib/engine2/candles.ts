import { fetchFuturesKlines } from "@/lib/futures/rest";
import { KEYS, kv } from "@/lib/store/kv";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/algo/types";

/**
 * Candle cache.
 *
 * A tick has a hard time budget, and refetching every symbol/timeframe on
 * every invocation would blow it and hammer the rate limit. Candles are cached
 * in KV with a TTL tied to the timeframe, so a 1h series is fetched at most
 * once an hour no matter how often the loop ticks.
 */

/** Bars kept per series — enough to warm up the slowest indicator. */
export const SERIES_BARS = Number(process.env.SERIES_BARS ?? "320");

function isFresh(candles: Candle[], timeframe: Timeframe): boolean {
  const last = candles.at(-1);
  if (!last) return false;
  // Fresh while the bar after the last stored one has not closed yet.
  return Date.now() - last.closeTime < TIMEFRAME_MS[timeframe];
}

export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  options: { bars?: number; force?: boolean } = {},
): Promise<Candle[]> {
  const { bars = SERIES_BARS, force = false } = options;
  const store = kv();
  const key = KEYS.candles(symbol, timeframe);

  if (!force) {
    const cached = await store.get<Candle[]>(key);
    if (cached && cached.length >= bars * 0.8 && isFresh(cached, timeframe)) {
      return cached;
    }
  }

  const fetched = await fetchFuturesKlines(symbol, timeframe, bars);
  if (fetched.length > 0) {
    // TTL of one interval: the series is stale as soon as a new bar closes.
    await store.set(key, fetched, Math.ceil(TIMEFRAME_MS[timeframe] / 1000));
  }
  return fetched;
}

/** Load several series concurrently, with a bounded worker pool. */
export async function getManyCandles(
  requests: { symbol: string; timeframe: Timeframe }[],
  concurrency = 8,
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    for (;;) {
      const job = requests[cursor++];
      if (!job) return;
      try {
        const candles = await getCandles(job.symbol, job.timeframe);
        if (candles.length > 0) out.set(`${job.symbol}:${job.timeframe}`, candles);
      } catch {
        // A single failed series must not abort the tick; the screener simply
        // sees one less timeframe for that symbol.
      }
    }
  });

  await Promise.all(workers);
  return out;
}
