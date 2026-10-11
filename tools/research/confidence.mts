/**
 * How often is the engine actually confident?
 *
 * A scalp gated at "more than 80% confidence" is only a feature if that
 * number occurs. Confidence here is not a probability — it is a weighted
 * blend of per-timeframe confidences, and nothing forces it to span the whole
 * 0..1 range. Before building an entry rule around a threshold, this measures
 * what the distribution actually looks like, using the same blend the engine
 * runs rather than an approximation of it.
 */
import { aggregate } from "@/lib/improve2/backtest";
import { analyseTimeframe } from "@/lib/algo/screener/analyse";
import {
  DEFAULT_PARAMS,
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "@/lib/algo/strategy/params";
import type { Candle, Timeframe, TimeframeAnalysis } from "@/lib/algo/types";
import fs from "node:fs";

const OUT = process.env.OUT ?? "/tmp";
const CACHE = process.env.CACHE ?? `${OUT}/klines120x24.json`;
const PARAMS_FILE = process.env.PARAMS ?? "";
const STEP: Timeframe = "1h";
const WINDOW = 260;

const params: StrategyParams = PARAMS_FILE
  ? sanitiseParams(
      StrategyParamsSchema.parse(
        (JSON.parse(fs.readFileSync(PARAMS_FILE, "utf8")) as { params: unknown }).params,
      ),
    ).params
  : DEFAULT_PARAMS;
console.log(PARAMS_FILE ? `params from ${PARAMS_FILE}` : "shipped default params");

const bySym = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Record<string, Record<string, Candle[]>>;

const confidences: number[] = [];
let qualifying = 0; // passes score + alignment + direction, whatever the confidence
const atLeast: Record<string, number> = { "0.70": 0, "0.75": 0, "0.80": 0, "0.85": 0, "0.90": 0 };
const qualifyingAtLeast: Record<string, number> = { ...atLeast };

for (const [symbol, tfs] of Object.entries(bySym)) {
  const byTimeframe = new Map(Object.entries(tfs) as [Timeframe, Candle[]][]);
  const step = byTimeframe.get(STEP) ?? [];
  // Every tenth bar: the blend moves slowly and this is a distribution, not a
  // backtest, so a tenth of the work gives the same shape.
  for (let i = WINDOW; i < step.length; i += 10) {
    const now = (step[i] as Candle).closeTime;
    const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
    for (const [tf, candles] of byTimeframe) {
      let j = candles.length - 1;
      while (j >= 0 && (candles[j] as Candle).closeTime > now) j--;
      if (j < WINDOW) continue;
      const a = analyseTimeframe(symbol, tf, candles.slice(j - WINDOW + 1, j + 1), params);
      if (a) perTimeframe.set(tf, a);
    }
    if (perTimeframe.size === 0) continue;
    const b = aggregate(perTimeframe, params);
    confidences.push(b.confidence);

    const passesRest =
      b.direction !== "flat" &&
      Math.abs(b.score) >= params.entry.minScore &&
      b.alignment >= params.entry.minAlignment;
    if (passesRest) qualifying++;

    for (const key of Object.keys(atLeast)) {
      if (b.confidence >= Number(key)) {
        atLeast[key] = (atLeast[key] as number) + 1;
        if (passesRest) qualifyingAtLeast[key] = (qualifyingAtLeast[key] as number) + 1;
      }
    }
  }
}

confidences.sort((a, b) => a - b);
const at = (q: number) => confidences[Math.min(confidences.length - 1, Math.floor(q * confidences.length))] as number;

console.log(`\n${confidences.length} evaluations across ${Object.keys(bySym).length} symbols\n`);
console.log("confidence distribution");
for (const q of [0.5, 0.75, 0.9, 0.95, 0.99, 1]) {
  console.log(`  p${(q * 100).toFixed(0).padStart(3)}  ${at(q === 1 ? 0.999999 : q).toFixed(3)}`);
}

console.log(`\nmoments at or above a threshold (of ${confidences.length}):`);
for (const key of Object.keys(atLeast)) {
  const n = atLeast[key] as number;
  const q = qualifyingAtLeast[key] as number;
  console.log(
    `  >=${key}  ${String(n).padStart(6)} (${((n / confidences.length) * 100).toFixed(2)}%)` +
      `   and passing the other entry checks: ${q}`,
  );
}
console.log(`\nmoments passing the other entry checks at any confidence: ${qualifying}`);
