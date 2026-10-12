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
    /**
     * Which timeframes the swing blend reads.
     *
     * Explicit so the two engines can genuinely differ: the scalp has its own
     * list below, and without this they would both read everything and be the
     * same signal wearing different exits.
     */
    timeframes: z.array(z.string()).min(1).max(8).default(["5m", "15m", "1h", "4h", "1d"]),
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
   * The scalp engine: its own timeframes, its own gates, its own slots.
   *
   * Shipped disabled, because on this data it does not work.
   *
   * It began as a rule on the swing signal — same blend, same thresholds,
   * just a shorter leash — which meant it could only fire on setups the
   * swing engine had already found and would have taken anyway. Every scalp
   * it took won, and every one of them left the account poorer, because it
   * closed at a fixed 5% a position the swing exits would have carried
   * further and paid a second taker fee to do it.
   *
   * So it was rebuilt as a genuine second engine, reading 15m/1h while the
   * swing engine reads 1h/4h/1d, with its own entry bar, its own position
   * slots and its own share of the balance. Then 36 configurations of it
   * were measured running alone, on the training window — the window they
   * were searched over, where overfitting should flatter them:
   *
   *     minScore   stop    target   trades   won    return    PF
   *       0.65     1.2 ATR   5%        23      8    -6.82%   0.31
   *       0.65     2.5 ATR   5%        20      6   -11.51%   0.13
   *       0.35     1.2 ATR   2%       205     84   -29.25%   0.55
   *       0.50     1.2 ATR   2%       225     93   -30.69%   0.52
   *
   * All 36 lost. Every profit factor was below 1. This is not a tuning
   * problem with a better corner somewhere; the region is negative.
   *
   * The likely reason is that 15m is not a scalp. Real scalping lives on 1m
   * and 5m bars, and the backtest holds 15m at its finest — so what was
   * measured here is a fast swing trade, which is the worst of both: too
   * slow to catch a scalp's edge, too quick to let a swing's run develop.
   * Judging a true scalp needs finer data than any of this was built on.
   *
   * Everything it needs is here and tested. `enabled: true` turns it on, and
   * the engine will trade it. The table above is why it is off.
   */  scalp: z
    .object({
      enabled: z.boolean(),
      /**
       * The scalp's own timeframes, blended separately from the swing's.
       *
       * This is what makes it a second engine rather than a second exit. It
       * was the swing signal with a shorter leash: same blend, same
       * thresholds, so it could only ever fire on setups the swing engine
       * had already found and would have taken anyway — which is why every
       * scalp it took cost more than it made.
       */
      timeframes: z.array(z.string()).min(1).max(6),
      /** Its own entry bar, read off its own blend. */
      minScore: z.number().min(0.05).max(0.95),
      minConfidence: z.number().min(0.2).max(0.99),
      minAlignment: z.number().min(0).max(1),
      /** Position slots of its own, so it cannot crowd out the swing book. */
      maxOpen: z.number().int().min(0).max(10),
      /**
       * Share of equity the scalp book may commit as margin, in total.
       *
       * Separate slots are not enough, because the two engines spend the
       * same balance. Measured: a scalp holding its two slots continuously
       * left so little free margin that the swing engine went from 79 trades
       * to 3 — it was not outvoted, it was priced out. This reserves the
       * rest of the account for it.
       */
      capitalShare: z.number().min(0.05).max(0.9),
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
      enabled: false,
      timeframes: ["15m", "1h"],
      minScore: 0.35,
      minConfidence: 0.45,
      minAlignment: 0.6,
      maxOpen: 2,
      capitalShare: 0.25,
      targetPct: 0.05,
      maxHoldBars: 24,
      atrStopMultiple: 1.2,
      closeFraction: 0.5,
    }),

  /**
   * How pessimistic to be about getting filled.
   *
   * Every fill here was at the mark price, which no real order ever gets.
   * Measured against the live futures book on the symbols this trades, a $75
   * market order costs a median of 0.46 bps from mid and 2.21 bps at worst —
   * small, because the size is small relative to these books, but not zero
   * and always against you.
   *
   * `stopSlippageBps` is larger for a reason that is not about size: a stop
   * triggers precisely when the market is moving fast against the position,
   * so it is the one order consistently filled into a thinning book. Pricing
   * it the same as a calm entry is the single most flattering assumption a
   * backtest can make.
   *
   * Resting take-profit limits take no slippage — they are filled at their
   * price or not at all — but they are still charged the taker fee, which is
   * conservative by about 3 bps a side.
   */
  execution: z
    .object({
      /** Basis points of adverse slippage on a market fill. */
      slippageBps: z.number().min(0).max(100),
      /** Basis points on a stop fill, which trades into a fast move. */
      stopSlippageBps: z.number().min(0).max(300),
    })
    .default({ slippageBps: 2, stopSlippageBps: 15 }),

  risk: z.object({
    /**
     * The most a single stop-out may cost, as a fraction of equity.
     *
     * This is the cap, not the target. `capitalPerTrade` says how much of
     * the account a position is meant to use; this says how much of it may
     * be lost if the stop is hit, and the smaller of the two always wins. A
     * fixed allocation without this would size a wide-stopped trade exactly
     * as large as a tight-stopped one and lose several times as much on it.
     */
    riskPerTrade: z.number().min(0.001).max(0.05),
    /**
     * Target share of equity to commit as margin on each position.
     *
     * With leverage this buys a notional several times larger, so it is the
     * ambition and `riskPerTrade` is the brake.
     */
    capitalPerTrade: z.number().min(0.01).max(1).default(0.2),
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
 * Those figures came from a search where fills were free. Once the engine
 * started charging the spread and pricing gapped stops honestly, the same
 * parameters measure at +10.88% on one continuous account over the same 83
 * days — median window 21.56%, still 4 of 4 profitable, worst drawdown
 * 16.9%. That is the number to hold in mind; the rest of this comment is
 * how it was arrived at.
 *
 * A second search was then run with those costs charged from the start, in
 * case parameters chosen under free fills were tuned for the wrong
 * objective. They were not. Charging execution dropped the share of random
 * trials that survive training from 53% to 19%, and the best of the 30
 * finalists lost to what is already here on every axis:
 *
 *                  median   windows   worst DD   trades    OOS1
 *   these           21.56%      4/4      16.9%       87   +40.2%
 *   re-tune         17.76%      3/4      33.2%      140   -29.2%
 *
 * It traded 60% more and bought one catastrophic window for it. Nothing was
 * promoted. A search that cannot beat the incumbent under honest costs is
 * the best evidence available that the incumbent is not simply an artefact
 * of the old fill model.
 *
 * What this is still not: 16 candidates cleared the bar originally and this
 * is the best of them, chosen on the same windows it is reported against, so
 * expect less live than the table shows. Four months is one market regime.
 * The improvement loop exists to beat this, not to be trusted by it.
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
    // The slow end of the board. The scalp engine owns the fast end, and
    // overlapping them would make one a noisier copy of the other.
    timeframes: ["1h", "4h", "1d"],
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
  execution: {
    // Measured on the live book: 0.46 bps median, 2.21 worst, for $75.
    slippageBps: 2,
    // Stops fill into the move that triggered them; deliberately pessimistic.
    stopSlippageBps: 15,
  },
  risk: {
    riskPerTrade: 0.01,
    // 20% of equity as margin per trade, capped by riskPerTrade above.
    capitalPerTrade: 0.2,
    maxOpenPositions: 5,
    maxPositionFraction: 0.25,
    volatilityTargetAtrPct: 0.03,
  },
  scalp: {
    // Off: all 36 measured configurations lost money. See the note above.
    enabled: false,
    // Fast relative to the swing engine's 1h/4h/1d, and blended on its own.
    timeframes: ["15m", "1h"],
    minScore: 0.35,
    minConfidence: 0.45,
    minAlignment: 0.6,
    maxOpen: 2,
    // A quarter of the account at most, so the swing book keeps the rest.
    capitalShare: 0.25,
    targetPct: 0.05,
    maxHoldBars: 24,
    atrStopMultiple: 1.2,
    // Half at the target, half left on the swing ladder.
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
