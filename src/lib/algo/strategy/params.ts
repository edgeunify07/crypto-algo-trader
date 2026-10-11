import { z } from "zod";
import type { Timeframe } from "../types";

/**
 * Every tunable knob in the strategy lives here as plain data.
 *
 * This is deliberately a flat, bounded, JSON-serialisable object: it is what
 * the LLM improvement loop reads, mutates and returns, and what gets versioned
 * on disk. The Zod schema is both the validator for LLM output and the source
 * of the structured-output format, so the model cannot propose a shape the
 * engine can't run.
 */

/** Bounds enforced on every parameter, so a bad proposal can't blow up risk. */
export const ParamBounds = {
  weights: { min: 0, max: 3 },
  emaFast: { min: 5, max: 60 },
  emaSlow: { min: 20, max: 250 },
  rsiPeriod: { min: 5, max: 40 },
  atrPeriod: { min: 5, max: 40 },
  atrStopMultiple: { min: 0.5, max: 6 },
  entryScore: { min: 0.1, max: 0.95 },
  alignment: { min: 0, max: 1 },
  riskReward: { min: 0.5, max: 6 },
  trailStart: { min: 0, max: 5 },
  maxHoldBars: { min: 5, max: 2000 },
  zigzagAtr: { min: 0.8, max: 6 },
} as const;

export const StrategyParamsSchema = z.object({
  /**
   * Component weights. Each analysis module emits a -1..+1 score; these decide
   * how much each one contributes to the blended timeframe score.
   */
  weights: z.object({
    emaTrend: z.number().min(0).max(3),
    macd: z.number().min(0).max(3),
    rsi: z.number().min(0).max(3),
    adx: z.number().min(0).max(3),
    bollinger: z.number().min(0).max(3),
    volume: z.number().min(0).max(3),
    structure: z.number().min(0).max(3),
    elliott: z.number().min(0).max(3),
    gann: z.number().min(0).max(3),
  }),

  indicators: z.object({
    emaFast: z.number().int().min(5).max(60),
    emaSlow: z.number().int().min(20).max(250),
    rsiPeriod: z.number().int().min(5).max(40),
    rsiOverbought: z.number().min(55).max(90),
    rsiOversold: z.number().min(10).max(45),
    atrPeriod: z.number().int().min(5).max(40),
    macdFast: z.number().int().min(3).max(30),
    macdSlow: z.number().int().min(10).max(60),
    macdSignal: z.number().int().min(3).max(20),
    bbPeriod: z.number().int().min(10).max(60),
    bbMultiplier: z.number().min(1).max(4),
    adxThreshold: z.number().min(10).max(40),
    /** ZigZag sensitivity for Elliott and Gann pivots, in ATR multiples. */
    zigzagAtrMultiple: z.number().min(0.8).max(6),
  }),

  /**
   * Per-timeframe weights for multi-timeframe confluence. Higher timeframes
   * normally dominate; the LLM can rebalance this.
   */
  timeframeWeights: z.record(z.string(), z.number().min(0).max(5)),

  entry: z.object({
    /** |score| required on the anchor timeframe to consider a trade. */
    minScore: z.number().min(0.1).max(0.95),
    /** Blended confidence required. */
    minConfidence: z.number().min(0).max(1),
    /** Fraction of weighted timeframes that must agree. */
    minAlignment: z.number().min(0).max(1),
    /** Reject entries when 24h quote volume is below this. */
    minQuoteVolume24h: z.number().min(0),
    /** Require the Elliott count to agree with the trade direction. */
    requireElliottAgreement: z.boolean(),
    /** Require the Gann bias to agree with the trade direction. */
    requireGannAgreement: z.boolean(),
    /** Skip entries inside a Gann time-cycle reversal window. */
    avoidGannTimeCycle: z.boolean(),
    /** Allow short positions (spot-only accounts should keep this false). */
    allowShorts: z.boolean(),
  }),

  exit: z.object({
    /** Initial stop distance in ATR multiples. */
    atrStopMultiple: z.number().min(0.5).max(6),
    /** Take-profit ladder, as reward:risk multiples with position fractions. */
    takeProfitRMultiples: z.array(z.number().min(0.3).max(10)).min(1).max(4),
    takeProfitFractions: z.array(z.number().min(0.05).max(1)).min(1).max(4),
    /** Start trailing once price is this many R in profit (0 = never). */
    trailStartR: z.number().min(0).max(5),
    /** Trailing distance in ATR multiples. */
    trailAtrMultiple: z.number().min(0.3).max(6),
    /** Move the stop to break-even at this R (0 = never). */
    breakEvenR: z.number().min(0).max(5),
    /** Close the position after this many bars on its timeframe. */
    maxHoldBars: z.number().int().min(5).max(2000),
    /** Exit when the blended score flips against the position beyond this. */
    exitOnScoreFlip: z.number().min(0).max(1),
    /** Prefer structural (Elliott/Gann) targets over pure R multiples. */
    useStructuralTargets: z.boolean(),
  }),

  risk: z.object({
    riskPerTrade: z.number().min(0.001).max(0.05),
    maxOpenPositions: z.number().int().min(1).max(20),
    maxPositionFraction: z.number().min(0.01).max(1),
    /** Scale size down when ATR% exceeds this. */
    volatilityTargetAtrPct: z.number().min(0.002).max(0.2),
  }),
});

