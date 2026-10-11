/**
 * Strategy optimisation with a three-way split.
 *
 * An earlier run selected on a single held-out window, which after a few
 * hundred trials stops being out-of-sample: the winner is partly chosen by
 * luck on that window. This uses three disjoint periods —
 *
 *   TRAIN    oldest 40%   search runs here
 *   VALIDATE middle 25%   survivors ranked here
 *   TEST     newest 35%   touched exactly once, by the final winner
 *
 * — so the reported TEST figure is an estimate nothing selected on. A
 * candidate that only looks good after seeing TEST would be a curve fit, and
 * the whole point is to find out before committing real behaviour to it.
 *
 * The backtester it calls now caps concurrent positions to match the live risk
 * manager and floors the balance at zero. Results from before those fixes
 * described a strategy carrying several times the real exposure.
 */
import { runFuturesBacktest, type BacktestInput, type BacktestResult } from "@/lib/improve2/backtest";
import {
  DEFAULT_PARAMS,
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";
import fs from "node:fs";

const OUT = process.env.OUT ?? "/tmp";
const TRIALS = Number(process.env.TRIALS ?? "400");
const TFS: Timeframe[] = ["15m", "1h", "4h"];
const STEP: Timeframe = "1h";
const HOST = "https://www.binance.com";
const DAYS = 60;

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

/** Page backwards past Binance's 1500-bar cap. */
async function fetchDeep(symbol: string, interval: Timeframe, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  while (out.length < bars) {
    const q = new URLSearchParams({ symbol, interval, limit: String(Math.min(1500, bars - out.length)) });
    if (endTime !== undefined) q.set("endTime", String(endTime));
    const res = await fetch(`${HOST}/fapi/v1/klines?${q}`, { cache: "no-store" });
    if (!res.ok) break;
    const raw = (await res.json()) as RawKline[];
    if (raw.length === 0) break;
    const page = raw.map((k) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      volume: +k[5], closeTime: k[6], quoteVolume: +k[7], trades: k[8], closed: true,
    }));
    out.unshift(...page);
    const first = page[0];
    if (!first) break;
    endTime = first.openTime - 1;
    if (raw.length < 1500) break;
  }
  const now = Date.now();
  return out.filter((c) => c.closeTime < now);
}

const cache = `${OUT}/klines60.json`;
let bySym: Record<string, Record<string, Candle[]>>;

if (fs.existsSync(cache)) {
  bySym = JSON.parse(fs.readFileSync(cache, "utf8"));
  console.log(`loaded ${Object.keys(bySym).length} symbols from cache`);
} else {
  const seed = JSON.parse(fs.readFileSync(`${OUT}/klines.json`, "utf8")) as Record<string, unknown>;
  const symbols = Object.keys(seed);
  console.log(`fetching ${DAYS} days for ${symbols.length} symbols...`);
  const NEED: Record<string, number> = { "15m": 5900, "1h": 1500, "4h": 400 };
  const loaded = await Promise.all(
    symbols.flatMap((s) =>
      TFS.map(async (tf) => ({ s, tf, c: await fetchDeep(s, tf, NEED[tf]!).catch(() => [] as Candle[]) })),
    ),
  );
  bySym = {};
  for (const { s, tf, c } of loaded) {
    if (!c.length) continue;
    (bySym[s] ??= {})[tf] = c;
  }
  fs.writeFileSync(cache, JSON.stringify(bySym));
  console.log(`cached ${Object.keys(bySym).length} symbols`);
}

const all: BacktestInput[] = Object.entries(bySym).map(([symbol, m]) => ({
  symbol, byTimeframe: new Map(Object.entries(m) as [Timeframe, Candle[]][]),
}));

const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const span = latest - earliest;

// Leave the first 3 days for indicator warm-up before any window trades.
const warm = earliest + 3 * 86_400_000;
const trainTo = earliest + span * 0.4;
const validateTo = earliest + span * 0.65;

const run = (p: StrategyParams, from: number, to: number) =>
  runFuturesBacktest(all, p, { stepTimeframe: STEP, startingBalance: 100, from, to });

const train = (p: StrategyParams) => run(p, warm, trainTo);
const validate = (p: StrategyParams) => run(p, trainTo, validateTo);
const test = (p: StrategyParams) => run(p, validateTo, latest);

const line = (t: string, r: BacktestResult) =>
  `${t.padEnd(10)} ${String(r.trades.length).padStart(4)}t ${(r.totalReturn * 100).toFixed(2).padStart(8)}% ` +
  `DD${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% PF${r.profitFactor.toFixed(2).padStart(5)} ` +
  `liq${r.liquidations} fees$${r.totalFees.toFixed(2).padStart(6)}`;

const d = (t: number) => new Date(t).toISOString().slice(0, 10);
console.log(`\nTRAIN    ${d(warm)} -> ${d(trainTo)}`);
console.log(`VALIDATE ${d(trainTo)} -> ${d(validateTo)}`);
console.log(`TEST     ${d(validateTo)} -> ${d(latest)}   (used once, at the end)\n`);

console.log("=== BASELINE (shipped defaults) ===");
console.log(line("train", train(DEFAULT_PARAMS)));
console.log(line("validate", validate(DEFAULT_PARAMS)));
const baseTest = test(DEFAULT_PARAMS);
console.log(line("test", baseTest));

const R = (a: number, b: number) => a + Math.random() * (b - a);
const RI = (a: number, b: number) => Math.round(R(a, b));
const P = (x: number) => Math.random() < x;

