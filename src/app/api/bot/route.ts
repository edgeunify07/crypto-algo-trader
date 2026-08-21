import { NextRequest, NextResponse } from "next/server";
import { BotRunner, type BotConfig } from "@/lib/engine/runner";
import { getEvents } from "@/lib/executor";
import { RiskGuard } from "@/lib/risk";
import { configSummary } from "@/lib/binance/config";

export async function GET() {
  return NextResponse.json({
    ...BotRunner.status(),
    events: getEvents(50),
    risk: RiskGuard.status(),
    config: { ...BotRunner.status().config },
    server: configSummary(),
  });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; config?: Partial<BotConfig> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.action === "stop") {
    BotRunner.stop();
    return NextResponse.json({ ok: true, ...BotRunner.status() });
  }

  if (body.action === "start") {
    const c = body.config ?? {};
    if (!c.symbol || !c.strategyId) {
      return NextResponse.json({ error: "symbol and strategyId are required" }, { status: 400 });
    }
    const cfg: BotConfig = {
      symbol: c.symbol,
      interval: c.interval ?? "1m",
      strategyId: c.strategyId,
      params: c.params ?? {},
      mode: c.mode === "live" ? "live" : "paper",
      tradeNotionalUSDT: Math.max(1, c.tradeNotionalUSDT ?? 10),
      pollMs: c.pollMs ?? 5000,
    };
    await BotRunner.start(cfg);
    return NextResponse.json({ ok: true, ...BotRunner.status() });
  }

  return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
}
