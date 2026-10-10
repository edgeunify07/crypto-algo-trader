# algo-screener

A multi-timeframe crypto screener and trading engine built on Binance market
data. It analyses every timeframe from 1m to 1w, blends classical indicators
with **Elliott Wave** and **Gann** analysis, executes automatically against a
paper account on live data, and uses an LLM to propose and validate
improvements to its own strategy parameters.

It is a standalone Node + TypeScript project — no framework, no database, no
build step.

```bash
cd algo-screener
npm install
cp .env.example .env     # optional; everything has a default

npm run screen           # rank the market right now
npm run backtest         # replay the strategy over history
npm run paper            # paper-trade live data + dashboard on :4317
npm run improve          # LLM proposes, backtests and promotes new parameters
```

No API key is needed for market data, screening, backtesting or paper trading.
`ANTHROPIC_API_KEY` unlocks the improvement loop; Binance keys are only read
when you explicitly turn live trading on.

---

## How it works

```
Binance REST + WebSocket
        │  warm-up + live klines, 13 timeframes
        ▼
   CandleSeries ──────────── closed bars only, never a forming bar
        │
        ▼
   analyseTimeframe()  per symbol × per timeframe
        │   EMA · MACD · RSI · ADX · Bollinger · OBV · structure
        │   Elliott Wave count   ·   Gann fan / Sq9 / time cycles
        │   → 9 components, each scored -1..+1 with a confidence
        ▼
   aggregate()  multi-timeframe confluence → score, alignment, regime
        ▼
   buildTradePlan()  entry · structural stop · TP ladder · position size
        ▼
   riskManager  →  PaperBroker  or  live Binance orders
        ▼
   backtest + walk-forward  →  performance report  →  LLM  →  new parameters
                                                            (promoted only if
                                                             they beat the
                                                             incumbent out of
                                                             sample)
```

The same screener, strategy and broker code runs in the backtester, in paper
trading and in live trading. A result measured in a backtest is measured on the
mechanics that will actually execute.

---

## All timeframes

Every symbol is analysed independently on each of `1m, 3m, 5m, 15m, 30m, 1h,
2h, 4h, 6h, 12h, 1d, 3d, 1w`. Each timeframe produces its own score, regime
classification, Elliott count and Gann read. These are then blended with
per-timeframe weights (higher timeframes dominate by default).

Two numbers come out of that blend and do most of the filtering work:

- **score** (-1..+1) — the weighted directional view.
- **alignment** (0..1) — how much of the weighted timeframe mass agrees with
  that direction. A 5m signal fighting the daily produces low alignment and no
  trade.

Only timeframes in `TRADE_TIMEFRAMES` may *anchor* a trade (they set the ATR
for stops and the bar clock for the time stop), but every timeframe
contributes to the decision.

---

## Elliott Wave

`src/analysis/elliott.ts` builds counts from confirmed ZigZag pivots and grades
them against Elliott's three hard rules. A count that violates any of them is
rejected outright, not down-weighted:

1. Wave 2 never retraces more than 100% of wave 1.
2. Wave 3 is never the shortest of waves 1, 3 and 5.
3. Wave 4 never enters wave 1's price territory.

Surviving counts are scored on the *guidelines* — Fibonacci relationships
between waves, alternation between waves 2 and 4, wave 3 extension past
1.618×, proportionality in time — which produces the confidence value, and
that confidence decays as the count goes stale.

Every count carries:

- the wave currently in progress and the directional bias it implies,
- Fibonacci projections used as take-profit targets,
- an **invalidation price** — breach it and the component scores zero rather
  than flipping direction.

Counts are built from *confirmed* pivots only, so they do not repaint.

Real counts are ambiguous and this module does not pretend otherwise. It is one
weighted, falsifiable component among nine, not an oracle.

## Gann

`src/analysis/gann.ts` implements three parts of Gann's method:

- **Angles / fan** — the 1×1, 2×1, 1×2 … lines projected from the most recent
  confirmed pivot. Gann's fixed price-per-time scale doesn't transfer to crypto,
  where price ranges over orders of magnitude, so the scale is derived from
  volatility: one unit of price per bar is the ATR at the anchor pivot. Price
  holding above or below the 1×1 is the primary trend read.
- **Square of Nine** — harmonic support and resistance, where a 360° turn from
  price *P* lands at (√P + 2)², a 180° turn at (√P + 1)², and so on in 45°
  increments.
- **Time cycles** — bars elapsed since the anchor, measured against Gann's
  significant counts (7, 9, 13, 21, 30, 45, 49, 52, 60, 72, 90, 120, 144, 180,
  270, 360). Inside a cycle window, trend conviction is *reduced* rather than
  reversed, and `avoidGannTimeCycle` can stand the engine aside entirely.

---

## Paper trading on live data

`npm run paper` warms up from REST, subscribes to live kline streams, and
trades a simulated account against real-time prices.

Fills are modelled the way a market order behaves: price moves against you by
`SLIPPAGE_RATE` and you pay `FEE_RATE` on both sides. Two clocks run:

- **bar close** — a closed bar on any timeframe re-analyses that symbol and may
  open a position;
- **tick** (5s) — open positions are checked against the live price so stops,
  break-even moves, trailing stops and targets act intrabar.

State persists to `data/runtime/state.json`, so a restart resumes the same
account. A paper account is never resumed into live mode or vice versa.

A read-only dashboard runs on `http://localhost:4317`: the screener grid with a
per-timeframe heat strip (hover a cell for that timeframe's regime, Elliott
count and Gann cycle), open positions, closed trades and the parameter
promotion history. Nothing on the page can place or cancel an order.

---

## Backtesting

```bash
npm run backtest -- --symbols BTCUSDT,ETHUSDT,SOLUSDT \
                    --timeframes 15m,1h,4h,1d --step 1h \
                    --bars 5000 --walkforward --folds 4
```

Klines are cached under `data/klines/` and extended rather than refetched.

The engine makes two guarantees, both covered by tests:

- **No lookahead.** Analysis at any step sees only bars that closed at or
  before that step. Orders fill at the *next* bar's open, intrabar exits are
  checked against the next bar's high/low, and a bar touching both the stop and
  a target resolves at the stop. A gap through the stop fills at the open, not
  the stop price. Appending future bars to the dataset cannot change a past
  trade.
- **Same code path as live.** The screener, strategy and broker are shared with
  the real-time loop.

`--walkforward` runs the parameters across consecutive out-of-sample windows
and reports both combined metrics and how many folds were profitable, which is
what separates an edge from a curve fit.

---

## LLM self-improvement

```bash
npm run improve -- --rounds 3 --candidates 4 --bars 8000 --folds 4
```

Each round:

