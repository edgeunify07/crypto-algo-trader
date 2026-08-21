// Executor — turns a strategy signal into an actual (paper or live) order.
// Paper mode simulates fills against live prices with realistic Binance fees;
// live mode routes real orders through the risk guard. Positions and a trade
// log are held in a process-wide singleton.
import { placeOrder } from "./binance/trading";
import { getMarkets, roundToStep } from "./binance/marketData";
import { RiskGuard } from "./risk";
import { configSummary } from "./binance/config";
import type { Signal } from "./strategies/types";

export type ExecMode = "paper" | "live";

const BINANCE_TAKER_FEE = 0.001; // 0.1% — no TDS, no per-trade tax deduction

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
}

export interface ExecEvent {
  time: number;
  symbol: string;
  action: "BUY" | "SELL" | "SKIP";
  mode: ExecMode;
  price: number;
  qty: number;
  notional: number;
  pnl?: number;
  reason?: string; // populated for SKIP
  live: boolean;
}

interface ExecState {
  positions: Map<string, Position>;
  events: ExecEvent[];
}

const g = globalThis as unknown as { __execState?: ExecState };
function state(): ExecState {
  if (!g.__execState) g.__execState = { positions: new Map(), events: [] };
  return g.__execState;
}

function log(e: ExecEvent) {
  const s = state();
  s.events.unshift(e);
  if (s.events.length > 500) s.events.length = 500;
}

export function getPositions(): Position[] {
  return [...state().positions.values()];
}

export function getEvents(limit = 100): ExecEvent[] {
  return state().events.slice(0, limit);
}

async function stepFor(symbol: string): Promise<number> {
  const markets = await getMarkets();
  return markets.find((m) => m.symbol === symbol)?.step ?? 0;
}

/**
 * Act on a signal for one symbol at the given price.
 * @param mode        paper (simulated) or live (real order via Binance)
 * @param tradeNotionalUSDT  size of each new position, in USDT
 */
export async function executeSignal(
  symbol: string,
  signal: Signal,
  price: number,
  mode: ExecMode,
  tradeNotionalUSDT: number,
): Promise<ExecEvent> {
  const s = state();
  const pos = s.positions.get(symbol);
  const now = Math.floor(Date.now() / 1000);
  const cfg = configSummary();
  const liveReal = mode === "live" && cfg.live; // true only with live env + TRADING_ENABLED

  // OPEN
  if (signal === "buy" && !pos) {
    const decision = RiskGuard.canOpen(symbol, tradeNotionalUSDT);
    if (!decision.ok) {
      const e: ExecEvent = { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: decision.reason, live: liveReal };
      log(e);
      return e;
    }

    let qty = (tradeNotionalUSDT / price) * (1 - BINANCE_TAKER_FEE);
    if (mode === "live") {
      const step = await stepFor(symbol);
      qty = roundToStep(tradeNotionalUSDT / price, step);
      if (liveReal) {
        const res = await placeOrder({ symbol, side: "BUY", type: "MARKET", quoteOrderQty: tradeNotionalUSDT });
        qty = res.executedQty || qty;
      }
    }
    s.positions.set(symbol, { symbol, qty, entryPrice: price, entryTime: now });
    RiskGuard.markOpen(symbol);
    const e: ExecEvent = { time: now, symbol, action: "BUY", mode, price, qty, notional: qty * price, live: liveReal };
    log(e);
    return e;
  }

  // CLOSE
  if (signal === "sell" && pos) {
    const decision = RiskGuard.canClose();
    if (!decision.ok) {
      const e: ExecEvent = { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: decision.reason, live: liveReal };
      log(e);
      return e;
    }

    let qty = pos.qty;
    if (mode === "live") {
      const step = await stepFor(symbol);
      qty = roundToStep(pos.qty, step);
      if (liveReal) {
        const res = await placeOrder({ symbol, side: "SELL", type: "MARKET", quantity: qty });
        qty = res.executedQty || qty;
      }
    }
    const gross = qty * price;
    const fee = gross * BINANCE_TAKER_FEE;
    const pnl = gross - fee - pos.qty * pos.entryPrice;
    s.positions.delete(symbol);
    RiskGuard.markClosed(symbol, pnl);
    const e: ExecEvent = { time: now, symbol, action: "SELL", mode, price, qty, notional: gross, pnl, live: liveReal };
    log(e);
    return e;
  }

  // Nothing actionable.
  return { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: "no position change", live: liveReal };
}
