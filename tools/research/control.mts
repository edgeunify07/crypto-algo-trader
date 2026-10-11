/**
 * Is the strategy reading the market, or reading noise?
 *
 * Parameter search can only find an edge that is there. Before spending more
 * of it, this asks the prior question with a control: run the same parameters
 * over synthetic series that keep each symbol's bar shapes and volatility but
 * destroy the order those bars came in. Trend, wave structure and support
 * levels cannot survive that; the fee bill and the sizing rules do.
 *
 * If the real series beat the controls clearly, the entries are reading
 * something. If they land inside the spread of the controls, the apparent
 * edge is the sampling noise of a few dozen trades, and no amount of further
 * tuning will fix that — it will only fit the noise harder.
 *
 * Bars are resampled in blocks rather than one at a time, so volatility
 * clustering (a quiet week, then a violent one) survives and only the
 * longer-range structure the strategy claims to trade is removed. Every
 * timeframe is rebuilt from the same synthetic 15m path so the timeframes
 * still agree with each other — shuffling each one independently would make
 * them contradict, which tests nothing.
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
/** Which parameters to test; defaults to the shipped ones. */
const PARAMS_FILE = process.env.PARAMS ?? "";
const CACHE = process.env.CACHE ?? `${OUT}/klines120x24.json`;
const RUNS = Number(process.env.RUNS ?? "12");
const BLOCK = Number(process.env.BLOCK ?? "32"); // 15m bars: 8 hours
const UNIVERSE = Number(process.env.UNIVERSE ?? "10");
const STEP: Timeframe = "1h";

/** Deterministic PRNG, so a surprising result can be reproduced exactly. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic 15m path built from the real bars in shuffled blocks.
 *
 * Each real bar contributes its shape — how far it ran up, down and closed
 * relative to its own open — and the shapes are chained onto a running price.
 * Timestamps stay on the original grid so the aggregation below is exact.
 */
function resample(real: Candle[], rand: () => number): Candle[] {
  const blocks: Candle[][] = [];
  for (let i = 0; i < real.length; i += BLOCK) blocks.push(real.slice(i, i + BLOCK));

  const order = blocks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }

  const out: Candle[] = [];
  let price = real[0]?.open ?? 100;
  for (const b of order) {
    for (const c of blocks[b] as Candle[]) {
      if (!(c.open > 0)) continue;
      const open = price;
      const high = open * (c.high / c.open);
      const low = open * (c.low / c.open);
      const close = open * (c.close / c.open);
      const slot = real[out.length];
      if (!slot) break;
      out.push({
        openTime: slot.openTime,
        open, high, low, close,
        volume: c.volume,
        closeTime: slot.closeTime,
        quoteVolume: c.quoteVolume,
        trades: c.trades,
        closed: true,
      });
      price = close;
    }
  }
  return out;
}

/**
 * Roll `n` finer bars into one, the way the exchange would have.
 *
 * Grouping has to start on a boundary of the coarser timeframe. Starting at
 * index 0 regardless would straddle hours whenever the series does not begin
 * on one, and every candle after that would carry a timestamp that disagrees
 * with the bars inside it — which the strategy reads as structure that is not
 * there, in a run whose whole purpose is to contain no structure.
 */
function aggregate(fine: Candle[], n: number): Candle[] {
  const span = n * 900_000;
  let start = 0;
  while (start < fine.length && (fine[start] as Candle).openTime % span !== 0) start++;

  const out: Candle[] = [];
  for (let i = start; i + n <= fine.length; i += n) {
    const group = fine.slice(i, i + n);
    const first = group[0] as Candle;
    const last = group[n - 1] as Candle;
    out.push({
      openTime: first.openTime,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: last.close,
      volume: group.reduce((a, c) => a + c.volume, 0),
      closeTime: last.closeTime,
      quoteVolume: group.reduce((a, c) => a + c.quoteVolume, 0),
      trades: group.reduce((a, c) => a + c.trades, 0),
      closed: true,
    });
  }
  return out;
}

const params: StrategyParams = PARAMS_FILE
  ? sanitiseParams(
      StrategyParamsSchema.parse(
        (JSON.parse(fs.readFileSync(PARAMS_FILE, "utf8")) as { params: unknown }).params,
      ),
    ).params
  : DEFAULT_PARAMS;
console.log(PARAMS_FILE ? `params from ${PARAMS_FILE}` : "shipped default params");

const bySym = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Record<string, Candle[]>>;
const symbols = Object.keys(bySym);
console.log(`${symbols.length} symbols from ${CACHE}`);

const real: BacktestInput[] = symbols.map((symbol) => ({
  symbol,
  byTimeframe: new Map(Object.entries(bySym[symbol] ?? {}) as [Timeframe, Candle[]][]),
}));

const stepAll = real.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const from = earliest + 3 * 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
console.log(`window ${day(from)} -> ${day(latest)}\n`);

const run = (data: BacktestInput[]) =>
  runFuturesBacktest(data, params, {
    stepTimeframe: STEP,
    startingBalance: 100,
    from,
    to: latest,
    universeSize: UNIVERSE,
  });

const show = (label: string, r: BacktestResult) =>
  `${label.padEnd(14)} ${String(r.trades.length).padStart(4)}t ` +
  `${(r.totalReturn * 100).toFixed(2).padStart(8)}%  DD ${(r.maxDrawdown * 100).toFixed(1).padStart(5)}%  ` +
  `PF ${r.profitFactor.toFixed(2).padStart(5)}  liq${r.liquidations}`;

const actual = run(real);
console.log(show("REAL", actual));
console.log();

const controls: BacktestResult[] = [];
for (let seed = 1; seed <= RUNS; seed++) {
  const rand = mulberry32(seed * 7919);
  const synthetic: BacktestInput[] = real.map((d) => {
    const fine = d.byTimeframe.get("15m") ?? [];
    if (fine.length === 0) return d;
    const shuffled = resample(fine, rand);
    return {
      symbol: d.symbol,
      byTimeframe: new Map<Timeframe, Candle[]>([
        ["15m", shuffled],
        ["1h", aggregate(shuffled, 4)],
        ["4h", aggregate(shuffled, 16)],
      ]),
    };
  });
  const r = run(synthetic);
  controls.push(r);
  console.log(show(`control ${seed}`, r));
}

const rets = controls.map((r) => r.totalReturn).sort((a, b) => a - b);
const mid = (xs: number[]) =>
  xs.length % 2 ? (xs[(xs.length - 1) / 2] as number) : (((xs[xs.length / 2 - 1] as number) + (xs[xs.length / 2] as number)) / 2);
const beaten = controls.filter((r) => actual.totalReturn > r.totalReturn).length;

console.log(`\ncontrols: median ${(mid(rets) * 100).toFixed(2)}%  ` +
  `range ${(rets[0]! * 100).toFixed(2)}% .. ${(rets.at(-1)! * 100).toFixed(2)}%`);
console.log(`real ${(actual.totalReturn * 100).toFixed(2)}% beats ${beaten}/${controls.length} controls`);
// With 12 controls, beating all of them is the one-sided p < 0.08 outcome —
// suggestive, not proof, and worth stating as such rather than as a finding.
console.log(
  beaten === controls.length
    ? "\nThe real series beat every control: the entries are reading something."
    : beaten >= controls.length * 0.75
      ? "\nAhead of most controls, but inside their spread — weak evidence at best."
      : "\nInside the control spread. There is no measurable edge here to tune toward.",
);
