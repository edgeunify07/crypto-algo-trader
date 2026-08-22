import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/data/historical";
import { fetchAggTrades } from "@/lib/data/aggTrades";
import { checkCandleQuality, checkCoverage } from "@/lib/data/quality";
import { prepareStrategyData } from "@/lib/engine/signals";
import { getStrategy, UI_STRATEGIES, isScalpStrategy } from "@/lib/strategies/registry";
import { backtest, BINANCE_SPOT_COSTS, type CostModel, type BacktestResult } from "@/lib/backtest";
import { backtestScalp } from "@/lib/backtest/scalpEngine";
import { computeExtendedMetrics, breakEvenEdgePerTrade } from "@/lib/backtest/metrics";
import { resolveUniverse, backtestContextKey } from "@/lib/universe";
import crypto from "node:crypto";
import type { CandleInterval } from "@/lib/types";

export async function GET() {
  return NextResponse.json({
    strategies: UI_STRATEGIES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      params: s.params,
    })),
  });
}

async function runOneSymbol(opts: {
  symbol: string;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  startEquity: number;
  limit: number;
  startTime?: number;
  endTime?: number;
  costs: CostModel;
  scalp: boolean;
}) {
  const { symbol, interval, strategyId, params, startEquity, limit, startTime, endTime, costs, scalp } = opts;
  const strategy = getStrategy(strategyId)!;
  const ctxKey = backtestContextKey(symbol);

  const { candles, source, fromCache, updatedAt } = await getHistoricalCandles({
    symbol,
    interval,
    limit,
    startTime,
    endTime,
    useCache: true,
  });

  if (candles.length < 30) {
    return { error: `not enough candles for ${symbol}`, symbol };
  }

  const quality = checkCandleQuality(candles, interval);
  await prepareStrategyData(strategyId, symbol, interval, candles, ctxKey);

  let result: BacktestResult;
  let scalpMeta = null;

  if (scalp) {
    const fromMs = candles[0].time * 1000;
    const toMs = (candles[candles.length - 1].closeTime ?? candles[candles.length - 1].time) * 1000;
    let aggTrades: Awaited<ReturnType<typeof fetchAggTrades>> = [];
    try {
      aggTrades = await fetchAggTrades(symbol, fromMs, toMs);
    } catch { /* kline fallback */ }
    const scalpResult = backtestScalp(strategy, candles, params, {
      startEquity,
      interval,
      aggTrades,
      klineOnly: aggTrades.length === 0,
      maxHoldBars: params.maxHoldBars ?? 15,
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0005,
      contextKey: ctxKey,
    });
    scalpMeta = scalpResult.scalpMeta;
    result = scalpResult;
  } else {
    result = backtest(strategy, candles, params, startEquity, costs, ctxKey);
  }

  const metrics = computeExtendedMetrics(result);
  return {
    symbol: symbol.toUpperCase(),
    result,
    metrics,
    scalpMeta,
    provenance: {
      source,
      symbol: symbol.toUpperCase(),
      interval,
      candleCount: candles.length,
      fromCache,
      updatedAt,
      gaps: quality.gaps.length,
      warnings: quality.warnings,
    },
    chartMarkers: result.trades.flatMap((t) => [
      { time: t.entryTime, price: t.entryPrice, side: "buy" as const, reason: `${symbol} · ${t.entryReason ?? "entry"}` },
      { time: t.exitTime, price: t.exitPrice, side: "sell" as const, reason: `${symbol} · ${t.exitReason ?? "exit"}` },
    ]),
  };
}

