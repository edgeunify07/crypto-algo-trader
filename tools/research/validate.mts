/**
 * Third-window validation of the optimiser's winner.
 *
 * The search ranked candidates with a score that included the held-out window,
 * so across 300 trials that window stopped being out-of-sample for the winner —
 * some of its edge is selection luck. The only honest check is a stretch of
 * history the search never touched at all.
 *
 * This fetches 60 days (paging backwards past Binance's 1500-bar cap) and
 * evaluates the winner, the runner-up and the shipped defaults on days 31-60,
 * which sit entirely before the optimisation window. It then perturbs the
 * winner's parameters to see whether its performance is a stable region or a
 * single lucky point.
 */
import { runFuturesBacktest, type BacktestInput, type BacktestResult } from "@/lib/improve2/backtest";
import { DEFAULT_PARAMS, sanitiseParams, type StrategyParams } from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";
import fs from "node:fs";

const OUT = process.env.OUT ?? "/tmp";
const TFS: Timeframe[] = ["15m", "1h", "4h"];
const STEP: Timeframe = "1h";
const HOST = "https://www.binance.com";

type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

/** Page backwards so windows longer than Binance's 1500-bar cap can be loaded. */
async function fetchDeep(symbol: string, interval: Timeframe, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;

  while (out.length < bars) {
    const params = new URLSearchParams({
      symbol, interval, limit: String(Math.min(1500, bars - out.length)),
    });
    if (endTime !== undefined) params.set("endTime", String(endTime));

    const res = await fetch(`${HOST}/fapi/v1/klines?${params}`, { cache: "no-store" });
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

const symbols = Object.keys(
  JSON.parse(fs.readFileSync(`${OUT}/klines.json`, "utf8")) as Record<string, unknown>,
);
console.log("loading 60 days for:", symbols.join(", "));

// 60 days: 15m -> 5760, 1h -> 1440, 4h -> 360.
const NEED: Record<string, number> = { "15m": 5900, "1h": 1500, "4h": 400 };

const loaded = await Promise.all(
  symbols.flatMap((s) =>
    TFS.map(async (tf) => ({ s, tf, c: await fetchDeep(s, tf, NEED[tf]!).catch(() => [] as Candle[]) })),
  ),
);
const bySym = new Map<string, Map<Timeframe, Candle[]>>();
for (const { s, tf, c } of loaded) {
  if (c.length === 0) continue;
  const m = bySym.get(s) ?? new Map<Timeframe, Candle[]>();
  m.set(tf, c);
  bySym.set(s, m);
}
const all: BacktestInput[] = [...bySym].map(([symbol, byTimeframe]) => ({ symbol, byTimeframe }));

const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const optimiseWindowStart = latest - 30 * 86_400_000;

console.log(
  `history ${new Date(earliest).toISOString().slice(0, 10)} -> ${new Date(latest).toISOString().slice(0, 10)} ` +
    `(${Math.round((latest - earliest) / 86_400_000)} days, ${all[0]?.byTimeframe.get(STEP)?.length} bars of ${STEP})`,
);
console.log(
  `UNSEEN window: ${new Date(earliest).toISOString().slice(0, 10)} -> ${new Date(optimiseWindowStart).toISOString().slice(0, 10)}\n`,
);

const unseen = (p: StrategyParams) =>
  runFuturesBacktest(all, p, {
    stepTimeframe: STEP, startingBalance: 100,
    // Start a few days in so indicators are warm before the first trade.
    from: earliest + 3 * 86_400_000, to: optimiseWindowStart,
  });

const line = (tag: string, r: BacktestResult) =>
  `${tag.padEnd(16)} ${String(r.trades.length).padStart(4)}t ${(r.totalReturn * 100).toFixed(2).padStart(8)}% ` +
  `DD${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% PF${r.profitFactor.toFixed(2).padStart(5)} ` +
  `liq${r.liquidations} fees$${r.totalFees.toFixed(2).padStart(5)} exp ${r.expectancy.toFixed(3)}R`;

const best = JSON.parse(fs.readFileSync(`${OUT}/best.json`, "utf8")) as { params: StrategyParams };

console.log("=== ON THE UNSEEN WINDOW (never used in the search) ===");
const baseRes = unseen(DEFAULT_PARAMS);
const bestRes = unseen(best.params);
console.log(line("defaults", baseRes));
console.log(line("optimised #1", bestRes));

// ---- robustness: is this a stable region or one lucky point? -------------
console.log("\n=== ROBUSTNESS: winner perturbed +/-12% on continuous params ===");
const perturb = (p: StrategyParams, scale: number): StrategyParams => {
  const n = structuredClone(p);
  const jitter = (v: number) => v * (1 + (Math.random() * 2 - 1) * scale);
  for (const k of Object.keys(n.weights) as (keyof typeof n.weights)[]) {
    n.weights[k] = Math.max(0, jitter(n.weights[k]));
  }
  for (const k of Object.keys(n.timeframeWeights)) {
    n.timeframeWeights[k] = Math.max(0, jitter(n.timeframeWeights[k] ?? 1));
  }
  n.entry.minScore = Math.min(0.95, Math.max(0.1, jitter(n.entry.minScore)));
  n.entry.minAlignment = Math.min(1, Math.max(0, jitter(n.entry.minAlignment)));
  n.exit.atrStopMultiple = Math.min(6, Math.max(0.5, jitter(n.exit.atrStopMultiple)));
  n.exit.trailAtrMultiple = Math.min(6, Math.max(0.3, jitter(n.exit.trailAtrMultiple)));
  n.indicators.adxThreshold = Math.min(40, Math.max(10, jitter(n.indicators.adxThreshold)));
  return sanitiseParams(n).params;
};

const runs = Array.from({ length: 12 }, () => unseen(perturb(best.params, 0.12)));
const rets = runs.map((r) => r.totalReturn).sort((a, b) => a - b);
const positive = rets.filter((r) => r > 0).length;
const median = rets[Math.floor(rets.length / 2)] ?? 0;
console.log(
  `  ${positive}/${runs.length} perturbations profitable | median ${(median * 100).toFixed(2)}% | ` +
    `worst ${((rets[0] ?? 0) * 100).toFixed(2)}% | best ${((rets.at(-1) ?? 0) * 100).toFixed(2)}%`,
);
console.log(`  liquidations across perturbations: ${runs.reduce((a, r) => a + r.liquidations, 0)}`);

fs.writeFileSync(
  `${OUT}/validation.json`,
  JSON.stringify(
    {
      unseenWindow: { from: earliest + 3 * 86_400_000, to: optimiseWindowStart },
      defaults: { trades: baseRes.trades.length, ret: baseRes.totalReturn, dd: baseRes.maxDrawdown, pf: baseRes.profitFactor },
      optimised: { trades: bestRes.trades.length, ret: bestRes.totalReturn, dd: bestRes.maxDrawdown, pf: bestRes.profitFactor },
      robustness: { positive, total: runs.length, median, worst: rets[0], best: rets.at(-1) },
    },
    null,
    2,
  ),
);
console.log(`\nwrote ${OUT}/validation.json`);
