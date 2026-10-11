import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine2/tick";
import {
  PUBLIC_TICK_WINDOW_SECONDS,
  claimPublicTick,
  isAuthorised,
  withTickLock,
} from "@/lib/engine2/guard";

/**
 * Advance the trading loop by one step.
 *
 * This replaces the old `setInterval` runner, which could never work on
 * serverless: a function is frozen once it responds, so an interval registered
 * inside one never fires again. Instead each call does exactly one complete
 * step and persists the result, and the schedule comes from outside — the open
 * PWA while someone is watching, and an external scheduler otherwise.
 *
 * Three kinds of caller reach this, in descending order of trust: a scheduler
 * holding `CRON_SECRET`, the deployment's own page, and anyone else. The
 * third is allowed through at a strict rate limit rather than refused,
 * because a scheduler nobody can set up without writing a secret into a
 * repository is a scheduler that never gets set up.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  // The open dashboard is this loop's primary scheduler, so its own fetches
  // count as authorised even once a cron secret is configured.
  if (!isAuthorised(request, { allowSameOrigin: true })) {
    /**
     * No credential. Rather than refuse outright, spend the window's public
     * allowance — which is what lets a scheduler drive this with nothing
     * configured but a URL. `claimPublicTick` explains why that is not the
     * loosening it looks like.
     */
    if (!(await claimPublicTick())) {
      return NextResponse.json(
        {
          skipped: true,
          reason:
            `unauthenticated ticks are limited to one per ${PUBLIC_TICK_WINDOW_SECONDS}s; ` +
            "send CRON_SECRET as a bearer token to tick without the limit",
        },
        { status: 202, headers: { "cache-control": "no-store" } },
      );
    }
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
