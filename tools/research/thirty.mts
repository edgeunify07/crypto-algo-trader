/**
 * Optimise each engine on its own: every 30-day window above the target.
 *
 * The brief is not a good month, it is four of them — 120 days cut into four
 * consecutive 30-day windows, each required to clear 15% on its own. A
 * candidate is scored by its *worst* window, so one spectacular month cannot
 * carry three poor ones, which is exactly how every previous winner in this
 * project got its headline number.
 *
 * That makes the target far harder and the result far more meaningful.
 * Fitting one month out of noise is easy: several hundred trials over twenty
 * free parameters will find a 15% month in almost any series, including a
 * random one. Fitting four disjoint months to 15% each is not something luck
 * supplies — a candidate that manages it is describing something that kept
 * working as the market changed underneath it.
 *
 * It is still a search over the windows it reports, so the number is fitted
 * rather than predicted. The honest reading is the spread across the four:
 * an edge holds its shape, a fit shows one tall window and three scraping
 * the bar.
 *
 * The engines are searched apart. The swing run disables the scalp; the
 * scalp run points the swing engine at timeframes the data does not hold, so
 * nothing it does can flatter the scalp's number.
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

const OUT = process.env.OUT ?? "/tmp/research";
const CACHE = process.env.CACHE ?? `${OUT}/klines120x24.json`;
const UNIVERSE = Number(process.env.UNIVERSE ?? "10");
const TRIALS = Number(process.env.TRIALS ?? "600");
const TARGET = Number(process.env.TARGET ?? "0.15");
const ENGINE = (process.env.ENGINE ?? "swing") as "swing" | "scalp";
const STEP: Timeframe = "1h";
const DAY = 86_400_000;

const bySym = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Record<string, Candle[]>>;
const all: BacktestInput[] = Object.entries(bySym).map(([symbol, m]) => ({
  symbol, byTimeframe: new Map(Object.entries(m) as [Timeframe, Candle[]][]),
}));
const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Four consecutive 30-day windows, newest last, covering the final 120 days.
 *
 * Consecutive and disjoint rather than overlapping: overlapping windows share
 * trades, so a single good fortnight would lift two of them at once and the
 * "every window" requirement would be weaker than it reads.
 */
const WINDOWS = Number(process.env.WINDOWS ?? "4");
const windows = Array.from({ length: WINDOWS }, (_, i) => ({
  from: latest - (WINDOWS - i) * 30 * DAY,
  to: latest - (WINDOWS - i - 1) * 30 * DAY,
}));
const searchFrom = windows[0]!.from;

const run = (p: StrategyParams, from: number, to: number) =>
  runFuturesBacktest(all, p, { stepTimeframe: STEP, startingBalance: 100, from, to, universeSize: UNIVERSE });

const R = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const RI = (lo: number, hi: number) => Math.round(R(lo, hi));
const P = (p: number) => Math.random() < p;

/** Swing alone: the scalp is off and cannot contribute a cent. */
const swingBase = (): StrategyParams => ({
  ...structuredClone(DEFAULT_PARAMS),
  scalp: { ...DEFAULT_PARAMS.scalp, enabled: false },
});

/**
 * Scalp alone: the swing engine reads timeframes this cache does not hold, so
 * it never forms a blend and never trades. Anything the run earns is the
 * scalp's.
 */
const scalpBase = (): StrategyParams => ({
  ...structuredClone(DEFAULT_PARAMS),
  entry: { ...DEFAULT_PARAMS.entry, timeframes: ["1w"] },
  scalp: { ...DEFAULT_PARAMS.scalp, enabled: true },
});

