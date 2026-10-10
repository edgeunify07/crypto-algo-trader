import { NextResponse } from "next/server";
import { runFuturesBacktest, type BacktestInput } from "@/lib/improve2/backtest";
import { fetchFuturesKlines } from "@/lib/futures/rest";
import { loadParams } from "@/lib/improve2/improve";
import { resolveUniverse } from "@/lib/engine2/universe";
import { kv } from "@/lib/store/kv";
import type { Candle, Timeframe } from "@/lib/algo/types";

/**
 * Replays the live strategy over recent real klines so the dashboard can show
 * what it would have done, not just what it is about to do.
 *
 * Cached, because a full replay costs several seconds and the answer only
 * changes as new bars close. The cache key includes the parameter version, so
 * a promotion from the improvement loop invalidates it immediately rather than
 * leaving the UI quoting results for parameters that are no longer live.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_SECONDS = 1800;

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
  const key = `algo:backtest:${stored.version}:${days}`;

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
    const universe = await resolveUniverse();
    const symbols = universe.entries.map((e) => e.symbol);
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

    const result = runFuturesBacktest(data, stored.params, {
      stepTimeframe: "1h",
      startingBalance: Number(process.env.STARTING_BALANCE ?? "100"),
      from,
      to: latest,
    });

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
