// Multi-symbol bot — scans universe, manages open positions, picks best BUY by score.
import { getCandles } from "../binance/marketData";
import { executeSignal, checkStops, getPositions, logBotEvent, type ExecMode, type ExecEvent } from "../executor";
import { evaluateStrategyDetail, prepareStrategyData } from "./signals";
import { RiskGuard } from "../risk";
import { loadBotSnapshot, saveBotSnapshot } from "../data/botState";
import { liveContextKey, resolveUniverse } from "../universe";
import type { Candle, CandleInterval } from "../types";
import type { Signal } from "../strategies/types";

export interface BotConfig {
  /** Primary / chart symbol (also included in universe). */
  symbol: string;
  /** When true, scan top liquid USDT pairs and pick best trade. */
  universeMode?: boolean;
  /** Explicit symbol list (overrides auto universe when provided). */
  symbols?: string[];
  /** Max symbols to scan in universe mode. */
  universeLimit?: number;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  mode: ExecMode;
  tradeNotionalUSDT: number;
  pollMs: number;
  stopLossAtrMult?: number;
  takeProfitRr?: number;
}

interface SymbolBook {
  candles: Candle[];
  lastClosedBar: Candle | null;
  lastFormingBar: Candle | null;
  pendingSignal: Signal | null;
  pendingReason?: string;
  pendingBarTime: number;
  lastScore: number;
  lastSignal: Signal | null;
}

interface BotState {
  running: boolean;
  config: BotConfig | null;
  books: Map<string, SymbolBook>;
  watchlist: string[];
  pollTimer: ReturnType<typeof setInterval> | null;
  lastTick: number;
  lastEvent: ExecEvent | null;
  lastError: string | null;
  ticks: number;
  lastSignal: Signal | null;
  pendingSignal: Signal | null;
  pendingReason?: string;
  bestCandidate: { symbol: string; score: number; reason?: string } | null;
  resumed: boolean;
}

const g = globalThis as unknown as { __botState?: BotState };

function state(): BotState {
  if (!g.__botState) {
    g.__botState = {
      running: false,
      config: null,
      books: new Map(),
      watchlist: [],
      pollTimer: null,
      lastTick: 0,
      lastEvent: null,
      lastError: null,
      ticks: 0,
      lastSignal: null,
      pendingSignal: null,
      bestCandidate: null,
      resumed: false,
    };
  }
  // Hot-reload / old snapshots may lack multi-symbol fields
  const s = g.__botState;
  if (!s.books) s.books = new Map();
  if (!Array.isArray(s.watchlist)) s.watchlist = s.config?.symbol ? [s.config.symbol.toUpperCase()] : [];
  if (s.bestCandidate === undefined) s.bestCandidate = null;
  return s;
}

function emptyBook(): SymbolBook {
  return {
    candles: [],
    lastClosedBar: null,
    lastFormingBar: null,
    pendingSignal: null,
    pendingReason: undefined,
    pendingBarTime: 0,
    lastScore: 0,
    lastSignal: null,
  };
}

async function persistSnapshot() {
  const s = state();
  await saveBotSnapshot({
    running: s.running,
    startedAt: new Date().toISOString(),
    config: s.config,
    lastSignal: s.lastSignal,
    pendingSignal: s.pendingSignal,
    pendingReason: s.pendingReason,
    lastError: s.lastError,
    ticks: s.ticks,
  });
}

async function resolveWatchlist(cfg: BotConfig): Promise<string[]> {
  if (cfg.symbols?.length) {
    return [...new Set(cfg.symbols.map((x) => x.toUpperCase()))];
  }
  if (cfg.universeMode) {
    const uni = await resolveUniverse(cfg.universeLimit ?? 20);
    if (!uni.includes(cfg.symbol.toUpperCase())) uni.unshift(cfg.symbol.toUpperCase());
    return uni;
  }
  return [cfg.symbol.toUpperCase()];
}

async function fillPending(symbol: string, bar: Candle) {
  const s = state();
  const cfg = s.config;
  const book = s.books.get(symbol);
  if (!cfg || !book) return;

  if (book.pendingSignal && book.pendingSignal !== "hold" && bar.time > book.pendingBarTime) {
    const held = getPositions().some((p) => p.symbol === symbol);
    const reason = book.pendingReason;
    if (book.pendingSignal === "buy" && !held) {
      // Only fill if still flat overall under max positions, or this is our pick
      s.lastEvent = await executeSignal(symbol, "buy", bar.open, cfg.mode, cfg.tradeNotionalUSDT, { reason });
      logBotEvent(symbol, "SIGNAL", cfg.mode, `FILLED BUY @ ${bar.open.toFixed(4)} · ${reason ?? "signal"}`, bar.open);
    } else if (book.pendingSignal === "sell" && held) {
      s.lastEvent = await executeSignal(symbol, "sell", bar.open, cfg.mode, cfg.tradeNotionalUSDT, { reason });
      logBotEvent(symbol, "SIGNAL", cfg.mode, `FILLED SELL @ ${bar.open.toFixed(4)} · ${reason ?? "signal"}`, bar.open);
    }
    book.pendingSignal = null;
    book.pendingReason = undefined;
  }
  await checkStops(symbol, bar.open, cfg.mode, cfg.tradeNotionalUSDT);
}

