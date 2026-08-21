// Binance public market data, mapped onto the app's shared domain types.
import { publicGet } from "./client";
import type { Candle, CandleInterval, Market, Ticker } from "../types";

// Binance uses the same interval strings we already expose.
type BinanceKline = [
  number, // open time (ms)
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  ...unknown[],
];

export async function getCandles(
  symbol: string,
  interval: CandleInterval,
  limit = 500,
): Promise<Candle[]> {
  const raw = await publicGet<BinanceKline[]>("/api/v3/klines", {
    symbol: symbol.toUpperCase(),
    interval,
    limit: Math.min(limit, 1000),
  });
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

interface Raw24hr {
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  priceChangePercent: string;
  closeTime: number;
}

export async function getTicker(symbol: string): Promise<Ticker> {
  const t = await publicGet<Raw24hr>("/api/v3/ticker/24hr", { symbol: symbol.toUpperCase() });
  return {
    market: t.symbol,
    lastPrice: Number(t.lastPrice),
    bid: Number(t.bidPrice),
    ask: Number(t.askPrice),
    high24h: Number(t.highPrice),
    low24h: Number(t.lowPrice),
    volume: Number(t.volume),
    change24h: Number(t.priceChangePercent),
    timestamp: Math.floor(t.closeTime / 1000),
  };
}

interface RawSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  filters: { filterType: string; stepSize?: string; minQty?: string; maxQty?: string; minNotional?: string }[];
}

let marketCache: { value: Market[]; expires: number } | null = null;

export async function getMarkets(): Promise<Market[]> {
  if (marketCache && marketCache.expires > Date.now()) return marketCache.value;
  const info = await publicGet<{ symbols: RawSymbol[] }>("/api/v3/exchangeInfo", {});
  const markets = info.symbols
    .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
    .map((s) => {
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const notional = s.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
      return {
        symbol: s.symbol,
        pair: s.symbol,
        base: s.quoteAsset,
        target: s.baseAsset,
        minQuantity: Number(lot?.minQty ?? 0),
        maxQuantity: Number(lot?.maxQty ?? 0),
        minNotional: Number(notional?.minNotional ?? 0),
        step: Number(lot?.stepSize ?? 0),
        status: s.status,
      } satisfies Market;
    });
  marketCache = { value: markets, expires: Date.now() + 10 * 60_000 };
  return markets;
}

/** Round a quantity down to the symbol's LOT_SIZE step. */
export function roundToStep(qty: number, step: number): number {
  if (!step || step <= 0) return qty;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const floored = Math.floor(qty / step) * step;
  return Number(floored.toFixed(decimals));
}

export interface DepthLevel {
  price: number;
  qty: number;
  total: number; // cumulative qty from best price
}

export interface OrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  spread: number;
  spreadPct: number;
}

export async function getDepth(symbol: string, limit = 20): Promise<OrderBook> {
  const raw = await publicGet<{ bids: [string, string][]; asks: [string, string][] }>("/api/v3/depth", {
    symbol: symbol.toUpperCase(),
    limit: Math.min(limit, 100),
  });
  let bt = 0;
  const bids = raw.bids.map(([p, q]) => {
    bt += Number(q);
    return { price: Number(p), qty: Number(q), total: bt };
  });
  let at = 0;
  const asks = raw.asks.map(([p, q]) => {
    at += Number(q);
    return { price: Number(p), qty: Number(q), total: at };
  });
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;
  return { bids, asks, spread, spreadPct: bestBid ? (spread / bestBid) * 100 : 0 };
}

export interface RecentTrade {
  id: number;
  price: number;
  qty: number;
  time: number; // ms
  isBuyerMaker: boolean; // true => aggressor sold (down), false => aggressor bought (up)
}

export async function getRecentTrades(symbol: string, limit = 30): Promise<RecentTrade[]> {
  const raw = await publicGet<{ id: number; price: string; qty: string; time: number; isBuyerMaker: boolean }[]>(
    "/api/v3/trades",
    { symbol: symbol.toUpperCase(), limit: Math.min(limit, 100) },
  );
  return raw
    .map((t) => ({ id: t.id, price: Number(t.price), qty: Number(t.qty), time: t.time, isBuyerMaker: t.isBuyerMaker }))
    .reverse(); // newest first
}

interface Raw24hrFull {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
}

export interface MarketRow {
  symbol: string;
  lastPrice: number;
  change24h: number;
  quoteVolume: number;
}

let topCache: { value: MarketRow[]; expires: number } | null = null;

/** Top USDT markets by 24h quote volume — for the Binance-style market list. */
export async function getTopTickers(limit = 40): Promise<MarketRow[]> {
  if (topCache && topCache.expires > Date.now()) return topCache.value.slice(0, limit);
  const raw = await publicGet<Raw24hrFull[]>("/api/v3/ticker/24hr", {});
  const rows = raw
    .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"))
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      change24h: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
    }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
  topCache = { value: rows, expires: Date.now() + 15_000 };
  return rows.slice(0, limit);
}

let priceCache: { value: Map<string, number>; expires: number } | null = null;

/** All symbol → last price, for valuing account balances in USDT. */
export async function getAllPrices(): Promise<Map<string, number>> {
  if (priceCache && priceCache.expires > Date.now()) return priceCache.value;
  const raw = await publicGet<{ symbol: string; price: string }[]>("/api/v3/ticker/price", {});
  const map = new Map<string, number>();
  for (const p of raw) map.set(p.symbol, Number(p.price));
  priceCache = { value: map, expires: Date.now() + 15_000 };
  return map;
}

/** Convert an asset amount to an approximate USDT value using live prices. */
export function valueInUsdt(asset: string, amount: number, prices: Map<string, number>): number {
  if (amount <= 0) return 0;
  if (asset === "USDT") return amount;
  const direct = prices.get(`${asset}USDT`);
  if (direct) return amount * direct;
  // Stablecoins ≈ $1 as a fallback.
  if (["USDC", "FDUSD", "TUSD", "BUSD", "DAI"].includes(asset)) return amount;
  return 0; // unknown / illiquid — don't fabricate a value
}
