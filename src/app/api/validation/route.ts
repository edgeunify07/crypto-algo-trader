import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/data/historical";
import { getStrategy } from "@/lib/strategies/builtin";
import { runValidation } from "@/lib/validation/runner";

export async function POST(req: NextRequest) {
  let body: {
    symbol?: string;
    interval?: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    strategyId?: string;
    params?: Record<string, number>;
    limit?: number;
    startEquity?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { symbol, interval = "1h", strategyId, limit = 1000, startEquity = 10_000 } = body;
  if (!symbol || !strategyId) {
    return NextResponse.json({ error: "symbol and strategyId required" }, { status: 400 });
  }

  const strategy = getStrategy(strategyId);
  if (!strategy) return NextResponse.json({ error: "unknown strategy" }, { status: 404 });

  const params = { ...strategy.params, ...(body.params ?? {}) };

  try {
    const { candles } = await getHistoricalCandles({ symbol, interval, limit, useCache: true });
    if (candles.length < 60) return NextResponse.json({ error: "not enough data" }, { status: 422 });

    // runValidation rebuilds the strategy context per slice itself — a single
    // full-window prepare here would misalign every out-of-sample signal.
    const result = await runValidation(strategy, symbol, interval, candles, params, startEquity);

    return NextResponse.json({ result, symbol, interval, bars: candles.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "validation failed" }, { status: 502 });
  }
}