export async function POST(req: NextRequest) {
  let body: {
    symbol?: string;
    pair?: string;
    symbols?: string[];
    universeMode?: boolean;
    universeLimit?: number;
    interval?: CandleInterval;
    strategyId?: string;
    params?: Record<string, number>;
    limit?: number;
    startEquity?: number;
    startTime?: number;
    endTime?: number;
    feeRate?: number;
    slippageRate?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const primary = (body.symbol ?? body.pair ?? "BTCUSDT").toUpperCase();
  const { interval = "15m", strategyId, limit = 800, startEquity, startTime, endTime } = body;

  if (!strategyId) {
    return NextResponse.json({ error: "strategyId is required" }, { status: 400 });
  }
  if (startEquity == null || startEquity <= 0) {
    return NextResponse.json({ error: "startEquity is required — enter your account size in USDT" }, { status: 400 });
  }

  const strategy = getStrategy(strategyId);
  if (!strategy) {
    return NextResponse.json({ error: `unknown strategy ${strategyId}` }, { status: 404 });
  }

  const params = { ...strategy.params, ...(body.params ?? {}) };
  const scalp = isScalpStrategy(strategyId);
  const costs: CostModel = {
    ...BINANCE_SPOT_COSTS,
    feeRate: scalp ? 0.0002 : BINANCE_SPOT_COSTS.feeRate,
    ...(body.feeRate != null ? { feeRate: body.feeRate } : {}),
    ...(body.slippageRate != null ? { slippageRate: body.slippageRate } : {}),
  };

  let symbols: string[] = [primary];
  if (body.symbols?.length) {
    symbols = [...new Set(body.symbols.map((s) => s.toUpperCase()))];
  } else if (body.universeMode) {
    symbols = await resolveUniverse(body.universeLimit ?? 20);
    if (!symbols.includes(primary)) symbols.unshift(primary);
  }

  try {
    const runs = [];
    for (const symbol of symbols) {
      try {
        const one = await runOneSymbol({
          symbol,
          interval,
          strategyId,
          params,
          startEquity,
          limit: scalp ? Math.min(limit, 400) : limit,
          startTime,
          endTime,
          costs,
          scalp,
        });
        if (!("error" in one)) runs.push(one);
      } catch (err) {
        runs.push({
          symbol,
          error: err instanceof Error ? err.message : "failed",
        } as never);
      }
    }

    const ok = runs.filter((r) => r && "result" in r && r.result) as Awaited<ReturnType<typeof runOneSymbol>>[];
    if (!ok.length) {
      return NextResponse.json({ error: "all symbol backtests failed" }, { status: 422 });
    }

    // Rank: positive expectancy first, then return, then win rate (skip zero-trade noise)
    const ranked = [...ok].sort((a, b) => {
      const aTrades = a.result!.numTrades;
      const bTrades = b.result!.numTrades;
      if (aTrades === 0 && bTrades > 0) return 1;
      if (bTrades === 0 && aTrades > 0) return -1;
      const exp = (b.result!.expectancy) - (a.result!.expectancy);
      if (Math.abs(exp) > 0.01) return exp;
      const ret = (b.result!.totalReturnPct) - (a.result!.totalReturnPct);
      if (Math.abs(ret) > 0.05) return ret;
      return (b.result!.winRate) - (a.result!.winRate);
    });

    const best = ranked[0];
    const primaryRun = ok.find((r) => r.symbol === primary) ?? best;
    const configHash = crypto.createHash("sha256")
      .update(JSON.stringify({ strategyId, params, interval, symbols }))
      .digest("hex")
      .slice(0, 12);
    const tradesPerDay = scalp ? 20 : 5;
    const breakEven = breakEvenEdgePerTrade(costs.feeRate, costs.slippageRate, tradesPerDay) * 100;

    if (scalp && best.scalpMeta) {
      const { setScalpBacktestMeta } = await import("@/lib/scalpState");
      setScalpBacktestMeta({
        klineOnly: best.scalpMeta.klineOnly,
        makerFillRatio: best.scalpMeta.makerFillRatio,
        strategyId,
      });
    }

    return NextResponse.json({
      result: primaryRun.result,
      metrics: primaryRun.metrics,
      scalpMeta: primaryRun.scalpMeta,
      chartMarkers: primaryRun.chartMarkers,
      params,
      costs,
      configHash,
      breakEven: {
        minEdgePct: breakEven,
        feeBudgetPct: scalp ? (20 * 2.5 * 0.001 / startEquity) * 100 : breakEven,
        viable: (primaryRun.result?.expectancy ?? 0) > 0 || (primaryRun.result?.numTrades ?? 0) === 0,
      },
      provenance: {
        ...primaryRun.provenance,
        strategyId,
        universeMode: symbols.length > 1,
        symbols,
        coverageFrom: null,
        coverageTo: null,
        warnings: [
          ...(primaryRun.provenance?.warnings ?? []),
          ...(symbols.length > 1 ? [`Scanned ${symbols.length} symbols — ranking by win rate`] : []),
        ],
        coverageOk: true,
        coverageMessage: "",
      },
      universe: ranked.map((r) => ({
        symbol: r.symbol,
        totalReturnPct: r.result!.totalReturnPct,
        winRate: r.result!.winRate,
        profitFactor: r.result!.profitFactor === Infinity ? null : r.result!.profitFactor,
        numTrades: r.result!.numTrades,
        maxDrawdownPct: r.result!.maxDrawdownPct,
        expectancy: r.result!.expectancy,
        endEquity: r.result!.endEquity,
      })),
      bestSymbol: best.symbol,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "backtest failed" },
      { status: 502 },
    );
  }
}
