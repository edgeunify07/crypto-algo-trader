import type { Candle } from "./types";
import type { Strategy } from "./strategies/types";
import { evaluateStrategyDetail, BACKTEST_KEY, type ContextKey } from "./engine/signals";
import { computeProtection } from "./engine/protection";
import { type CostModel, INDIA_SPOT_COSTS, BINANCE_SPOT_COSTS } from "./costs";

export { type CostModel, INDIA_SPOT_COSTS, BINANCE_SPOT_COSTS };

/**
 * Exit rules applied in addition to the strategy's own reversal signal.
 * These MUST mirror what the live runner does (see engine/protection.ts), or the
 * backtest measures a strategy the bot will never actually trade.
 */
export interface ExitPolicy {
  /** ATR multiple for the protective stop. Omit to disable bracket exits. */
  stopLossAtrMult?: number;
  /** Take-profit as a multiple of the stop distance. */
  takeProfitRr?: number;
  atrPeriod?: number;
  /** Force an exit after this many bars in position. 0/undefined = no limit. */
  maxHoldBars?: number;
  /** Also exit on the strategy's reversal signal (default true). */
  useSignalExit?: boolean;
}

/** Mirrors the live bot's default protection (protection.ts). */
export const LIVE_EXIT_POLICY: ExitPolicy = {
  stopLossAtrMult: 2,
  takeProfitRr: 1.5,
  atrPeriod: 14,
  useSignalExit: true,
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
  exitPolicy?: ExitPolicy,
): BacktestResult {
  if (candles.length < 2) {
    return emptyResult(strategy.id, startEquity, candles);
  }

  const bracketOn = !!exitPolicy?.stopLossAtrMult;
  const useSignalExit = exitPolicy?.useSignalExit ?? true;
  const maxHoldBars = exitPolicy?.maxHoldBars ?? 0;

  let cash = startEquity;
  let qty = 0;
  let position: "long" | "flat" = "flat";
  let entryPrice = 0;
  let entryTime = 0;
  let entryBar = 0;
  let entryFee = 0;
  let entrySlippage = 0;
  let stopLevel = 0;
  let targetLevel = 0;

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

  /**
   * Close the open long at `rawExitPrice`, booking fees, slippage and the trade.
   * Used by signal exits, bracket (stop/target) exits and the final force-close
   * so all three paths account identically.
   */
  function recordExit(rawExitPrice: number, bar: Candle, i: number, reason: string) {
    const px = fillPrice(rawExitPrice, "sell", costs.slippageRate);
    const slipCost = qty * (rawExitPrice - px);
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
      exitReason: reason,
    });
    cash = proceeds;
    qty = 0;
    position = "flat";
    openEntryReason = undefined;
  }

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
      // Attach the same protection the live bot uses, so the backtest models the
      // policy that will actually trade. Computed from bars up to entry only.
      stopLevel = 0;
      targetLevel = 0;
      if (bracketOn) {
        const prot = computeProtection(candles, i, entryPrice, {
          stopLossAtrMult: exitPolicy?.stopLossAtrMult,
          takeProfitRr: exitPolicy?.takeProfitRr,
          atrPeriod: exitPolicy?.atrPeriod,
        });
        if (prot) {
          stopLevel = prot.stopLoss;
          targetLevel = prot.takeProfit;
        }
      }
    } else if (pending === "sell" && position === "long" && i === signalBar + 1) {
      recordExit(bar.open, bar, i, pendingReason ?? "signal");
      pending = null;
      pendingReason = undefined;
    }

    // Bracket exits. The entry filled at this bar's open, so the remainder of the
    // bar is legitimately after the fill and may be tested.
    // Pessimistic on purpose: if both levels are touchable in one bar we assume
    // the STOP filled first, and a gap through the stop fills at the open (worse),
    // while a gap through the target never fills better than the target.
    if (position === "long" && (stopLevel > 0 || targetLevel > 0)) {
      const barsHeld = i - entryBar;
      if (stopLevel > 0 && bar.low <= stopLevel) {
        recordExit(Math.min(stopLevel, bar.open), bar, i, "stop-loss");
        pending = null;
        pendingReason = undefined;
      } else if (targetLevel > 0 && bar.high >= targetLevel) {
        recordExit(targetLevel, bar, i, "take-profit");
        pending = null;
        pendingReason = undefined;
      } else if (maxHoldBars > 0 && barsHeld >= maxHoldBars) {
        recordExit(bar.close, bar, i, "max-hold");
        pending = null;
        pendingReason = undefined;
      }
    }

    // Mark to market. Drawdown uses the bar LOW while long: a close-only curve
    // understates the drawdown a real account actually experiences.
    const mark = position === "long" ? qty * bar.close : cash;
    const markLow = position === "long" ? qty * bar.low : cash;
    equityCurve.push({ time: bar.time, equity: mark });
    if (mark > peakEquity) peakEquity = mark;
    const dd = peakEquity > 0 ? ((peakEquity - markLow) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    // Signal on completed bar i → queue fill for bar i+1
    if (i < candles.length - 1 && pending === null) {
      const { signal, reason } = evaluateStrategyDetail(strategy.id, candles, i, position, params, contextKey);
      if (signal === "buy" && position === "flat") {
        pending = "buy";
        signalBar = i;
        pendingReason = reason ?? "confluence";
      } else if (signal === "sell" && position === "long" && useSignalExit) {
        pending = "sell";
        signalBar = i;
        pendingReason = reason ?? "exit-signal";
      }
    }
  }

  const lastBar = candles[candles.length - 1];
  // Force-close any open long at the last bar close so return/trades reflect
  // realized P&L after fees. Without this, an open position hides its outcome
  // from winRate/expectancy entirely.
  if (position === "long" && qty > 0) {
    recordExit(lastBar.close, lastBar, candles.length - 1, "eod-close");
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
