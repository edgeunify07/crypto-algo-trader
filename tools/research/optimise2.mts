/**
 * Two-stage optimisation validated across multiple out-of-sample windows.
 *
 * The previous run searched 60 days and validated on one 21-day window. That
 * is thin evidence: with 400 trials, some candidate will look good on any
 * single window by luck. This widens both sides of the problem.
 *
 *   Stage 1  Random search on the oldest window only, scored cheaply on a
 *            subset of symbols. Keeps the top candidates by training fitness.
 *   Stage 2  Those survivors are re-run across four *disjoint* later windows,
 *            on the full universe. A candidate is only accepted if it is
 *            profitable in most of them — one good window is luck, four is a
 *            property of the parameters.
 *
 * Ranking uses the median window return rather than the mean, so a single
 * outlier window cannot carry a candidate that is otherwise mediocre.
 *
 * Every backtest here re-ranks its symbols by trailing volume at each step and
 * only trades the top `UNIVERSE`, exactly as the live engine does. Searching
 * over a pool fixed at today's top ten instead — which is what the earlier
 * runs did — hands the optimiser the coins that already had the biggest
 * months, and it will happily tune into that: the same shipped parameters
 * score +26% on the last 30 days that way and -2.4% once the ranking is
 * honest. A search is only as truthful as the window it is scored on.
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
const TRIALS = Number(process.env.TRIALS ?? "600");
const KEEP = Number(process.env.KEEP ?? "40");
const DAYS = Number(process.env.DAYS ?? "150");
/** Symbols the ranking chooses between. Wider than the engine trades. */
const POOL = Number(process.env.POOL ?? "24");
/** Symbols tradable at once — the live `UNIVERSE_SIZE`. */
const UNIVERSE = Number(process.env.UNIVERSE ?? "10");
/** Stage 1 runs on a slice of the pool, at the same pool-to-tradable ratio. */
const SUBSET = Number(process.env.SUBSET ?? "12");
const TFS: Timeframe[] = ["15m", "1h", "4h"];
const STEP: Timeframe = "1h";
const HOST = "https://www.binance.com";

const EXCLUDED = new Set(["USDCUSDT", "BUSDUSDT", "FDUSDUSDT", "TUSDUSDT"]);

/** Today's highest-volume perpetuals, which is as far back as listings go. */
async function poolSymbols(size: number): Promise<string[]> {
  const res = await fetch(`${HOST}/fapi/v1/ticker/24hr`, { cache: "no-store" });
  const tickers = (await res.json()) as { symbol: string; quoteVolume: string; lastPrice: string }[];
  return tickers
    .filter((t) => t.symbol.endsWith("USDT") && !EXCLUDED.has(t.symbol) && +t.quoteVolume > 0 && +t.lastPrice > 0)
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, size)
    .map((t) => t.symbol);
}

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

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
  return out.filter((c) => c.closeTime < Date.now());
}

const cache = `${OUT}/klines${DAYS}x${POOL}.json`;
let bySym: Record<string, Record<string, Candle[]>>;

if (fs.existsSync(cache)) {
  bySym = JSON.parse(fs.readFileSync(cache, "utf8"));
  console.log(`loaded ${Object.keys(bySym).length} symbols from cache`);
} else {
  const symbols = await poolSymbols(POOL);
  console.log(`fetching ${DAYS} days for ${symbols.length} symbols (paged)...`);
  const NEED: Record<string, number> = {
    "15m": DAYS * 96 + 400,
    "1h": DAYS * 24 + 200,
    "4h": DAYS * 6 + 100,
  };
  bySym = {};
  // Symbols sequentially, timeframes together: paging is many requests and a
  // full fan-out trips the rate limit.
  for (const s of symbols) {
    const got = await Promise.all(
      TFS.map(async (tf) => [tf, await fetchDeep(s, tf, NEED[tf]!).catch(() => [] as Candle[])] as const),
    );
    for (const [tf, c] of got) {
      if (c.length > 0) (bySym[s] ??= {})[tf] = c;
    }
    const n = bySym[s]?.["1h"]?.length ?? 0;
    console.log(`  ${s}: ${n} 1h bars (${(n / 24).toFixed(0)} days)`);
  }
  fs.writeFileSync(cache, JSON.stringify(bySym));
}

