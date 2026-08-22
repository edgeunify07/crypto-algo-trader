import type { Candle } from "./types";
import type { Strategy } from "./strategies/types";
import { evaluateStrategyDetail, BACKTEST_KEY, type ContextKey } from "./engine/signals";

export interface CostModel {
  /** Exchange fee per trade side, as a fraction (0.001 = 0.1%). Applied to fill notional. */
  feeRate: number;
  /** Slippage per side as a fraction of price (0.0005 = 5 bps). Buys pay more, sells receive less. */
  slippageRate: number;
  /** Legacy India TDS on sell proceeds (fraction). Binance spot = 0. */
  tdsRate: number;
  /** Post-run capital gains tax on net profit (fraction). Not auto-applied for Binance. */
  capitalGainsRate: number;
}

export const INDIA_SPOT_COSTS: CostModel = {
  feeRate: 0.005,
  tdsRate: 0.01,
  capitalGainsRate: 0.3,
  slippageRate: 0.001,
};

export const BINANCE_SPOT_COSTS: CostModel = {
  feeRate: 0.001,
  tdsRate: 0,
  capitalGainsRate: 0,
  slippageRate: 0.0005,
};

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryNotional: number;
  exitNotional: number;
  entryFee: number;
  exitFee: number;
  slippageCost: number;
  grossPnl: number;
  pnl: number;
  returnPct: number;
  /** Spot long-only: BUY opens, SELL closes — no short selling. */
  side: "long";
  entryAction: "BUY";
  exitAction: "SELL";
  entryReason?: string;
  exitReason?: string;
}

export interface BacktestResult {
  strategyId: string;
  startEquity: number;
  endEquity: number;
  endEquityAfterTax: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  trades: Trade[];
  numTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  totalFeesPaid: number;
  totalSlippagePaid: number;
  totalTdsPaid: number;
  equityCurve: { time: number; equity: number }[];
}

function fillPrice(open: number, side: "buy" | "sell", slippageRate: number): number {
  return side === "buy" ? open * (1 + slippageRate) : open * (1 - slippageRate);
}

/**
 * Long/flat spot backtest. Signals are evaluated on the **close** of bar i;
 * fills execute at the **open** of bar i+1 (realistic, no lookahead).
 * Fees: feeRate × (qty × fillPrice) on each side.
 */
