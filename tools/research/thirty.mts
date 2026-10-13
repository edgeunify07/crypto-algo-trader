/**
 * Optimise each engine on its own, against the last 30 days.
 *
 * The brief is a 15% return on the most recent month, per engine, searched
 * until it is reached. That is what this does — and because it searches the
 * same 30 days it reports, that number is fitted, not predicted. So every
 * candidate is also run over the three months *before* the search window,
 * which it never sees. The gap between the two columns is the whole story:
 * a real edge carries, a fitted one collapses.
 *
 *   SEARCH  the last 30 days          — what was asked for
 *   BEFORE  the 90 days preceding it  — what it is worth
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
const searchFrom = latest - 30 * DAY;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

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

const worstTrade = (r: BacktestResult) => Math.min(0, ...r.trades.map((t) => t.netPnl / 100));

console.log(`ENGINE=${ENGINE}  target ${(TARGET * 100).toFixed(0)}%  trials ${TRIALS}`);
console.log(`data   ${day(earliest)} -> ${day(latest)}`);
console.log(`SEARCH ${day(searchFrom)} -> ${day(latest)}  (the last 30 days)`);
console.log(`BEFORE ${day(earliest)} -> ${day(searchFrom)}  (never searched)\n`);

interface Hit { p: StrategyParams; ret: number; trades: number; dd: number; pf: number; worst: number }
const hits: Hit[] = [];
let best: StrategyParams | undefined;
let bestRet = -Infinity;
const started = Date.now();

for (let i = 0; i < TRIALS; i++) {
  if (i > 0 && i % 25 === 0) {
    const per = (Date.now() - started) / i;
    console.log(
      `  ...${i}/${TRIALS} best ${(bestRet * 100).toFixed(2)}% hits=${hits.length} ` +
        `(${(per / 1000).toFixed(1)}s/trial, ~${(((TRIALS - i) * per) / 60000).toFixed(0)}m left)`,
    );
    if (hits.length > 0) {
      fs.writeFileSync(`${OUT}/thirty-${ENGINE}.json`,
        JSON.stringify({ at: Date.now(), engine: ENGINE, hits: hits.slice(0, 10) }));
    }
  }
  const p = sample(best);
  if (!StrategyParamsSchema.safeParse(p).success) continue;
  const r = run(p, searchFrom, latest);
  if (r.trades.length < 5 || r.liquidations > 0) continue;
  if (r.totalReturn > bestRet) { bestRet = r.totalReturn; best = p; }
  // The 5% per-trade rule still stands; a 15% month bought with 9% losses is
  // not the thing that was asked for.
  if (r.totalReturn >= TARGET && worstTrade(r) >= -0.05) {
    hits.push({ p, ret: r.totalReturn, trades: r.trades.length, dd: r.maxDrawdown, pf: r.profitFactor, worst: worstTrade(r) });
    hits.sort((a, b) => b.ret - a.ret);
  }
}

console.log(`\n=== ${ENGINE.toUpperCase()}: ${hits.length} configurations cleared ${(TARGET * 100).toFixed(0)}% on the search window ===`);
console.log(`best return seen anywhere: ${(bestRet * 100).toFixed(2)}%\n`);

if (hits.length === 0) {
  console.log("Nothing reached the target. Defaults stay.");
} else {
  console.log("rank  SEARCH-30d            BEFORE-90d           worst trade");
  for (const [i, h] of hits.slice(0, 10).entries()) {
    const before = run(h.p, earliest, searchFrom);
    console.log(
      `${String(i + 1).padStart(4)}  ${(h.ret * 100).toFixed(2).padStart(7)}% ${String(h.trades).padStart(3)}t ` +
        `DD${(h.dd * 100).toFixed(1).padStart(5)}% PF${h.pf.toFixed(2).padStart(5)}  |  ` +
        `${(before.totalReturn * 100).toFixed(2).padStart(8)}% ${String(before.trades.length).padStart(3)}t ` +
        `DD${(before.maxDrawdown * 100).toFixed(1).padStart(5)}% PF${before.profitFactor.toFixed(2).padStart(5)} liq${before.liquidations}  |  ` +
        `${(h.worst * 100).toFixed(2)}%`,
    );
  }
  fs.writeFileSync(`${OUT}/thirty-${ENGINE}.json`,
    JSON.stringify({ at: Date.now(), engine: ENGINE, hits: hits.slice(0, 10) }, null, 2));
  console.log(`\nwrote ${OUT}/thirty-${ENGINE}.json`);
}