1. Backtest and walk-forward the incumbent parameters.
2. Build a performance report — per timeframe, per symbol, per exit reason, per
   side, the worst and best trades, risk-gate rejections, and explicit
   diagnostics ("68% of trades ended at the stop", "high win rate with negative
   expectancy").
3. Ask Claude for candidate parameter sets, each testing one stated hypothesis.
   The response is constrained by **structured output** to the strategy's own
   Zod schema, so the model cannot return parameters the engine can't run; the
   result is then bounds-checked and repaired anyway.
4. Backtest and walk-forward every candidate.
5. Promote at most one.

### What the model can and cannot do

The model only ever proposes values for `src/strategy/params.ts`. It never
writes code, never touches the live config, and never promotes anything itself.
Promotion requires **all** of:

- at least `MIN_TRADES` out-of-sample trades,
- out-of-sample drawdown within `MAX_ACCEPTABLE_DRAWDOWN`,
- more than half the walk-forward folds profitable,
- positive out-of-sample return,
- beating the incumbent's out-of-sample score by `MIN_IMPROVEMENT`.

Account-level risk limits (`MAX_DRAWDOWN`, `MAX_DAILY_LOSS`,
`MAX_OPEN_POSITIONS`, `MAX_POSITION_FRACTION`) live in config and are enforced
by the risk manager *outside* the parameters the model edits, so no proposal can
tune them away.

Every promotion is appended to `data/params/history.jsonl` with the evidence
that justified it:

```bash
npm run improve -- --dry-run        # evaluate, promote nothing
npx tsx src/cli.ts params --action history
npx tsx src/cli.ts params --action rollback --version <id>
```

Without `ANTHROPIC_API_KEY`, the loop falls back to local random-mutation
search. That path is also a useful control: if random perturbation matches the
model's proposals, the model is not adding value on this problem.

The live loop hot-reloads promoted parameters between scans, and
`--improve-hours N` schedules improvement rounds while it runs.

---

## Live trading

Live mode is off by default and requires **both** `LIVE_TRADING=true` and
`BINANCE_API_KEY` / `BINANCE_API_SECRET`. The check runs on every order, not
once at startup.

```bash
LIVE_TRADING=true npx tsx src/cli.ts live --symbols BTCUSDT
```

Entries are market orders rounded to the symbol's `LOT_SIZE` / `MIN_NOTIONAL`
filters, and a protective `STOP_LOSS_LIMIT` is parked on the exchange so the
stop survives this process dying. If that stop is rejected, the failure is
logged loudly — the position is open and unprotected at that point. Every real
fill is mirrored into the paper broker so position management and reporting are
identical in both modes.

Run it on paper for a long time first. Nothing in this project is financial
advice, and past backtest performance is not evidence of future returns.

---

## Commands

| Command | What it does |
| --- | --- |
| `screen` | Rank the universe across every timeframe now. `--detail` prints the per-timeframe Elliott/Gann breakdown. |
| `backtest` | Replay history. `--walkforward` adds out-of-sample folds. |
| `improve` | Run the improvement loop. `--no-llm` forces mutation search, `--dry-run` promotes nothing. |
| `paper` | Live paper trading + dashboard. |
| `live` | Same loop, real orders. Requires `LIVE_TRADING=true`. |
| `params` | `--action show \| history \| rollback --version <id>`. |

Common flags: `--symbols`, `--timeframes`, `--step`, `--bars`, `--top`,
`--cash`, `--port`, `--folds`, `--rounds`, `--candidates`.
Run `npx tsx src/cli.ts` with no arguments for the full list.

---

## Layout

```
src/
  binance/      REST client (host failover, weight limiter) + kline websocket
  data/         rolling candle series, multi-timeframe market data manager
  indicators/   EMA/SMA/RSI/ATR/MACD/ADX/Bollinger/OBV, ZigZag pivots, fractals
  analysis/     elliott.ts · gann.ts · fibonacci.ts · regime.ts
  screener/     per-timeframe analysis + multi-timeframe confluence
  strategy/     params.ts (the tunable surface) · strategy.ts (plans + exits)
  execution/    paper broker · risk manager · live Binance orders · executor
  backtest/     engine · metrics · walk-forward · cached data loader
  improve/      report · LLM client · mutation search · param store · loop
  runtime/      real-time trading loop
  server/       read-only dashboard
```

`npm test` runs 137 unit tests; `npm run typecheck` runs `tsc --noEmit`.

---

## Notes on running this in a restricted region

`api.binance.com` returns HTTP 451 from some regions. Both the REST client and
the websocket detect this and fail over to Binance's public data mirror
(`data-api.binance.vision` / `data-stream.binance.vision`) automatically. The
geo-blocked websocket host accepts the connection and then goes silent rather
than erroring, so the stream also carries open and staleness watchdogs that
force a reconnect and rotate hosts.

Signed endpoints exist only on the main host, so live trading is not possible
from a region Binance blocks.
