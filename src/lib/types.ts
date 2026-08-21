// Shared domain types for the crypto algo-trading app.

/** A single OHLCV candle. `time` is a UNIX timestamp in SECONDS (lightweight-charts convention). */
export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Live ticker snapshot for one market. */
export interface Ticker {
  market: string; // e.g. "BTCINR"
  lastPrice: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  volume: number;
  change24h: number; // percent
  timestamp: number; // unix seconds
}

/** Tradable market metadata from CoinDCX. */
export interface Market {
  symbol: string; // "BTCINR"
  pair: string; // "I-BTC_INR" (used for candle/orderbook endpoints)
  base: string; // quote currency, e.g. "INR"
  target: string; // asset, e.g. "BTC"
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  step: number;
  status: string;
}

export type CandleInterval =
  | "1m"
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d";