const all: BacktestInput[] = Object.entries(bySym).map(([symbol, m]) => ({
  symbol, byTimeframe: new Map(Object.entries(m) as [Timeframe, Candle[]][]),
}));
// A cheaper subset for stage 1; stage 2 uses everything. The subset keeps the
// pool's ratio of candidates to tradable slots, so a candidate that only wins
// by being unselective does not sail through the cheap stage.
const subset = all.slice(0, Math.min(SUBSET, all.length));
const subsetUniverse = Math.max(1, Math.round((subset.length * UNIVERSE) / all.length));

const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const totalDays = (latest - earliest) / 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// Oldest 35% trains; the rest splits into four disjoint test windows.
const warm = earliest + 3 * 86_400_000;
const trainTo = earliest + (latest - earliest) * 0.35;
const windowSpan = (latest - trainTo) / 4;
const windows = Array.from({ length: 4 }, (_, i) => ({
  from: trainTo + windowSpan * i,
  to: trainTo + windowSpan * (i + 1),
}));

console.log(`\nhistory ${day(earliest)} -> ${day(latest)} (${totalDays.toFixed(0)} days)`);
console.log(`TRAIN ${day(warm)} -> ${day(trainTo)}`);
windows.forEach((w, i) => console.log(`  OOS${i + 1} ${day(w.from)} -> ${day(w.to)}`));

/**
 * One backtest. `universeSize` is the whole point of the pool: rank it at
 * every step and trade only the top slice, which is the same partial
 * information the live engine has.
 */
const run = (
  data: BacktestInput[],
  p: StrategyParams,
  from: number,
  to: number,
  universeSize: number,
) => runFuturesBacktest(data, p, { stepTimeframe: STEP, startingBalance: 100, from, to, universeSize });

/** Stage 2 and the baseline: the full pool, the live number of slots. */
const runFull = (p: StrategyParams, from: number, to: number) => run(all, p, from, to, UNIVERSE);
/** Stage 1: the cheap slice, at the same ratio. */
const runSubset = (p: StrategyParams, from: number, to: number) =>
  run(subset, p, from, to, subsetUniverse);

const line = (t: string, r: BacktestResult) =>
  `${t.padEnd(8)} ${String(r.trades.length).padStart(3)}t ${(r.totalReturn * 100).toFixed(2).padStart(8)}% ` +
  `DD${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% PF${r.profitFactor.toFixed(2).padStart(5)} liq${r.liquidations}`;

console.log("\n=== BASELINE (current shipped defaults) ===");
const baseWindows = windows.map((w) => runFull(DEFAULT_PARAMS, w.from, w.to));
baseWindows.forEach((r, i) => console.log(line(`OOS${i + 1}`, r)));
const baseRets = baseWindows.map((r) => r.totalReturn).sort((a, b) => a - b);
const baseMedian = (baseRets[1]! + baseRets[2]!) / 2;
const baseTotal = baseWindows.reduce((acc, r) => acc * (1 + r.totalReturn), 1) - 1;
console.log(
  `median ${(baseMedian * 100).toFixed(2)}% | compounded ${(baseTotal * 100).toFixed(2)}% | ` +
    `${baseWindows.filter((r) => r.totalReturn > 0).length}/4 profitable`,
);

const R = (a: number, b: number) => a + Math.random() * (b - a);
const RI = (a: number, b: number) => Math.round(R(a, b));
const P = (x: number) => Math.random() < x;

