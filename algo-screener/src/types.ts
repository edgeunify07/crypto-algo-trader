/** Core domain types shared across the screener, strategy and execution layers. */

/** Binance kline intervals this project understands, ordered from fast to slow. */
export const TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
  "3d",
  "1w",
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Milliseconds per timeframe. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
};

/** A single OHLCV bar. `openTime`/`closeTime` are epoch milliseconds. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  /** Quote-asset volume (USDT for *USDT pairs). */
  quoteVolume: number;
  trades: number;
  /** False while the bar is still forming (live websocket updates). */
  closed: boolean;
}

export type Side = "long" | "short";
export type Direction = Side | "flat";

/** Normalised, bounded signal emitted by any analysis module. */
export interface SignalComponent {
  /** Stable identifier, e.g. "ema_trend", "elliott", "gann_fan". */
  name: string;
  /** -1 (max bearish) .. +1 (max bullish). */
  score: number;
  /** 0..1 — how much to trust this component right now. */
  confidence: number;
  /** Human-readable explanation, surfaced in the screener and LLM reports. */
  note: string;
}

/** Result of analysing one symbol on one timeframe. */
export interface TimeframeAnalysis {
  symbol: string;
  timeframe: Timeframe;
  /** Close time of the last *closed* candle the analysis is based on. */
  asOf: number;
  price: number;
  atr: number;
  /** -1..+1 blended score across all components. */
  score: number;
  /** 0..1 blended confidence. */
  confidence: number;
  direction: Direction;
  regime: Regime;
  components: SignalComponent[];
  elliott: ElliottAnalysis;
  gann: GannAnalysis;
  /** Nearby structural levels, used for stops and targets. */
  levels: PriceLevel[];
}

export type RegimeKind = "trending_up" | "trending_down" | "ranging" | "volatile";

export interface Regime {
  kind: RegimeKind;
  /** 0..1 strength of the classification. */
  strength: number;
  adx: number;
  /** ATR as a fraction of price. */
  atrPct: number;
}

export interface PriceLevel {
  price: number;
  kind: "support" | "resistance";
  /** 0..1 — how significant the level is. */
  weight: number;
  source: string;
}

/** A detected swing pivot (ZigZag style). */
export interface Pivot {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
}

export type ElliottWaveLabel =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "A"
  | "B"
  | "C"
  | "unknown";

export interface ElliottWave {
  label: ElliottWaveLabel;
  startTime: number;
  endTime: number;
  startPrice: number;
  endPrice: number;
}

export interface ElliottAnalysis {
  /** Degree of the count, derived from the timeframe. */
  timeframe: Timeframe;
  pattern: "impulse" | "correction" | "none";
  /** Wave currently in progress, if the count is usable. */
  currentWave: ElliottWaveLabel;
  /** Direction the count implies for the *next* move. */
  bias: Direction;
  /** 0..1, penalised by every soft rule violation. */
  confidence: number;
  waves: ElliottWave[];
  /** Fibonacci projections for the wave in progress. */
  targets: number[];
  /** Price that would invalidate the count. */
  invalidation: number | null;
  notes: string[];
}

export interface GannAngleLevel {
  /** e.g. "1x1", "2x1", "1x4". */
  ratio: string;
  price: number;
  /** Positive when price sits above the line. */
  distancePct: number;
}

export interface GannAnalysis {
  timeframe: Timeframe;
  /** Pivot the fan is anchored to. */
  anchor: Pivot | null;
  /** Price unit per bar used to scale the fan (derived from ATR). */
  unitPerBar: number;
  angles: GannAngleLevel[];
  /** Square-of-nine levels bracketing current price. */
  squareOfNine: { support: number[]; resistance: number[] };
  /** Bars since anchor vs. Gann's significant counts. */
  timeCycle: { barsSinceAnchor: number; nearestCycle: number; distance: number };
  bias: Direction;
  confidence: number;
  notes: string[];
}

/** Aggregated multi-timeframe verdict for one symbol. */
export interface ScreenerRow {
  symbol: string;
  price: number;
  /** -1..+1 across all timeframes. */
  score: number;
  confidence: number;
  direction: Direction;
  /** 0..1 — fraction of timeframes agreeing with `direction`, weighted. */
  alignment: number;
  /** Timeframe whose analysis drives the trade plan. */
  anchorTimeframe: Timeframe;
  perTimeframe: Record<string, TimeframeAnalysis>;
  quoteVolume24h: number;
  plan: TradePlan | null;
}

export interface TradePlan {
  symbol: string;
  side: Side;
  timeframe: Timeframe;
  entry: number;
  stopLoss: number;
  takeProfits: { price: number; fraction: number }[];
  /** Account fraction risked (0..1). */
  riskFraction: number;
  quantity: number;
  notional: number;
  rMultiple: number;
  confidence: number;
  reasons: string[];
  createdAt: number;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number | null;
  createdAt: number;
  status: "new" | "filled" | "cancelled" | "rejected";
  reason?: string;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  time: number;
}

export interface Position {
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  openedAt: number;
  stopLoss: number;
  takeProfits: { price: number; fraction: number; hit: boolean }[];
  /** Highest (long) / lowest (short) price seen since entry — drives the trail. */
  extreme: number;
  feesPaid: number;
  timeframe: Timeframe;
  /** Params version that opened this position. */
  paramsVersion: string;
  tags: string[];
}

export interface ClosedTrade {
  symbol: string;
  side: Side;
  timeframe: Timeframe;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  fees: number;
  exitReason: ExitReason;
  paramsVersion: string;
  tags: string[];
}

export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "signal_flip"
  | "max_hold"
  | "manual"
  | "end_of_data";

export interface AccountSnapshot {
  time: number;
  equity: number;
  cash: number;
  unrealisedPnl: number;
  realisedPnl: number;
  openPositions: number;
}
