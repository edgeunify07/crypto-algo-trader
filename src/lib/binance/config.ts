// Binance environment + endpoint configuration.
//
// SAFETY: keys are read ONLY from server-side env (.env.local, gitignored).
// They are never imported into client components. All signed calls happen in
// API routes / server modules.

export type BinanceEnv = "testnet" | "live";

export const BINANCE_ENV: BinanceEnv =
  process.env.BINANCE_ENV === "live" ? "live" : "testnet";

// Public market data endpoint — no geo-blocking, no auth. Used for charts,
// backtests, and the bot's candle feed regardless of env.
export const DATA_BASE = "https://data-api.binance.vision";

// Signed trading endpoints. Testnet is the default so nothing touches real
// money until BINANCE_ENV=live is deliberately set.
export const TRADE_BASE =
  BINANCE_ENV === "live" ? "https://api.binance.com" : "https://testnet.binance.vision";

export const API_KEY = process.env.BINANCE_API_KEY ?? "";
export const API_SECRET = process.env.BINANCE_API_SECRET ?? "";

// Extra belt-and-suspenders switch: even with live keys, real orders are
// refused unless TRADING_ENABLED=true. Lets you run live market data with
// paper execution safely.
export const TRADING_ENABLED = process.env.TRADING_ENABLED === "true";

export function hasCredentials(): boolean {
  return API_KEY.length > 0 && API_SECRET.length > 0;
}

export function configSummary() {
  return {
    env: BINANCE_ENV,
    tradeBase: TRADE_BASE,
    hasKeys: hasCredentials(),
    tradingEnabled: TRADING_ENABLED,
    live: BINANCE_ENV === "live" && TRADING_ENABLED,
  };
}
