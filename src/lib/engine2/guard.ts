import { KEYS, kv } from "@/lib/store/kv";

/**
 * Request guard for the mutating endpoints.
 *
 * `/api/v2/tick` advances a real paper account, so it cannot be a wide-open
 * GET that anyone can spam. Two protections apply:
 *
 *  - an optional shared secret, required once `CRON_SECRET` is set, which is
 *    what an external scheduler (GitHub Actions, cron-job.org) presents;
 *  - a KV lock, so two overlapping invocations can never both trade. On a
 *    platform that may run several instances concurrently this is the only
 *    thing standing between one tick and a double-sized position.
 */

export function isAuthorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  // No secret configured: open, which is the convenient default for a private
  // deployment driven only by its own UI.
  if (!secret) return true;

  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;

  const url = new URL(request.url);
  return url.searchParams.get("secret") === secret;
}

export async function withTickLock<T>(
  ttlSeconds: number,
  run: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; reason: string }> {
  const store = kv();
  const acquired = await store.acquireLock(KEYS.tickLock, ttlSeconds);
  if (!acquired) {
    return { ran: false, reason: "another tick is already running" };
  }
  try {
    return { ran: true, result: await run() };
  } finally {
    await store.releaseLock(KEYS.tickLock);
  }
}
