import crypto from "node:crypto";
import { placeOrder } from "./binance/trading";
import { getMarkets, roundToStep } from "./binance/marketData";
import { loadExecutions, queuePersist } from "./data/executions";
import { RiskGuard } from "./risk";
import { configSummary } from "./binance/config";
import type { Signal } from "./strategies/types";

export type ExecMode = "paper" | "live";

const BINANCE_TAKER_FEE = 0.001;

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ExecEvent {
  time: number;
  symbol: string;
  action: "BUY" | "SELL" | "SKIP" | "BOT" | "SIGNAL";
  mode: ExecMode;
  price: number;
  qty: number;
  notional: number;
  pnl?: number;
  reason?: string;
  live: boolean;
  clientOrderId?: string;
}

interface ExecState {
  positions: Map<string, Position>;
  events: ExecEvent[];
  pendingClientIds: Set<string>;
  loadedFromDisk: boolean;
}

const g = globalThis as unknown as { __execState?: ExecState };
function state(): ExecState {
  if (!g.__execState) {
    g.__execState = { positions: new Map(), events: [], pendingClientIds: new Set(), loadedFromDisk: false };
  }
  return g.__execState;
}

async function ensureLoaded() {
  const s = state();
  if (s.loadedFromDisk) return;
  s.loadedFromDisk = true;
  const stored = await loadExecutions();
  if (stored.length) {
    const seen = new Set(s.events.map((e) => `${e.time}-${e.symbol}-${e.action}-${e.clientOrderId ?? ""}`));
    for (const e of stored) {
      const key = `${e.time}-${e.symbol}-${e.action}-${e.clientOrderId ?? ""}`;
      if (!seen.has(key)) s.events.push(e);
    }
    s.events.sort((a, b) => b.time - a.time);
    if (s.events.length > 2000) s.events.length = 2000;
  }
}

function log(e: ExecEvent) {
  const s = state();
  s.events.unshift(e);
  if (s.events.length > 2000) s.events.length = 2000;
  queuePersist(s.events);
}