async function evaluateSymbol(symbol: string, closedBar: Candle): Promise<{
  symbol: string;
  signal: Signal;
  reason?: string;
  score: number;
  threshold: number;
}> {
  const s = state();
  const cfg = s.config!;
  const book = s.books.get(symbol) ?? emptyBook();
  s.books.set(symbol, book);

  const buf = book.candles;
  if (buf.length && buf[buf.length - 1].time === closedBar.time) buf[buf.length - 1] = closedBar;
  else buf.push(closedBar);
  if (buf.length > 400) buf.splice(0, buf.length - 400);
  book.lastClosedBar = closedBar;

  const key = liveContextKey(symbol);
  await prepareStrategyData(cfg.strategyId, symbol, cfg.interval, buf, key);

  const held = getPositions().some((p) => p.symbol === symbol);
  const detail = evaluateStrategyDetail(
    cfg.strategyId,
    buf,
    buf.length - 1,
    held ? "long" : "flat",
    cfg.params,
    key,
  );
  book.lastSignal = detail.signal;
  book.lastScore = detail.score ?? 0;

  if (detail.signal === "sell" && held) {
    book.pendingSignal = "sell";
    book.pendingReason = detail.reason;
    book.pendingBarTime = closedBar.time;
    logBotEvent(symbol, "SIGNAL", cfg.mode, `Queued SELL · ${detail.reason ?? "exit"}`, closedBar.close);
  }

  return {
    symbol,
    signal: detail.signal,
    reason: detail.reason,
    score: detail.score ?? 0,
    threshold: detail.threshold ?? 0,
  };
}

async function scanUniverse() {
  const s = state();
  const cfg = s.config;
  if (!cfg || !s.running) return;

  RiskGuard.heartbeat();
  s.lastTick = Date.now();
  s.ticks += 1;

  const openPositions = getPositions();
  const candidates: { symbol: string; score: number; reason?: string; price: number }[] = [];

  // Process symbols with limited concurrency
  const batch = [...s.watchlist];
  for (let i = 0; i < batch.length; i++) {
    const symbol = batch[i];
    try {
      const klines = await getCandles(symbol, cfg.interval, 80);
      if (klines.length < 32) continue;
      let book = s.books.get(symbol);
      if (!book) {
        book = emptyBook();
        book.candles = klines.slice(0, -1);
        s.books.set(symbol, book);
      } else if (book.candles.length < 30) {
        book.candles = klines.slice(0, -1);
      }

      const forming = klines[klines.length - 1];
      const lastClosed = klines[klines.length - 2];

      if (!book.lastFormingBar || forming.time > book.lastFormingBar.time) {
        await fillPending(symbol, forming);
        book.lastFormingBar = forming;
      } else {
        book.lastFormingBar = forming;
      }

      await checkStops(symbol, forming.close, cfg.mode, cfg.tradeNotionalUSDT);

      const isNewClose = !book.lastClosedBar || lastClosed.time > book.lastClosedBar.time;
      if (isNewClose || book.candles.length < 40) {
        // Seed buffer on first pass
        if (book.candles.length < 40) {
          book.candles = klines.slice(0, -1);
        }
        const ev = await evaluateSymbol(symbol, lastClosed);
        if (ev.signal === "buy") {
          candidates.push({
            symbol,
            score: ev.score,
            reason: ev.reason,
            price: lastClosed.close,
          });
        }
      } else {
        // Still score flat symbols for ranking display even mid-bar
        const held = openPositions.some((p) => p.symbol === symbol);
        if (!held && book.lastSignal === "buy") {
          candidates.push({
            symbol,
            score: book.lastScore,
            reason: book.pendingReason,
            price: forming.close,
          });
        }
      }
    } catch (err) {
      s.lastError = `${symbol}: ${err instanceof Error ? err.message : "scan failed"}`;
    }
  }

  // Rank candidates — pick best score for new entries
  candidates.sort((a, b) => b.score - a.score);
  s.bestCandidate = candidates[0]
    ? { symbol: candidates[0].symbol, score: candidates[0].score, reason: candidates[0].reason }
    : null;

  const canOpenMore = openPositions.length < RiskGuard.status().limits.maxOpenPositions;
  if (canOpenMore && candidates.length > 0) {
    const best = candidates[0];
    const alreadyOpen = openPositions.some((p) => p.symbol === best.symbol);
    const book = s.books.get(best.symbol);
    if (!alreadyOpen && book && book.pendingSignal !== "buy") {
      // Clear competing pending buys on other symbols
      for (const [sym, b] of s.books) {
        if (sym !== best.symbol && b.pendingSignal === "buy") {
          b.pendingSignal = null;
          b.pendingReason = undefined;
        }
      }
      book.pendingSignal = "buy";
      book.pendingReason = `${best.reason ?? "confluence"} · best-of-${s.watchlist.length} (score ${best.score.toFixed(1)})`;
      book.pendingBarTime = book.lastClosedBar?.time ?? Math.floor(Date.now() / 1000);
      s.lastSignal = "buy";
      s.pendingSignal = "buy";
      s.pendingReason = book.pendingReason;
      logBotEvent(
        best.symbol,
        "SIGNAL",
        cfg.mode,
        `BEST trade selected · score ${best.score.toFixed(1)} among ${candidates.length} buys · ${book.pendingReason}`,
        best.price,
      );
    }
  }

  // Sync status fields from primary / best
  const focus = s.bestCandidate?.symbol ?? cfg.symbol;
  const focusBook = s.books.get(focus);
  if (focusBook) {
    s.lastSignal = focusBook.lastSignal;
    if (focusBook.pendingSignal) {
      s.pendingSignal = focusBook.pendingSignal;
      s.pendingReason = focusBook.pendingReason;
    }
  }

  s.lastError = null;
  void persistSnapshot();
}

