"use client";

// Single shared Binance WebSocket connection for the whole terminal.
// Replaces REST polling with real-time push (depth @100ms, trades, ticker,
// klines). One connection regardless of how many components listen; the page
// calls `ensure(symbol, interval)` and the manager (re)subscribes.

export type StreamType = "ticker" | "depth" | "trade" | "kline";
type Listener = (type: StreamType, data: unknown) => void;

const WS_BASE = "wss://data-stream.binance.vision/stream";

class MarketStream {
  private ws: WebSocket | null = null;
  private symbol = "";
  private interval = "";
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private connected = false;

  /** Point the connection at a symbol/interval; reconnects only if changed. */
  ensure(symbol: string, interval: string) {
    const changed = symbol !== this.symbol || interval !== this.interval;
    const dead = !this.ws || this.ws.readyState > 1; // CLOSING/CLOSED
    if (!changed && !dead) return;
    this.symbol = symbol;
    this.interval = interval;
    this.open();
  }

  private open() {
    this.teardown();
    const s = this.symbol.toLowerCase();
    const streams = [`${s}@ticker`, `${s}@depth20@100ms`, `${s}@trade`, `${s}@kline_${this.interval}`].join("/");
    const ws = new WebSocket(`${WS_BASE}?streams=${streams}`);
    this.ws = ws;
    this.closedByUs = false;
    ws.onopen = () => { this.connected = true; };
    ws.onmessage = (m) => {
      try {
        const { stream, data } = JSON.parse(m.data as string) as { stream: string; data: unknown };
        this.dispatch(stream, data);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      this.connected = false;
      if (!this.closedByUs) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  private dispatch(stream: string, data: unknown) {
    let type: StreamType | null = null;
    if (stream.includes("@ticker")) type = "ticker";
    else if (stream.includes("@depth")) type = "depth";
    else if (stream.includes("@trade")) type = "trade";
    else if (stream.includes("@kline")) type = "kline";
    if (type) for (const l of this.listeners) l(type, data);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), 1500);
  }

  private teardown() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.closedByUs = true;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  isConnected() { return this.connected; }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}

export const marketStream = new MarketStream();
