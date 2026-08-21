import type { Candle } from "./types";
import type { Strategy } from "./strategies/types";

export interface CostModel {
  /** Exchange fee per trade side, as a fraction (0.005 = 0.5%). */
  feeRate: number;
  /**
   * India TDS: 1% deducted at source on every SELL of a VDA (fraction 0.01).
   * This is the killer for high-frequency spot strategies — modelled here so
   * backtests reflect reality, not a fantasy fee-free curve.
   */
  tdsRate: number;
  /** Flat 30% tax on net profit at the end (fraction 0.30). Applied post-run. */
  capitalGainsRate: number;
}

export const INDIA_SPOT_COSTS: CostModel = {
  feeRate: 0.005, // 0.5% typical CoinDCX spot taker
  tdsRate: 0.01, // 1% TDS on every sell
  capitalGainsRate: 0.3, // 30% flat on gains
};

// Binance global spot: no Indian TDS deducted at source, low taker fee.
// (Your personal tax obligation as a resident is separate — see notes.)
export const BINANCE_SPOT_COSTS: CostModel = {
  feeRate: 0.001, // 0.1% taker
  tdsRate: 0, // no per-trade TDS
  capitalGainsRate: 0, // not auto-applied; report per your jurisdiction
};

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number; // net of fees + TDS, in quote currency
  returnPct: number;
}

export interface BacktestResult {
  strategyId: string;
  startEquity: number;
  endEquity: number; // before capital-gains tax
  endEquityAfterTax: number; // after 30% on net profit
  totalReturnPct: number;
  buyHoldReturnPct: number;
  trades: Trade[];
  numTrades: number;
  winRate: number;
  maxDrawdownPct: number;
  totalFeesPaid: number;
  totalTdsPaid: number;
  equityCurve: { time: number; equity: number }[];
}

/**
 * Long/flat spot backtest (no shorting, no leverage — matches Indian spot
 * reality). All-in / all-out sizing for simplicity. Costs are applied on every
 * fill so the resulting P&L is honest about Indian trading friction.
 */
export function backtest(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  startEquity = 100_000, // ₹1,00,000
  costs: CostModel = BINANCE_SPOT_COSTS,
): BacktestResult {
  let cash = startEquity;
  let qty = 0;
  let position: "long" | "flat" = "flat";
  let entryPrice = 0;
  let entryTime = 0;

  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let totalFeesPaid = 0;
  let totalTdsPaid = 0;
  let peakEquity = startEquity;
  let maxDrawdownPct = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const signal = strategy.next({ candles, index: i, position }, params);
    const price = candle.close;

    if (signal === "buy" && position === "flat") {
      // Spend all cash; fee reduces the quantity we receive.
      const fee = cash * costs.feeRate;
      totalFeesPaid += fee;
      qty = (cash - fee) / price;
      cash = 0;
      position = "long";
      entryPrice = price;
      entryTime = candle.time;
    } else if (signal === "sell" && position === "long") {
      const gross = qty * price;
      const fee = gross * costs.feeRate;
      const tds = gross * costs.tdsRate; // 1% TDS on sell proceeds
      totalFeesPaid += fee;
      totalTdsPaid += tds;
      const proceeds = gross - fee - tds;
      const costBasis = qty * entryPrice;
      const pnl = proceeds - costBasis;
      trades.push({
        entryTime,
        exitTime: candle.time,
        entryPrice,
        exitPrice: price,
        qty,
        pnl,
        returnPct: (pnl / costBasis) * 100,
      });
      cash = proceeds;
      qty = 0;
      position = "flat";
    }

    const equity = position === "long" ? qty * price : cash;
    equityCurve.push({ time: candle.time, equity });
    if (equity > peakEquity) peakEquity = equity;
    const dd = ((peakEquity - equity) / peakEquity) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Mark-to-market any open position at the last close (no exit costs applied
  // until actually sold — those would hit on exit).
  const lastPrice = candles[candles.length - 1]?.close ?? 0;
  const endEquity = position === "long" ? qty * lastPrice : cash;

  const netProfit = endEquity - startEquity;
  const tax = netProfit > 0 ? netProfit * costs.capitalGainsRate : 0;
  const endEquityAfterTax = endEquity - tax;

  const wins = trades.filter((t) => t.pnl > 0).length;
  const buyHold =
    candles.length > 1
      ? ((lastPrice - candles[0].close) / candles[0].close) * 100
      : 0;

  return {
    strategyId: strategy.id,
    startEquity,
    endEquity,
    endEquityAfterTax,
    totalReturnPct: (netProfit / startEquity) * 100,
    buyHoldReturnPct: buyHold,
    trades,
    numTrades: trades.length,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    maxDrawdownPct,
    totalFeesPaid,
    totalTdsPaid,
    equityCurve,
  };
}
