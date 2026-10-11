"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live market data straight from Binance to the browser.
 *
 * Polling the app's own API could never feel live: each poll costs a
 * serverless invocation, the data is already a round trip old, and the rate
 * limit caps how often it can run. The exchange publishes the same data over a
 * websocket, so the browser subscribes to it directly — the order book updates
 * every 100ms, trades arrive as they print, and the candle redraws on every
 * tick, at no cost to the deployment.
 *
 * The engine still reads prices server-side for its own decisions. This stream
 * is for display only, which is why it can afford to be best-effort: if the
 * socket cannot connect — a blocked region, a corporate proxy — `connected`
 * goes false and the caller falls back to its polled data.
 */

const WS_HOSTS = [
  "wss://fstream.binance.com",
  // Same streams via the main domain, which answers from some regions where
  // fstream does not.
  "wss://fstream.binance.com:9443",
];

export interface LiveKline {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  closed: boolean;
}

export interface LiveTrade {
  id: number;
  price: number;
  qty: number;
  time: number;
  side: "buy" | "sell";
}

export interface LiveDepth {
  bids: { price: number; qty: number; total: number }[];
  asks: { price: number; qty: number; total: number }[];
  maxTotal: number;
  spread: number;
  spreadPct: number;
}

export interface LiveTicker {
  lastPrice: number;
  changePct: number;
  high: number;
  low: number;
  quoteVolume: number;
}

export interface StreamState {
  connected: boolean;
  kline: LiveKline | null;
  depth: LiveDepth | null;
  trades: LiveTrade[];
  ticker: LiveTicker | null;
  /** Ticker for every symbol in the watchlist, for the market rail. */
  prices: Record<string, { price: number; changePct: number }>;
}

interface RawKlineMsg {
  e: "kline";
  k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean };
}
interface RawAggTradeMsg {
  e: "aggTrade";
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}
interface RawDepthMsg {
  e: "depthUpdate";
  b: [string, string][];
  a: [string, string][];
}
interface RawPartialDepth {
  bids: [string, string][];
  asks: [string, string][];
}
interface RawTickerMsg {
  e: "24hrTicker";
  s: string;
  c: string;
  P: string;
  h: string;
  l: string;
  q: string;
}

function cumulate(rows: [string, string][], take: number) {
  let total = 0;
  return rows
    .map(([p, q]) => ({ price: +p, qty: +q }))
    .filter((r) => r.qty > 0)
    .slice(0, take)
    .map((r) => ({ ...r, total: (total += r.qty) }));
}

export function useBinanceStream(
  symbol: string,
  timeframe: string,
  watchlist: string[],
): StreamState {
  const [state, setState] = useState<StreamState>({
    connected: false,
    kline: null,
    depth: null,
    trades: [],
    ticker: null,
    prices: {},
  });

  // Held in a ref so a burst of trades does not re-render per message.
  const tradesRef = useRef<LiveTrade[]>([]);
  const hostIndex = useRef(0);

  // The watchlist changes identity on every poll even when unchanged, which
  // would tear the socket down and rebuild it; key on the contents instead.
  const watchKey = watchlist.join(",");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;

      const lower = symbol.toLowerCase();
      const streams = [
        `${lower}@kline_${timeframe}`,
        `${lower}@depth20@100ms`,
        `${lower}@aggTrade`,
        `${lower}@ticker`,
        // One ticker stream per watchlist symbol keeps the market rail live
        // without a second connection.
        ...watchKey
          .split(",")
          .filter(Boolean)
          .slice(0, 20)
          .map((s) => `${s.toLowerCase()}@ticker`),
      ];
      const unique = [...new Set(streams)];

      const host = WS_HOSTS[hostIndex.current % WS_HOSTS.length] as string;
      const url = `${host}/stream?streams=${unique.join("/")}`;

      try {
        socket = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }

      // A geo-blocked endpoint accepts the connection and then goes silent
      // rather than erroring, so an open timeout is the only way to notice.
      const openTimer = setTimeout(() => {
        if (socket && socket.readyState !== WebSocket.OPEN) {
          socket.close();
        }
      }, 8000);

      socket.onopen = () => {
        clearTimeout(openTimer);
        attempt = 0;
        setState((s) => ({ ...s, connected: true }));
      };

      socket.onmessage = (event) => {
        let payload: { stream?: string; data?: unknown };
        try {
          payload = JSON.parse(event.data as string) as { stream?: string; data?: unknown };
        } catch {
          return;
        }
        const data = payload.data as
          | RawKlineMsg
          | RawAggTradeMsg
          | RawDepthMsg
          | RawTickerMsg
          | RawPartialDepth
          | undefined;
        if (!data) return;

        const stream = payload.stream ?? "";

        if ("e" in data && data.e === "kline") {
          const k = data.k;
          setState((s) => ({
            ...s,
            kline: {
              t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: k.x,
            },
          }));
          return;
        }

        if ("e" in data && data.e === "aggTrade") {
          const trade: LiveTrade = {
            id: data.a,
            price: +data.p,
            qty: +data.q,
            time: data.T,
            // `m` true means the buyer was the maker, so the aggressor sold.
            side: data.m ? "sell" : "buy",
          };
          tradesRef.current = [trade, ...tradesRef.current].slice(0, 25);
          setState((s) => ({ ...s, trades: tradesRef.current }));
          return;
        }

        if ("e" in data && data.e === "24hrTicker") {
          const t = data;
          const sym = t.s;
          setState((s) => ({
            ...s,
            prices: { ...s.prices, [sym]: { price: +t.c, changePct: +t.P / 100 } },
            ticker:
              sym === symbol
                ? { lastPrice: +t.c, changePct: +t.P / 100, high: +t.h, low: +t.l, quoteVolume: +t.q }
                : s.ticker,
          }));
          return;
        }

        // Partial book depth arrives without an event name.
        if (stream.includes("@depth") && "bids" in data && "asks" in data) {
          const bids = cumulate(data.bids, 12);
          const asks = cumulate(data.asks, 12);
          const bestBid = bids[0]?.price ?? 0;
          const bestAsk = asks[0]?.price ?? 0;
          setState((s) => ({
            ...s,
            depth: {
              bids,
              asks,
              maxTotal: Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0),
              spread: bestAsk && bestBid ? bestAsk - bestBid : 0,
              spreadPct: bestAsk && bestBid ? (bestAsk - bestBid) / bestBid : 0,
            },
          }));
        }
      };

      const fail = () => {
        clearTimeout(openTimer);
        setState((s) => ({ ...s, connected: false }));
        scheduleRetry();
      };
      socket.onerror = fail;
      socket.onclose = fail;
    };

    const scheduleRetry = () => {
      if (closed || retry) return;
      // Rotate hosts so a persistently unreachable one is not retried forever.
      hostIndex.current += 1;
      const delay = Math.min(20_000, 2 ** Math.min(attempt++, 4) * 1000);
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [symbol, timeframe, watchKey]);

  return state;
}