function sample(seed?: StrategyParams): StrategyParams {
  const refine = seed !== undefined && Math.random() < 0.55;
  const p = refine ? structuredClone(seed!) : (ENGINE === "swing" ? swingBase() : scalpBase());
  const j = (v: number, lo: number, hi: number, s = 0.25) =>
    Math.min(hi, Math.max(lo, v * (1 + (Math.random() * 2 - 1) * s)));

  // Shared: how the blend is built, and how big a trade is.
  if (refine) {
    for (const k of Object.keys(p.weights) as (keyof typeof p.weights)[]) p.weights[k] = j(p.weights[k], 0, 3);
    for (const tf of ["5m", "15m", "1h", "4h", "1d"]) p.timeframeWeights[tf] = j(p.timeframeWeights[tf] ?? 1, 0, 5);
    p.indicators.adxThreshold = j(p.indicators.adxThreshold, 10, 40);
    p.risk.riskPerTrade = j(p.risk.riskPerTrade, 0.005, 0.05);
    p.risk.capitalPerTrade = j(p.risk.capitalPerTrade, 0.05, 0.35);
  } else {
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
    p.risk.riskPerTrade = R(0.005, 0.05);
    p.risk.capitalPerTrade = R(0.05, 0.35);
  }

  if (ENGINE === "swing") {
    if (refine) {
      p.entry.minScore = j(p.entry.minScore, 0.15, 0.9);
      p.entry.minConfidence = j(p.entry.minConfidence, 0.2, 0.85);
      p.entry.minAlignment = j(p.entry.minAlignment, 0.3, 0.98);
      p.exit.atrStopMultiple = j(p.exit.atrStopMultiple, 1.0, 5);
      p.exit.trailStartR = j(p.exit.trailStartR, 0, 4);
      p.exit.trailAtrMultiple = j(p.exit.trailAtrMultiple, 0.5, 5);
      p.exit.breakEvenR = j(p.exit.breakEvenR, 0, 4);
      p.exit.maxHoldBars = Math.round(j(p.exit.maxHoldBars, 12, 500));
      p.exit.exitOnScoreFlip = j(p.exit.exitOnScoreFlip, 0.1, 0.95);
      p.exit.takeProfitRMultiples = p.exit.takeProfitRMultiples
        .map((r) => Number(j(r, 0.5, 12).toFixed(2))).sort((a, b) => a - b);
    } else {
      p.entry.timeframes = P(0.5) ? ["1h", "4h", "1d"] : P(0.5) ? ["15m", "1h", "4h"] : ["1h", "4h"];
      p.entry.minScore = R(0.2, 0.85);
      p.entry.minConfidence = R(0.2, 0.8);
      p.entry.minAlignment = R(0.3, 0.97);
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
        Number((rung * (i + 1) * R(0.9, 1.5)).toFixed(2))).sort((a, b) => a - b);
      p.exit.takeProfitFractions = Array.from({ length: k }, () => 1 / k);
    }
  } else {
    if (refine) {
      p.scalp.minScore = j(p.scalp.minScore, 0.15, 0.9);
      p.scalp.minConfidence = j(p.scalp.minConfidence, 0.25, 0.9);
      p.scalp.minAlignment = j(p.scalp.minAlignment, 0.2, 0.98);
      p.scalp.targetPct = j(p.scalp.targetPct, 0.005, 0.15);
      p.scalp.atrStopMultiple = j(p.scalp.atrStopMultiple, 0.4, 3.5);
      p.scalp.maxHoldBars = Math.round(j(p.scalp.maxHoldBars, 3, 160));
      p.scalp.closeFraction = j(p.scalp.closeFraction, 0.2, 1);
      p.scalp.capitalShare = j(p.scalp.capitalShare, 0.2, 0.9);
    } else {
      p.scalp.timeframes = P(0.4) ? ["15m", "1h"] : P(0.5) ? ["5m", "15m"] : ["5m", "15m", "1h"];
      p.scalp.minScore = R(0.15, 0.9);
      p.scalp.minConfidence = R(0.25, 0.9);
      p.scalp.minAlignment = R(0.2, 0.98);
      p.scalp.targetPct = R(0.005, 0.15);
      p.scalp.atrStopMultiple = R(0.4, 3.5);
      p.scalp.maxHoldBars = RI(3, 160);
      p.scalp.closeFraction = R(0.2, 1);
      p.scalp.capitalShare = R(0.2, 0.9);
      p.scalp.maxOpen = RI(1, 4);
    }
    // The scalp owns the account in a scalp-only run.
    p.scalp.capitalShare = Math.max(p.scalp.capitalShare, 0.8);
  }
  return sanitiseParams(p).params;
}

const worstTrade = (rs: BacktestResult[]) =>
  Math.min(0, ...rs.flatMap((r) => r.trades.map((t) => t.netPnl / 100)));

console.log(`ENGINE=${ENGINE}  every 30-day window >= ${(TARGET * 100).toFixed(0)}%  trials ${TRIALS}`);
console.log(`data ${day(earliest)} -> ${day(latest)}`);
windows.forEach((w, i) => console.log(`  W${i + 1}  ${day(w.from)} -> ${day(w.to)}`));
console.log("");

