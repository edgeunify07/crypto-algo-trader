import type { Candle } from "../types";
import type { Strategy } from "../strategies/types";
import type { AggTrade } from "../data/aggTrades";
import { aggTradesForBar } from "../data/aggTrades";
import { intervalMs } from "../data/intervalMs";
import type { CandleInterval } from "../types";
import type { BacktestResult, CostModel, Trade } from "../backtest";
import { BINANCE_SPOT_COSTS } from "../backtest";
import { MIN_TARGET_PCT } from "../engine/protection";
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
  /** True when the take-profit target was clamped up to the cost floor. */
  widenedForCost: boolean;
}

const DEFAULT_MAX_HOLD = 15;
/** Degenerate-input fallback only (see MIN_STOP_PCT in engine/protection.ts). */
const DEFAULT_STOP_PCT = 0.006;

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
  exitSlippage: number,
  exitReason: string,
): number {
  // `exitPrice` is already the executed price: for taker exits the slippage is
  // baked into a worse price (see caller), so pnl needs no extra slippage term —
  // `exitSlippage` is carried only for reporting. Mirrors backtest.ts recordExit.
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
    slippageCost: entry.entrySlippage + exitSlippage,
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

/**
 * Scalp backtest: maker-limit entry, tight bracket exits, max-hold timeout.
 *
 * Accounting mirrors backtest.ts so scalp and swing numbers are comparable:
 *  - maker legs (resting limit entry, resting take-profit) pay the maker fee and
 *    zero slippage (the honest maker advantage);
 *  - taker legs (stop-loss, max-hold, signal exit, forced close) cross the spread
 *    and pay the taker fee + slippage;
 *  - the take-profit is clamped up to the round-trip cost floor (MIN_TARGET_PCT),
 *    since a target below it is a guaranteed net loss booked as a fake win;
 *  - a gap through the stop fills at the worse (open / actual-trade) price;
 *  - the final open position is force-closed so win rate/expectancy include it.
 *
 * NOTE ON CONGRUENCE: this models a maker/tight-bracket strategy the LIVE bot
 * does not execute — live confluence-scalp uses ATR stops via computeProtection,
 * i.e. backtest(confluenceScalp, …, LIVE_EXIT_POLICY). Repairing the costs here
 * does not make these numbers what live will trade.
 */
export function backtestScalp(
  strategy: Strategy,
  candles: Candle[],
  params: Record<string, number>,
  opts: ScalpBacktestOptions,
): BacktestResult & { scalpMeta: ScalpBacktestMeta } {
  const makerFee = opts.makerFeeRate ?? params.makerFeeRate ?? 0.001; // real Binance spot
  const takerFee = opts.takerFeeRate ?? params.takerFeeRate ?? 0.001;
  const slippage = BINANCE_SPOT_COSTS.slippageRate; // applied on taker legs only

  let maxHold = opts.maxHoldBars ?? params.maxHoldBars ?? DEFAULT_MAX_HOLD;
  if (!(maxHold >= 1)) maxHold = DEFAULT_MAX_HOLD; // must be ≥1 so it can't fire at held 0

  // HARD target cost-floor: a take-profit below the round-trip cost cannot pay for
  // itself — clamp it up and flag it, rather than book guaranteed-losing "wins".
  const rawTargetPct = opts.targetPct ?? params.targetPct ?? 0.002;
  let targetPct = rawTargetPct;
  let widenedForCost = false;
  if (targetPct < MIN_TARGET_PCT) { targetPct = MIN_TARGET_PCT; widenedForCost = true; }

  // Faithful GIGO: do NOT silently rewrite the user's stop — a too-tight stop
  // should SHOW as noise-driven bleed. Only guard degenerate values.
  const rawStopPct = opts.stopPct ?? params.stopPct ?? DEFAULT_STOP_PCT;
  const stopPct = rawStopPct > 0 && rawStopPct < 0.5 ? rawStopPct : DEFAULT_STOP_PCT;

  const spread = (opts.spreadBps ?? 5) / 10_000; // maker limit offset below close
  const barMs = intervalMs(opts.interval);
  const ctxKey = opts.contextKey ?? BACKTEST_KEY;

  let cash = opts.startEquity;
  const meta: ScalpBacktestMeta = {
    // Force kline-only whenever there are no aggTrades, regardless of an explicit
    // opts.klineOnly:false — otherwise the aggTrade branch silently books nothing.
    klineOnly: opts.aggTrades.length === 0 ? true : opts.klineOnly ?? false,
    makerFills: 0,
    takerFills: 0,
    abandonedEntries: 0,
    makerFillRatio: 0,
    maxHoldExits: 0,
    widenedForCost,
  };

  if (candles.length < 2) {
    return { ...emptyScalp(strategy.id, opts.startEquity, candles), scalpMeta: meta };
  }

  const trades: Trade[] = [];
  const equityCurve: { time: number; equity: number }[] = [];
  let peakEquity = opts.startEquity;
  let maxDrawdownPct = 0;
  let totalFeesPaid = 0;
  let totalSlippagePaid = 0;

  type Pos = {
    entryTime: number; entryBar: number; entryPrice: number; qty: number;
    entryFee: number; entrySlippage: number; entryReason: string;
    stop: number; target: number; fillTime: number;
  };
  let pos: Pos | null = null;
  let pendingBuy: { bar: number; reason: string; limitPrice: number } | null = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const barCloseSec = bar.closeTime ?? bar.time + barMs / 1000 - 1;
    const barTrades = aggTradesForBar(opts.aggTrades, bar.time, barCloseSec);

    // Fill a pending maker buy at this bar — never chase across the spread.
    if (pendingBuy && pendingBuy.bar + 1 === i && !pos) {
      const limit = pendingBuy.limitPrice;
      let fillTime: number | null = null;
      if (meta.klineOnly) {
        if (bar.low <= limit) fillTime = bar.time;
      } else {
        const hit = [...barTrades].sort((a, b) => a.time - b.time).find((t) => t.price <= limit);
        if (hit) fillTime = hit.time;
      }
      if (fillTime != null) {
        const fee = cash * makerFee;
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
          fillTime,
        };
        totalFeesPaid += fee;
        cash = 0;
        meta.makerFills++;
      } else {
        meta.abandonedEntries++;
      }
      pendingBuy = null;
    }

    // In-position: resolve bracket / max-hold / signal exit for this bar.
    if (pos) {
      const held = i - pos.entryBar;
      let rawExitPrice: number | null = null;
      let exitReason = "";
      let taker = true; // SL / max-hold / signal cross the spread; only TP is maker

      if (meta.klineOnly) {
        // Pessimistic kline: assume the STOP fills before the target if both are
        // touched. A gap through the stop fills at the (worse) open, never better.
        if (bar.low <= pos.stop) {
          rawExitPrice = Math.min(pos.stop, bar.open);
          exitReason = "SL-kline";
        } else if (held > 0 && bar.high >= pos.target) {
          // Suppress TP on the entry bar: a pre-fill high must not book a fake win.
          rawExitPrice = pos.target;
          exitReason = "TP-kline";
          taker = false;
        }
      } else {
        const sorted = [...barTrades].sort((a, b) => a.time - b.time);
        for (const t of sorted) {
          // On the entry bar only replay trades AFTER the fill (no lookahead).
          if (held === 0 && t.time <= pos.fillTime) continue;
          if (t.price <= pos.stop) { rawExitPrice = Math.min(pos.stop, t.price); exitReason = "SL"; break; }
          if (t.price >= pos.target) { rawExitPrice = pos.target; exitReason = "TP"; taker = false; break; }
        }
      }

      if (rawExitPrice == null && held >= maxHold) {
        rawExitPrice = bar.close;
        exitReason = "max-hold";
        meta.maxHoldExits++;
      }

      if (rawExitPrice == null) {
        const { signal } = evaluateStrategyDetail(strategy.id, candles, i, "long", params, ctxKey);
        if (signal === "sell") {
          rawExitPrice = bar.close; // reversal → we market out
          exitReason = "signal";
        }
      }

      if (rawExitPrice != null) {
        const execPrice = taker ? rawExitPrice * (1 - slippage) : rawExitPrice;
        const exitSlippage = taker ? pos.qty * (rawExitPrice - execPrice) : 0;
        const fee = pos.qty * execPrice * (taker ? takerFee : makerFee);
        totalFeesPaid += fee;
        totalSlippagePaid += exitSlippage;
        if (taker) meta.takerFills++; else meta.makerFills++;
        cash = closeTrade(trades, pos, i, bar.time, execPrice, fee, exitSlippage, exitReason);
        pos = null;
      }
    }

    // Mark to market. Drawdown uses the bar LOW while in position — a close-only
    // curve understates the drawdown a real account actually experiences.
    const mark = pos ? pos.qty * bar.close : cash;
    const markLow = pos ? pos.qty * bar.low : cash;
    equityCurve.push({ time: bar.time, equity: mark });
    if (mark > peakEquity) peakEquity = mark;
    const dd = peakEquity > 0 ? ((peakEquity - markLow) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    if (i < candles.length - 1 && !pos && !pendingBuy) {
      const { signal, reason } = evaluateStrategyDetail(strategy.id, candles, i, "flat", params, ctxKey);
      if (signal === "buy") {
        const limit = bar.close * (1 - spread);
        pendingBuy = { bar: i, reason: reason ?? ((params.mode ?? 0) >= 1 ? "scalp" : "swing"), limitPrice: limit };
      }
    }
  }

  // Force-close any still-open position at the last close (taker) so its outcome
  // counts in win rate / expectancy instead of being hidden. Mirrors backtest.ts.
  if (pos) {
    const lastBar = candles[candles.length - 1];
    const raw = lastBar.close;
    const execPrice = raw * (1 - slippage);
    const exitSlippage = pos.qty * (raw - execPrice);
    const fee = pos.qty * execPrice * takerFee;
    totalFeesPaid += fee;
    totalSlippagePaid += exitSlippage;
    meta.takerFills++;
    cash = closeTrade(trades, pos, candles.length - 1, lastBar.time, execPrice, fee, exitSlippage, "eod-close");
    pos = null;
  }

  const lastClose = candles[candles.length - 1].close;
  const endEquity = cash; // position (if any) force-closed above
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
    totalSlippagePaid,
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
