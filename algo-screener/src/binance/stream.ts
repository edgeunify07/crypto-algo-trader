import WebSocket from "ws";
import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import type { Candle, Timeframe } from "../types.js";

const log = createLogger("binance:ws");

/** A socket that hasn't opened in this long is treated as dead. */
const OPEN_TIMEOUT_MS = 15_000;
/**
 * Binance sends a ping every ~3 minutes even on quiet streams, so silence for
 * materially longer than that means the link is gone whatever the socket says.
 */
const STALE_TIMEOUT_MS = 240_000;

export interface KlineUpdate {
  symbol: string;
  timeframe: Timeframe;
  candle: Candle;
}

interface RawKlineEvent {
  stream?: string;
  data?: {
    e: string;
    s: string;
    k: {
      t: number;
      T: number;
      i: string;
      o: string;
      h: string;
      l: string;
      c: string;
      v: string;
      q: string;
      n: number;
      x: boolean;
    };
  };
}

/**
 * Multiplexed Binance kline websocket with automatic reconnect.
 *
 * Streams are chunked across several connections because Binance caps a single
 * combined stream at 1024 subscriptions and gets unreliable well before that.
 * Each connection reconnects independently with exponential backoff, and hosts
 * rotate on failure so a geo-blocked primary falls through to the public mirror.
 */
export class KlineStream {
  private sockets: WebSocket[] = [];
  private closed = false;
  private hostIndex = 0;

  constructor(
    private readonly subscriptions: { symbol: string; timeframe: Timeframe }[],
    private readonly onUpdate: (update: KlineUpdate) => void,
  ) {}

  start(): void {
    this.closed = false;
    const names = this.subscriptions.map(
      (s) => `${s.symbol.toLowerCase()}@kline_${s.timeframe}`,
    );
    const chunkSize = Math.max(1, config.binance.streamsPerConnection);
    for (let i = 0; i < names.length; i += chunkSize) {
      this.connect(names.slice(i, i + chunkSize), 0);
    }
    log.info(
      `subscribing to ${names.length} kline streams over ${Math.ceil(names.length / chunkSize)} connection(s)`,
    );
  }

  stop(): void {
    this.closed = true;
    for (const socket of this.sockets) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
    }
    this.sockets = [];
  }

  private nextHost(): string {
    const hosts = config.binance.wsHosts;
    const host = hosts[this.hostIndex % hosts.length] ?? hosts[0] ?? "";
    return host;
  }

  private connect(streams: string[], attempt: number): void {
    if (this.closed) return;
    const host = this.nextHost();
    const url = `${host}/stream?streams=${streams.join("/")}`;
    const socket = new WebSocket(url);
    this.sockets.push(socket);

    let settled = false;
    let openTimer: NodeJS.Timeout | null = null;
    let staleTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      if (openTimer) clearTimeout(openTimer);
      if (staleTimer) clearTimeout(staleTimer);
      openTimer = null;
      staleTimer = null;
    };

    const reconnect = (why: string) => {
      // `error` and `close` both fire for one failure; only act on the first.
      if (settled || this.closed) return;
      settled = true;
      clearTimers();
      this.sockets = this.sockets.filter((s) => s !== socket);
      socket.removeAllListeners();
      // `terminate()` on a socket that never finished its handshake emits an
      // 'error' event, which would be unhandled now that listeners are gone.
      socket.on("error", () => {});
      socket.terminate();
      // Rotate hosts so a persistently failing endpoint doesn't trap us.
      this.hostIndex += 1;
      const delay = Math.min(30_000, 2 ** Math.min(attempt, 5) * 1000);
      log.warn(`${host}: ${why}; reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(streams, attempt + 1), delay);
    };

    /**
     * A geo-blocked or black-holed endpoint accepts the TCP connection and then
     * goes silent — no error, no close. Without these watchdogs the stream
     * would hang forever instead of failing over to the next host.
     */
    const armStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(
        () => reconnect(`no data for ${STALE_TIMEOUT_MS}ms`),
        STALE_TIMEOUT_MS,
      );
    };

    openTimer = setTimeout(
      () => reconnect(`did not open within ${OPEN_TIMEOUT_MS}ms`),
      OPEN_TIMEOUT_MS,
    );

    socket.on("open", () => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      armStaleTimer();
      log.info(`connected to ${host} (${streams.length} streams)`);
    });

    socket.on("message", (raw) => {
      armStaleTimer();
      try {
        const parsed = JSON.parse(raw.toString()) as RawKlineEvent;
        const data = parsed.data;
        if (!data || data.e !== "kline") return;
        const k = data.k;
        this.onUpdate({
          symbol: data.s,
          timeframe: k.i as Timeframe,
          candle: {
            openTime: k.t,
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            closeTime: k.T,
            quoteVolume: Number(k.q),
            trades: k.n,
            closed: k.x,
          },
        });
      } catch (err) {
        log.debug("failed to parse stream message", err);
      }
    });

    // Binance pings every ~3 minutes and expects a pong; `ws` answers
    // automatically, but the ping also proves the link is alive.
    socket.on("ping", () => {
      armStaleTimer();
      socket.pong();
    });
    socket.on("pong", armStaleTimer);
    socket.on("error", (err) => reconnect(err.message));
    socket.on("close", (code) => reconnect(`closed with code ${code}`));
  }
}
