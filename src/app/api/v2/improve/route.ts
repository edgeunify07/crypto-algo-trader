import { NextResponse } from "next/server";
import { runImprovement } from "@/lib/improve2/improve";
import { isAuthorised } from "@/lib/engine2/guard";
import { KEYS, kv } from "@/lib/store/kv";

/**
 * Run one LLM improvement round.
 *
 * Scoped deliberately small — a few symbols, a few hundred bars — so the whole
 * round (backtest, model call, candidate backtests) fits inside the function
 * budget. A heavier sweep belongs in the `algo-screener` CLI, which has no
 * time limit; a promotion from either path lands in the same KV key and the
 * next tick picks it up.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const url = new URL(request.url);
  const store = kv();

  // An improvement round is expensive; never let two overlap.
  if (!(await store.acquireLock(KEYS.improveLock, 120))) {
    return NextResponse.json(
      { skipped: true, reason: "an improvement round is already running" },
      { status: 202 },
    );
  }

  try {
    const report = await runImprovement({
      candidates: Number(url.searchParams.get("candidates") ?? "2"),
      bars: Number(url.searchParams.get("bars") ?? "700"),
      dryRun: url.searchParams.get("dryRun") === "1",
      measureOnly: url.searchParams.get("measureOnly") === "1",
    });

    return NextResponse.json(
      {
        ok: true,
        ranAt: report.ranAt,
        durationMs: report.durationMs,
        servedBy: report.servedBy,
        analysis: report.analysis,
        symbols: report.symbols,
        incumbent: {
          version: report.incumbent.version,
          trades: report.incumbent.result.trades.length,
          totalReturn: report.incumbent.result.totalReturn,
          maxDrawdown: report.incumbent.result.maxDrawdown,
          fitness: report.incumbent.result.fitness,
        },
        candidates: report.candidates.map((c) => ({
          name: c.name,
          hypothesis: c.hypothesis,
          changes: c.changes,
          trades: c.result.trades.length,
          totalReturn: c.result.totalReturn,
          maxDrawdown: c.result.maxDrawdown,
          liquidations: c.result.liquidations,
          fitness: c.result.fitness,
          rejectedBecause: c.rejectedBecause,
        })),
        promoted: report.promoted,
        notes: report.notes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await store.releaseLock(KEYS.improveLock);
  }
}

export const GET = handle;
export const POST = handle;
