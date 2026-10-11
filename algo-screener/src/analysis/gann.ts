import type {
  Candle,
  GannAnalysis,
  GannAngleLevel,
  Pivot,
  Timeframe,
} from "../types.js";
import { findPivots } from "../indicators/pivots.js";
import { atr, last } from "../indicators/index.js";
import { clamp, clamp1, pctDiff } from "../util/math.js";

/**
 * W. D. Gann analysis: angles/fan, Square of Nine levels and time cycles.
 *
 * Gann's original work assumes a fixed price-per-unit-of-time scale read off
 * paper charts, which does not transfer to crypto where price ranges over
 * orders of magnitude. The standard fix, used here, is to derive the scale from
 * recent volatility: one "unit" of price per bar is set to the ATR at the
 * anchor pivot. The 1x1 line then advances one ATR per bar, and the rest of the
 * fan follows Gann's ratios. This keeps the geometry meaningful on any symbol
 * and any timeframe.
 */

/** Gann's fan ratios, expressed as price-units per time-unit. */
export const GANN_RATIOS: { ratio: string; slope: number }[] = [
  { ratio: "8x1", slope: 8 },
  { ratio: "4x1", slope: 4 },
  { ratio: "3x1", slope: 3 },
  { ratio: "2x1", slope: 2 },
  { ratio: "1x1", slope: 1 },
  { ratio: "1x2", slope: 1 / 2 },
  { ratio: "1x3", slope: 1 / 3 },
  { ratio: "1x4", slope: 1 / 4 },
  { ratio: "1x8", slope: 1 / 8 },
];

/**
 * Gann's significant time counts (in bars). Anniversary/square-of-time dates
 * are the bar counts at which reversals cluster in his method.
 */
export const GANN_TIME_CYCLES = [
  7, 9, 13, 21, 30, 45, 49, 52, 60, 72, 90, 120, 144, 180, 270, 360,
];

export interface GannOptions {
  atrMultiple?: number;
  atrPeriod?: number;
}

/**
 * Square of Nine.
 *
 * Numbers spiral outward from a centre; prices sitting on the same spoke
 * (i.e. separated by a whole or half turn) are taken to be harmonically
 * related. A 360° turn from price P lands at (sqrt(P) + 2)², a 180° turn at
 * (sqrt(P) + 1)², and so on for the 45° increments Gann emphasised.
 */
export function squareOfNineLevels(
  price: number,
  turns = 2,
  degreeStep = 45,
): { support: number[]; resistance: number[] } {
  if (price <= 0) return { support: [], resistance: [] };
  const root = Math.sqrt(price);
  const support: number[] = [];
  const resistance: number[] = [];

  const steps = Math.round((360 / degreeStep) * turns);
  for (let i = 1; i <= steps; i++) {
    // One full 360° turn adds 2 to the square root.
    const delta = (i * degreeStep * 2) / 360;
    const up = (root + delta) ** 2;
    const downRoot = root - delta;
    if (downRoot > 0) support.push(downRoot ** 2);
    resistance.push(up);
  }
  return {
    support: support.sort((a, b) => b - a),
    resistance: resistance.sort((a, b) => a - b),
  };
}

/** Build the Gann fan projected to `atBar` from an anchor pivot. */
export function gannFan(
  anchor: Pivot,
  atBar: number,
  unitPerBar: number,
  currentPrice: number,
): GannAngleLevel[] {
  const bars = Math.max(0, atBar - anchor.index);
  // Lines rise from a swing low and fall from a swing high.
  const direction = anchor.type === "low" ? 1 : -1;
  return GANN_RATIOS.map(({ ratio, slope }) => {
    const price = anchor.price + direction * slope * unitPerBar * bars;
    return {
      ratio,
      price,
      distancePct: price > 0 ? pctDiff(currentPrice, price) : 0,
    };
  });
}

