import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/store/kv";
import type { FuturesTrade } from "@/lib/store/account";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const limit = Math.min(
    500,
    Number(new URL(request.url).searchParams.get("limit") ?? "100") || 100,
  );
  const trades = await kv().list<FuturesTrade>(KEYS.trades, limit);

  return NextResponse.json(
    { trades: trades.slice().reverse(), count: trades.length },
    { headers: { "cache-control": "no-store" } },
  );
}
