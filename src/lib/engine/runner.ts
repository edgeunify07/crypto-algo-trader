// Bot runner — the automated trading loop, now driven by a Binance WebSocket
// kline stream (server-side). Reacts within milliseconds of a candle close
// instead of waiting up to a poll interval. A process-wide singleton drives one
// strategy on one symbol; start/stop/status are controlled via /api/bot.
import { getCandles } from "../binance/marketData";
import { getStrategy } from "../strategies/builtin";
import { executeSignal, getPositions, type ExecMode, type ExecEvent } from "../executor";
import type { Candle, CandleInterval } from "../types";
import type { Signal } from "../strategies/types";

const WS_BASE = "wss://data-stream.binance.vision/ws";

export interface BotConfig {
  symbol: string;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  mode: ExecMode;
  tradeNotionalUSDT: number;
  pollMs: number; // retained for API compatibility; WS-driven now
}

interface BotState {
  running: boolean;
  config: BotConfig | null;
  ws: WebSocket | null;
  candles: Candle[];
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  closedByUs: boolean;
  lastSignal: Signal | null;
  lastTick: number;
  lastEvent: ExecEvent | null;
  lastError: string | null;
  ticks: number;
}

const g = globalThis as unknown as { __botState?: BotState };
function state(): BotState {
  if (!g.__botState) {
    g.__botState = {
      running: false, config: null, ws: null, candles: [], reconnectTimer: null,
      closedByUs: false, lastSignal: null, lastTick: 0, lastEvent: null, lastError: null, ticks: 0,
    };
  }
  return g.__botState;
}

async function onClosedCandle(candle: Candle) {
  const s = state();
  const cfg = s.config;
  if (!cfg) return;
  // Append / replace by time.
  const buf = s.candles;
  if (buf.length && buf[buf.length - 1].time === candle.time) buf[buf.length - 1] = candle;
  else buf.push(candle);
  if (buf.length > 500) buf.splice(0, buf.length - 500);

  s.ticks += 1;
  s.lastTick = Date.now();
  try {
    const strategy = getStrategy(cfg.strategyId);
    if (!strategy) throw new Error(`unknown strategy ${cfg.strategyId}`);
    if (buf.length < 30) return;
    const held = getPositions().some((p) => p.symbol === cfg.symbol);
    const signal = strategy.next({ candles: buf, index: buf.length - 1, position: held ? "long" : "flat" }, cfg.params);
    s.lastSignal = signal;
    if (signal !== "hold") {
      s.lastEvent = await executeSignal(cfg.symbol, signal, candle.close, cfg.mode, cfg.tradeNotionalUSDT);
    }
    s.lastError = null;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : "evaluation failed";
  }
}

function openSocket() {
  const s = state();
  const cfg = s.config;
  if (!cfg) return;
  if (s.ws) { s.closedByUs = true; try { s.ws.close(); } catch {} }
  const ws = new WebSocket(`${WS_BASE}/${cfg.symbol.toLowerCase()}@kline_${cfg.interval}`);
  s.ws = ws;
  s.closedByUs = false;
  ws.onmessage = (m) => {
    try {
      const evt = JSON.parse(m.data as string) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
      const k = evt.k;
      s.lastTick = Date.now();
      if (k && k.x) {
        void onClosedCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
      }
    } catch { /* ignore frame */ }
  };
  ws.onclose = () => { if (!s.closedByUs && s.running) scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  const s = state();
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = setTimeout(() => openSocket(), 1500);
}

export const BotRunner = {
  async start(config: BotConfig) {
    const s = state();
    this.stop();
    s.config = config;
    s.running = true;
    s.ticks = 0;
    s.lastError = null;
    // Seed indicator history (drop the still-forming last bar).
    try {
      const seed = await getCandles(config.symbol, config.interval, 300);
      s.candles = seed.slice(0, -1);
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : "seed failed";
      s.candles = [];
    }
    openSocket();
  },

  stop() {
    const s = state();
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    if (s.ws) { s.closedByUs = true; try { s.ws.close(); } catch {} s.ws = null; }
    s.running = false;
  },

  status() {
    const s = state();
    return {
      running: s.running,
      config: s.config,
      lastSignal: s.lastSignal,
      lastTick: s.lastTick,
      lastEvent: s.lastEvent,
      lastError: s.lastError,
      ticks: s.ticks,
      positions: getPositions(),
      transport: "websocket",
    };
  },
};
