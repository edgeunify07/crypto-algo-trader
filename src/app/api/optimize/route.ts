import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/data/historical";
import { prepareStrategyData, BACKTEST_KEY } from "@/lib/engine/signals";
import { backtest, BINANCE_SPOT_COSTS } from "@/lib/backtest";
import { computeExtendedMetrics } from "@/lib/backtest/metrics";
import { getStrategy, UI_STRATEGIES } from "@/lib/strategies/registry";
import type { CandleInterval } from "@/lib/types";

/** Simple grid search — reports top configs with DSR (Stage 5 / §11). */
export async function POST(req: NextRequest) {
  let body: {
    symbol?: string;
    interval?: CandleInterval;
    strategyId?: string;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { symbol, interval = "1h", strategyId = "confluence-swing", limit = 500 } = body;
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const strategy = getStrategy(strategyId);
  if (!strategy) return NextResponse.json({ error: "unknown strategy" }, { status: 404 });

  try {
    const { candles } = await getHistoricalCandles({ symbol, interval, limit, useCache: true });
    await prepareStrategyData(strategyId, symbol, interval, candles, BACKTEST_KEY);

    const grid: Record<string, number>[] = [];
    if (strategyId === "confluence-swing" || strategyId === "confluence-scalp") {
      for (const fast of [5, 9, 12]) {
        for (const slow of [21, 26, 34]) {
          if (fast >= slow) continue;
          grid.push({ ...strategy.params, emaFast: fast, emaSlow: slow, smaFast: fast, smaSlow: slow, entryThreshold: 5 + fast });
        }
      }
    } else {
      grid.push(strategy.params);
    }

    const results = grid.map((params) => {
      const r = backtest(strategy, candles, params, 10_000, BINANCE_SPOT_COSTS);
      const m = computeExtendedMetrics(r, grid.length);
      return {
        params,
        totalReturnPct: r.totalReturnPct,
        sharpe: m.sharpe,
        deflatedSharpe: m.deflatedSharpe,
        profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : null,
        maxDrawdownPct: r.maxDrawdownPct,
        numTrades: r.numTrades,
      };
    }).sort((a, b) => b.deflatedSharpe - a.deflatedSharpe);

    return NextResponse.json({
      symbol,
      interval,
      trials: grid.length,
      best: results[0],
      top: results.slice(0, 10),
      note: "Select from robustness plateaus, not isolated peaks. Live Sharpe typically 30–50% below backtest.",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "optimize failed" }, { status: 502 });
  }
}

export async function GET() {
  return NextResponse.json({ strategies: UI_STRATEGIES.map((s) => s.id) });
}