function startPolling() {
  const s = state();
  const cfg = s.config;
  if (!cfg) return;
  if (s.pollTimer) clearInterval(s.pollTimer);
  // Universe scan is heavier — poll a bit slower
  const ms = cfg.universeMode || (cfg.symbols?.length ?? 0) > 1
    ? Math.max(8000, cfg.pollMs)
    : Math.max(3000, cfg.pollMs);
  s.pollTimer = setInterval(() => { void scanUniverse(); }, ms);
  void scanUniverse();
}

function stopPolling() {
  const s = state();
  if (s.pollTimer) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }
}

async function ensureResumed() {
  const s = state();
  if (s.resumed || s.running) return;
  s.resumed = true;
  const snap = await loadBotSnapshot();
  if (snap?.running && snap.config) {
    s.config = snap.config;
    s.running = true;
    s.lastSignal = snap.lastSignal as Signal | null;
    s.pendingSignal = snap.pendingSignal as Signal | null;
    s.pendingReason = snap.pendingReason;
    s.lastError = snap.lastError;
    s.ticks = snap.ticks;
    try {
      s.watchlist = await resolveWatchlist(snap.config);
      if (!s.books) s.books = new Map();
      for (const sym of s.watchlist) s.books.set(sym, emptyBook());
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : "resume failed";
      s.watchlist = [snap.config.symbol.toUpperCase()];
    }
    startPolling();
    logBotEvent(snap.config.symbol, "BOT", snap.config.mode, `Bot resumed · scanning ${(s.watchlist ?? []).length} symbols`);
  }
}

export const BotRunner = {
  async start(config: BotConfig) {
    const s = state();
    this.stop();
    s.config = config;
    s.running = true;
    s.ticks = 0;
    s.lastError = null;
    s.pendingSignal = null;
    s.bestCandidate = null;
    s.books = new Map();

    RiskGuard.heartbeat();
    s.watchlist = await resolveWatchlist(config);
    for (const sym of s.watchlist) s.books.set(sym, emptyBook());

    const modeLabel = config.universeMode || s.watchlist.length > 1
      ? `universe×${s.watchlist.length}`
      : config.symbol;

    logBotEvent(
      config.symbol,
      "BOT",
      config.mode,
      `Started · ${config.strategyId} · ${config.interval} · $${config.tradeNotionalUSDT} · ${modeLabel} · ${s.watchlist.join(",")}`,
    );

    startPolling();
    await persistSnapshot();
  },

  stop() {
    const s = state();
    const cfg = s.config;
    stopPolling();
    if (s.running && cfg) {
      logBotEvent(cfg.symbol, "BOT", cfg.mode, "Stopped");
    }
    s.running = false;
    s.pendingSignal = null;
    s.bestCandidate = null;
    void persistSnapshot();
  },

  async status() {
    await ensureResumed();
    const s = state();
    const watchlist = Array.isArray(s.watchlist) ? s.watchlist : [];
    return {
      running: s.running,
      config: s.config
        ? {
            ...s.config,
            symbols: watchlist,
            universeMode: s.config.universeMode ?? watchlist.length > 1,
          }
        : null,
      lastSignal: s.lastSignal,
      pendingSignal: s.pendingSignal,
      pendingReason: s.pendingReason,
      lastTick: s.lastTick,
      lastEvent: s.lastEvent,
      lastError: s.lastError,
      ticks: s.ticks,
      positions: getPositions(),
      watchlist,
      bestCandidate: s.bestCandidate ?? null,
      transport: "multi-poll",
    };
  },
};