interface Hit {
  p: StrategyParams;
  /** The worst of the four windows. The score: a candidate is its weakest month. */
  min: number;
  rets: number[];
  trades: number;
  dd: number;
  worst: number;
}
const hits: Hit[] = [];
let best: StrategyParams | undefined;
let bestMin = -Infinity;
const started = Date.now();

for (let i = 0; i < TRIALS; i++) {
  if (i > 0 && i % 25 === 0) {
    const per = (Date.now() - started) / i;
    console.log(
      `  ...${i}/${TRIALS} best worst-window ${(bestMin * 100).toFixed(2)}% hits=${hits.length} ` +
        `(${(per / 1000).toFixed(1)}s/trial, ~${(((TRIALS - i) * per) / 60000).toFixed(0)}m left)`,
    );
    if (hits.length > 0) {
      fs.writeFileSync(`${OUT}/thirty-${ENGINE}.json`,
        JSON.stringify({ at: Date.now(), engine: ENGINE, hits: hits.slice(0, 10) }));
    }
  }
  const p = sample(best);
  if (!StrategyParamsSchema.safeParse(p).success) continue;

  /**
   * Windows are run oldest first and abandoned as soon as one cannot be
   * saved. Most candidates fail on their first window, and running the other
   * three to confirm a failure already known costs three quarters of the
   * search budget.
   */
  const rs: BacktestResult[] = [];
  let viable = true;
  for (const w of windows) {
    const r = run(p, w.from, w.to);
    rs.push(r);
    if (r.liquidations > 0 || r.trades.length < 3) { viable = false; break; }
    // Nothing recovers a window that is already below target.
    if (r.totalReturn < TARGET && rs.length < windows.length) {
      // Keep going only while it could still beat the best worst-window seen,
      // which is what the search is climbing.
      if (r.totalReturn <= bestMin) { viable = false; break; }
    }
  }
  if (!viable || rs.length < windows.length) {
    const partial = Math.min(...rs.map((r) => r.totalReturn));
    if (rs.length === windows.length && partial > bestMin) { bestMin = partial; best = p; }
    continue;
  }

  const rets = rs.map((r) => r.totalReturn);
  const min = Math.min(...rets);
  if (min > bestMin) { bestMin = min; best = p; }

  // Every window at or above target, and the 5% per-trade rule intact: a 15%
  // month bought with a 9% loss is not the thing that was asked for.
  if (min >= TARGET && worstTrade(rs) >= -0.05) {
    hits.push({
      p, min, rets,
      trades: rs.reduce((a, r) => a + r.trades.length, 0),
      dd: Math.max(...rs.map((r) => r.maxDrawdown)),
      worst: worstTrade(rs),
    });
    hits.sort((a, b) => b.min - a.min);
  }
}

console.log(
  `\n=== ${ENGINE.toUpperCase()}: ${hits.length} configurations held ` +
    `>= ${(TARGET * 100).toFixed(0)}% in ALL ${windows.length} windows ===`,
);
console.log(`best worst-window seen: ${(bestMin * 100).toFixed(2)}%\n`);

if (hits.length === 0) {
  /**
   * Said plainly rather than softened. The whole point of scoring a candidate
   * by its weakest window is that it cannot be talked around: if nothing
   * cleared the bar in all four, the strategy does not clear the bar, and the
   * best single month found is not an answer to a question about every month.
   */
  console.log(
    `No configuration cleared ${(TARGET * 100).toFixed(0)}% in every window. ` +
      `The best any candidate managed in its WEAKEST month was ${(bestMin * 100).toFixed(2)}%.`,
  );
  console.log("Defaults stay.");
} else {
  console.log(`rank  worst    ${windows.map((_, i) => `W${i + 1}`.padStart(8)).join("")}   trades  maxDD  worst trade`);
  for (const [i, h] of hits.slice(0, 10).entries()) {
    console.log(
      `${String(i + 1).padStart(4)}  ${(h.min * 100).toFixed(2).padStart(6)}% ` +
        h.rets.map((r) => `${(r * 100).toFixed(2).padStart(7)}%`).join(" ") +
        `   ${String(h.trades).padStart(4)}t  ${(h.dd * 100).toFixed(1).padStart(5)}%  ${(h.worst * 100).toFixed(2)}%`,
    );
  }
  fs.writeFileSync(`${OUT}/thirty-${ENGINE}.json`,
    JSON.stringify({ at: Date.now(), engine: ENGINE, windows: windows.map((w) => [day(w.from), day(w.to)]), hits: hits.slice(0, 10) }, null, 2));
  console.log(`\nwrote ${OUT}/thirty-${ENGINE}.json`);
}
