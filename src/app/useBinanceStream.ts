"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live market data straight from Binance to the browser.
 *
 * Polling the app's own API could never feel live: each poll costs a
 * serverless invocation, the data is already a round trip old, and the rate
 * limit caps how often it can run. The exchange publishes the same data over a
 * websocket, so the browser subscribes to it directly — the order book updates
 * every 100ms, the best bid and ask move many times a second, and the candle
 * redraws on every tick, at no cost to the deployment.
 *
 * Two things this has to survive, both of which look identical from the
 * outside — a socket that is open and quiet:
 *
 *  - **a region that withholds some streams.** `kline`, `aggTrade` and
 *    `ticker` can connect and then deliver nothing at all while `bookTicker`
 *    and `depth` on the same connection pour in. Measured, not assumed: from
 *    one host the book streams delivered 59 and 243 messages in six seconds
 *    and the other three delivered zero. So price is taken from `bookTicker`,
 *    which is the feed that survives, and the richer streams are used only as
 *    a bonus where they work. `feeds` reports which actually arrived, so the
 *    UI can say what is live instead of showing a dead panel.
 *  - **the message rate.** Ten symbols of `bookTicker` is some three hundred
 *    messages a second. Calling `setState` on each one would spend the whole
 *    frame budget in React, so messages accumulate into a ref and publish on
 *    a timer.
 *
 * The engine still reads prices server-side for its own decisions. This stream
 * is for display only, which is why it can afford to be best-effort: if the
 * socket cannot connect at all, `connected` goes false and the caller falls
 * back to its polled data.
 */

const WS_HOSTS = [
  "wss://fstream.binance.com",
  // Same streams via the alternate port, which answers from some networks
  // where the default does not.
  "wss://fstream.binance.com:9443",
];

/** How often accumulated messages are published to React. */
const FLUSH_MS = 150;

/** A feed that has said nothing for this long is treated as unavailable. */
const FEED_TIMEOUT_MS = 10_000;

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

/** Best bid and ask for the active symbol — the feed served everywhere. */
export interface LiveMark {
  price: number;
  bid: number;
  ask: number;
  spread: number;
  spreadPct: number;
  at: number;
}

/** Which streams have actually delivered, as opposed to merely connected. */
export interface FeedStatus {
  book: boolean;
  depth: boolean;
  kline: boolean;
  trades: boolean;
  ticker: boolean;
}

