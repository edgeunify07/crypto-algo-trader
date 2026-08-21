import { NextRequest, NextResponse } from "next/server";
import { getTopTickers } from "@/lib/binance/marketData";

export async function GET(req: NextRequest) {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 40);
  try {
    const markets = await getTopTickers(limit);
    return NextResponse.json({ markets });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}
