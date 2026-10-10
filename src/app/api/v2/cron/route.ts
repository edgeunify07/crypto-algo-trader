import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine2/tick";
import { runImprovement } from "@/lib/improve2/improve";
import { isAuthorised, withTickLock } from "@/lib/engine2/guard";

/**
 * Scheduled entry point.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, which `isAuthorised`
 * already accepts, so the same endpoint serves Vercel Cron and any external
 * scheduler. On the Hobby plan Vercel Cron only fires once per day — too slow
 * to trade on, but exactly the right cadence for a strategy-improvement round,
 * so this does both: one tick to keep positions managed, then one improvement
 * round. Minute-by-minute ticking comes from the app and an external
 * scheduler hitting `/api/v2/tick`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const skipImprove = url.searchParams.get("improve") === "0";
  const out: Record<string, unknown> = {};

  // Always tick first: positions must be managed even if improvement fails.
  try {
    const tick = await withTickLock(50, () => runTick());
    out.tick = tick.ran
      ? {
          opened: tick.result.opened.length,
          closed: tick.result.closed.length,
          equity: tick.result.equity,
          positions: tick.result.positions.length,
        }
      : { skipped: tick.reason };
  } catch (err) {
    out.tickError = err instanceof Error ? err.message : String(err);
  }

  if (!skipImprove) {
    try {
      const report = await runImprovement({ candidates: 2 });
      out.improve = {
        servedBy: report.servedBy,
        incumbentFitness: report.incumbent.result.fitness,
        candidates: report.candidates.map((c) => ({
          name: c.name,
          fitness: c.result.fitness,
          rejectedBecause: c.rejectedBecause,
        })),
        promoted: report.promoted,
      };
    } catch (err) {
      out.improveError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json(
    { ok: true, at: Date.now(), ...out },
    { headers: { "cache-control": "no-store" } },
  );
}
