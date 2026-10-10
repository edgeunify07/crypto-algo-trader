import type {
  AccountSnapshot,
  ClosedTrade,
  ExitReason,
  Fill,
  Position,
  Side,
  TradePlan,
} from "../types.js";
import { config } from "../config.js";

/**
 * Paper-trading broker.
 *
 * Fills are modelled the way a market order actually behaves: the price moves
 * against you by `slippageRate` and you pay `feeRate` on both sides. Backtest
 * and real-time paper trading share this exact class, so a strategy validated
 * on history is scored on identical mechanics when it runs live.
 *
 * Shorts are modelled as cash-settled: the proceeds are credited at entry and
 * the buy-back is debited at exit. On a spot-only Binance account you'd set
 * `allowShorts: false`, but the simulation supports them for margin/futures
 * parity and because the screener itself is direction-agnostic.
 */
export interface PaperBrokerOptions {
  startingCash?: number;
  feeRate?: number;
  slippageRate?: number;
}

export class PaperBroker {
  private cash: number;
  private readonly feeRate: number;
  private readonly slippageRate: number;
  private readonly positions = new Map<string, Position>();
  private readonly trades: ClosedTrade[] = [];
  private readonly fills: Fill[] = [];
  private readonly equityCurve: AccountSnapshot[] = [];
  private realisedPnl = 0;
  private orderSeq = 0;
  private peakEquity: number;
  private dayStartEquity: number;
  private dayStamp: string;

  constructor(
    private readonly startingCash = config.account.startingCash,
    options: PaperBrokerOptions = {},
  ) {
    this.cash = options.startingCash ?? startingCash;
    this.feeRate = options.feeRate ?? config.account.feeRate;
    this.slippageRate = options.slippageRate ?? config.account.slippageRate;
    this.peakEquity = this.cash;
    this.dayStartEquity = this.cash;
    this.dayStamp = "";
  }

  get openPositions(): Position[] {
    return [...this.positions.values()];
  }

  get closedTrades(): readonly ClosedTrade[] {
    return this.trades;
  }

  get allFills(): readonly Fill[] {
    return this.fills;
  }

  get curve(): readonly AccountSnapshot[] {
    return this.equityCurve;
  }

  get availableCash(): number {
    return this.cash;
  }

