import type {
  Candle,
  ElliottAnalysis,
  ElliottWave,
  ElliottWaveLabel,
  Pivot,
  Timeframe,
} from "../types.js";
import { findPivots } from "../indicators/pivots.js";
import { clamp, clamp1 } from "../util/math.js";
import {
  EXTENSIONS,
  RETRACEMENTS,
  fibAffinity,
  nearestFib,
  project,
  retrace,
} from "./fibonacci.js";

/**
 * Elliott Wave analysis.
 *
 * The count is built from confirmed ZigZag pivots and then graded against
 * Elliott's three hard rules plus the common guidelines. Nothing here claims to
 * find *the* correct count — real counts are ambiguous — so the output carries
 * an explicit confidence that the strategy layer weights by, and an
 * invalidation price that makes the count falsifiable.
 *
 * Hard rules (violating any of these rejects the count outright):
 *   1. Wave 2 never retraces more than 100% of wave 1.
 *   2. Wave 3 is never the shortest of waves 1, 3 and 5.
 *   3. Wave 4 never enters wave 1's price territory.
 */

export interface ElliottOptions {
  /** ZigZag sensitivity, in ATR multiples. */
  atrMultiple?: number;
  /** Minimum pivots required before attempting a count. */
  minPivots?: number;
}

interface Leg {
  from: Pivot;
  to: Pivot;
  /** Signed price travel. */
  delta: number;
  /** Absolute price travel. */
  size: number;
  bars: number;
}

function toLegs(pivots: Pivot[]): Leg[] {
  const legs: Leg[] = [];
  for (let i = 1; i < pivots.length; i++) {
    const from = pivots[i - 1] as Pivot;
    const to = pivots[i] as Pivot;
    legs.push({
      from,
      to,
      delta: to.price - from.price,
      size: Math.abs(to.price - from.price),
      bars: Math.max(1, to.index - from.index),
    });
  }
  return legs;
}

function wave(label: ElliottWaveLabel, leg: Leg): ElliottWave {
  return {
    label,
    startTime: leg.from.time,
    endTime: leg.to.time,
    startPrice: leg.from.price,
    endPrice: leg.to.price,
  };
}

interface Scored {
  waves: ElliottWave[];
  confidence: number;
  notes: string[];
  bullish: boolean;
}

/**
 * Grade a five-leg impulse. Returns null when a hard rule is broken.
 * `bullish` is true for an upward impulse (1 up, 2 down, 3 up, 4 down, 5 up).
 */
function scoreImpulse(legs: Leg[], bullish: boolean): Scored | null {
  if (legs.length < 5) return null;
  const [w1, w2, w3, w4, w5] = legs as [Leg, Leg, Leg, Leg, Leg];
  const sign = bullish ? 1 : -1;

  // Directions must alternate correctly for an impulse.
  if (
    Math.sign(w1.delta) !== sign ||
    Math.sign(w2.delta) !== -sign ||
    Math.sign(w3.delta) !== sign ||
    Math.sign(w4.delta) !== -sign ||
    Math.sign(w5.delta) !== sign
  ) {
    return null;
  }

  const notes: string[] = [];

  // Rule 1 — wave 2 cannot retrace beyond the origin of wave 1.
  const w2Retrace = w2.size / w1.size;
  if (w2Retrace >= 1) return null;

  // Rule 2 — wave 3 is never the shortest impulse leg.
  if (w3.size < w1.size && w3.size < w5.size) return null;

  // Rule 3 — wave 4 cannot overlap wave 1's territory.
  const w1End = w1.to.price;
  const w4End = w4.to.price;
  if (bullish ? w4End <= w1End : w4End >= w1End) return null;

  // Guidelines contribute to confidence rather than rejecting the count.
  let score = 0.4;

  const w2Fib = fibAffinity(w2Retrace, RETRACEMENTS);
  score += 0.15 * w2Fib;
  notes.push(
    `wave 2 retraced ${(w2Retrace * 100).toFixed(1)}% (nearest fib ${(nearestFib(w2Retrace, RETRACEMENTS) * 100).toFixed(1)}%)`,
  );

  const w3Ratio = w3.size / w1.size;
  const w3Fib = fibAffinity(w3Ratio, EXTENSIONS, 0.25);
  score += 0.15 * w3Fib;
  notes.push(`wave 3 = ${w3Ratio.toFixed(2)}x wave 1`);

  const w4Retrace = w4.size / w3.size;
  score += 0.1 * fibAffinity(w4Retrace, [0.236, 0.382, 0.5], 0.1);
  notes.push(`wave 4 retraced ${(w4Retrace * 100).toFixed(1)}% of wave 3`);

  // Alternation: waves 2 and 4 should differ in depth.
  if (Math.abs(w2Retrace - w4Retrace) > 0.15) {
    score += 0.08;
    notes.push("alternation between waves 2 and 4 holds");
  }

  // Wave 3 extending beyond 1.618x wave 1 is the classic signature.
  if (w3Ratio >= 1.618) {
    score += 0.07;
    notes.push("wave 3 extended beyond 1.618x — textbook impulse");
  }

  // Proportionality in time: wildly mismatched leg durations weaken the count.
  const barSpread =
    Math.max(w1.bars, w3.bars, w5.bars) / Math.max(1, Math.min(w1.bars, w3.bars, w5.bars));
  if (barSpread <= 4) score += 0.05;

  return {
    waves: [
      wave("1", w1),
      wave("2", w2),
      wave("3", w3),
      wave("4", w4),
      wave("5", w5),
    ],
    confidence: clamp(score, 0, 1),
    notes,
    bullish,
  };
}