export type StrategyParams = z.infer<typeof StrategyParamsSchema>;

/** A params object plus the metadata the improvement loop tracks. */
export interface VersionedParams {
  version: string;
  createdAt: number;
  /** "default", "llm", or "manual". */
  source: string;
  /** The LLM's reasoning for this mutation, when applicable. */
  rationale: string;
  parentVersion: string | null;
  params: StrategyParams;
}

/**
 * Baseline parameters, found by random search over 60 days of real USDⓈ-M
 * futures klines on the top-10 universe, with a three-way split: searched on
 * the oldest 40%, ranked on the middle 25%, then scored once on the most
 * recent 35%, which nothing in the search had seen.
 *
 *            trades   return   maxDD   PF     fees
 *   train        33   +17.2%    7.5%   2.71   $2.16
 *   validate     13   +32.3%    1.6%  17.89   $0.36
 *   test         25    +4.5%   11.9%   1.31   $0.97
 *
 * The previous defaults returned -7.6% on that same test window across 283
 * trades, paying $19.64 in commission. The entire difference is selectivity:
 * `minAlignment` at 0.93 demands near-total agreement across timeframes, which
 * is what takes 283 trades down to 25 and the fee bill with it. On a $100
 * account at 0.05% per side, trade count is the dominant cost.
 *
 * Three of the five finalists stayed profitable on the untouched window, so
 * this is a region that holds rather than a single lucky point. It is still a
 * 60-day sample in one market regime, the test window was used once to choose
 * among those five, and 25 trades is a small sample — this is a starting
 * point for the improvement loop to beat, not a forecast.
 */
