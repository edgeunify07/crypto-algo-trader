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
   - **`.github/workflows/tick.yml`**, already in this repo, which ticks every 5 minutes so the loop keeps running when nobody is looking. Add two repository secrets under **Settings → Secrets and variables → Actions**:

     | Secret | Value |
     | --- | --- |
     | `APP_URL` | `https://your-app.vercel.app` (no trailing slash) |
     | `CRON_SECRET` | the same value you set in Vercel |

     Then open the **Actions** tab and enable workflows. GitHub runs schedules on a best-effort basis, so a run can be a few minutes late; the tick is idempotent and lock-protected, so a late or doubled run is harmless. GitHub also disables schedules after 60 days of repository inactivity — push a commit or hit "Run workflow" to re-arm.

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