export interface StreamState {
  connected: boolean;
  kline: LiveKline | null;
  depth: LiveDepth | null;
  trades: LiveTrade[];
  ticker: LiveTicker | null;
  mark: LiveMark | null;
  /** Ticker for every symbol in the watchlist, for the market rail. */
  prices: Record<string, { price: number; changePct?: number }>;
  feeds: FeedStatus;
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
/**
 * Futures partial-book depth.
 *
 * The futures stream names its sides `b` and `a`, unlike the spot REST
 * endpoint's `bids`/`asks`. Matching on the REST spelling silently never fires,
 * which is a quiet failure: the socket connects, messages arrive, and the book
 * simply never updates.
 */
interface RawDepthMsg {
  e: "depthUpdate";
  b: [string, string][];
  a: [string, string][];
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
interface RawBookTickerMsg {
  e: "bookTicker";
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
  E: number;
}

type RawMsg = RawKlineMsg | RawAggTradeMsg | RawDepthMsg | RawTickerMsg | RawBookTickerMsg;

function cumulate(rows: [string, string][], take: number) {
  let total = 0;
  return rows
    .map(([p, q]) => ({ price: +p, qty: +q }))
    .filter((r) => r.qty > 0)
    .slice(0, take)
    .map((r) => ({ ...r, total: (total += r.qty) }));
}

const EMPTY_FEEDS: FeedStatus = {
  book: false, depth: false, kline: false, trades: false, ticker: false,
};

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
    mark: null,
    prices: {},
    feeds: EMPTY_FEEDS,
  });

  // Everything the socket has said since the last publish. Held in a ref so a
  // burst of several hundred messages a second costs one render, not several
  // hundred.
  const pending = useRef<Partial<StreamState>>({});
  const dirty = useRef(false);
  const tradesRef = useRef<LiveTrade[]>([]);
  const pricesRef = useRef<StreamState["prices"]>({});
  const lastSeen = useRef<Record<keyof FeedStatus, number>>({
    book: 0, depth: 0, kline: 0, trades: 0, ticker: 0,
  });
  const hostIndex = useRef(0);

  // The watchlist changes identity on every poll even when unchanged, which
  // would tear the socket down and rebuild it; key on the contents instead.
  const watchKey = watchlist.join(",");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // A symbol change invalidates everything keyed to the old one.
    pending.current = {};
    tradesRef.current = [];
    pricesRef.current = {};
    lastSeen.current = { book: 0, depth: 0, kline: 0, trades: 0, ticker: 0 };

    const note = (feed: keyof FeedStatus) => {
      lastSeen.current[feed] = Date.now();
    };

    const flush = () => {
      const now = Date.now();
      const feeds: FeedStatus = {
        book: now - lastSeen.current.book < FEED_TIMEOUT_MS,
        depth: now - lastSeen.current.depth < FEED_TIMEOUT_MS,
        kline: now - lastSeen.current.kline < FEED_TIMEOUT_MS,
        trades: now - lastSeen.current.trades < FEED_TIMEOUT_MS,
        ticker: now - lastSeen.current.ticker < FEED_TIMEOUT_MS,
      };
      const patch = pending.current;
      pending.current = {};
      const hadPatch = dirty.current;
      dirty.current = false;

      setState((s) => {
        const sameFeeds =
          s.feeds.book === feeds.book && s.feeds.depth === feeds.depth &&
          s.feeds.kline === feeds.kline && s.feeds.trades === feeds.trades &&
          s.feeds.ticker === feeds.ticker;
        if (!hadPatch && sameFeeds) return s;
        return { ...s, ...patch, feeds };
      });
    };

    const timer = setInterval(flush, FLUSH_MS);

    const handle = (data: RawMsg) => {
      switch (data.e) {
        case "bookTicker": {
          const bid = +data.b;
          const ask = +data.a;
          if (!(bid > 0) || !(ask > 0)) return;
          const price = (bid + ask) / 2;
          // Every symbol's best quote feeds the market rail. `changePct` is
          // left alone: it only exists on the 24h ticker, and overwriting it
          // with a placeholder would blank a column the poll had filled.
          pricesRef.current = {
            ...pricesRef.current,
            [data.s]: { ...pricesRef.current[data.s], price },
          };
          pending.current.prices = pricesRef.current;
          if (data.s === symbol) {
            pending.current.mark = {
              price, bid, ask,
              spread: ask - bid,
              spreadPct: (ask - bid) / bid,
              at: data.E,
            };
            note("book");
          }
          dirty.current = true;
          return;
        }
        case "kline": {
          const k = data.k;
          pending.current.kline = {
            t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: k.x,
          };
          note("kline");
          dirty.current = true;
          return;
        }
        case "aggTrade": {
          const trade: LiveTrade = {
            id: data.a,
            price: +data.p,
            qty: +data.q,
            time: data.T,
            // `m` true means the buyer was the maker, so the aggressor sold.
            side: data.m ? "sell" : "buy",
          };
          tradesRef.current = [trade, ...tradesRef.current].slice(0, 25);
          pending.current.trades = tradesRef.current;
          note("trades");
          dirty.current = true;
          return;
        }
        case "24hrTicker": {
          pricesRef.current = {
            ...pricesRef.current,
            [data.s]: { price: +data.c, changePct: +data.P / 100 },
          };
          pending.current.prices = pricesRef.current;
          if (data.s === symbol) {
            pending.current.ticker = {
              lastPrice: +data.c, changePct: +data.P / 100,
              high: +data.h, low: +data.l, quoteVolume: +data.q,
            };
            note("ticker");
          }
          dirty.current = true;
          return;
        }
        case "depthUpdate": {
          const bids = cumulate(data.b, 12);
          const asks = cumulate(data.a, 12);
          const bestBid = bids[0]?.price ?? 0;
          const bestAsk = asks[0]?.price ?? 0;
          pending.current.depth = {
            bids,
            asks,
            maxTotal: Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0),
            spread: bestAsk && bestBid ? bestAsk - bestBid : 0,
            spreadPct: bestAsk && bestBid ? (bestAsk - bestBid) / bestBid : 0,
          };
          note("depth");
          dirty.current = true;
          return;
        }
      }
    };

    const connect = () => {
      if (closed) return;

      const lower = symbol.toLowerCase();
      const watched = watchKey.split(",").filter(Boolean).slice(0, 14);
      const streams = [
        // Best quote first: it is the one feed every region serves, and the
        // only one guaranteed to make the price move on screen.
        `${lower}@bookTicker`,
        `${lower}@depth20@100ms`,
        `${lower}@kline_${timeframe}`,
        `${lower}@aggTrade`,
        `${lower}@ticker`,
        // The market rail: a live price from the quote feed, and the 24h
        // change from the ticker where that is served.
        ...watched.map((s) => `${s.toLowerCase()}@bookTicker`),
        ...watched.map((s) => `${s.toLowerCase()}@ticker`),
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

      // An unreachable endpoint accepts the connection and then goes silent
      // rather than erroring, so an open timeout is the only way to notice.
      const openTimer = setTimeout(() => {
        if (socket && socket.readyState !== WebSocket.OPEN) socket.close();
      }, 8000);

      socket.onopen = () => {
        clearTimeout(openTimer);
        attempt = 0;
        setState((s) => (s.connected ? s : { ...s, connected: true }));
      };

      socket.onmessage = (event) => {
        let payload: { stream?: string; data?: RawMsg };
        try {
          payload = JSON.parse(event.data as string) as { stream?: string; data?: RawMsg };
        } catch {
          return;
        }
        if (payload.data && "e" in payload.data) handle(payload.data);
      };

      const fail = () => {
        clearTimeout(openTimer);
        setState((s) => (s.connected ? { ...s, connected: false } : s));
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
      clearInterval(timer);
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
