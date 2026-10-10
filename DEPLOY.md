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

`vercel.json` additionally pins functions to `sin1` (Singapore). Change `regions` if you prefer somewhere else; keep it outside the blocked set.

## Steps

1. **Create the Redis store.** Vercel dashboard → Storage → Upstash Redis → connect it to the project. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are injected for you.

   Without this the app still runs, but state is in-memory and resets constantly. The dashboard shows an amber banner when storage is missing, so this failure is visible rather than silent.

2. **Set environment variables** (Project Settings → Environment Variables), from `.env.example`:
   - `CRON_SECRET` — a long random string.
   - `OPENROUTER_API_KEY` — enables the improvement loop.
   - Leave `AUTH_PASSWORD` empty for no login screen.

3. **Deploy.** `vercel.json` registers a daily cron at 02:00 UTC hitting `/api/v2/cron`.

4. **Keep it ticking.** The Hobby plan allows Vercel Cron **once per day**, which is fine for strategy improvement but far too slow to trade on. Two things drive the loop instead:

   - **The app itself.** While the PWA is open it calls `/api/v2/tick` every 20 seconds, and again whenever it returns to the foreground.
   - **An external scheduler**, for when nobody has it open. Any free runner works:

     ```yaml
     # .github/workflows/tick.yml
     name: tick
     on:
       schedule: [{ cron: "*/5 * * * *" }]
       workflow_dispatch:
     jobs:
       tick:
         runs-on: ubuntu-latest
         steps:
           - run: |
               curl -fsS -X POST "https://YOUR-APP.vercel.app/api/v2/tick" \
                 -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
     ```

     Upgrading to Vercel Pro lets you set the `vercel.json` cron to `* * * * *` and skip this.

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
