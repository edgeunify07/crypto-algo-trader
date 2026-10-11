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

  /**
   * High-conviction scalp: take a fixed percentage move and close.
   *
   * Two measurements shape the defaults here, and the second is the reason
   * the threshold is set where it is.
   *
   * `minConfidence` runs on the engine's own confidence scale, which is a
   * weighted blend of per-timeframe confidences and not a probability. Over
   * 120 days and 24 symbols it reached 0.80 six times in 6,768 evaluations
   * and never passed 0.86, so a threshold chosen by intuition from the word
   * "confidence" barely fires at all: 0.80 is roughly one trade a month.
   *
   * Lowering it to where it fires often costs money, which is not what the
   * win rate suggests. Closing the *whole* position at the target, over 83
   * out-of-sample days on one account:
   *
   *     threshold   scalps   won    scalp P&L   account
   *     off              0     —            —   +22.04%
   *     >=0.72           4   4/4      +$10.86   +17.21%
   *     >=0.70           9   9/9      +$23.90   +13.43%
   *     >=0.68          14  14/14     +$52.51    +9.74%
   *
   * Every scalp won — 29 of 29 across that sweep — and each one left the
   * account poorer. They are not losing trades; they are winning trades
   * taken instead of better ones. A scalp pre-empts the swing entry on the
   * same signal and closes at a fixed 5% a position the swing exits would
   * have carried further, paying a second taker fee to do it. The profit is
   * real and the opportunity cost is larger.
   *
   * `closeFraction` is the lever against exactly that, and it is what makes
   * the rule affordable at a threshold where it actually fires. At 0.75:
   *
   *     close    scalps   won   scalp P&L   account
   *     100%          2   2/2      +$3.58   +17.50%
   *      75%          4   4/4      +$3.51   +19.93%
   *      50%          4   4/4      +$4.17   +20.59%
   *      25%          4   4/4      +$5.58   +21.96%
   *
   * Taking half at the target and leaving half on the swing ladder keeps the
   * fast exit while giving up almost none of the run — the defaults below.
   * Below 0.70 no fraction rescues it: the rule fires too often and the
   * account lands near 15% whatever it closes.
   */
  scalp: z
    .object({
      enabled: z.boolean(),
      /** Blended confidence at or above which a signal becomes a scalp. */
      minConfidence: z.number().min(0.3).max(0.99),
      /** Take profit at this fractional move in the position's favour. */
      targetPct: z.number().min(0.005).max(0.5),
      /** Give up after this many bars on the anchor timeframe. */
      maxHoldBars: z.number().int().min(1).max(500),
      /**
       * Stop distance in ATR multiples, overriding the swing stop. A scalp
       * that needs a swing-sized stop is not a scalp: the position would be
       * sized down to nothing to keep the same risk.
       */
      atrStopMultiple: z.number().min(0.3).max(4),
      /**
       * How much of the position the target closes. Below 1 the remainder
       * stays on the swing ladder, which is the lever against a scalp's one
       * real cost: it takes 5% from a position the swing exits would have
       * carried further.
       */
      closeFraction: z.number().min(0.1).max(1),
    })
    .default({
      enabled: true,
      minConfidence: 0.75,
      targetPct: 0.05,
      maxHoldBars: 24,
      atrStopMultiple: 1.2,
      closeFraction: 0.5,
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
 * Baseline parameters, from a two-stage search over 120 days of real USDⓈ-M
 * futures klines.
 *
 * Stage one ran 400 random trials on the oldest 35% and kept the 212 that
 * were profitable there; the best 40 were then scored across four *disjoint*
 * later windows on the full 24-symbol pool, and 16 held up in at least three
 * of four with no liquidation. This is the best median of those.
 *
 * Every backtest behind it ranks the universe point-in-time, by the trailing
 * volume each step actually had, rather than over today's top ten. That
 * distinction is not academic: the previous defaults scored +26% on the last
 * 30 days the old way and -2.7% once the ranking was honest.
 *
 * Re-measured by the current engine — drawdown halt, equity marked with
 * unrealised P&L, live concurrency cap — across the four out-of-sample
 * windows:
 *
 *            trades   return   maxDD   PF
 *   OOS1         16   +42.1%   12.0%   4.55
 *   OOS2         30   +42.5%   15.4%   2.69
 *   OOS3         12    +6.8%    5.1%   2.00
 *   OOS4         22    +5.0%    7.5%   1.34
 *
 * The shipped defaults these replace managed a -1.9% median on the same four,
 * profitable in two of them, with one liquidation.
 *
 * Read as one continuous account rather than four fresh ones — which is the
 * only figure anybody can spend — that is **+22.0% over 83 out-of-sample
 * days**, a 15.4% worst drawdown and no liquidations, against -15.5% for the
 * parameters it replaces. Compounding the four windows gives a much larger
 * number; it describes four separate accounts and is not quoted here.
 *
 * Against a control: the same parameters over twelve synthetic series that
 * keep each symbol's bar shapes and volatility but shuffle the order in
 * eight-hour blocks returned a median of -27.8%, and the real series beat all
 * twelve. The entries are reading market structure, not noise.
 *
 * What this is not: 16 candidates cleared the bar and this is the best of
 * them, chosen on the same windows it is reported against, so expect less
 * live than the table shows. Four months is one market regime. The
 * improvement loop exists to beat this, not to be trusted by it.
 */
/**
 * The last moment of market data that influenced `DEFAULT_PARAMS`.
 *
 * Any backtest window overlapping this is in-sample: the parameters were
 * chosen partly because of what happened in it, so a good score there is
 * partly a measurement of the search, not of the strategy. The dashboard
 * reads this to say which part of a window it is allowed to take seriously —
 * without it, the natural thing to show is "the last 30 days", which for
 * freshly fitted parameters is the one window guaranteed to flatter them.
 *
 * Set to the end of the validation slice rather than of the training slice.
 * The four out-of-sample windows were unseen during the search itself, but
 * they still chose this candidate out of forty, so they are not untouched
 * either and a backtest over them would flatter these parameters.
 */
export const DEFAULT_PARAMS_FITTED_THROUGH = Date.UTC(2026, 9, 11);

export const DEFAULT_PARAMS: StrategyParams = {
  weights: {
    emaTrend: 0.810899,
    macd: 2.03637,
    rsi: 0.372427,
    adx: 0.453101,
    bollinger: 0.449826,
    volume: 0.662844,
    structure: 2.08622,
    elliott: 0.918342,
    gann: 1.18951,
  },
  indicators: {
    emaFast: 39,
    emaSlow: 170,
    rsiPeriod: 22,
    rsiOverbought: 70,
    rsiOversold: 30,
    atrPeriod: 24,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbMultiplier: 2,
    adxThreshold: 16.9062,
    zigzagAtrMultiple: 3.843,
  },
  timeframeWeights: {
    "1m": 0.2,
    "3m": 0.3,
    "5m": 0.607774,
    "15m": 0.589945,
    "30m": 0.85,
    "1h": 1.51795,
    "2h": 1.1,
    "4h": 1.10784,
    "6h": 1.3,
    "12h": 1.4,
    "1d": 0.756526,
    "3d": 1.3,
    "1w": 1.2,
  },
  entry: {
    minScore: 0.537952,
    minConfidence: 0.307368,
    minAlignment: 0.701781,
    minQuoteVolume24h: 50000000,
    requireElliottAgreement: false,
    requireGannAgreement: true,
    avoidGannTimeCycle: false,
    allowShorts: true,
  },
  exit: {
    atrStopMultiple: 4.00087,
    takeProfitRMultiples: [2.4],
    takeProfitFractions: [1],
    trailStartR: 0.796014,
    trailAtrMultiple: 3.91327,
    breakEvenR: 1.15497,
    maxHoldBars: 54,
    exitOnScoreFlip: 0.185211,
    useStructuralTargets: true,
  },
  risk: {
    riskPerTrade: 0.01,
    maxOpenPositions: 5,
    maxPositionFraction: 0.25,
    volatilityTargetAtrPct: 0.03,
  },
  scalp: {
    enabled: true,
    minConfidence: 0.75,
    targetPct: 0.05,
    maxHoldBars: 24,
    atrStopMultiple: 1.2,
    // Half at the target, half left on the swing ladder — see the table above.
    closeFraction: 0.5,
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