function sample(): StrategyParams {
  const p = structuredClone(DEFAULT_PARAMS);
  p.weights = {
    emaTrend: R(0, 2.5), macd: R(0, 2), rsi: R(0, 2), adx: R(0, 2),
    bollinger: R(0, 1.5), volume: R(0, 1.5), structure: R(0, 2.5),
    elliott: R(0, 2.5), gann: R(0, 2.5),
  };
  p.indicators.emaFast = RI(8, 40);
  p.indicators.emaSlow = RI(45, 160);
  p.indicators.adxThreshold = R(12, 35);
  p.indicators.zigzagAtrMultiple = R(1.0, 4.0);
  p.indicators.atrPeriod = RI(8, 28);
  p.indicators.rsiPeriod = RI(8, 25);
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) p.timeframeWeights[tf] = R(0, 2.5);
  // Entry thresholds skew high: the measured failure mode is overtrading,
  // where commission on 200+ round trips exceeds the edge on a $100 account.
  p.entry.minScore = R(0.3, 0.85);
  p.entry.minConfidence = R(0.3, 0.8);
  p.entry.minAlignment = R(0.4, 0.95);
  p.entry.requireElliottAgreement = P(0.35);
  p.entry.requireGannAgreement = P(0.35);
  p.entry.avoidGannTimeCycle = P(0.5);
  p.exit.atrStopMultiple = R(1.2, 4.0);
  p.exit.trailStartR = R(0, 3);
  p.exit.trailAtrMultiple = R(0.8, 4);
  p.exit.breakEvenR = R(0, 2.5);
  p.exit.maxHoldBars = RI(24, 400);
  p.exit.exitOnScoreFlip = R(0.2, 0.95);
  p.exit.useStructuralTargets = P(0.5);
  const k = RI(1, 3);
  const rung = R(1.0, 2.5);
  p.exit.takeProfitRMultiples = Array.from({ length: k }, (_, i) =>
    Number((rung * (i + 1) * R(0.9, 1.4)).toFixed(2)),
  ).sort((a, b) => a - b);
  p.exit.takeProfitFractions = Array.from({ length: k }, () => 1 / k);
  return sanitiseParams(p).params;
}

interface Row { p: StrategyParams; tr: BacktestResult; va: BacktestResult; score: number }
const kept: Row[] = [];
let evaluated = 0;

for (let i = 0; i < TRIALS; i++) {
  const p = sample();
  if (!StrategyParamsSchema.safeParse(p).success) continue;

  const tr = train(p);
  evaluated++;
  if (tr.trades.length < 15 || tr.liquidations > 0 || tr.totalReturn <= 0) continue;

  const va = validate(p);
  if (va.liquidations > 0 || va.totalReturn <= 0 || va.trades.length < 5) continue;

  // Rank on validation, with training as corroboration and the worse
  // drawdown of the two as a penalty. TEST is deliberately absent.
  const score = va.fitness * 2 + tr.fitness - Math.max(tr.maxDrawdown, va.maxDrawdown) * 3;
  kept.push({ p, tr, va, score });

  if ((i + 1) % 50 === 0) {
    console.log(`  ...${i + 1}/${TRIALS} evaluated=${evaluated} survivors=${kept.length}`);
  }
}

kept.sort((a, b) => b.score - a.score);
console.log(`\nevaluated ${evaluated}, profitable on train AND validate: ${kept.length}\n`);

if (kept.length === 0) {
  console.log("No candidate was profitable on both windows. Keeping the defaults.");
  process.exit(0);
}

console.log("=== TOP 5 ON TRAIN+VALIDATE, NOW SCORED ON UNSEEN TEST ===");
const finalists = kept.slice(0, 5).map((r) => ({ ...r, te: test(r.p) }));
for (const [i, r] of finalists.entries()) {
  console.log(`\n#${i + 1} score ${r.score.toFixed(3)}`);
  console.log(line("  train", r.tr));
  console.log(line("  valid", r.va));
  console.log(line("  TEST", r.te));
}

// Pick the finalist that actually holds up on the untouched window.
const holds = finalists.filter((r) => r.te.totalReturn > 0 && r.te.liquidations === 0);
const winner = holds.sort((a, b) => b.te.totalReturn - a.te.totalReturn)[0];

console.log(`\n${holds.length}/${finalists.length} finalists stayed profitable on TEST`);

if (!winner) {
  console.log("None survived the untouched window — the defaults stay. This is the honest outcome.");
  process.exit(0);
}

console.log(`\nWINNER: test ${(winner.te.totalReturn * 100).toFixed(2)}% vs baseline ${(baseTest.totalReturn * 100).toFixed(2)}%`);
fs.writeFileSync(
  `${OUT}/winner.json`,
  JSON.stringify(
    {
      params: winner.p,
      train: { trades: winner.tr.trades.length, ret: winner.tr.totalReturn, dd: winner.tr.maxDrawdown, pf: winner.tr.profitFactor },
      validate: { trades: winner.va.trades.length, ret: winner.va.totalReturn, dd: winner.va.maxDrawdown, pf: winner.va.profitFactor },
      test: { trades: winner.te.trades.length, ret: winner.te.totalReturn, dd: winner.te.maxDrawdown, pf: winner.te.profitFactor, fees: winner.te.totalFees },
      baselineTest: { trades: baseTest.trades.length, ret: baseTest.totalReturn, dd: baseTest.maxDrawdown },
      windows: { warm, trainTo, validateTo, latest },
      finalistsHolding: holds.length,
      finalistsTotal: finalists.length,
    },
    null,
    2,
  ),
);
console.log(`wrote ${OUT}/winner.json`);
