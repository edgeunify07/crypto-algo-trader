/**
 * Re-measure the optimiser's winner with the code that will actually trade it.
 *
 * A long search loads the engine once and runs for hours, so its results
 * describe whatever the backtester did at the moment it started — this run
 * began before the drawdown halt and the equity-marking fix landed. Shipping
 * a winner on those numbers would mean deploying parameters chosen under
 * rules the live engine does not follow.
 *
 * So the winner is scored again here, on the same four disjoint windows, by
 * the current build, against the shipped defaults measured the same way. The
 * bar is deliberately boring: beat the incumbent on the median window, stay
 * profitable in at least three of four, and liquidate in none. One good
 * window is luck.
 */
import { runFuturesBacktest, type BacktestInput, type BacktestResult } from "@/lib/improve2/backtest";
import { DEFAULT_PARAMS, StrategyParamsSchema, sanitiseParams } from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";
import fs from "node:fs";

const OUT = process.env.OUT ?? "/tmp";
const CACHE = process.env.CACHE ?? `${OUT}/klines120x24.json`;
const WINNER = process.env.WINNER ?? `${OUT}/winner2.json`;
const UNIVERSE = Number(process.env.UNIVERSE ?? "10");
const STEP: Timeframe = "1h";

const bySym = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Record<string, Candle[]>>;
const all: BacktestInput[] = Object.entries(bySym).map(([symbol, m]) => ({
  symbol,
  byTimeframe: new Map(Object.entries(m) as [Timeframe, Candle[]][]),
}));

const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// The same split the search used, so "out of sample" means the same thing.
const trainTo = earliest + (latest - earliest) * 0.35;
const span = (latest - trainTo) / 4;
const windows = Array.from({ length: 4 }, (_, i) => ({
  from: trainTo + span * i,
  to: trainTo + span * (i + 1),
}));

const run = (p: Parameters<typeof runFuturesBacktest>[1], from: number, to: number) =>
  runFuturesBacktest(all, p, {
    stepTimeframe: STEP,
    startingBalance: 100,
    from,
    to,
    universeSize: UNIVERSE,
  });

const line = (t: string, r: BacktestResult) =>
  `${t.padEnd(10)} ${String(r.trades.length).padStart(3)}t ${(r.totalReturn * 100).toFixed(2).padStart(8)}% ` +
  `DD${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% PF${r.profitFactor.toFixed(2).padStart(6)} liq${r.liquidations}`;

interface Summary {
  results: BacktestResult[];
  median: number;
  compounded: number;
  profitable: number;
  liquidations: number;
  worstDd: number;
  trades: number;
}

function summarise(p: Parameters<typeof runFuturesBacktest>[1]): Summary {
  const results = windows.map((w) => run(p, w.from, w.to));
  const rets = results.map((r) => r.totalReturn).sort((a, b) => a - b);
  return {
    results,
    median: ((rets[1] as number) + (rets[2] as number)) / 2,
    compounded: results.reduce((acc, r) => acc * (1 + r.totalReturn), 1) - 1,
    profitable: results.filter((r) => r.totalReturn > 0).length,
    liquidations: results.reduce((a, r) => a + r.liquidations, 0),
    worstDd: Math.max(...results.map((r) => r.maxDrawdown)),
    trades: results.reduce((a, r) => a + r.trades.length, 0),
  };
}

const report = (name: string, s: Summary) => {
  console.log(`\n=== ${name} ===`);
  s.results.forEach((r, i) => console.log(line(`  OOS${i + 1}`, r)));
  console.log(
    `  median ${(s.median * 100).toFixed(2)}% | compounded ${(s.compounded * 100).toFixed(2)}% | ` +
      `${s.profitable}/4 profitable | ${s.trades} trades | worst DD ${(s.worstDd * 100).toFixed(1)}% | ` +
      `liq ${s.liquidations}`,
  );
};

console.log(`history ${day(earliest)} -> ${day(latest)}, ${all.length} symbols, top ${UNIVERSE} tradable`);
windows.forEach((w, i) => console.log(`  OOS${i + 1} ${day(w.from)} -> ${day(w.to)}`));

const incumbent = summarise(DEFAULT_PARAMS);
report("SHIPPED DEFAULTS, re-measured by the current build", incumbent);

if (!fs.existsSync(WINNER)) {
  console.log(`\nNo ${WINNER} — the search accepted nothing. Defaults stay.`);
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(WINNER, "utf8")) as { params: unknown };
const parsed = StrategyParamsSchema.safeParse(raw.params);
if (!parsed.success) {
  console.log("\nWinner failed schema validation; defaults stay.");
  process.exit(1);
}
const candidate = sanitiseParams(parsed.data).params;
const challenger = summarise(candidate);
report("SEARCH WINNER, same code, same windows", challenger);

const reasons: string[] = [];
if (challenger.profitable < 3) reasons.push(`only ${challenger.profitable}/4 windows profitable`);
if (challenger.liquidations > 0) reasons.push(`${challenger.liquidations} liquidation(s)`);
if (challenger.median <= incumbent.median) {
  reasons.push(
    `median ${(challenger.median * 100).toFixed(2)}% does not beat the incumbent's ` +
      `${(incumbent.median * 100).toFixed(2)}%`,
  );
}
if (challenger.trades < 40) reasons.push(`only ${challenger.trades} trades across all windows`);

console.log();
if (reasons.length === 0) {
  console.log(`PROMOTE: ${reasons.length === 0 ? "clears every bar" : ""}`);
  fs.writeFileSync(`${OUT}/validated.json`, JSON.stringify({ params: candidate }, null, 2));
  console.log(`wrote ${OUT}/validated.json`);
} else {
  console.log("DO NOT PROMOTE:");
  for (const r of reasons) console.log(`  - ${r}`);
}
