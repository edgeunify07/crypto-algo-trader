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
  /**
   * Which engine opened it. Not inferable from `exitReason`, because a scalp
   * that is stopped out exits as `stop_loss` like anything else.
   */
  scalp?: boolean;
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

/**
 * The two books, each funded and measured on its own.
 *
 * The engines used to share one balance, carved by `scalp.capitalShare`. That
 * made them independent in slots but not in results: a swing drawdown shrank
 * what the scalp could size against, and one equity curve could not say which
 * engine earned or lost the money. Two accounts of their own make the
 * comparison the split exists for an actual measurement — each starts at the
 * same stake and is judged on what it does with it.
 */
export interface Books {
  swing: AccountState;
  scalp: AccountState;
}

export function newBooks(startingBalance = STARTING_BALANCE): Books {
  return { swing: newAccount(startingBalance), scalp: newAccount(startingBalance) };
}

/**
 * Read the books, migrating a single-account deployment on the way.
 *
 * Everything the old account traded was the swing engine's — the scalp was
 * switched off for all but the last few minutes of its life — so it becomes
 * the swing book unchanged, keeping its history, and the scalp starts fresh
 * at the same stake. Splitting one curve down the middle would invent a
 * past neither engine had.
 */
export function booksFrom(
  stored: Books | null | undefined,
  legacy: AccountState | null | undefined,
  startingBalance = STARTING_BALANCE,
): Books {
  if (stored?.swing && stored?.scalp) return { swing: { ...stored.swing }, scalp: { ...stored.scalp } };
  /**
   * Copied, never aliased.
   *
   * Returning `legacy` itself made the swing book and the combined account
   * the same object, so `syncCombined` summed the pair into one of its own
   * halves: the swing balance absorbed the scalp's stake on every call and
   * compounded, turning two $100 books into a $500 account in a few ticks.
   */
  if (legacy) return { swing: { ...legacy }, scalp: newAccount(startingBalance) };
  return newBooks(startingBalance);
}

/**
 * Refresh a combined view from the two books.
 *
 * The money fields are plain sums, recomputed rather than stored, so the
 * pair can never drift from its parts. Everything else — when the deployment
 * started, how many ticks it has run, the peak equity its curve is drawn
 * against — belongs to the pair and is kept as it was.
 */
export function syncCombined(combined: AccountState, books: Books): AccountState {
  // Summing into one of the halves being summed double-counts and compounds.
  // Loud here beats a balance that quietly grows by the other book's stake.
  if (combined === books.swing || combined === books.scalp) {
    throw new Error("syncCombined: the combined account must not be one of the books");
  }
  combined.balance = books.swing.balance + books.scalp.balance;
  combined.startingBalance = books.swing.startingBalance + books.scalp.startingBalance;
  combined.realisedPnl = books.swing.realisedPnl + books.scalp.realisedPnl;
  combined.totalFees = books.swing.totalFees + books.scalp.totalFees;
  combined.totalFunding = books.swing.totalFunding + books.scalp.totalFunding;
  // Halted only while neither engine may trade; one book sitting out is not
  // the deployment stopping.
  combined.haltedReason =
    books.swing.haltedReason && books.scalp.haltedReason
      ? `swing: ${books.swing.haltedReason}; scalp: ${books.scalp.haltedReason}`
      : null;
  return combined;
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
