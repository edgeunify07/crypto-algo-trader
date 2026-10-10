import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/store/kv";
import { isAuthorised } from "@/lib/engine2/guard";
import { STARTING_BALANCE, newAccount } from "@/lib/store/account";

/**
 * Reset the paper account back to its starting balance.
 *
 * POST-only and guarded: this destroys the trade history, so it must not be
 * reachable by following a link or by a crawler hitting a GET.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const store = kv();
  await Promise.all([
    store.set(KEYS.account, newAccount(STARTING_BALANCE)),
    store.set(KEYS.positions, []),
    store.del(KEYS.trades),
    store.del(KEYS.equity),
    store.del(KEYS.screener),
  ]);

  return NextResponse.json({ ok: true, startingBalance: STARTING_BALANCE });
}