export const DEFAULT_PARAMS: StrategyParams = {
  weights: {
    emaTrend: 2.04,
    macd: 1.61,
    rsi: 0.96,
    adx: 0.89,
    bollinger: 1.11,
    volume: 0.51,
    structure: 0.55,
    elliott: 0.76,
    gann: 2.14,
  },
  indicators: {
    emaFast: 23,
    emaSlow: 76,
    rsiPeriod: 11,
    rsiOverbought: 70,
    rsiOversold: 30,
    atrPeriod: 9,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbMultiplier: 2,
    adxThreshold: 33.59,
    zigzagAtrMultiple: 3.11,
  },
  timeframeWeights: {
    "1m": 0.2,
    "3m": 0.3,
    "5m": 1.2,
    "15m": 2.0,
    "30m": 0.85,
    "1h": 2.04,
    "2h": 1.1,
    "4h": 2.21,
    "6h": 1.3,
    "12h": 1.4,
    "1d": 0.99,
    "3d": 1.3,
    "1w": 1.2,
  },
  entry: {
    minScore: 0.52,
    minConfidence: 0.64,
    minAlignment: 0.93,
    minQuoteVolume24h: 50000000,
    requireElliottAgreement: false,
    requireGannAgreement: false,
    avoidGannTimeCycle: false,
    allowShorts: true,
  },
  exit: {
    atrStopMultiple: 2.71,
    takeProfitRMultiples: [1.28, 2.13],
    takeProfitFractions: [0.5, 0.5],
    trailStartR: 1.68,
    trailAtrMultiple: 3.06,
    breakEvenR: 2.49,
    maxHoldBars: 146,
    exitOnScoreFlip: 0.49,
    useStructuralTargets: false,
  },
  risk: {
    riskPerTrade: 0.01,
    maxOpenPositions: 5,
    maxPositionFraction: 0.25,
    volatilityTargetAtrPct: 0.03,
  },
};

export function timeframeWeight(
  params: StrategyParams,
  timeframe: Timeframe,
): number {
  return params.timeframeWeights[timeframe] ?? 1;
}

/**
 * Normalise a params object into something safe to run:
 * clamps out-of-range values, fixes ordering constraints (fast < slow), and
 * makes the take-profit ladder consistent. Returns the repairs made so the
 * improvement loop can tell the model what it got wrong.
 */
export function sanitiseParams(params: StrategyParams): {
  params: StrategyParams;
  repairs: string[];
} {
  const repairs: string[] = [];
  const next: StrategyParams = structuredClone(params);

  if (next.indicators.emaFast >= next.indicators.emaSlow) {
    next.indicators.emaSlow = next.indicators.emaFast + 20;
    repairs.push("emaSlow raised above emaFast");
  }
  if (next.indicators.macdFast >= next.indicators.macdSlow) {
    next.indicators.macdSlow = next.indicators.macdFast + 10;
    repairs.push("macdSlow raised above macdFast");
  }
  if (next.indicators.rsiOversold >= next.indicators.rsiOverbought) {
    next.indicators.rsiOversold = 30;
    next.indicators.rsiOverbought = 70;
    repairs.push("RSI bands reset — oversold was above overbought");
  }

  // The take-profit ladder must be ascending and its fractions must sum to <= 1.
  const rungs = Math.min(
    next.exit.takeProfitRMultiples.length,
    next.exit.takeProfitFractions.length,
  );
  if (rungs !== next.exit.takeProfitRMultiples.length) {
    repairs.push("take-profit ladder truncated to matching length");
  }
  next.exit.takeProfitRMultiples = next.exit.takeProfitRMultiples
    .slice(0, rungs)
    .sort((a, b) => a - b);
  next.exit.takeProfitFractions = next.exit.takeProfitFractions.slice(0, rungs);

  const fractionSum = next.exit.takeProfitFractions.reduce((a, b) => a + b, 0);
  if (fractionSum > 1.0001) {
    next.exit.takeProfitFractions = next.exit.takeProfitFractions.map(
      (f) => f / fractionSum,
    );
    repairs.push("take-profit fractions normalised to sum to 1");
  }

  // All weights zero would make every score zero.
  const weightSum = Object.values(next.weights).reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    next.weights = structuredClone(DEFAULT_PARAMS.weights);
    repairs.push("component weights were all zero — reset to defaults");
  }

  return { params: next, repairs };
}

export function paramsVersionId(source: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const salt = Math.random().toString(36).slice(2, 6);
  return `${source}-${stamp}-${salt}`;
}

export function defaultVersionedParams(): VersionedParams {
  return {
    version: "default-v1",
    createdAt: Date.now(),
    source: "default",
    rationale: "Hand-tuned baseline shipped with the project.",
    parentVersion: null,
    params: structuredClone(DEFAULT_PARAMS),
  };
}
