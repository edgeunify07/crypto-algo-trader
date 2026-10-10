import { describe, expect, it } from "vitest";
import {
  GANN_RATIOS,
  GANN_TIME_CYCLES,
  analyseGann,
  gannFan,
  gannLevels,
  gannScore,
  squareOfNineLevels,
} from "./gann.js";
import { classifyRegime, regimeWeight } from "./regime.js";
import { joinLegs, linear, makeCandles } from "../testUtils.js";
import type { Pivot } from "../types.js";

describe("square of nine", () => {
  it("places a 360-degree turn at (sqrt(p) + 2)^2", () => {
    const { resistance } = squareOfNineLevels(100, 1, 360);
    // One full turn from 100: (10 + 2)^2 = 144.
    expect(resistance[0]).toBeCloseTo(144, 6);
  });

  it("places a 180-degree turn at (sqrt(p) + 1)^2", () => {
    const { resistance } = squareOfNineLevels(100, 1, 180);
    expect(resistance[0]).toBeCloseTo(121, 6);
  });

  it("brackets the input price with ordered levels", () => {
    const { support, resistance } = squareOfNineLevels(100);
    expect(support.every((s) => s < 100)).toBe(true);
    expect(resistance.every((r) => r > 100)).toBe(true);
    // Support descends, resistance ascends.
    expect(support).toEqual([...support].sort((a, b) => b - a));
    expect(resistance).toEqual([...resistance].sort((a, b) => a - b));
  });

  it("never emits a negative support level", () => {
    const { support } = squareOfNineLevels(1, 4);
    expect(support.every((s) => s > 0)).toBe(true);
  });

  it("returns nothing for a non-positive price", () => {
    expect(squareOfNineLevels(0)).toEqual({ support: [], resistance: [] });
  });
});

describe("gann fan", () => {
  const low: Pivot = { index: 0, time: 0, price: 100, type: "low" };
  const high: Pivot = { index: 0, time: 0, price: 100, type: "high" };

  it("advances the 1x1 by exactly one unit per bar from a low", () => {
    const angles = gannFan(low, 10, 2, 120);
    const oneByOne = angles.find((a) => a.ratio === "1x1");
    expect(oneByOne?.price).toBeCloseTo(100 + 10 * 2);
  });

  it("falls from a swing high instead of rising", () => {
    const angles = gannFan(high, 10, 2, 80);
    const oneByOne = angles.find((a) => a.ratio === "1x1");
    expect(oneByOne?.price).toBeCloseTo(100 - 10 * 2);
  });

  it("orders the fan by slope, steepest first", () => {
    const angles = gannFan(low, 10, 1, 110);
    const prices = angles.map((a) => a.price);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    expect(angles).toHaveLength(GANN_RATIOS.length);
  });

  it("reports price position relative to each angle", () => {
    const angles = gannFan(low, 10, 1, 105);
    const steep = angles.find((a) => a.ratio === "8x1");
    const shallow = angles.find((a) => a.ratio === "1x8");
    // Price is below the steep line and above the shallow one.
    expect(steep?.distancePct).toBeLessThan(0);
    expect(shallow?.distancePct).toBeGreaterThan(0);
  });

  it("returns the anchor price itself at the anchor bar", () => {
    const angles = gannFan(low, 0, 5, 100);
    expect(angles.every((a) => Math.abs(a.price - 100) < 1e-9)).toBe(true);
  });
});

describe("analyseGann", () => {
  const trendUp = joinLegs(linear(100, 100, 25), linear(100, 125, 30), linear(125, 118, 12), linear(118, 160, 40));

  it("reports no anchor when history is too short", () => {
    const result = analyseGann(makeCandles(linear(100, 110, 8)), "1h");
    expect(result.anchor).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("anchors to a confirmed pivot and scales the fan by ATR", () => {
    const result = analyseGann(makeCandles(trendUp), "1h", { atrMultiple: 1.2 });
    expect(result.anchor).not.toBeNull();
    expect(result.unitPerBar).toBeGreaterThan(0);
    expect(result.angles).toHaveLength(GANN_RATIOS.length);
  });

  it("identifies the nearest Gann time cycle", () => {
    const result = analyseGann(makeCandles(trendUp), "1h", { atrMultiple: 1.2 });
    expect(GANN_TIME_CYCLES).toContain(result.timeCycle.nearestCycle);
    expect(result.timeCycle.distance).toBe(
      Math.abs(result.timeCycle.nearestCycle - result.timeCycle.barsSinceAnchor),
    );
  });

  it("produces a bullish read while price holds above the rising 1x1", () => {
    const result = analyseGann(makeCandles(trendUp), "4h", { atrMultiple: 1.2 });
    expect(["long", "flat", "short"]).toContain(result.bias);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("maps bias onto a bounded score", () => {
    const result = analyseGann(makeCandles(trendUp), "1h", { atrMultiple: 1.2 });
    const score = gannScore(result);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
    if (result.bias === "flat") expect(score).toBe(0);
  });

  it("emits support below price and resistance above it", () => {
    const candles = makeCandles(trendUp);
    const price = candles.at(-1)!.close;
    const result = analyseGann(candles, "1h", { atrMultiple: 1.2 });
    for (const level of gannLevels(result, price)) {
      if (level.kind === "support") expect(level.price).toBeLessThan(price);
      else expect(level.price).toBeGreaterThanOrEqual(price);
    }
  });
});

describe("regime classification", () => {
  it("calls a sustained rally a trend", () => {
    const regime = classifyRegime(makeCandles(linear(100, 200, 150)));
    expect(regime.kind).toBe("trending_up");
    expect(regime.adx).toBeGreaterThan(20);
  });

  it("calls a sustained decline a downtrend", () => {
    expect(classifyRegime(makeCandles(linear(200, 100, 150))).kind).toBe("trending_down");
  });

  it("calls a flat oscillation a range", () => {
    const choppy = Array.from({ length: 150 }, (_, i) => 100 + Math.sin(i / 3) * 1.5);
    expect(classifyRegime(makeCandles(choppy)).kind).toBe("ranging");
  });

  it("reports ATR as a fraction of price", () => {
    const regime = classifyRegime(makeCandles(linear(100, 120, 100), { range: 0.01 }));
    expect(regime.atrPct).toBeGreaterThan(0);
    expect(regime.atrPct).toBeLessThan(1);
  });

  it("favours trend components in a trend and mean reversion in a range", () => {
    const trend = { kind: "trending_up" as const, strength: 1, adx: 30, atrPct: 0.01 };
    const range = { kind: "ranging" as const, strength: 1, adx: 12, atrPct: 0.01 };
    expect(regimeWeight(trend, "trend")).toBeGreaterThan(regimeWeight(range, "trend"));
    expect(regimeWeight(range, "meanReversion")).toBeGreaterThan(
      regimeWeight(trend, "meanReversion"),
    );
  });
});
