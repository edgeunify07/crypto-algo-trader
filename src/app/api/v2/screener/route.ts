import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/store/kv";
import { resolveUniverse } from "@/lib/engine2/universe";
import type { ScreenerRowLite } from "@/lib/engine2/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The latest screener snapshot, written by the most recent tick.
 *
 * Deliberately a read of persisted state rather than a fresh analysis: running
 * a full multi-timeframe scan on every dashboard poll would burn the rate
 * limit and make the UI slow, and the numbers would still only be as fresh as
 * the last closed candle.
 */
export async function GET() {
  const store = kv();
  const [rows, universe] = await Promise.all([
    store.get<ScreenerRowLite[]>(KEYS.screener),
    resolveUniverse().catch(() => null),
  ]);

  return NextResponse.json(
    {
      rows: rows ?? [],
      universe: universe?.entries ?? [],
      day: universe?.day ?? null,
      stale: rows === null,
      updatedAt: Date.now(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
