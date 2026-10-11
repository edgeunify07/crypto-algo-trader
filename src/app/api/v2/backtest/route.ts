import { NextResponse } from "next/server";
import { runFuturesBacktest, type BacktestInput } from "@/lib/improve2/backtest";
import { fetchFuturesKlines } from "@/lib/futures/rest";
import { loadParams } from "@/lib/improve2/improve";
import { UNIVERSE_SIZE, rankUniverse } from "@/lib/engine2/universe";
import { fetchFuturesTickers } from "@/lib/futures/rest";
import { kv } from "@/lib/store/kv";
import type { Candle, Timeframe } from "@/lib/algo/types";

/**
 * Replays the live strategy over recent real klines so the dashboard can show
 * what it would have done, not just what it is about to do.
 *
 * Two things keep the number honest, and both cost something:
 *
 *  - the symbol pool is wider than the ten the engine trades, and the
 *    backtester re-ranks it by trailing volume at every step. Handing it
 *    today's top ten instead would score the strategy only on the coins that
 *    turned out to have the biggest month — reliably worth tens of percent it
 *    could never have earned;
 *  - the window is split at the parameters' `fittedThrough`, so the part the
 *    search had already seen is reported separately from the part it had not.
 *
 * Cached, because a full replay costs several seconds and the answer only
 * changes as new bars close. The cache key includes the parameter version, so
 * a promotion from the improvement loop invalidates it immediately rather than
 * leaving the UI quoting results for parameters that are no longer live.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_SECONDS = 1800;

/**
 * A short, stable fingerprint of the parameters themselves.
 *
 * The cache was keyed on the version *label*, which for the shipped defaults
 * is the fixed string "default-v1" — so retuning those defaults left the key
 * unchanged and the dashboard went on serving the previous parameters'
 * results. Measured on the deployment right after a promotion: the cache said
 * -3.01% over 40 trades while the same request computed fresh said +3.25%
 * over 28. It healed itself half an hour later, which is worse than failing,
 * because by then nobody is looking.
 *
 * Keys are sorted before hashing so a record loaded from storage, whose
 * property order is whatever the serialiser chose, fingerprints the same as
 * the literal in source.
 */
