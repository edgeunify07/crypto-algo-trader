import { NextRequest, NextResponse } from "next/server";
import { getRecentTrades } from "@/lib/binance/marketData";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const limit = Number(searchParams.get("limit") ?? 30);
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  try {
    const trades = await getRecentTrades(symbol, limit);
    return NextResponse.json({ trades });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