function sample(seed?: StrategyParams): StrategyParams {
  // Half the trials explore freely; half refine around an existing good point,
  // which is what turns a random search into a usable one once it has hits.
  const refine = seed !== undefined && Math.random() < 0.5;
  const base = refine ? structuredClone(seed!) : structuredClone(DEFAULT_PARAMS);
  const p = base;
  const jitter = (v: number, lo: number, hi: number, scale = 0.2) =>
    Math.min(hi, Math.max(lo, v * (1 + (Math.random() * 2 - 1) * scale)));

  if (refine) {
    for (const k of Object.keys(p.weights) as (keyof typeof p.weights)[]) {
      p.weights[k] = jitter(p.weights[k], 0, 3);
    }
    for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
      p.timeframeWeights[tf] = jitter(p.timeframeWeights[tf] ?? 1, 0, 5);
    }
    p.entry.minScore = jitter(p.entry.minScore, 0.15, 0.9);
    p.entry.minConfidence = jitter(p.entry.minConfidence, 0.2, 0.85);
    p.entry.minAlignment = jitter(p.entry.minAlignment, 0.3, 0.98);
    p.exit.atrStopMultiple = jitter(p.exit.atrStopMultiple, 1.0, 5);
    p.exit.trailStartR = jitter(p.exit.trailStartR, 0, 4);
    p.exit.trailAtrMultiple = jitter(p.exit.trailAtrMultiple, 0.5, 5);
    p.exit.breakEvenR = jitter(p.exit.breakEvenR, 0, 4);
    p.exit.maxHoldBars = Math.round(jitter(p.exit.maxHoldBars, 12, 500));
    p.exit.exitOnScoreFlip = jitter(p.exit.exitOnScoreFlip, 0.1, 0.95);
    p.indicators.adxThreshold = jitter(p.indicators.adxThreshold, 10, 40);
    p.exit.takeProfitRMultiples = p.exit.takeProfitRMultiples
      .map((r) => Number(jitter(r, 0.5, 12).toFixed(2)))
      .sort((a, b) => a - b);
    return sanitiseParams(p).params;
  }

  p.weights = {
    emaTrend: R(0, 2.5), macd: R(0, 2.5), rsi: R(0, 2), adx: R(0, 2),
    bollinger: R(0, 2), volume: R(0, 1.5), structure: R(0, 2.5),
    elliott: R(0, 2.5), gann: R(0, 2.5),
  };
  p.indicators.emaFast = RI(8, 45);
  p.indicators.emaSlow = RI(50, 180);
  p.indicators.adxThreshold = R(12, 38);
  p.indicators.zigzagAtrMultiple = R(1.0, 4.5);
  p.indicators.atrPeriod = RI(7, 30);
  p.indicators.rsiPeriod = RI(7, 25);
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) p.timeframeWeights[tf] = R(0, 2.5);
  p.entry.minScore = R(0.25, 0.85);
  p.entry.minConfidence = R(0.25, 0.8);
  p.entry.minAlignment = R(0.4, 0.97);
  p.entry.requireElliottAgreement = P(0.3);
  p.entry.requireGannAgreement = P(0.3);
  p.entry.avoidGannTimeCycle = P(0.5);
  p.exit.atrStopMultiple = R(1.2, 4.5);
  p.exit.trailStartR = R(0, 3.5);
  p.exit.trailAtrMultiple = R(0.8, 4.5);
  p.exit.breakEvenR = R(0, 3);
  p.exit.maxHoldBars = RI(24, 480);
  p.exit.exitOnScoreFlip = R(0.2, 0.95);
  p.exit.useStructuralTargets = P(0.5);
  const k = RI(1, 3);
  const rung = R(1.0, 3.0);
  p.exit.takeProfitRMultiples = Array.from({ length: k }, (_, i) =>
    Number((rung * (i + 1) * R(0.9, 1.5)).toFixed(2)),
  ).sort((a, b) => a - b);
  p.exit.takeProfitFractions = Array.from({ length: k }, () => 1 / k);
  return sanitiseParams(p).params;
}

// ---- stage 1: cheap search on the training window ------------------------
console.log(
  `\n=== STAGE 1: ${TRIALS} trials on TRAIN ` +
    `(${subset.length} symbols, top ${subsetUniverse} tradable) ===`,
);
const stage1Started = Date.now();
const stage1: { p: StrategyParams; fit: number; ret: number; trades: number }[] = [];
let best: StrategyParams | undefined;