export function fingerprint(params: unknown): string {
  const canonical = JSON.stringify(params, (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value,
  );
  // FNV-1a: not a security hash, just a cheap stable one with few collisions
  // across the handful of parameter sets this will ever see.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * How many symbols the replay ranks between.
 *
 * Wider than the live universe so the point-in-time ranking has losers to
 * choose against, but every extra symbol is three more kline requests inside
 * a 60s function, so it stops well short of the whole board.
 */
const POOL_SIZE = Number(process.env.BACKTEST_POOL_SIZE ?? "20");

/** Headline figures for one slice of the replay. */
interface Slice {
  from: number;
  to: number;
  days: number;
  totalReturn: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
}

interface CachedBacktest {
  paramsVersion: string;
  days: number;
  ranAt: number;
  startingBalance: number;
  finalEquity: number;
  totalReturn: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  expectancy: number;
  totalFees: number;
  totalFunding: number;
  liquidations: number;
  bySymbol: { symbol: string; trades: number; netPnl: number }[];
  byReason: { reason: string; trades: number; netPnl: number }[];
  equityCurve: { t: number; equity: number }[];
  /** Symbols ranked against each other, and how many could trade at once. */
  poolSize: number;
  universeSize: number;
  /** Last moment of data the live parameters were fitted on. */
  fittedThrough: number;
  /** Days of this window that the parameter search had already seen. */
  inSampleDays: number;
  /**
   * The part of the window after `fittedThrough`, replayed on its own.
   * Null when the whole window is in-sample, which is the honest answer for
   * freshly fitted parameters: there is no clean number to show yet.
   */
  outOfSample: Slice | null;
  recent: {
    symbol: string; side: string; entryPrice: number; exitPrice: number;
    netPnl: number; exitReason: string; closedAt: number;
  }[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Math.min(45, Math.max(5, Number(url.searchParams.get("days") ?? "30") || 30));
  const force = url.searchParams.get("refresh") === "1";

  const store = kv();
  const stored = await loadParams();
  const key = `algo:backtest:${stored.version}:${fingerprint(stored.params)}:${days}`;

  if (!force) {
    const cached = await store.get<CachedBacktest>(key);
    if (cached) {
      return NextResponse.json(
        { ...cached, cached: true },
        { headers: { "cache-control": "no-store" } },
      );
    }
  }

  try {
    // Ranked here rather than through `resolveUniverse`, which caches into the
    // key the live engine reads: a backtest asking for a wider pool must not
    // hand the engine twenty symbols to trade.
    const tickers = await fetchFuturesTickers();
    const symbols = rankUniverse(tickers, POOL_SIZE).map((e) => e.symbol);
    const timeframes: Timeframe[] = ["15m", "1h", "4h"];
    // 1h bars for the window, plus headroom so indicators are warm at the start.
    const bars: Record<string, number> = {
      "15m": Math.min(1500, days * 96 + 300),
      "1h": Math.min(1500, days * 24 + 300),
      "4h": Math.min(1500, days * 6 + 200),
    };

    const loaded = await Promise.all(
      symbols.flatMap((s) =>
        timeframes.map(async (tf) => ({
          s, tf,
          c: await fetchFuturesKlines(s, tf, bars[tf]!).catch(() => [] as Candle[]),
        })),
      ),
    );
    const bySym = new Map<string, Map<Timeframe, Candle[]>>();
    for (const { s, tf, c } of loaded) {
      if (c.length === 0) continue;
      const m = bySym.get(s) ?? new Map<Timeframe, Candle[]>();
      m.set(tf, c);
      bySym.set(s, m);
    }
    const data: BacktestInput[] = [...bySym].map(([symbol, byTimeframe]) => ({ symbol, byTimeframe }));
    if (data.length === 0) {
      return NextResponse.json({ error: "no market data available" }, { status: 503 });
    }

    const stepAll = data.flatMap((d) => d.byTimeframe.get("1h") ?? []);
    const latest = Math.max(...stepAll.map((c) => c.closeTime));
    const from = latest - days * 86_400_000;

    const startingBalance = Number(process.env.STARTING_BALANCE ?? "100");
    const replay = (windowFrom: number) =>
      runFuturesBacktest(data, stored.params, {
        stepTimeframe: "1h",
        startingBalance,
        from: windowFrom,
        to: latest,
        // Matches the live engine, which only ever trades the day's top N.
        universeSize: UNIVERSE_SIZE,
      });

    const result = replay(from);

    // The clean slice, when one exists. Replayed separately rather than
    // sliced out of the full run, because an account that compounded through
    // the in-sample months would enter the clean window with the wrong size.
    const oosFrom = Math.max(from, stored.fittedThrough);
    const outOfSample: Slice | null =
      latest - oosFrom >= 5 * 86_400_000
        ? (() => {
            const r = replay(oosFrom);
            return {
              from: oosFrom,
              to: latest,
              days: Math.round((latest - oosFrom) / 86_400_000),
              totalReturn: r.totalReturn,
              trades: r.trades.length,
              winRate: r.winRate,
              profitFactor: r.profitFactor,
              maxDrawdown: r.maxDrawdown,
            };
          })()
        : null;

    const group = (keyOf: (t: (typeof result.trades)[number]) => string) => {
      const m = new Map<string, { trades: number; netPnl: number }>();
      for (const t of result.trades) {
        const k = keyOf(t);
        const b = m.get(k) ?? { trades: 0, netPnl: 0 };
        b.trades++;
        b.netPnl += t.netPnl;
        m.set(k, b);
      }
      return [...m.entries()].sort((a, b) => b[1].netPnl - a[1].netPnl);
    };

    // Equity curve reconstructed from closed trades, which is all the
    // backtester retains; enough to draw the shape of the run.
    let running = result.startingBalance;
    const equityCurve = result.trades
      .slice()
      .sort((a, b) => a.closedAt - b.closedAt)
      .map((t) => {
        running += t.netPnl;
        return { t: t.closedAt, equity: Number(running.toFixed(4)) };
      });

    const wins = result.trades.filter((t) => t.netPnl > 0).length;
    const payload: CachedBacktest = {
      paramsVersion: stored.version,
      days,
      ranAt: Date.now(),
      startingBalance: result.startingBalance,
      finalEquity: result.finalEquity,
      totalReturn: result.totalReturn,
      trades: result.trades.length,
      wins,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      maxDrawdown: result.maxDrawdown,
      expectancy: result.expectancy,
      totalFees: result.totalFees,
      totalFunding: result.totalFunding,
      liquidations: result.liquidations,
      bySymbol: group((t) => t.symbol).map(([symbol, v]) => ({ symbol, ...v })),
      byReason: group((t) => t.exitReason).map(([reason, v]) => ({ reason, ...v })),
      equityCurve: equityCurve.slice(-200),
      poolSize: data.length,
      universeSize: UNIVERSE_SIZE,
      fittedThrough: stored.fittedThrough,
      inSampleDays: Math.max(
        0,
        Math.round((Math.min(latest, stored.fittedThrough) - from) / 86_400_000),
      ),
      outOfSample,
      recent: result.trades
        .slice()
        .sort((a, b) => b.closedAt - a.closedAt)
        .slice(0, 12)
        .map((t) => ({
          symbol: t.symbol, side: t.side, entryPrice: t.entryPrice,
          exitPrice: t.exitPrice, netPnl: t.netPnl,
          exitReason: t.exitReason, closedAt: t.closedAt,
        })),
    };

    await store.set(key, payload, CACHE_TTL_SECONDS);
    return NextResponse.json({ ...payload, cached: false }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
