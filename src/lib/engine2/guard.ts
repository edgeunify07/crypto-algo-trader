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

/**
 * Was this request made by a browser from a page on this same deployment?
 *
 * `Sec-Fetch-Site` is on the forbidden header list, so page script cannot set
 * it: a `fetch()` from another site arrives as `cross-site` no matter what
 * that site does. It is not a defence against a crafted request — curl will
 * happily send any header — but it does not need to be. The dashboard is the
 * loop's own scheduler, so anyone who can open the page can already make it
 * tick; the point is only to separate "our page, in a browser" from a crawler
 * following a link or another site posting at us.
 */
function isSameOriginBrowserRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== "same-origin") return false;
  // A top-level navigation to the URL is not the dashboard calling the API;
  // the page uses `fetch`, which reports `cors` (or `same-origin`).
  return request.headers.get("sec-fetch-mode") !== "navigate";
}

export interface AuthOptions {
  /**
   * Accept a `fetch` from the deployment's own page as well as the secret.
   *
   * Set on `/api/v2/tick` only. Without it a deployment that configures
   * `CRON_SECRET` — which the deploy guide tells everyone to do — rejects
   * every tick the open dashboard sends, and the loop silently never runs:
   * the UI shows "idle" with a tick count stuck at zero while the external
   * cron, five minutes apart, is the only thing getting through.
   *
   * The destructive and expensive endpoints (`reset`, `improve`) leave it off
   * and keep requiring the secret.
   */
  allowSameOrigin?: boolean;
}

export function isAuthorised(request: Request, options: AuthOptions = {}): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  // No secret configured: open, which is the convenient default for a private
  // deployment driven only by its own UI.
  if (!secret) return true;

  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;

  const url = new URL(request.url);
  if (url.searchParams.get("secret") === secret) return true;

  return options.allowSameOrigin === true && isSameOriginBrowserRequest(request);
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
