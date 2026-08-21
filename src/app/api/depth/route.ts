import { NextRequest, NextResponse } from "next/server";
import { getDepth } from "@/lib/binance/marketData";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const limit = Number(searchParams.get("limit") ?? 20);
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  try {
    const book = await getDepth(symbol, limit);
    return NextResponse.json(book);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
