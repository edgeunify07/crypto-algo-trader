import { NextResponse } from "next/server";
import { evaluatePromotionGate } from "@/lib/promotion";
import { getMarkets } from "@/lib/binance/marketData";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "BTCUSDT";
  const equity = Number(searchParams.get("equity") ?? 100);
  const riskPct = Number(searchParams.get("riskPct") ?? 2);

  const gate = await evaluatePromotionGate();
  let minNotionalWarning: string | null = null;
  try {
    const markets = await getMarkets();
    const m = markets.find((x) => x.symbol === symbol.toUpperCase());
    if (m) {
      const { getMinNotionalWarning } = await import("@/lib/promotion");
      minNotionalWarning = getMinNotionalWarning(symbol, m.minNotional || 5, equity, riskPct);
    }
  } catch { /* ignore */ }

  const roundTripFee = 0.002;
  const tradesPerDay = 5;
  const breakEvenEdge = roundTripFee / tradesPerDay + 0.003;

  return NextResponse.json({
    gate,
    minNotionalWarning,
    breakEvenEdgePct: breakEvenEdge * 100,
    feeDragNote: "0.2% round-trip spot taker; 5 trades/day ≈ 1%/day fee drag on $100",
    defaults: { maxDailyLoss: 5, maxOrder: 25, maxPositions: 2, riskPct: 2 },
  });
}
