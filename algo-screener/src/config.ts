import fs from "node:fs";
import path from "node:path";
import { TIMEFRAMES, isTimeframe, type Timeframe } from "./types.js";

/**
 * Minimal .env loader — avoids a dependency and keeps the file optional.
 * Values already present in process.env win, so shell exports override the file.
 */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

loadDotEnv(path.join(PROJECT_ROOT, ".env"));

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function timeframes(key: string, fallback: Timeframe[]): Timeframe[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isTimeframe);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * REST hosts are tried in order. `data-api.binance.vision` is Binance's public
 * market-data mirror: it serves klines/depth/ticker without an API key and stays
 * reachable from regions where `api.binance.com` returns HTTP 451. Signed
 * endpoints only exist on the main host, so live trading always uses that one.
 */
const DEFAULT_REST_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];

export const config = {
  binance: {
    restHosts: (process.env.BINANCE_REST_HOSTS ?? DEFAULT_REST_HOSTS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Host used for signed (account/order) requests. */
    tradeHost: process.env.BINANCE_TRADE_HOST ?? "https://api.binance.com",
    /** WebSocket hosts, tried in order (same geo-block story as REST). */
    wsHosts: (
      process.env.BINANCE_WS_HOSTS ??
      "wss://stream.binance.com:9443,wss://data-stream.binance.vision"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Max kline streams multiplexed onto one connection (Binance caps at 1024). */
    streamsPerConnection: num("STREAMS_PER_CONNECTION", 150),
    apiKey: process.env.BINANCE_API_KEY ?? "",
    apiSecret: process.env.BINANCE_API_SECRET ?? "",
    /** Max REST weight to consume per minute; Binance's cap is 6000. */
    weightPerMinute: num("BINANCE_WEIGHT_PER_MINUTE", 2400),
  },

  universe: {
    /** Explicit symbol list; empty means "auto-discover by volume". */
    symbols: list("SYMBOLS", []),
    quoteAsset: (process.env.QUOTE_ASSET ?? "USDT").toUpperCase(),
    /** How many symbols to keep when auto-discovering. */
    topN: num("UNIVERSE_TOP_N", 30),
    minQuoteVolume24h: num("MIN_QUOTE_VOLUME_24H", 50_000_000),
    /** Symbols never traded or screened (stablecoin pairs, leveraged tokens). */
    exclude: list("EXCLUDE_SYMBOLS", [
      "USDCUSDT",
      "FDUSDUSDT",
      "TUSDUSDT",
      "BUSDUSDT",
      "EURUSDT",
      "DAIUSDT",
    ]),
  },

  /** Every timeframe the engine analyses. */
  timeframes: timeframes("TIMEFRAMES", [...TIMEFRAMES]),
  /** Timeframes allowed to anchor a trade (fast noise is filtered out). */
  tradeTimeframes: timeframes("TRADE_TIMEFRAMES", [
    "15m",
    "30m",
    "1h",
    "4h",
    "1d",
  ]),
  /** Bars of history kept per symbol/timeframe. */
  historyBars: num("HISTORY_BARS", 750),

  account: {
    startingCash: num("STARTING_CASH", 10_000),
    /** Taker fee per side, as a fraction (0.001 = 0.1%). */
    feeRate: num("FEE_RATE", 0.001),
    /** Modelled slippage per side, as a fraction of price. */
    slippageRate: num("SLIPPAGE_RATE", 0.0005),
  },

  risk: {
    /** Account fraction risked on a single trade. */
    riskPerTrade: num("RISK_PER_TRADE", 0.01),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    /** Cap on a single position's notional as a fraction of equity. */
    maxPositionFraction: num("MAX_POSITION_FRACTION", 0.25),
    /** Daily loss that halts new entries, as a fraction of day-start equity. */
    maxDailyLoss: num("MAX_DAILY_LOSS", 0.05),
    /** Drawdown from peak equity that halts new entries. */
    maxDrawdown: num("MAX_DRAWDOWN", 0.2),
    /** Only one position per symbol at a time when true. */
    oneTradePerSymbol: bool("ONE_TRADE_PER_SYMBOL", true),
  },

  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "claude-opus-5-5",
    effort: process.env.LLM_EFFORT ?? "high",
    maxTokens: num("LLM_MAX_TOKENS", 16_000),
    /** Candidate parameter sets requested per improvement round. */
    candidatesPerRound: num("LLM_CANDIDATES", 4),
  },

  improve: {
    /** Fraction of the backtest window held out for validation. */
    validationFraction: num("VALIDATION_FRACTION", 0.3),
    /** A candidate must beat the incumbent's score by at least this much. */
    minImprovement: num("MIN_IMPROVEMENT", 0.05),
    /** Candidates with fewer trades than this are rejected as noise. */
    minTrades: num("MIN_TRADES", 20),
    /** Candidates exceeding this out-of-sample drawdown are rejected. */
    maxAcceptableDrawdown: num("MAX_ACCEPTABLE_DRAWDOWN", 0.25),
  },

  runtime: {
    /** Live trading is opt-in and additionally requires API credentials. */
    liveTrading: bool("LIVE_TRADING", false),
    /** Screener re-scan cadence in the real-time loop, in seconds. */
    scanIntervalSec: num("SCAN_INTERVAL_SEC", 30),
    /** Hours between automatic LLM improvement rounds (0 disables). */
    improveIntervalHours: num("IMPROVE_INTERVAL_HOURS", 0),
    httpPort: num("HTTP_PORT", 4317),
    dataDir: process.env.DATA_DIR ?? path.join(PROJECT_ROOT, "data"),
    logLevel: process.env.LOG_LEVEL ?? "info",
  },
} as const;

export type Config = typeof config;
