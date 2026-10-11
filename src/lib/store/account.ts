import type { Timeframe } from "@/lib/algo/types";

/**
 * Serverless-safe futures paper account.
 *
 * All state is plain JSON so it round-trips through KV. There is no class
 * holding state in memory — a tick loads this, mutates it, and writes it back,
 * which is the only model that survives a platform where every request may hit
 * a different cold instance.
 */

export type Side = "long" | "short";

export type TradeStyle = "scalp" | "swing";

export interface FuturesPosition {
  id: string;
  symbol: string;
  side: Side;
  /** Contracts held. */
  quantity: number;
  entryPrice: number;
  /** Margin locked by this position, in USDT. */
  margin: number;
  leverage: number;
  openedAt: number;
  stopLoss: number;
  /**
   * `scalp` marks the fixed-percentage target, so the ladder the remainder
   * rides is not tallied under the scalp's name. Labelling by the position
   * instead made every swing exit on a part-closed scalp read as a scalp
   * exit, which is precisely the comparison the two reasons exist to allow.
   */
  takeProfits: { price: number; fraction: number; hit: boolean; scalp?: boolean }[];
  liquidationPrice: number;
  /** Best price seen since entry; drives the trailing stop. */
  extreme: number;
  /** Commission paid on entry. */
  entryFee: number;
  /** Signed funding cash flow so far; negative means the position has paid. */
  fundingPaid: number;
  /** Last funding settlement already applied, so a replay cannot double-charge. */
  lastFundingAt: number;
  timeframe: Timeframe;
  style: TradeStyle;
  /**
   * Opened by the high-conviction scalp rule: fixed percentage target, short
   * clock, no swing trailing. Stored on the position rather than inferred
   * from `style`, which is only a label derived from the anchor timeframe —
   * a 4h anchor can still produce a scalp, and the exit rules must follow
   * how the position was opened, not what it is called.
   */
  scalp?: boolean;
  paramsVersion: string;
  /** Why the engine opened this, shown in the UI. */
  reasons: string[];
}

export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "signal_flip"
  | "max_hold"
  | "liquidation"
  | "manual"
  // Scalps get their own two, so the trade history can be read apart from
  // the swing book: whether the fast trades pay for themselves is the whole
  // question about them, and it cannot be answered if their exits are
  // tallied under the same names.
  | "scalp_target"
  | "scalp_timeout";

export interface FuturesTrade {
  id: string;
  symbol: string;
  side: Side;
  style: TradeStyle;
  timeframe: Timeframe;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  openedAt: number;
  closedAt: number;
  /** Price move only, before any cost. */
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  /** Positive when the position paid funding. */
  fundingCost: number;
  /** grossPnl - entryFee - exitFee - fundingCost. This is what hits the balance. */
  netPnl: number;
  /** Net return on the margin committed. */
  netPnlPct: number;
  rMultiple: number;
  exitReason: ExitReason;
  paramsVersion: string;
}

export interface AccountState {
  /** Free collateral, in USDT. */
  balance: number;
  startingBalance: number;
  /** Lifetime realised PnL, net of every cost. */
  realisedPnl: number;
  totalFees: number;
  totalFunding: number;
  peakEquity: number;
  createdAt: number;
  updatedAt: number;
  tickCount: number;
  lastTickAt: number;
  /** Set when trading is halted by a risk limit. */
  haltedReason: string | null;
}

export interface EquityPoint {
  t: number;
  /** Balance + margin + unrealised PnL. */
  equity: number;
  balance: number;
  unrealised: number;
  positions: number;
}

export const STARTING_BALANCE = Number(process.env.STARTING_BALANCE ?? "100");
export const DEFAULT_LEVERAGE = Number(process.env.FUTURES_LEVERAGE ?? "3");

export function newAccount(startingBalance = STARTING_BALANCE): AccountState {
  const now = Date.now();
  return {
    balance: startingBalance,
    startingBalance,
    realisedPnl: 0,
    totalFees: 0,
    totalFunding: 0,
    peakEquity: startingBalance,
    createdAt: now,
    updatedAt: now,
    tickCount: 0,
    lastTickAt: 0,
    haltedReason: null,
  };
}

/** Margin locked across all open positions. */
export function lockedMargin(positions: FuturesPosition[]): number {
  return positions.reduce((sum, p) => sum + p.margin, 0);
}

/**
 * Account equity: free balance, plus margin posted, plus unrealised PnL.
 * `marks` is keyed by symbol; a missing mark falls back to the entry price,
 * which values the position at break-even rather than inventing a number.
 */
export function equity(
  account: AccountState,
  positions: FuturesPosition[],
  marks: Record<string, number>,
): number {
  let total = account.balance;
  for (const p of positions) {
    const mark = marks[p.symbol] ?? p.entryPrice;
    const pnl =
      p.side === "long"
        ? (mark - p.entryPrice) * p.quantity
        : (p.entryPrice - mark) * p.quantity;
    total += p.margin + pnl;
  }
  return total;
}

export function unrealisedTotal(
  positions: FuturesPosition[],
  marks: Record<string, number>,
): number {
  let total = 0;
  for (const p of positions) {
    const mark = marks[p.symbol] ?? p.entryPrice;
    total +=
      p.side === "long"
        ? (mark - p.entryPrice) * p.quantity
        : (p.entryPrice - mark) * p.quantity;
  }
  return total;
}

export function drawdown(account: AccountState, currentEquity: number): number {
  if (account.peakEquity <= 0) return 0;
  return Math.max(0, (account.peakEquity - currentEquity) / account.peakEquity);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
