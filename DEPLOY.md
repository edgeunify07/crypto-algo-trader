# Deploying to Vercel

## Why the previous deployment showed placeholder data

The error in the browser was `ENOENT: no such file or directory, mkdir '/var/task/.data'`.

Three patterns in the old app cannot work on serverless, and all three are now removed:

| Old pattern | Why it fails on Vercel | Replacement |
| --- | --- | --- |
| State written to `process.cwd()/.data/*` | The filesystem is read-only outside `/tmp`, and `/tmp` is per-instance and discarded. Bot state and trade history vanished between requests, so the UI rendered empty values. | Upstash Redis via `src/lib/store/kv.ts` |
| `setInterval` poll loop in the bot runner | A function is frozen once it responds; the interval never fires again, and a new instance has no loop at all. Hence "Bot STOPPED". | One complete step per request to `/api/v2/tick`, driven by the app and a scheduler |
| In-memory `Map` caches | Reset on every cold start. | KV, with TTLs tied to each timeframe |

There is deliberately **no Start/Stop button**. On serverless there is no process to start — a button implying one would be lying about what is running.

## Binance and Vercel regions

`fapi.binance.com` returns **HTTP 451** from several regions, including Vercel's US ones. The futures client therefore calls `https://www.binance.com/fapi/v1/*`, which proxies the same endpoints and is reachable from restricted regions, and falls back to `fapi` if that ever fails.

**`vercel.json` deliberately does not set `regions`.** Pinning a function region is a Pro/Enterprise feature, and including it fails the build on Hobby. On Pro you can add it back to move functions closer to Binance:

```json
{ "regions": ["sin1"] }
```

If Binance turns out to be unreachable from whatever region your deployment lands in, `/api/v2/health` says so explicitly, and `BINANCE_FUTURES_HOSTS` lets you point the client somewhere else without a code change.

## Steps

1. **Create the Redis store.** Vercel dashboard → Storage → Upstash Redis → connect it to the project. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are injected for you.

   Without this the app still runs, but state is in-memory and resets constantly. The dashboard shows an amber banner when storage is missing, so this failure is visible rather than silent.

2. **Set environment variables** in Project Settings → Environment Variables (apply to Production, Preview and Development):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `UPSTASH_REDIS_REST_URL` | yes | injected automatically if you connect the store in step 1 |
   | `UPSTASH_REDIS_REST_TOKEN` | yes | same |
   | `CRON_SECRET` | yes | a long random string; also add it to GitHub secrets in step 4 |
   | `OPENROUTER_API_KEY` | for improvement | without it the strategy trades but never self-tunes |
   | `AUTH_PASSWORD` | no | leave empty for no login screen |

   Everything else in `.env.example` has a working default.

3. **Deploy.** `vercel.json` registers a daily cron at 02:00 UTC hitting `/api/v2/cron`.

