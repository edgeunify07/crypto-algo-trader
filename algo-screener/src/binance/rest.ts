import crypto from "node:crypto";
import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { sleep } from "../util/time.js";
import type { Candle, Timeframe } from "../types.js";

const log = createLogger("binance:rest");

/** Raw kline tuple as returned by GET /api/v3/klines. */
type RawKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // trades
  string, // taker buy base volume
  string, // taker buy quote volume
  string, // ignore
];

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
  spotTradingAllowed: boolean;
}

export class BinanceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "BinanceError";
  }
}

/**
 * Token-bucket limiter over Binance's request-weight budget. Binance replies
 * with 429 (and then 418 bans) when the per-minute weight is exceeded, so we
 * pace ourselves locally instead of relying on retries.
 */
class WeightLimiter {
  private used = 0;
  private windowStart = Date.now();

  constructor(private readonly limitPerMinute: number) {}

  async acquire(weight: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now;
        this.used = 0;
      }
      if (this.used + weight <= this.limitPerMinute) {
        this.used += weight;
        return;
      }
      await sleep(60_000 - (now - this.windowStart) + 50);
    }
  }
}

const limiter = new WeightLimiter(config.binance.weightPerMinute);

/** Hosts that returned 451 (geo-block) — skipped for the rest of the process. */
const blockedHosts = new Set<string>();

function parseNumber(value: string | undefined): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET a public endpoint, failing over to the next configured host on geo-blocks
 * and transient errors. Retries with exponential backoff on 429/5xx.
 */
async function publicGet<T>(
  endpoint: string,
  params: Record<string, string | number>,
  weight: number,
): Promise<T> {
  await limiter.acquire(weight);
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
  const hosts = config.binance.restHosts.filter((h) => !blockedHosts.has(h));
  const candidates = hosts.length > 0 ? hosts : config.binance.restHosts;

  let lastError: unknown;
  for (const host of candidates) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(
          `${host}${endpoint}${query ? `?${query}` : ""}`,
          { headers: { Accept: "application/json" } },
        );
        if (res.ok) return (await res.json()) as T;

        const body = await res.text();
        if (res.status === 451) {
          // Geo-restricted host; remember and move on to the mirror.
          if (!blockedHosts.has(host)) {
            log.warn(
              `${host} is geo-restricted (451); falling back to the next host`,
            );
            blockedHosts.add(host);
          }
          break;
        }
        if (res.status === 429 || res.status === 418 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "0");
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
          log.warn(`${endpoint} -> ${res.status}; retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        throw new BinanceError(
          `${endpoint} failed: ${res.status} ${body.slice(0, 200)}`,
          res.status,
        );
      } catch (err) {
        lastError = err;
        if (err instanceof BinanceError && err.status < 500) throw err;
        await sleep(2 ** attempt * 500);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new BinanceError(`${endpoint} failed on every configured host`, 0);
}

/** Signed request against the trading host. Used only for live trading. */
export async function signedRequest<T>(
  endpoint: string,
  params: Record<string, string | number>,
  method: "GET" | "POST" | "DELETE" = "GET",
): Promise<T> {
  const { apiKey, apiSecret, tradeHost } = config.binance;
  if (!apiKey || !apiSecret) {
    throw new BinanceError(
      "BINANCE_API_KEY / BINANCE_API_SECRET are required for signed requests",
      401,
    );
  }
  await limiter.acquire(10);
  const query = new URLSearchParams(
    Object.entries({ ...params, timestamp: Date.now(), recvWindow: 5000 }).map(
      ([k, v]) => [k, String(v)] as [string, string],
    ),
  ).toString();
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(query)
    .digest("hex");

  const res = await fetch(`${tradeHost}${endpoint}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    let code: number | undefined;
    try {
      code = (JSON.parse(text) as { code?: number }).code;
    } catch {
      /* non-JSON error body */
    }
    throw new BinanceError(
      `${endpoint} failed: ${res.status} ${text.slice(0, 200)}`,
      res.status,
      code,
    );
  }
  return JSON.parse(text) as T;
}

export function toCandle(raw: RawKline): Candle {
  return {
    openTime: raw[0],
    open: parseNumber(raw[1]),
    high: parseNumber(raw[2]),
    low: parseNumber(raw[3]),
    close: parseNumber(raw[4]),
    volume: parseNumber(raw[5]),
    closeTime: raw[6],
    quoteVolume: parseNumber(raw[7]),
    trades: raw[8],
    closed: true,
  };
}

/**
 * Fetch klines, paging backwards when `limit` exceeds Binance's 1000-bar cap.
 * The final (still-forming) bar is dropped so callers only see closed candles.
 */
export async function fetchKlines(
  symbol: string,
  interval: Timeframe,
  limit: number,
  endTime?: number,
): Promise<Candle[]> {
  const collected: Candle[] = [];
  let remaining = limit;
  let cursor = endTime;

  while (remaining > 0) {
    const batch = Math.min(1000, remaining);
    const params: Record<string, string | number> = {
      symbol,
      interval,
      limit: batch,
    };
    if (cursor !== undefined) params.endTime = cursor;

    const raw = await publicGet<RawKline[]>("/api/v3/klines", params, 2);
    if (raw.length === 0) break;

    const candles = raw.map(toCandle);
    collected.unshift(...candles);
    remaining -= candles.length;
    const first = candles[0];
    if (first === undefined || raw.length < batch) break;
    cursor = first.openTime - 1;
  }

  const now = Date.now();
  return collected.filter((c) => c.closeTime < now);
}

export async function fetch24hTickers(): Promise<Ticker24h[]> {
  const raw = await publicGet<
    { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]
  >("/api/v3/ticker/24hr", {}, 80);
  return raw.map((t) => ({
    symbol: t.symbol,
    lastPrice: parseNumber(t.lastPrice),
    priceChangePercent: parseNumber(t.priceChangePercent),
    quoteVolume: parseNumber(t.quoteVolume),
  }));
}

export async function fetchPrices(symbols: string[]): Promise<Map<string, number>> {
  const raw = await publicGet<{ symbol: string; price: string }[]>(
    "/api/v3/ticker/price",
    symbols.length === 1 && symbols[0] !== undefined ? { symbol: symbols[0] } : {},
    symbols.length === 1 ? 2 : 4,
  );
  const wanted = new Set(symbols);
  const out = new Map<string, number>();
  for (const row of Array.isArray(raw) ? raw : [raw]) {
    if (wanted.size === 0 || wanted.has(row.symbol)) {
      out.set(row.symbol, parseNumber(row.price));
    }
  }
  return out;
}

interface RawExchangeInfo {
  symbols: {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    isSpotTradingAllowed: boolean;
    filters: { filterType: string; tickSize?: string; stepSize?: string; minNotional?: string }[];
  }[];
}

export async function fetchExchangeInfo(): Promise<Map<string, SymbolFilters>> {
  const info = await publicGet<RawExchangeInfo>("/api/v3/exchangeInfo", {}, 20);
  const out = new Map<string, SymbolFilters>();
  for (const s of info.symbols) {
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const notional = s.filters.find(
      (f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL",
    );
    out.set(s.symbol, {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
      tickSize: parseNumber(price?.tickSize) || 0.01,
      stepSize: parseNumber(lot?.stepSize) || 0.0001,
      minNotional: parseNumber(notional?.minNotional) || 5,
      spotTradingAllowed: s.isSpotTradingAllowed,
    });
  }
  return out;
}
