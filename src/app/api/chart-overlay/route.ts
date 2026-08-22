import { NextRequest, NextResponse } from "next/server";
import { getHistoricalCandles } from "@/lib/data/historical";
import { computeChartOverlay } from "@/lib/chart/computeOverlay";
import { defaultHtfFor, prepareConfluenceStrategy, CONFLUENCE_KEY } from "@/lib/strategies/confluenceStrategy";
import { DEFAULT_CONFLUENCE_PARAMS, DEFAULT_SCALP_PARAMS } from "@/lib/strategies/confluence";
import type { CandleInterval } from "@/lib/types";

function parseParams(searchParams: URLSearchParams): Record<string, number> {
  const raw = searchParams.get("params");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* fall through */ }
  }
  return {};
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const interval = (searchParams.get("interval") ?? "15m") as CandleInterval;
  const limit = Math.min(Number(searchParams.get("limit") ?? 500), 500);
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const params = { ...DEFAULT_CONFLUENCE_PARAMS, ...DEFAULT_SCALP_PARAMS, ...parseParams(searchParams) };

  try {
    const { candles: ltf } = await getHistoricalCandles({ symbol, interval, limit, useCache: true });
    const htfInterval = defaultHtfFor(interval, (params.mode ?? 0) >= 1);
    const { candles: htf } = await getHistoricalCandles({
      symbol,
      interval: htfInterval,
      startTime: ltf[0]?.time,
      endTime: ltf[ltf.length - 1]?.time,
      useCache: true,
    });

    prepareConfluenceStrategy(CONFLUENCE_KEY, ltf, htf, htfInterval);
    const overlay = computeChartOverlay(ltf, htf, htfInterval, params);

    return NextResponse.json(overlay);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "overlay failed" }, { status: 502 });
  }
}
