import { NextRequest, NextResponse } from "next/server";
import { BotRunner, type BotConfig } from "@/lib/engine/runner";
import { getEvents } from "@/lib/executor";
import { RiskGuard } from "@/lib/risk";
import { configSummary } from "@/lib/binance/config";

export async function GET() {
  const bot = await BotRunner.status();
  return NextResponse.json({
    ...bot,
    events: await getEvents(100),
    risk: RiskGuard.status(),
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
    const bot = await BotRunner.status();
    return NextResponse.json({ ok: true, ...bot, events: await getEvents(100), risk: RiskGuard.status(), server: configSummary() });
  }

  if (body.action === "start") {
    const c = body.config ?? {};
    if (!c.symbol || !c.strategyId) {
      return NextResponse.json({ error: "symbol and strategyId are required — pick a strategy first" }, { status: 400 });
    }
    if (RiskGuard.status().killSwitch) {
      return NextResponse.json({ error: "Kill switch is engaged — release it before starting the bot" }, { status: 409 });
    }
    const cfg: BotConfig = {
      symbol: c.symbol,
      universeMode: c.universeMode !== false, // default ON — scan all markets
      symbols: c.symbols,
      universeLimit: c.universeLimit ?? 20,
      interval: c.interval ?? "15m",
      strategyId: c.strategyId,
      params: c.params ?? {},
      mode: c.mode === "live" ? "live" : "paper",
      tradeNotionalUSDT: Math.max(1, c.tradeNotionalUSDT ?? 10),
      pollMs: c.pollMs ?? 5000,
    };
    await BotRunner.start(cfg);
    const bot = await BotRunner.status();
    return NextResponse.json({
      ok: true,
      ...bot,
      events: await getEvents(100),
      risk: RiskGuard.status(),
      server: configSummary(),
    });
  }

  return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
}
