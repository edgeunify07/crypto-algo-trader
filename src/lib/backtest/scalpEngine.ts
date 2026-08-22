import type { Candle } from "../types";
import type { Strategy } from "../strategies/types";
import type { AggTrade } from "../data/aggTrades";
import {
  aggTradesForBar,
  makerBuyFills,
  makerSellFills,
} from "../data/aggTrades";
import { intervalMs } from "../data/intervalMs";
import type { CandleInterval } from "../types";
import type { BacktestResult, CostModel, Trade } from "../backtest";
import { BINANCE_SPOT_COSTS } from "../backtest";
import { evaluateStrategyDetail, BACKTEST_KEY, type ContextKey } from "../engine/signals";

export interface ScalpBacktestOptions {
  startEquity: number;
  interval: CandleInterval;
  maxHoldBars?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
  targetPct?: number;
  stopPct?: number;
  spreadBps?: number;
  aggTrades: AggTrade[];
  klineOnly?: boolean;
  contextKey?: ContextKey;
}

export interface ScalpBacktestMeta {
  klineOnly: boolean;
  makerFills: number;
  takerFills: number;
  abandonedEntries: number;
  makerFillRatio: number;
  maxHoldExits: number;
}

const DEFAULT_MAX_HOLD = 15;

function closeTrade(
  trades: Trade[],
  entry: {
    entryTime: number; entryBar: number; entryPrice: number; qty: number;
    entryFee: number; entrySlippage: number; entryReason: string;
  },
  exitBar: number,
  exitTime: number,
  exitPrice: number,
  exitFee: number,
  exitReason: string,
): number {
  const exitNotional = entry.qty * exitPrice;
  const entryNotional = entry.qty * entry.entryPrice;
  const grossPnl = exitNotional - entryNotional;
  const pnl = exitNotional - exitFee - entryNotional - entry.entryFee;
  trades.push({
    entryTime: entry.entryTime,
    exitTime,
    entryBar: entry.entryBar,
    exitBar,
    entryPrice: entry.entryPrice,
    exitPrice,
    qty: entry.qty,
    entryNotional,
    exitNotional,
    entryFee: entry.entryFee,
    exitFee,
    slippageCost: entry.entrySlippage,
    grossPnl,
    pnl,
    returnPct: entryNotional > 0 ? (pnl / entryNotional) * 100 : 0,
    side: "long",
    entryAction: "BUY",
    exitAction: "SELL",
    entryReason: entry.entryReason,
    exitReason,
  });
  return exitNotional - exitFee;
}

