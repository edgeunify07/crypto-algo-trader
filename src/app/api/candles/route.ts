import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/lib/binance/marketData";
import type { CandleInterval } from "@/lib/types";

const VALID: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? searchParams.get("pair");
  const interval = (searchParams.get("interval") ?? "1m") as CandleInterval;
  const limit = Math.min(Number(searchParams.get("limit") ?? 500), 1000);

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  if (!VALID.includes(interval)) {
    return NextResponse.json({ error: `interval must be one of ${VALID.join(", ")}` }, { status: 400 });
  }

  try {
    const candles = await getCandles(symbol, interval, limit);
    return NextResponse.json({ candles });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to fetch candles" },
      { status: 502 },
    );
  }
}