  position(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  /** Price actually paid/received after modelled slippage. */
  private fillPrice(price: number, side: "buy" | "sell"): number {
    return side === "buy"
      ? price * (1 + this.slippageRate)
      : price * (1 - this.slippageRate);
  }

  /** Mark-to-market equity at the supplied prices. */
  equity(prices: Map<string, number>): number {
    let value = this.cash;
    for (const position of this.positions.values()) {
      const price = prices.get(position.symbol) ?? position.entryPrice;
      if (position.side === "long") {
        value += position.quantity * price;
      } else {
        // Short proceeds were already credited; buying back costs quantity*price.
        value -= position.quantity * price;
      }
    }
    return value;
  }

  unrealised(prices: Map<string, number>): number {
    let pnl = 0;
    for (const position of this.positions.values()) {
      const price = prices.get(position.symbol) ?? position.entryPrice;
      pnl +=
        position.side === "long"
          ? (price - position.entryPrice) * position.quantity
          : (position.entryPrice - price) * position.quantity;
    }
    return pnl;
  }

  /** Open a position from a trade plan. Returns null when it can't be funded. */
  open(
    plan: TradePlan,
    time: number,
    options: { paramsVersion?: string; tags?: string[] } = {},
  ): Position | null {
    if (this.positions.has(plan.symbol)) return null;
    if (!(plan.quantity > 0)) return null;

    const side: Side = plan.side;
    const orderSide = side === "long" ? "buy" : "sell";
    const price = this.fillPrice(plan.entry, orderSide);
    const notional = price * plan.quantity;
    const fee = notional * this.feeRate;

    if (side === "long") {
      if (notional + fee > this.cash) return null;
      this.cash -= notional + fee;
    } else {
      // Short: credit proceeds, debit fee. Cash must cover the fee.
      if (fee > this.cash + notional) return null;
      this.cash += notional - fee;
    }

    const orderId = `paper-${++this.orderSeq}`;
    this.fills.push({
      orderId,
      symbol: plan.symbol,
      side: orderSide,
      quantity: plan.quantity,
      price,
      fee,
      time,
    });

    const position: Position = {
      symbol: plan.symbol,
      side,
      quantity: plan.quantity,
      entryPrice: price,
      openedAt: time,
      stopLoss: plan.stopLoss,
      takeProfits: plan.takeProfits.map((tp) => ({ ...tp, hit: false })),
      extreme: price,
      feesPaid: fee,
      timeframe: plan.timeframe,
      paramsVersion: options.paramsVersion ?? "unknown",
      tags: options.tags ?? [],
    };
    this.positions.set(plan.symbol, position);
    return position;
  }

  /** Close all or part of a position. `fraction` is of the *original* size. */
  close(
    symbol: string,
    price: number,
    time: number,
    reason: ExitReason,
    fraction = 1,
  ): ClosedTrade | null {
    const position = this.positions.get(symbol);
    if (!position) return null;

    const quantity = Math.min(position.quantity, position.quantity * Math.min(1, fraction));
    if (!(quantity > 0)) return null;

    const orderSide = position.side === "long" ? "sell" : "buy";
    const fillPrice = this.fillPrice(price, orderSide);
    const notional = fillPrice * quantity;
    const fee = notional * this.feeRate;

    if (position.side === "long") {
      this.cash += notional - fee;
    } else {
      this.cash -= notional + fee;
    }

    const orderId = `paper-${++this.orderSeq}`;
    this.fills.push({
      orderId,
      symbol,
      side: orderSide,
      quantity,
      price: fillPrice,
      fee,
      time,
    });

    const grossPnl =
      position.side === "long"
        ? (fillPrice - position.entryPrice) * quantity
        : (position.entryPrice - fillPrice) * quantity;
    // Entry fee is apportioned to the slice being closed.
    const entryFeeShare = position.feesPaid * (quantity / position.quantity);
    const pnl = grossPnl - fee - entryFeeShare;
    this.realisedPnl += pnl;

    const riskPerUnit = Math.abs(position.entryPrice - position.stopLoss);
    const trade: ClosedTrade = {
      symbol,
      side: position.side,
      timeframe: position.timeframe,
      quantity,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      openedAt: position.openedAt,
      closedAt: time,
      pnl,
      pnlPct: position.entryPrice === 0 ? 0 : grossPnl / (position.entryPrice * quantity),
      rMultiple: riskPerUnit > 0 ? grossPnl / (riskPerUnit * quantity) : 0,
      fees: fee + entryFeeShare,
      exitReason: reason,
      paramsVersion: position.paramsVersion,
      tags: position.tags,
    };
    this.trades.push(trade);

    position.quantity -= quantity;
    position.feesPaid -= entryFeeShare;
    if (position.quantity <= 1e-12) {
      this.positions.delete(symbol);
    }
    return trade;
  }

  /** Track the favourable extreme, which drives trailing stops. */
  updateExtreme(symbol: string, high: number, low: number): void {
    const position = this.positions.get(symbol);
    if (!position) return;
    position.extreme =
      position.side === "long"
        ? Math.max(position.extreme, high)
        : Math.min(position.extreme, low);
  }

  setStop(symbol: string, stopLoss: number): void {
    const position = this.positions.get(symbol);
    if (position) position.stopLoss = stopLoss;
  }

  markTakeProfitHit(symbol: string, price: number): void {
    const position = this.positions.get(symbol);
    if (!position) return;
    for (const tp of position.takeProfits) {
      if (tp.price === price) tp.hit = true;
    }
  }

  /** Record an equity snapshot. Also maintains peak and day-start equity. */
  snapshot(time: number, prices: Map<string, number>): AccountSnapshot {
    const equity = this.equity(prices);
    this.peakEquity = Math.max(this.peakEquity, equity);

    const day = new Date(time).toISOString().slice(0, 10);
    if (day !== this.dayStamp) {
      this.dayStamp = day;
      this.dayStartEquity = equity;
    }

    const snap: AccountSnapshot = {
      time,
      equity,
      cash: this.cash,
      unrealisedPnl: this.unrealised(prices),
      realisedPnl: this.realisedPnl,
      openPositions: this.positions.size,
    };
    this.equityCurve.push(snap);
    return snap;
  }

  /** Drawdown from peak equity, as a fraction. */
  drawdown(prices: Map<string, number>): number {
    const equity = this.equity(prices);
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, (this.peakEquity - equity) / this.peakEquity);
  }

  /** Today's loss as a positive fraction of day-start equity. */
  dailyLoss(prices: Map<string, number>): number {
    if (this.dayStartEquity <= 0) return 0;
    const equity = this.equity(prices);
    return Math.max(0, (this.dayStartEquity - equity) / this.dayStartEquity);
  }

  reset(): void {
    this.cash = this.startingCash;
    this.positions.clear();
    this.trades.length = 0;
    this.fills.length = 0;
    this.equityCurve.length = 0;
    this.realisedPnl = 0;
    this.peakEquity = this.startingCash;
    this.dayStartEquity = this.startingCash;
    this.dayStamp = "";
  }

  /** Position lookup for persistence/reporting. */
  toJSON(): {
    cash: number;
    realisedPnl: number;
    positions: Position[];
    trades: ClosedTrade[];
  } {
    return {
      cash: this.cash,
      realisedPnl: this.realisedPnl,
      positions: this.openPositions,
      trades: [...this.trades],
    };
  }

  /** Restore state saved by `toJSON` (used when the live loop restarts). */
  restore(state: {
    cash: number;
    realisedPnl: number;
    positions: Position[];
    trades: ClosedTrade[];
  }): void {
    this.cash = state.cash;
    this.realisedPnl = state.realisedPnl;
    this.positions.clear();
    for (const p of state.positions) this.positions.set(p.symbol, p);
    this.trades.length = 0;
    this.trades.push(...state.trades);
    this.peakEquity = Math.max(this.cash, this.startingCash);
  }
}
