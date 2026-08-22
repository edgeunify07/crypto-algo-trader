import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/data/historical";
import { prepareStrategyData, BACKTEST_KEY } from "@/lib/engine/signals";
import { UI_STRATEGIES } from "@/lib/strategies/registry";
import { backtest, BINANCE_SPOT_COSTS } from "@/lib/backtest";
import type { CandleInterval } from "@/lib/types";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const interval = (searchParams.get("interval") ?? "15m") as CandleInterval;
  const limit = Math.min(Number(searchParams.get("limit") ?? 1000), 1000);
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });

  try {
    const { candles } = await getHistoricalCandles({ symbol, interval, limit, useCache: true });
    if (candles.length < 30) return NextResponse.json({ error: "not enough candle data" }, { status: 422 });

    const board = await Promise.all(
      UI_STRATEGIES.map(async (s) => {
        await prepareStrategyData(s.id, symbol, interval, candles, BACKTEST_KEY);
        const r = backtest(s, candles, s.params, 10_000, BINANCE_SPOT_COSTS);
        return {
          id: s.id,
          name: s.name,
          params: s.params,
          totalReturnPct: r.totalReturnPct,
          buyHoldReturnPct: r.buyHoldReturnPct,
          numTrades: r.numTrades,
          winRate: r.winRate,
          profitFactor: r.profitFactor,
          maxDrawdownPct: r.maxDrawdownPct,
          totalFeesPaid: r.totalFeesPaid,
          endEquity: r.endEquity,
        };
      }),
    );
    board.sort((a, b) => b.totalReturnPct - a.totalReturnPct);

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
