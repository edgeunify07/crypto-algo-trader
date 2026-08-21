import { NextResponse } from "next/server";
import { getMarkets } from "@/lib/binance/marketData";

export async function GET() {
  try {
    const markets = await getMarkets();
    return NextResponse.json({ markets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to fetch markets" },
      { status: 502 },
    );
  }
}