/** Grade a three-leg A-B-C correction. */
function scoreCorrection(legs: Leg[], downward: boolean): Scored | null {
  if (legs.length < 3) return null;
  const [a, b, c] = legs as [Leg, Leg, Leg];
  const sign = downward ? -1 : 1;

  if (
    Math.sign(a.delta) !== sign ||
    Math.sign(b.delta) !== -sign ||
    Math.sign(c.delta) !== sign
  ) {
    return null;
  }

  const notes: string[] = [];
  let score = 0.3;

  const bRetrace = b.size / a.size;
  // A B wave retracing more than ~138% of A is usually a different structure.
  if (bRetrace > 1.38) return null;
  score += 0.2 * fibAffinity(bRetrace, [0.382, 0.5, 0.618, 0.786], 0.1);
  notes.push(`wave B retraced ${(bRetrace * 100).toFixed(1)}% of wave A`);

  const cRatio = c.size / a.size;
  score += 0.25 * fibAffinity(cRatio, [0.618, 1.0, 1.272, 1.618], 0.2);
  notes.push(`wave C = ${cRatio.toFixed(2)}x wave A`);

  // Zigzag (C ≈ A) and flat (B ≈ A) are the most tradeable shapes.
  if (Math.abs(cRatio - 1) < 0.15) {
    score += 0.1;
    notes.push("C ≈ A — classic zigzag");
  }

  return {
    waves: [wave("A", a), wave("B", b), wave("C", c)],
    confidence: clamp(score, 0, 1),
    notes,
    bullish: !downward,
  };
}

const EMPTY: Omit<ElliottAnalysis, "timeframe"> = {
  pattern: "none",
  currentWave: "unknown",
  bias: "flat",
  confidence: 0,
  waves: [],
  targets: [],
  invalidation: null,
  notes: [],
};

export function analyseElliott(
  candles: Candle[],
  timeframe: Timeframe,
  options: ElliottOptions = {},
): ElliottAnalysis {
  const { atrMultiple = 2, minPivots = 5 } = options;

  // Confirmed pivots only: a provisional pivot would make the count repaint.
  const pivots = findPivots(candles, { atrMultiple, confirmedOnly: true });
  if (pivots.length < minPivots) {
    return { timeframe, ...EMPTY, notes: ["not enough confirmed swings for a count"] };
  }

  const lastCandle = candles.at(-1) as Candle;
  const price = lastCandle.close;

  // Try the most recent complete 5-leg impulse, then the most recent 3-leg
  // correction, preferring whichever scores higher.
  const recent = pivots.slice(-7);
  const legs = toLegs(recent);

  const candidates: { scored: Scored; pattern: "impulse" | "correction" }[] = [];
  for (const window of [legs.slice(-5), legs.slice(-6, -1)]) {
    if (window.length < 5) continue;
    for (const bullish of [true, false]) {
      const scored = scoreImpulse(window, bullish);
      if (scored) candidates.push({ scored, pattern: "impulse" });
    }
  }
  for (const window of [legs.slice(-3), legs.slice(-4, -1)]) {
    if (window.length < 3) continue;
    for (const downward of [true, false]) {
      const scored = scoreCorrection(window, downward);
      if (scored) candidates.push({ scored, pattern: "correction" });
    }
  }

  if (candidates.length === 0) {
    return {
      timeframe,
      ...EMPTY,
      notes: ["no rule-valid Elliott count on the recent swing sequence"],
    };
  }

  candidates.sort((a, b) => b.scored.confidence - a.scored.confidence);
  const best = candidates[0] as { scored: Scored; pattern: "impulse" | "correction" };
  const { scored, pattern } = best;
  const waves = scored.waves;
  const lastWave = waves.at(-1) as ElliottWave;

  // Stale counts are worth less: decay confidence as price travels past the
  // last labelled wave without confirming the next one.
  const barsSinceCount =
    candles.length - 1 - (pivots.at(-1)?.index ?? candles.length - 1);
  const staleness = clamp(barsSinceCount / 40, 0, 1);
  const confidence = clamp(scored.confidence * (1 - 0.5 * staleness), 0, 1);

  const { currentWave, bias, targets, invalidation, notes } = projectNext(
    pattern,
    scored,
    waves,
    price,
  );

  return {
    timeframe,
    pattern,
    currentWave,
    bias,
    confidence,
    waves,
    targets,
    invalidation,
    notes: [...scored.notes, ...notes],
  };
}