4. **Keep it ticking.** The Hobby plan allows Vercel Cron **once per day**, which is the right cadence for strategy improvement but far too slow to trade on. Two things drive the loop instead:

   - **The app itself.** While the PWA is open it calls `/api/v2/tick` every 20 seconds, and again whenever it returns to the foreground.
   - **`.github/workflows/tick.yml`**, already in this repo, which ticks every 5 minutes so the loop keeps running when nobody is looking. **It needs no secrets.** Point `DEFAULT_APP_URL` at the top of that file at your deployment and it works; both secrets below are optional overrides, under **Settings → Secrets and variables → Actions**:

     | Secret | Why you might set it |
     | --- | --- |
     | `APP_URL` | to drive a different deployment than `DEFAULT_APP_URL`. No trailing slash. |
     | `CRON_SECRET` | the value you set in Vercel. Without it the workflow ticks as an anonymous caller, which the endpoint rate-limits to one tick per minute — ample at five-minute intervals. With it, the limit does not apply. |

     A secret is not required because requiring one protects less than it looks like it does: the dashboard is public, so anyone who finds the URL can already drive ticks by opening it. What the endpoint enforces instead is a rate limit on anonymous callers, which also caps the browser path the secret never touched. Nobody, credentialled or not, can use it to spend your serverless budget — and a scheduler that cannot be set up without writing a secret into a repository is a scheduler that never gets set up.

     > **The workflow file has to be on the repository's default branch.** GitHub runs `schedule:` triggers from the default branch only — from any other branch it is never scheduled, never appears under **Actions**, and reports no error anywhere. A `tick.yml` sitting on a feature branch has simply never run, which on the dashboard looks like an engine that went idle for no reason. Merge the branch, or change the default under **Settings → General → Default branch**.

     Then open the **Actions** tab and enable workflows. GitHub runs schedules on a best-effort basis, so a run can be a few minutes late; the tick is idempotent and lock-protected, so a late or doubled run is harmless. GitHub also disables schedules after 60 days of repository inactivity — push a commit or hit "Run workflow" to re-arm.

     To check: the **Actions** tab should list a `tick` workflow with recent runs. If the tab is empty, the file is not on the default branch. `/api/v2/health` says the same thing whenever the engine has not ticked for fifteen minutes.

     > **Do not rely on the GitHub schedule alone.** "Best effort" is weaker than it sounds: measured on this repository, a `*/5` schedule fired **once in nine hours** instead of about a hundred times. Runs are dropped under load rather than queued, and nothing reports it. Each run now ticks four times across its budget, which makes a surviving run worth more but does not close hour-long gaps.
     >
     > This matters beyond missed entries. The engine only checks stops when it ticks, so a long gap means a stop can be overshot well past its price before anything notices — the live account can lose more than the backtest modelled. For anything you care about, point a second scheduler at the tick endpoint. It needs no credentials, so any free pinger works:
     >
     > ```
     > POST https://your-app.vercel.app/api/v2/tick    every 1–5 minutes
     > ```
     >
     > [cron-job.org](https://cron-job.org) and [UptimeRobot](https://uptimerobot.com) both do this on a free tier. The endpoint rate-limits anonymous callers to one tick a minute, so over-scheduling is harmless.

     > **Point `APP_URL` at the production deployment, not a preview.** Preview deployments sit behind Vercel Authentication, which answers an unauthenticated request with a `302` to a Vercel login page. The scheduler sends `Authorization: Bearer $CRON_SECRET` and nothing else, so against a preview URL every tick is redirected and none of them ever reach the app — a failure that looks, again, exactly like an engine that went idle. `curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/v2/health"` must return `200`; a `302` means the URL is protected.
     >
     > Vercel only rebuilds production from its **production branch** (`master` unless you changed it). Pushing to a feature branch creates a preview and leaves production exactly where it was, so a production URL can keep serving a months-old build while every push reports success. Merge to the production branch to actually ship.

   On Vercel Pro you can skip the Action: change the `vercel.json` cron to `* * * * *`.

## If something looks wrong, check `/api/v2/health` first

It needs no authentication and reports every dependency separately, because
all of them fail with the same symptom — a dashboard full of zeroes:

```bash
curl -s https://your-app.vercel.app/api/v2/health | jq
```

```json
{
  "ok": true,
  "region": "iad1",
  "storage": { "durable": true, "writes": true },
  "binance": { "reachable": true, "hosts": [{ "host": "https://www.binance.com", "status": 200 }] },
  "env": { "UPSTASH_REDIS_REST_URL": true, "CRON_SECRET": true, "OPENROUTER_API_KEY": true },
  "engine": { "ticks": 42 },
  "problems": []
}
```

It returns HTTP 503 while `problems` is non-empty, so an uptime monitor can watch it. `storage.writes` is a real round trip, not just "a client was constructed", and `binance.hosts` shows the per-host status — a `451` there is the geo-block, not an outage.

## Installing on iPhone

Open the deployment in Safari → Share → **Add to Home Screen**. It launches full-screen with no browser chrome, respects the notch and home-indicator insets, and keeps ticking while it is open.

## Endpoints

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/v2/tick` | POST/GET | One trading step. Lock-protected so two cannot overlap. |
| `/api/v2/state` | GET | Account, positions at mark price, P&L after fees. |
| `/api/v2/screener` | GET | Last scan of today's top 10, with Elliott/Gann per timeframe. |
| `/api/v2/trades` | GET | Closed trades with the full cost breakdown. |
| `/api/v2/improve` | POST/GET | One LLM improvement round. |
| `/api/v2/cron` | GET | Scheduler entry: tick, then improve. |
| `/api/v2/reset` | POST | Reset the paper account to its starting balance. |

All mutating routes require `CRON_SECRET` once it is set, as `Authorization: Bearer <secret>` or `?secret=`.

## What is real and what is modelled

Real, fetched live:
- Prices, klines, mark prices, funding rates, 24h volumes — Binance USDⓈ-M.
- The top-10 universe, re-ranked once per UTC day.
- Commissions: 0.05% taker on entry and exit.
- Funding: charged on every 8h boundary a position is held through, at that symbol's current rate.
- Liquidation: the exact isolated-margin formula, not the common approximation.

Modelled, and worth knowing:
- **Fills assume the mark price with no slippage or order-book depth.** A real $100 account would do slightly worse.
- **Maintenance margin** uses published tier-1 rates for majors and a conservative 1% elsewhere, because the real bracket table needs an authenticated endpoint. Erring high makes liquidation trigger slightly early, which is the safe direction.
- The backtester's funding uses a flat assumed rate rather than per-symbol history.

No order is ever sent to an exchange. This is a paper account.
