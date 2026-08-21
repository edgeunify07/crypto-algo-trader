import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/lib/binance/marketData";
import { getStrategy, STRATEGIES } from "@/lib/strategies/builtin";
import { backtest } from "@/lib/backtest";
import type { CandleInterval } from "@/lib/types";

// List available strategies (for the UI to render).
export async function GET() {
  return NextResponse.json({
    strategies: STRATEGIES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      params: s.params,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: {
    symbol?: string;
    pair?: string;
    interval?: CandleInterval;
    strategyId?: string;
    params?: Record<string, number>;
    limit?: number;
    startEquity?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const symbol = body.symbol ?? body.pair;
  const { interval = "1h", strategyId, limit = 1000, startEquity } = body;
  if (!symbol || !strategyId) {
    return NextResponse.json({ error: "symbol and strategyId are required" }, { status: 400 });
  }

  const strategy = getStrategy(strategyId);
  if (!strategy) {
    return NextResponse.json({ error: `unknown strategy ${strategyId}` }, { status: 404 });
  }

  const params = { ...strategy.params, ...(body.params ?? {}) };

  try {
    const candles = await getCandles(symbol, interval, Math.min(limit, 1000));
    if (candles.length < 30) {
      return NextResponse.json({ error: "not enough candle data to backtest" }, { status: 422 });
    }
    const result = backtest(strategy, candles, params, startEquity ?? 100_000);
    return NextResponse.json({ result, params });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "backtest failed" },
      { status: 502 },
    );
  }
}
