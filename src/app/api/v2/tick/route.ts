import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine2/tick";
import { isAuthorised, withTickLock } from "@/lib/engine2/guard";

/**
 * Advance the trading loop by one step.
 *
 * This replaces the old `setInterval` runner, which could never work on
 * serverless: a function is frozen once it responds, so an interval registered
 * inside one never fires again. Instead each call does exactly one complete
 * step and persists the result, and the schedule comes from outside — the open
 * PWA while someone is watching, and an external scheduler otherwise.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const manageOnly = url.searchParams.get("manageOnly") === "1";

  try {
    const outcome = await withTickLock(55, () => runTick({ manageOnly }));

    if (!outcome.ran) {
      // Not an error: a concurrent tick is doing the work.
      return NextResponse.json({ skipped: true, reason: outcome.reason }, { status: 202 });
    }

    const r = outcome.result;
    return NextResponse.json(
      {
        ok: true,
        at: r.at,
        durationMs: r.durationMs,
        durable: r.durable,
        universe: r.universe,
        analysed: r.analysed,
        opened: r.opened,
        closed: r.closed,
        fundingApplied: r.fundingApplied,
        equity: r.equity,
        positions: r.positions.length,
        notes: r.notes,
        // Returned inline so the dashboard can populate even when storage is
        // not configured — otherwise a missing Upstash binding shows up as an
        // empty market list, which looks like the engine failing rather than
        // the deployment missing a variable.
        screener: r.screener,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
