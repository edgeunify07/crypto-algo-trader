/**
 * Does the scalp rule pay for itself?
 *
 * A high-conviction scalp sounds good and costs real money: it takes the
 * same taker fee twice for a move a fraction of the size the swing exits aim
 * at, so it has to be right much more often to break even. This runs the
 * same parameters over the same out-of-sample windows with the rule off and
 * on, and at a range of confidence thresholds, so the answer is measured
 * rather than assumed.
 */
import { runFuturesBacktest, type BacktestInput } from "@/lib/improve2/backtest";
import {
  DEFAULT_PARAMS,
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";
import fs from "node:fs";

const OUT = process.env.OUT ?? "/tmp";
const CACHE = process.env.CACHE ?? `${OUT}/klines120x24.json`;
const PARAMS_FILE = process.env.PARAMS ?? "";
const UNIVERSE = Number(process.env.UNIVERSE ?? "10");
const STEP: Timeframe = "1h";

const base: StrategyParams = PARAMS_FILE
  ? sanitiseParams(
      StrategyParamsSchema.parse(
        (JSON.parse(fs.readFileSync(PARAMS_FILE, "utf8")) as { params: unknown }).params,
      ),
    ).params
  : DEFAULT_PARAMS;

const bySym = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Record<string, Candle[]>>;
const all: BacktestInput[] = Object.entries(bySym).map(([symbol, m]) => ({
  symbol,
  byTimeframe: new Map(Object.entries(m) as [Timeframe, Candle[]][]),
}));

const stepAll = all.flatMap((d) => d.byTimeframe.get(STEP) ?? []);
const latest = Math.max(...stepAll.map((c) => c.closeTime));
const earliest = Math.min(...stepAll.map((c) => c.closeTime));
const trainTo = earliest + (latest - earliest) * 0.35;
const span = (latest - trainTo) / 4;
const windows = Array.from({ length: 4 }, (_, i) => ({
  from: trainTo + span * i,
  to: trainTo + span * (i + 1),
}));

function measure(p: StrategyParams) {
  const results = windows.map((w) =>
    runFuturesBacktest(all, p, {
      stepTimeframe: STEP,
      startingBalance: 100,
      from: w.from,
      to: w.to,
      universeSize: UNIVERSE,
    }),
  );
  const rets = results.map((r) => r.totalReturn).sort((a, b) => a - b);
  const scalpTrades = results.flatMap((r) =>
    r.trades.filter((t) => t.exitReason.startsWith("scalp_")),
  );
  return {
    results,
    median: ((rets[1] as number) + (rets[2] as number)) / 2,
    compounded: results.reduce((acc, r) => acc * (1 + r.totalReturn), 1) - 1,
    profitable: results.filter((r) => r.totalReturn > 0).length,
    trades: results.reduce((a, r) => a + r.trades.length, 0),
    liq: results.reduce((a, r) => a + r.liquidations, 0),
    scalps: scalpTrades.length,
    scalpPnl: scalpTrades.reduce((a, t) => a + t.netPnl, 0),
    scalpWins: scalpTrades.filter((t) => t.netPnl > 0).length,
    worstDd: Math.max(...results.map((r) => r.maxDrawdown)),
  };
}

const show = (label: string, m: ReturnType<typeof measure>) =>
  console.log(
    `${label.padEnd(26)} median ${(m.median * 100).toFixed(2).padStart(7)}%  ` +
      `comp ${(m.compounded * 100).toFixed(2).padStart(8)}%  ${m.profitable}/4  ` +
      `${String(m.trades).padStart(3)}t  DD ${(m.worstDd * 100).toFixed(1).padStart(5)}%  liq${m.liq}  ` +
      `scalps ${String(m.scalps).padStart(3)} (${m.scalpWins} won, ` +
      `${m.scalpPnl >= 0 ? "+" : ""}$${m.scalpPnl.toFixed(2)})`,
  );

console.log(`${all.length} symbols, top ${UNIVERSE} tradable, 4 out-of-sample windows\n`);

show("scalp off", measure({ ...base, scalp: { ...base.scalp, enabled: false } }));
for (const minConfidence of [0.65, 0.68, 0.7, 0.72, 0.75, 0.8]) {
  show(
    `scalp on, >=${minConfidence}`,
    measure({ ...base, scalp: { ...base.scalp, enabled: true, minConfidence } }),
  );
}

console.log("\ntarget size, at the default threshold:");
for (const targetPct of [0.02, 0.03, 0.05, 0.08]) {
  show(
    `  target ${(targetPct * 100).toFixed(0)}%`,
    measure({ ...base, scalp: { ...base.scalp, enabled: true, targetPct } }),
  );
}