function makeClientOrderId(symbol: string, side: string): string {
  return `unify_${symbol}_${side}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export function getPositions(): Position[] {
  return [...state().positions.values()];
}

export async function getEvents(limit = 100): Promise<ExecEvent[]> {
  await ensureLoaded();
  return state().events.slice(0, limit);
}

export async function getEventsForSymbol(symbol: string, limit = 100): Promise<ExecEvent[]> {
  await ensureLoaded();
  const sym = symbol.toUpperCase();
  return state().events.filter((e) => e.symbol.toUpperCase() === sym).slice(0, limit);
}

async function stepFor(symbol: string): Promise<{ step: number; minNotional: number }> {
  const markets = await getMarkets();
  const m = markets.find((x) => x.symbol === symbol);
  return { step: m?.step ?? 0, minNotional: m?.minNotional ?? 5 };
}

export async function executeSignal(
  symbol: string,
  signal: Signal,
  price: number,
  mode: ExecMode,
  tradeNotionalUSDT: number,
  opts?: { stopLoss?: number; takeProfit?: number; reason?: string },
): Promise<ExecEvent> {
  const s = state();
  const pos = s.positions.get(symbol);
  const now = Math.floor(Date.now() / 1000);
  const cfg = configSummary();
  const liveReal = mode === "live" && cfg.live;

  RiskGuard.heartbeat();

  if (signal === "buy" && !pos) {
    const decision = RiskGuard.canOpen(symbol, tradeNotionalUSDT);
    if (!decision.ok) {
      const e: ExecEvent = { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: decision.reason, live: liveReal };
      log(e);
      return e;
    }

    const { step, minNotional } = await stepFor(symbol);
    if (tradeNotionalUSDT < minNotional) {
      const e: ExecEvent = { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: `below min notional $${minNotional}`, live: liveReal };
      log(e);
      return e;
    }

    const clientOrderId = makeClientOrderId(symbol, "BUY");
    let qty = (tradeNotionalUSDT / price) * (1 - BINANCE_TAKER_FEE);
    if (mode === "live") {
      qty = roundToStep(tradeNotionalUSDT / price, step);
      if (liveReal && !s.pendingClientIds.has(clientOrderId)) {
        s.pendingClientIds.add(clientOrderId);
        try {
          const res = await placeOrder({ symbol, side: "BUY", type: "MARKET", quoteOrderQty: tradeNotionalUSDT, clientOrderId });
          qty = res.executedQty || qty;
        } finally {
          s.pendingClientIds.delete(clientOrderId);
        }
      }
    }
    s.positions.set(symbol, {
      symbol, qty, entryPrice: price, entryTime: now,
      stopLoss: opts?.stopLoss, takeProfit: opts?.takeProfit,
    });
    RiskGuard.markOpen(symbol);
    const e: ExecEvent = { time: now, symbol, action: "BUY", mode, price, qty, notional: qty * price, live: liveReal, clientOrderId, reason: opts?.reason };
    log(e);
    return e;
  }

  if (signal === "sell" && pos) {
    const decision = RiskGuard.canClose();
    if (!decision.ok) {
      const e: ExecEvent = { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: decision.reason, live: liveReal };
      log(e);
      return e;
    }

    const clientOrderId = makeClientOrderId(symbol, "SELL");
    let qty = pos.qty;
    if (mode === "live") {
      const { step } = await stepFor(symbol);
      qty = roundToStep(pos.qty, step);
      if (liveReal && !s.pendingClientIds.has(clientOrderId)) {
        s.pendingClientIds.add(clientOrderId);
        try {
          const res = await placeOrder({ symbol, side: "SELL", type: "MARKET", quantity: qty, clientOrderId });
          qty = res.executedQty || qty;
        } finally {
          s.pendingClientIds.delete(clientOrderId);
        }
      }
    }
    const gross = qty * price;
    const fee = gross * BINANCE_TAKER_FEE;
    const pnl = gross - fee - pos.qty * pos.entryPrice;
    s.positions.delete(symbol);
    RiskGuard.markClosed(symbol, pnl);
    RiskGuard.updateEquity(gross);
    const e: ExecEvent = { time: now, symbol, action: "SELL", mode, price, qty, notional: gross, pnl, live: liveReal, clientOrderId, reason: opts?.reason ?? (pos.stopLoss && price <= pos.stopLoss ? "stop-loss" : pos.takeProfit && price >= pos.takeProfit ? "take-profit" : undefined) };
    log(e);
    return e;
  }

  return { time: now, symbol, action: "SKIP", mode, price, qty: 0, notional: 0, reason: "no position change", live: liveReal };
}

/** Check open positions for SL/TP hits at current price. */
export async function checkStops(
  symbol: string,
  price: number,
  mode: ExecMode,
  tradeNotionalUSDT: number,
): Promise<ExecEvent | null> {
  const pos = state().positions.get(symbol);
  if (!pos) return null;
  if (pos.stopLoss && price <= pos.stopLoss) {
    return executeSignal(symbol, "sell", price, mode, tradeNotionalUSDT, { reason: "stop-loss" });
  }
  if (pos.takeProfit && price >= pos.takeProfit) {
    return executeSignal(symbol, "sell", price, mode, tradeNotionalUSDT, { reason: "take-profit" });
  }
  return null;
}

export async function exportEventsCsv(limit = 500): Promise<string> {
  const events = await getEvents(limit);
  const header = "time,symbol,action,mode,price,qty,notional,pnl,live,reason\n";
  const rows = events.map((e) =>
    [e.time, e.symbol, e.action, e.mode, e.price, e.qty, e.notional, e.pnl ?? "", e.live, e.reason ?? ""].join(","),
  );
  return header + rows.join("\n");
}

/** Lifecycle / signal events — show immediately in Execution Log. */
export function logBotEvent(
  symbol: string,
  action: "BOT" | "SIGNAL",
  mode: ExecMode,
  reason: string,
  price = 0,
): ExecEvent {
  const e: ExecEvent = {
    time: Math.floor(Date.now() / 1000),
    symbol,
    action,
    mode,
    price,
    qty: 0,
    notional: 0,
    reason,
    live: false,
  };
  log(e);
  return e;
}
