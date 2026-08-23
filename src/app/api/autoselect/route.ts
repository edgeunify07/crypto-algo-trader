import { NextRequest, NextResponse } from "next/server";
import { runAutoSelect, getLastSelection, setLastSelection, DEFAULT_GATES, type SelectionGates } from "@/lib/engine/autoSelect";
import { BotRunner } from "@/lib/engine/runner";
import type { CandleInterval } from "@/lib/types";

export const maxDuration = 300;

/** Last completed selection (so the UI can render without re-scanning). */
export async function GET() {
  const last = getLastSelection();
  return NextResponse.json({ run: last, defaultGates: DEFAULT_GATES });
}

export async function POST(req: NextRequest) {
  let body: {
    symbols?: string[];
    universeLimit?: number;
    intervals?: CandleInterval[];
    gridSize?: "small" | "full";
    days?: number;
    bars?: number;
    startEquity?: number;
    gates?: Partial<SelectionGates>;
    /** Start the bot on the winning config. Refused when nothing passes. */
    apply?: boolean;
    mode?: "paper" | "live";
    tradeNotionalUSDT?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const run = await runAutoSelect({
      symbols: body.symbols,
      universeLimit: body.universeLimit ?? 20,
      intervals: body.intervals,
      gridSize: body.gridSize ?? "small",
      days: body.days,
      bars: body.bars,
      startEquity: body.startEquity,
      gates: body.gates,
    });
    setLastSelection(run);

    if (!body.apply) {
      return NextResponse.json({ run, applied: false });
    }

    // Refuse to trade when nothing survived the gates. Trading nothing is the
    // correct action, not a fallback to "best available".
    if (!run.best) {
      return NextResponse.json(
        {
          run,
          applied: false,
          error:
            "No configuration passed the out-of-sample gates, so the bot was NOT started. " +
            "Loosening the gates to force a pick would mean trading a strategy with no demonstrated edge.",
        },
        { status: 409 },
      );
    }

    const best = run.best;
    await BotRunner.start({
      symbol: best.symbol,
      symbols: [best.symbol],
      universeMode: false,
      interval: best.interval,
      strategyId: best.strategyId,
      params: best.params,
      mode: body.mode === "live" ? "live" : "paper",
      tradeNotionalUSDT: Math.max(1, body.tradeNotionalUSDT ?? 25),
      pollMs: 5000,
      stopLossAtrMult: 2,
      takeProfitRr: 1.5,
    });

    return NextResponse.json({ run, applied: true, appliedTo: { symbol: best.symbol, interval: best.interval, strategyId: best.strategyId } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "auto-select failed" }, { status: 502 });
  }
}
