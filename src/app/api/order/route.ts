import { NextRequest, NextResponse } from "next/server";
import { placeOrder, cancelOrder, getOpenOrders, type PlaceOrderParams } from "@/lib/binance/trading";
import { RiskGuard } from "@/lib/risk";
import { configSummary, hasCredentials } from "@/lib/binance/config";

export async function GET(req: NextRequest) {
  if (!hasCredentials()) return NextResponse.json({ error: "no credentials" }, { status: 401 });
  const symbol = new URL(req.url).searchParams.get("symbol") ?? undefined;
  try {
    const orders = await getOpenOrders(symbol);
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasCredentials()) return NextResponse.json({ error: "no credentials configured" }, { status: 401 });

  const cfg = configSummary();
  let body: PlaceOrderParams;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.symbol || !body.side || !body.type) {
    return NextResponse.json({ error: "symbol, side, type are required" }, { status: 400 });
  }

  // Risk check on opening trades.
  if (body.side === "BUY") {
    const notional = body.quoteOrderQty ?? (body.quantity ?? 0) * (body.price ?? 0);
    const decision = RiskGuard.canOpen(body.symbol.toUpperCase(), notional);
    if (!decision.ok) return NextResponse.json({ error: `blocked: ${decision.reason}` }, { status: 403 });
  } else {
    const decision = RiskGuard.canClose();
    if (!decision.ok) return NextResponse.json({ error: `blocked: ${decision.reason}` }, { status: 403 });
  }

  // Refuse real orders unless the live env is explicitly enabled.
  if (!cfg.live) {
    return NextResponse.json(
      { error: `refusing real order: env=${cfg.env}, tradingEnabled=${cfg.tradingEnabled}. Set BINANCE_ENV=live and TRADING_ENABLED=true to arm.` },
      { status: 403 },
    );
  }

  try {
    const result = await placeOrder(body);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "order failed" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!hasCredentials()) return NextResponse.json({ error: "no credentials" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const orderId = Number(searchParams.get("orderId"));
  if (!symbol || !orderId) return NextResponse.json({ error: "symbol and orderId required" }, { status: 400 });
  try {
    const result = await cancelOrder(symbol, orderId);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "cancel failed" }, { status: 502 });
  }
}
