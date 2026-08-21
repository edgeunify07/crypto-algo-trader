import { NextRequest, NextResponse } from "next/server";
import { getTicker } from "@/lib/binance/marketData";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  try {
    const ticker = await getTicker(symbol);
    return NextResponse.json({ ticker });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to fetch ticker" },
      { status: 502 },
    );
  }
}