for (let i = 0; i < TRIALS; i++) {
  const p = sample(best);
  if (!StrategyParamsSchema.safeParse(p).success) continue;
  const r = runSubset(p, warm, trainTo);
  if (r.trades.length < 10 || r.liquidations > 0 || r.totalReturn <= 0) continue;
  stage1.push({ p, fit: r.fitness, ret: r.totalReturn, trades: r.trades.length });
  // Seed refinement from the best point found so far.
  stage1.sort((a, b) => b.fit - a.fit);
  best = stage1[0]!.p;
  if ((i + 1) % 25 === 0) {
    const per = (Date.now() - stage1Started) / (i + 1);
    const left = ((TRIALS - i - 1) * per) / 60_000;
    console.log(
      `  ...${i + 1}/${TRIALS} survivors=${stage1.length} ` +
        `(${(per / 1000).toFixed(1)}s/trial, ~${left.toFixed(0)}m left)`,
    );
  }
}

console.log(`stage 1 survivors: ${stage1.length}, taking top ${KEEP}`);
const finalists = stage1.slice(0, KEEP);

// ---- stage 2: validate across four disjoint windows ----------------------
console.log(
  `\n=== STAGE 2: ${finalists.length} finalists across 4 OOS windows ` +
    `(${all.length} symbols, top ${UNIVERSE} tradable) ===`,
);
interface Scored {
  p: StrategyParams;
  results: BacktestResult[];
  profitable: number;
  median: number;
  compounded: number;
  worstDd: number;
  liq: number;
}
const scored: Scored[] = [];

for (const [i, f] of finalists.entries()) {
  const results = windows.map((w) => runFull(f.p, w.from, w.to));
  const rets = results.map((r) => r.totalReturn).sort((a, b) => a - b);
  scored.push({
    p: f.p,
    results,
    profitable: results.filter((r) => r.totalReturn > 0).length,
    median: (rets[1]! + rets[2]!) / 2,
    compounded: results.reduce((acc, r) => acc * (1 + r.totalReturn), 1) - 1,
    worstDd: Math.max(...results.map((r) => r.maxDrawdown)),
    liq: results.reduce((a, r) => a + r.liquidations, 0),
  });
  if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${finalists.length}`);
}

// Accept only what held up in at least three of the four windows, with no
// liquidation anywhere; rank by median so one outlier cannot carry a candidate.
const accepted = scored
  .filter((s) => s.profitable >= 3 && s.liq === 0 && s.worstDd < 0.35)
  .sort((a, b) => b.median - a.median);

console.log(`\naccepted (>=3/4 windows profitable, no liquidations): ${accepted.length}`);

for (const [i, s] of accepted.slice(0, 5).entries()) {
  console.log(`\n#${i + 1} median ${(s.median * 100).toFixed(2)}% | compounded ${(s.compounded * 100).toFixed(2)}% | ${s.profitable}/4 profitable | worst DD ${(s.worstDd * 100).toFixed(1)}%`);
  s.results.forEach((r, w) => console.log(line(`  OOS${w + 1}`, r)));
}

if (accepted[0]) {
  const w = accepted[0];
  fs.writeFileSync(
    `${OUT}/winner2.json`,
    JSON.stringify(
      {
        params: w.p,
        median: w.median,
        compounded: w.compounded,
        profitableWindows: w.profitable,
        worstDrawdown: w.worstDd,
        windows: w.results.map((r, i) => ({
          window: i + 1,
          trades: r.trades.length,
          ret: r.totalReturn,
          dd: r.maxDrawdown,
          pf: r.profitFactor,
          fees: r.totalFees,
        })),
        baseline: {
          median: baseMedian,
          compounded: baseTotal,
          profitable: baseWindows.filter((r) => r.totalReturn > 0).length,
        },
        acceptedCount: accepted.length,
        evaluated: stage1.length,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${OUT}/winner2.json`);
} else {
  console.log("\nNothing held up across windows. Current defaults stay.");
}
