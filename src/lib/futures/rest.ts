import type { Candle, Timeframe } from "@/lib/algo/types";

/**
 * Binance USDⓈ-M futures REST client.
 *
 * Host order matters and is the reason this file exists separately from the
 * spot client: `fapi.binance.com` returns HTTP 451 from restricted regions,
 * and Vercel's default function regions are US-based, so a deployment that
 * talks to `fapi` directly fails in production while working locally.
 * `www.binance.com` proxies the same `/fapi/v1/*` routes and is reachable from
 * those regions, so it is tried first.
 *
 * There is no filesystem and no process-level state here: every function is
 * safe to call from a cold serverless invocation.
 */

const HOSTS = (
  process.env.BINANCE_FUTURES_HOSTS ??
  "https://www.binance.com,https://fapi.binance.com"
)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

/** Hosts that returned 451 in this instance; skipped until it recycles. */
const blocked = new Set<string>();

export class FuturesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FuturesApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = 15_000,
): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
  const suffix = query ? `?${query}` : "";

  const hosts = HOSTS.filter((h) => !blocked.has(h));
  const candidates = hosts.length > 0 ? hosts : HOSTS;
  let lastError: unknown;

  for (const host of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${host}${path}${suffix}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          // Never let Next cache market data — this is the whole point.
          cache: "no-store",
        });

        if (res.ok) return (await res.json()) as T;

        const body = await res.text();
        if (res.status === 451) {
          blocked.add(host);
          break; // geo-blocked: move to the next host
        }
        if (res.status === 429 || res.status === 418 || res.status >= 500) {
          await sleep(2 ** attempt * 800);
          continue;
        }
        throw new FuturesApiError(
          `${path} failed: ${res.status} ${body.slice(0, 160)}`,
          res.status,
        );
      } catch (err) {
        lastError = err;
        if (err instanceof FuturesApiError && err.status < 500) throw err;
        await sleep(2 ** attempt * 400);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new FuturesApiError(`${path} unreachable on every configured host`, 0);
}

type RawKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

function toCandle(raw: RawKline): Candle {
  return {
    openTime: raw[0],
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: raw[6],
    quoteVolume: Number(raw[7]),
    trades: raw[8],
    closed: true,
  };
}

/**
 * Closed futures klines, newest last. The still-forming bar is dropped so
 * analysis never sees a partial candle.
 */
export async function fetchFuturesKlines(
  symbol: string,
  interval: Timeframe,
  limit = 300,
): Promise<Candle[]> {
  const raw = await get<RawKline[]>("/fapi/v1/klines", {
    symbol,
    interval,
    limit: Math.min(1500, limit),
  });
  const now = Date.now();
  return raw.map(toCandle).filter((c) => c.closeTime < now);
}

export interface FuturesTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
}

export async function fetchFuturesTickers(): Promise<FuturesTicker[]> {
  const raw = await get<
    {
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      quoteVolume: string;
    }[]
  >("/fapi/v1/ticker/24hr", {}, 25_000);
  return raw.map((t) => ({
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice),
    priceChangePercent: Number(t.priceChangePercent),
    quoteVolume: Number(t.quoteVolume),
  }));
}

export interface MarkPrice {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  /** Current funding rate for the upcoming settlement, as a fraction. */
  lastFundingRate: number;
  nextFundingTime: number;
}

/**
 * Mark price and funding rate. Liquidation and unrealised PnL on Binance
 * futures are computed from the **mark** price, not the last traded price, so
 * the engine uses this rather than the ticker for position valuation.
 */
export async function fetchMarkPrices(symbol?: string): Promise<MarkPrice[]> {
  const raw = await get<
    | {
        symbol: string;
        markPrice: string;
        indexPrice: string;
        lastFundingRate: string;
        nextFundingTime: number;
      }
    | {
        symbol: string;
        markPrice: string;
        indexPrice: string;
        lastFundingRate: string;
        nextFundingTime: number;
      }[]
  >("/fapi/v1/premiumIndex", symbol ? { symbol } : {});

  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((r) => ({
    symbol: r.symbol,
    markPrice: Number(r.markPrice),
    indexPrice: Number(r.indexPrice),
    lastFundingRate: Number(r.lastFundingRate),
    nextFundingTime: r.nextFundingTime,
  }));
}

export interface FuturesSymbolInfo {
  symbol: string;
  status: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

export async function fetchFuturesExchangeInfo(): Promise<Map<string, FuturesSymbolInfo>> {
  const info = await get<{
    symbols: {
      symbol: string;
      status: string;
      contractType: string;
      quoteAsset: string;
      pricePrecision: number;
      quantityPrecision: number;
      filters: {
        filterType: string;
        tickSize?: string;
        stepSize?: string;
        notional?: string;
      }[];
    }[];
  }>("/fapi/v1/exchangeInfo", {}, 30_000);

  const out = new Map<string, FuturesSymbolInfo>();
  for (const s of info.symbols) {
    if (s.contractType !== "PERPETUAL" || s.quoteAsset !== "USDT") continue;
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const notional = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
    out.set(s.symbol, {
      symbol: s.symbol,
      status: s.status,
      pricePrecision: s.pricePrecision,
      quantityPrecision: s.quantityPrecision,
      tickSize: Number(price?.tickSize ?? "0.01"),
      stepSize: Number(lot?.stepSize ?? "0.001"),
      minNotional: Number(notional?.notional ?? "5"),
    });
  }
  return out;
}