export function backtest(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  startEquity = 10_000,
  costs: CostModel = BINANCE_SPOT_COSTS,
  contextKey: ContextKey = BACKTEST_KEY,
): BacktestResult {
  if (candles.length < 2) {
    return emptyResult(strategy.id, startEquity, candles, costs);
  }

  let cash = startEquity;
  let qty = 0;
  let position: "long" | "flat" = "flat";
  let entryPrice = 0;
  let entryTime = 0;
  let entryBar = 0;
  let entryFee = 0;
  let entrySlippage = 0;

  let pending: "buy" | "sell" | null = null;
  let signalBar = -1;
  let pendingReason: string | undefined;
  let openEntryReason: string | undefined;

  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let totalFeesPaid = 0;
  let totalSlippagePaid = 0;
  let totalTdsPaid = 0;
  let peakEquity = startEquity;
  let maxDrawdownPct = 0;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // Execute pending order at this bar's open (signal was on prior bar's close)
    if (pending === "buy" && position === "flat" && i === signalBar + 1) {
      const px = fillPrice(bar.open, "buy", costs.slippageRate);
      const notional = cash;
      const fee = notional * costs.feeRate;
      qty = (notional - fee) / px;
      const slipCost = qty * (px - bar.open);
      entryPrice = px;
      entryTime = bar.time;
      entryBar = i;
      entryFee = fee;
      entrySlippage = slipCost;
      totalFeesPaid += fee;
      totalSlippagePaid += slipCost;
      cash = 0;
      position = "long";
      pending = null;
      openEntryReason = pendingReason;
      pendingReason = undefined;
    } else if (pending === "sell" && position === "long" && i === signalBar + 1) {
      const px = fillPrice(bar.open, "sell", costs.slippageRate);
      const slipCost = qty * (bar.open - px);
      const exitNotional = qty * px;
      const fee = exitNotional * costs.feeRate;
      const tds = exitNotional * costs.tdsRate;
      totalFeesPaid += fee;
      totalTdsPaid += tds;
      totalSlippagePaid += slipCost;
      const proceeds = exitNotional - fee - tds;
      const entryNotional = qty * entryPrice;
      const grossPnl = exitNotional - entryNotional;
      const pnl = proceeds - entryNotional - entryFee;
      trades.push({
        entryTime,
        exitTime: bar.time,
        entryBar,
        exitBar: i,
        entryPrice,
        exitPrice: px,
        qty,
        entryNotional,
        exitNotional,
        entryFee,
        exitFee: fee,
        slippageCost: entrySlippage + slipCost,
        grossPnl,
        pnl,
        returnPct: entryNotional > 0 ? (pnl / entryNotional) * 100 : 0,
        side: "long",
        entryAction: "BUY",
        exitAction: "SELL",
        entryReason: openEntryReason ?? "signal",
        exitReason: pendingReason ?? "signal",
      });
      cash = proceeds;
      qty = 0;
      position = "flat";
      pending = null;
      openEntryReason = undefined;
      pendingReason = undefined;
    }

    const mark = position === "long" ? qty * bar.close : cash;
    equityCurve.push({ time: bar.time, equity: mark });
    if (mark > peakEquity) peakEquity = mark;
    const dd = peakEquity > 0 ? ((peakEquity - mark) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    // Signal on completed bar i → queue fill for bar i+1
    if (i < candles.length - 1 && pending === null) {
      const { signal, reason } = evaluateStrategyDetail(strategy.id, candles, i, position, params, contextKey);
      if (signal === "buy" && position === "flat") {
        pending = "buy";
        signalBar = i;
        pendingReason = reason ?? "confluence";
      } else if (signal === "sell" && position === "long") {
        pending = "sell";
        signalBar = i;
        pendingReason = reason ?? "exit-signal";
      }
    }
  }

  const lastBar = candles[candles.length - 1];
  // Force-close any open long at last bar close so return/trades reflect realized P&L after fees
  if (position === "long" && qty > 0) {
    const px = fillPrice(lastBar.close, "sell", costs.slippageRate);
    const slipCost = qty * (lastBar.close - px);
    const exitNotional = qty * px;
    const fee = exitNotional * costs.feeRate;
    const tds = exitNotional * costs.tdsRate;
    totalFeesPaid += fee;
    totalTdsPaid += tds;
    totalSlippagePaid += slipCost;
    const proceeds = exitNotional - fee - tds;
    const entryNotional = qty * entryPrice;
    const grossPnl = exitNotional - entryNotional;
    const pnl = proceeds - entryNotional - entryFee;
    trades.push({
      entryTime,
      exitTime: lastBar.time,
      entryBar,
      exitBar: candles.length - 1,
      entryPrice,
      exitPrice: px,
      qty,
      entryNotional,
      exitNotional,
      entryFee,
      exitFee: fee,
      slippageCost: entrySlippage + slipCost,
      grossPnl,
      pnl,
      returnPct: entryNotional > 0 ? (pnl / entryNotional) * 100 : 0,
      side: "long",
      entryAction: "BUY",
      exitAction: "SELL",
      entryReason: openEntryReason ?? "signal",
      exitReason: "eod-close",
    });
    cash = proceeds;
    qty = 0;
    position = "flat";
  }

  const lastClose = lastBar.close;
  const endEquity = cash;
  const netProfit = endEquity - startEquity;
  const tax = netProfit > 0 ? netProfit * costs.capitalGainsRate : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectancy = trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;

  const firstOpen = candles[0].open;
  const buyHoldReturnPct = firstOpen > 0 ? ((lastClose - firstOpen) / firstOpen) * 100 : 0;

  return {
    strategyId: strategy.id,
    startEquity,
    endEquity,
    endEquityAfterTax: endEquity - tax,
    totalReturnPct: (netProfit / startEquity) * 100,
    buyHoldReturnPct,
    trades,
    numTrades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor,
    expectancy,
    maxDrawdownPct,
    totalFeesPaid,
    totalSlippagePaid,
    totalTdsPaid,
    equityCurve,
  };
}

function emptyResult(
  strategyId: string,
  startEquity: number,
  candles: Candle[],
  costs: CostModel,
): BacktestResult {
  return {
    strategyId,
    startEquity,
    endEquity: startEquity,
    endEquityAfterTax: startEquity,
    totalReturnPct: 0,
    buyHoldReturnPct: 0,
    trades: [],
    numTrades: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdownPct: 0,
    totalFeesPaid: 0,
    totalSlippagePaid: 0,
    totalTdsPaid: 0,
    equityCurve: candles.map((c) => ({ time: c.time, equity: startEquity })),
  };
}
