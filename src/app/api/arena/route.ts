import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/lib/binance/marketData";
import { STRATEGIES } from "@/lib/strategies/builtin";
import { backtest, BINANCE_SPOT_COSTS } from "@/lib/backtest";
import type { CandleInterval } from "@/lib/types";

// Auto-backtest EVERY strategy on the latest live candles and rank them.
// Stateless: each call fetches fresh candles, so polling this endpoint gives a
// leaderboard that updates as new live candles form. Real Binance taker fees
// (0.1%, no TDS) are applied via BINANCE_SPOT_COSTS.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const interval = (searchParams.get("interval") ?? "15m") as CandleInterval;
  const limit = Math.min(Number(searchParams.get("limit") ?? 1000), 1000);
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });

  try {
    const candles = await getCandles(symbol, interval, limit);
    if (candles.length < 30) return NextResponse.json({ error: "not enough candle data" }, { status: 422 });

    const board = STRATEGIES.map((s) => {
      const r = backtest(s, candles, s.params, 10_000, BINANCE_SPOT_COSTS);
      return {
        id: s.id,
        name: s.name,
        params: s.params,
        totalReturnPct: r.totalReturnPct,
        buyHoldReturnPct: r.buyHoldReturnPct,
        numTrades: r.numTrades,
        winRate: r.winRate,
        maxDrawdownPct: r.maxDrawdownPct,
        totalFeesPaid: r.totalFeesPaid,
        endEquity: r.endEquity,
      };
    }).sort((a, b) => b.totalReturnPct - a.totalReturnPct);

    return NextResponse.json({
      symbol,
      interval,
      bars: candles.length,
      from: candles[0].time,
      to: candles[candles.length - 1].time,
      buyHoldReturnPct: board[0]?.buyHoldReturnPct ?? 0,
      leaderboard: board,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "arena failed" }, { status: 502 });
  }
}