export function analyseGann(
  candles: Candle[],
  timeframe: Timeframe,
  options: GannOptions = {},
): GannAnalysis {
  const { atrMultiple = 2, atrPeriod = 14 } = options;
  const empty: GannAnalysis = {
    timeframe,
    anchor: null,
    unitPerBar: 0,
    angles: [],
    squareOfNine: { support: [], resistance: [] },
    timeCycle: { barsSinceAnchor: 0, nearestCycle: 0, distance: 0 },
    bias: "flat",
    confidence: 0,
    notes: [],
  };

  if (candles.length < atrPeriod + 10) {
    return { ...empty, notes: ["not enough history for a Gann fan"] };
  }

  const lastCandle = candles.at(-1) as Candle;
  const price = lastCandle.close;
  const atrValues = atr(candles, atrPeriod);

  const pivots = findPivots(candles, { atrMultiple, confirmedOnly: true });
  const anchor = pivots.at(-1);
  if (!anchor) {
    return { ...empty, notes: ["no confirmed pivot to anchor the fan"] };
  }

  // Scale: one price unit per bar = ATR at the anchor. Falls back to the latest
  // ATR when the anchor is inside the indicator warm-up region.
  const anchorAtr = atrValues[anchor.index] as number;
  const unitPerBar = Number.isFinite(anchorAtr)
    ? anchorAtr
    : last(atrValues, price * 0.01);
  if (!(unitPerBar > 0)) {
    return { ...empty, anchor, notes: ["volatility scale unavailable"] };
  }

  const atBar = candles.length - 1;
  const angles = gannFan(anchor, atBar, unitPerBar, price);
  const squareOfNine = squareOfNineLevels(price);

  const barsSinceAnchor = atBar - anchor.index;
  const nearestCycle = GANN_TIME_CYCLES.reduce((best, cycle) =>
    Math.abs(cycle - barsSinceAnchor) < Math.abs(best - barsSinceAnchor) ? cycle : best,
  );
  const cycleDistance = Math.abs(nearestCycle - barsSinceAnchor);

  const notes: string[] = [];
  let score = 0;
  let confidence = 0;

  // --- Angle bias -------------------------------------------------------
  // Position relative to the 1x1 is Gann's primary trend read: above it from a
  // low is strength, below it is weakness (and mirrored from a high).
  const oneByOne = angles.find((a) => a.ratio === "1x1");
  if (oneByOne) {
    const aboveLine = price > oneByOne.price;
    if (anchor.type === "low") {
      score += aboveLine ? 0.6 : -0.5;
      notes.push(
        aboveLine
          ? "price holds above the 1x1 rising from the anchor low — trend intact"
          : "price has broken below the 1x1 from the anchor low — trend weakening",
      );
    } else {
      score += aboveLine ? 0.5 : -0.6;
      notes.push(
        aboveLine
          ? "price has reclaimed the 1x1 falling from the anchor high — downtrend failing"
          : "price stays below the 1x1 from the anchor high — downtrend intact",
      );
    }
    confidence += 0.35;
  }

  // --- Angle proximity --------------------------------------------------
  // Price sitting on an angle is where Gann expects support/resistance to act.
  const nearest = angles
    .filter((a) => a.price > 0)
    .reduce<GannAngleLevel | null>(
      (best, a) =>
        best === null || Math.abs(a.distancePct) < Math.abs(best.distancePct) ? a : best,
      null,
    );
  if (nearest && Math.abs(nearest.distancePct) < 0.01) {
    notes.push(
      `price is within ${(Math.abs(nearest.distancePct) * 100).toFixed(2)}% of the ${nearest.ratio} angle — decision point`,
    );
    confidence += 0.2;
    // Reacting off an angle reinforces whatever side price is on.
    score += Math.sign(nearest.distancePct) * 0.2;
  }

  // --- Square of Nine ---------------------------------------------------
  const sqNearestResistance = squareOfNine.resistance[0];
  const sqNearestSupport = squareOfNine.support[0];
  if (sqNearestResistance !== undefined && sqNearestSupport !== undefined) {
    const toResistance = (sqNearestResistance - price) / price;
    const toSupport = (price - sqNearestSupport) / price;
    // Room to the next harmonic level favours continuation in that direction.
    if (toResistance > toSupport * 1.5) {
      score += 0.2;
      notes.push(
        `square-of-nine room to the upside (next resistance ${sqNearestResistance.toFixed(4)})`,
      );
    } else if (toSupport > toResistance * 1.5) {
      score -= 0.2;
      notes.push(
        `square-of-nine room to the downside (next support ${sqNearestSupport.toFixed(4)})`,
      );
    }
    confidence += 0.15;
  }

  // --- Time cycle -------------------------------------------------------
  // Near a Gann time count, reversals are more likely, so trend-following
  // conviction is reduced rather than reversed.
  const nearCycle = cycleDistance <= Math.max(1, Math.round(nearestCycle * 0.05));
  if (nearCycle) {
    notes.push(
      `bar ${barsSinceAnchor} from the anchor is on the ${nearestCycle}-bar Gann time cycle — reversal window`,
    );
    score *= 0.6;
    confidence += 0.2;
  } else {
    confidence += 0.1;
  }

  const bias = score > 0.15 ? "long" : score < -0.15 ? "short" : "flat";

  return {
    timeframe,
    anchor,
    unitPerBar,
    angles,
    squareOfNine,
    timeCycle: { barsSinceAnchor, nearestCycle, distance: cycleDistance },
    bias,
    confidence: clamp(confidence, 0, 1),
    notes,
  };
}

/** Bounded directional score from a Gann analysis. */
export function gannScore(analysis: GannAnalysis): number {
  if (analysis.bias === "flat") return 0;
  const direction = analysis.bias === "long" ? 1 : -1;
  return clamp1(direction * analysis.confidence);
}

/**
 * Gann angle and Square-of-Nine prices bracketing the current price — fed to
 * the strategy as structural stop/target candidates.
 */
export function gannLevels(
  analysis: GannAnalysis,
  price: number,
): { price: number; kind: "support" | "resistance"; source: string }[] {
  const out: { price: number; kind: "support" | "resistance"; source: string }[] = [];
  for (const angle of analysis.angles) {
    if (angle.price <= 0) continue;
    out.push({
      price: angle.price,
      kind: angle.price < price ? "support" : "resistance",
      source: `gann ${angle.ratio}`,
    });
  }
  for (const s of analysis.squareOfNine.support.slice(0, 2)) {
    out.push({ price: s, kind: "support", source: "square-of-nine" });
  }
  for (const r of analysis.squareOfNine.resistance.slice(0, 2)) {
    out.push({ price: r, kind: "resistance", source: "square-of-nine" });
  }
  return out;
}