/**
 * Given a completed count, work out what should happen next: which wave is in
 * progress, the directional bias, Fibonacci targets and the invalidation price.
 */
function projectNext(
  pattern: "impulse" | "correction",
  scored: Scored,
  waves: ElliottWave[],
  price: number,
): {
  currentWave: ElliottWaveLabel;
  bias: ElliottAnalysis["bias"];
  targets: number[];
  invalidation: number | null;
  notes: string[];
} {
  const notes: string[] = [];
  const bullish = scored.bullish;

  if (pattern === "impulse") {
    const w1 = waves[0] as ElliottWave;
    const w4 = waves[3] as ElliottWave;
    const w5 = waves[4] as ElliottWave;
    // A finished 5-wave impulse implies an A-B-C correction against it.
    const impulseStart = w1.startPrice;
    const impulseEnd = w5.endPrice;
    const targets = [0.382, 0.5, 0.618].map((r) =>
      retrace(impulseStart, impulseEnd, r),
    );
    notes.push(
      `5-wave ${bullish ? "up" : "down"} impulse complete — expecting an A-B-C correction toward ${targets.map((t) => t.toFixed(4)).join(" / ")}`,
    );
    return {
      currentWave: "A",
      // Correction runs against the impulse.
      bias: bullish ? "short" : "long",
      targets,
      // A move beyond wave 5's extreme says the impulse is still extending.
      invalidation: impulseEnd,
      notes,
    };
  }

  // Completed A-B-C: the prior trend is expected to resume.
  const a = waves[0] as ElliottWave;
  const c = waves[2] as ElliottWave;
  const correctionDown = c.endPrice < a.startPrice;
  const span = Math.abs(a.startPrice - c.endPrice);
  const direction = correctionDown ? 1 : -1;
  const targets = [0.618, 1.0, 1.618].map(
    (r) => c.endPrice + direction * span * r,
  );
  notes.push(
    `A-B-C ${correctionDown ? "down" : "up"} correction complete — trend resumption targets ${targets.map((t) => t.toFixed(4)).join(" / ")}`,
  );
  void price;
  return {
    currentWave: "1",
    bias: correctionDown ? "long" : "short",
    targets,
    invalidation: c.endPrice,
    notes,
  };
}

/**
 * Convert an Elliott analysis to a bounded directional score.
 * Counts with an invalidated structure score zero rather than flipping.
 */
export function elliottScore(analysis: ElliottAnalysis, price: number): number {
  if (analysis.pattern === "none" || analysis.bias === "flat") return 0;
  if (analysis.invalidation !== null) {
    const invalidated =
      analysis.bias === "long"
        ? price < analysis.invalidation
        : price > analysis.invalidation;
    if (invalidated) return 0;
  }
  const direction = analysis.bias === "long" ? 1 : -1;
  return clamp1(direction * analysis.confidence);
}

/** Projected targets expressed as a distance in price, for take-profit sizing. */
export function elliottTargets(analysis: ElliottAnalysis, price: number): number[] {
  return analysis.targets
    .filter((t) => Number.isFinite(t) && t > 0)
    .filter((t) =>
      analysis.bias === "long" ? t > price : analysis.bias === "short" ? t < price : true,
    );
}

/** Exposed for the Gann module and tests. */
export const __internal = { toLegs, scoreImpulse, scoreCorrection, project };
