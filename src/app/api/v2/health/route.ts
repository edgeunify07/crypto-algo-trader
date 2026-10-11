import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/store/kv";

/**
 * Deployment self-check.
 *
 * Every way this app can be misconfigured produces the same useless symptom —
 * a dashboard full of zeroes — so this reports each dependency separately:
 * whether storage is durable, whether Binance is reachable from the region the
 * function actually runs in, and which environment variables are present.
 *
 * Secrets are never echoed, only whether they are set.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FUTURES_HOSTS = (
  process.env.BINANCE_FUTURES_HOSTS ??
  "https://www.binance.com,https://fapi.binance.com"
)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

async function probe(host: string): Promise<{ host: string; status: number | string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetch(`${host}/fapi/v1/ping`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    return { host, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      host,
      status: err instanceof Error ? err.name : "error",
      ms: Date.now() - started,
    };
  }
}

export async function GET() {
  const store = kv();

  // Prove storage round-trips rather than just that the client constructed.
  let storageWrites = false;
  let storageError: string | null = null;
  try {
    const probeKey = "algo:healthcheck";
    const token = Date.now();
    await store.set(probeKey, token, 60);
    storageWrites = (await store.get<number>(probeKey)) === token;
  } catch (err) {
    storageError = err instanceof Error ? err.message : String(err);
  }

  const hosts = await Promise.all(FUTURES_HOSTS.map(probe));
  const binanceReachable = hosts.some((h) => h.status === 200);
  const account = await store.get<{ tickCount?: number; lastTickAt?: number }>(KEYS.account);

  const env = {
    UPSTASH_REDIS_REST_URL: Boolean(
      process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    ),
    UPSTASH_REDIS_REST_TOKEN: Boolean(
      process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
    ),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    AUTH_PASSWORD: Boolean(process.env.AUTH_PASSWORD),
  };

  const problems: string[] = [];
  if (!store.isDurable) {
    problems.push(
      "Storage is not durable — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. State resets on every request until you do.",
    );
  }
  if (store.isDurable && !storageWrites) {
    problems.push(
      `Storage is configured but a write/read round trip failed${storageError ? `: ${storageError}` : "."}`,
    );
  }
  if (!binanceReachable) {
    problems.push(
      "Binance futures is unreachable from this region (likely HTTP 451). Set BINANCE_FUTURES_HOSTS to a reachable endpoint, or move the function to a permitted region.",
    );
  }
  if (!env.CRON_SECRET) {
    problems.push("CRON_SECRET is unset, so the scheduler cannot authenticate.");
  }
  if (!env.OPENROUTER_API_KEY) {
    problems.push("OPENROUTER_API_KEY is unset — trading runs, but the strategy will never self-improve.");
  }

  /**
   * Nothing is driving the loop.
   *
   * This is the failure that looks least like a failure: every panel renders,
   * the deployment is green, and the engine simply never runs. Two things can
   * drive it and both have quiet ways to be absent — nobody has the dashboard
   * open, and the scheduled workflow only fires from the repository's
   * *default* branch, so a `tick.yml` that lives on a feature branch has
   * never run once. Naming both beats an "idle" badge with no explanation.
   */
  const ticks = account?.tickCount ?? 0;
  const lastTickAt = account?.lastTickAt ?? 0;
  const sinceTick = lastTickAt ? Date.now() - lastTickAt : Infinity;
  if (store.isDurable && (ticks === 0 || sinceTick > 15 * 60_000)) {
    const how =
      ticks === 0
        ? "The engine has never ticked."
        : `The engine last ticked ${Math.round(sinceTick / 60_000)} minutes ago.`;
    problems.push(
      `${how} It advances once per request to /api/v2/tick: from this dashboard while it is open, ` +
        "and otherwise from a scheduler. Check that .github/workflows/tick.yml is on the repository's " +
        "default branch — GitHub only runs schedules from there — and that the APP_URL and CRON_SECRET " +
        "repository secrets are set.",
    );
  }

  return NextResponse.json(
    {
      ok: problems.length === 0,
      // Vercel exposes the serving region here; useful because Binance
      // reachability depends entirely on it.
      region: process.env.VERCEL_REGION ?? "local",
      storage: { durable: store.isDurable, writes: storageWrites, error: storageError },
      binance: { reachable: binanceReachable, hosts },
      env,
      engine: {
        ticks: account?.tickCount ?? 0,
        lastTickAt: account?.lastTickAt ?? null,
      },
      problems,
      checkedAt: Date.now(),
    },
    { status: problems.length === 0 ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