/** Scalp backtest with aggTrade replay, maker-first, no chase, max-hold timeout. */
export function backtestScalp(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  opts: ScalpBacktestOptions,
): BacktestResult & { scalpMeta: ScalpBacktestMeta } {
  const costs: CostModel = {
    ...BINANCE_SPOT_COSTS,
    feeRate: opts.makerFeeRate ?? 0.0002,
  };
  const maxHold = opts.maxHoldBars ?? params.maxHoldBars ?? DEFAULT_MAX_HOLD;
  const targetPct = opts.targetPct ?? params.targetPct ?? 0.002;
  const stopPct = opts.stopPct ?? params.stopPct ?? 0.001;
  const takerFee = opts.takerFeeRate ?? 0.0005;
  const spread = (opts.spreadBps ?? 5) / 10_000;
  const barMs = intervalMs(opts.interval);
  const ctxKey = opts.contextKey ?? BACKTEST_KEY;

  let cash = opts.startEquity;
  let meta: ScalpBacktestMeta = {
    klineOnly: opts.klineOnly ?? opts.aggTrades.length === 0,
    makerFills: 0,
    takerFills: 0,
    abandonedEntries: 0,
    makerFillRatio: 0,
    maxHoldExits: 0,
  };

  if (candles.length < 2) {
    return { ...emptyScalp(strategy.id, opts.startEquity, candles), scalpMeta: meta };
  }

  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let peakEquity = opts.startEquity;
  let maxDrawdownPct = 0;
  let totalFeesPaid = 0;

  type Pos = {
    entryTime: number; entryBar: number; entryPrice: number; qty: number;
    entryFee: number; entrySlippage: number; entryReason: string;
    stop: number; target: number;
  };
  let pos: Pos | null = null;
  let pendingBuy: { bar: number; reason: string; limitPrice: number } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const barCloseSec = bar.closeTime ?? bar.time + barMs / 1000 - 1;
    const barTrades = aggTradesForBar(opts.aggTrades, bar.time, barCloseSec);

    // Try fill pending maker buy at bar open — never chase across spread
    if (pendingBuy && pendingBuy.bar + 1 === i && !pos) {
      const limit = pendingBuy.limitPrice;
      const filled = meta.klineOnly
        ? bar.low <= limit
        : makerBuyFills(barTrades, limit);
      if (filled) {
        const fee = cash * costs.feeRate;
        const qty = (cash - fee) / limit;
        pos = {
          entryTime: bar.time,
          entryBar: i,
          entryPrice: limit,
          qty,
          entryFee: fee,
          entrySlippage: 0,
          entryReason: pendingBuy.reason,
          stop: limit * (1 - stopPct),
          target: limit * (1 + targetPct),
        };
        totalFeesPaid += fee;
        cash = 0;
        meta.makerFills++;
      } else {
        meta.abandonedEntries++;
      }
      pendingBuy = null;
    }

    // In-position: check stop/target via aggTrade replay (pessimistic)
    if (pos) {
      const held = i - pos.entryBar;
      let exitPrice: number | null = null;
      let exitReason = "";

      if (!meta.klineOnly && barTrades.length > 0) {
        const sorted = [...barTrades].sort((a, b) => a.time - b.time);
        for (const t of sorted) {
          if (t.price <= pos.stop) { exitPrice = pos.stop; exitReason = "SL"; break; }
          if (t.price >= pos.target) { exitPrice = pos.target; exitReason = "TP"; break; }
        }
      } else if (meta.klineOnly) {
        // Pessimistic kline: stop before target if both possible
        if (bar.low <= pos.stop) { exitPrice = pos.stop; exitReason = "SL-kline"; }
        else if (bar.high >= pos.target) { exitPrice = pos.target; exitReason = "TP-kline"; }
      }

      if (held >= maxHold && !exitPrice) {
        exitPrice = bar.close * (1 - spread);
        exitReason = "max-hold";
        meta.maxHoldExits++;
        meta.takerFills++;
      }

      const { signal } = evaluateStrategyDetail(strategy.id, candles, i, "long", params, ctxKey);
      if (!exitPrice && signal === "sell") {
        const limit = bar.close * (1 - spread);
        const sold = meta.klineOnly ? bar.high >= limit : makerSellFills(barTrades, limit);
        if (sold) {
          exitPrice = limit;
          exitReason = "signal";
          meta.makerFills++;
        }
      }

      if (exitPrice != null) {
        const fee = pos.qty * exitPrice * (exitReason === "max-hold" ? takerFee : costs.feeRate);
        totalFeesPaid += fee;
        cash = closeTrade(trades, pos, i, bar.time, exitPrice, fee, exitReason);
        pos = null;
      }
    }

    const mark = pos ? pos.qty * bar.close : cash;
    equityCurve.push({ time: bar.time, equity: mark });
    if (mark > peakEquity) peakEquity = mark;
    const dd = peakEquity > 0 ? ((peakEquity - mark) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    if (i < candles.length - 1 && !pos && !pendingBuy) {
      const { signal, reason } = evaluateStrategyDetail(strategy.id, candles, i, "flat", params, ctxKey);
      if (signal === "buy") {
        const limit = bar.close * (1 - spread);
        pendingBuy = { bar: i, reason: reason ?? (params.mode >= 1 ? "scalp" : "swing"), limitPrice: limit };
      }
    }
  }

  const lastClose = candles[candles.length - 1].close;
  const endEquity = pos ? pos.qty * lastClose : cash;
  const totalFills = meta.makerFills + meta.takerFills;
  meta.makerFillRatio = totalFills > 0 ? meta.makerFills / totalFills : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    strategyId: strategy.id,
    startEquity: opts.startEquity,
    endEquity,
    endEquityAfterTax: endEquity,
    totalReturnPct: ((endEquity - opts.startEquity) / opts.startEquity) * 100,
    buyHoldReturnPct: candles.length > 1 ? ((lastClose - candles[0].open) / candles[0].open) * 100 : 0,
    trades,
    numTrades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0,
    maxDrawdownPct,
    totalFeesPaid,
    totalSlippagePaid: 0,
    totalTdsPaid: 0,
    equityCurve,
    scalpMeta: meta,
  };
}

function emptyScalp(strategyId: string, startEquity: number, candles: Candle[]): BacktestResult {
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
