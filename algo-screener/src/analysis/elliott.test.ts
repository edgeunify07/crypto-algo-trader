import { describe, expect, it } from "vitest";
import { analyseElliott, elliottScore, elliottTargets, __internal } from "./elliott.js";
import { fibAffinity, nearestFib, project, retrace, retracementRatio } from "./fibonacci.js";
import { impulseCloses, joinLegs, linear, makeCandles } from "../testUtils.js";
import type { Pivot } from "../types.js";

/** Build the leg list the scorers expect from a price path. */
function legsFromPrices(prices: number[]): ReturnType<typeof __internal.toLegs> {
  const pivots: Pivot[] = prices.map((price, i) => ({
    index: i * 10,
    time: i * 10_000,
    price,
    type: i % 2 === 0 ? "low" : "high",
  }));
  return __internal.toLegs(pivots);
}

describe("fibonacci helpers", () => {
  it("retraces and projects consistently", () => {
    expect(retrace(100, 200, 0.5)).toBeCloseTo(150);
    expect(retrace(100, 200, 0)).toBeCloseTo(200);
    expect(project(100, 200, 150, 1.618)).toBeCloseTo(311.8);
  });

  it("measures how far through a move a price sits", () => {
    expect(retracementRatio(100, 200, 150)).toBeCloseTo(0.5);
    expect(retracementRatio(100, 200, 200)).toBeCloseTo(0);
  });

  it("scores affinity highest at the canonical ratios", () => {
    expect(fibAffinity(0.618)).toBeCloseTo(1);
    expect(fibAffinity(0.95)).toBe(0);
    expect(nearestFib(0.6)).toBeCloseTo(0.618);
  });
});

describe("elliott hard rules", () => {
  // Legs: start -> w1 -> w2 -> w3 -> w4 -> w5
  it("accepts a textbook bullish impulse", () => {
    const scored = __internal.scoreImpulse(
      legsFromPrices([100, 130, 118, 170, 152, 185]),
      true,
    );
    expect(scored).not.toBeNull();
    expect(scored?.waves.map((w) => w.label)).toEqual(["1", "2", "3", "4", "5"]);
    expect(scored?.confidence).toBeGreaterThan(0.4);
  });

  it("rejects a count where wave 2 retraces more than 100% of wave 1", () => {
    // Wave 2 ends at 99, below wave 1's origin of 100.
    expect(
      __internal.scoreImpulse(legsFromPrices([100, 130, 99, 170, 152, 185]), true),
    ).toBeNull();
  });

  it("rejects a count where wave 3 is the shortest impulse leg", () => {
    // w1 = 30, w3 = 10, w5 = 25 — wave 3 is shortest, which Elliott forbids.
    const scored = __internal.scoreImpulse(
      legsFromPrices([100, 130, 120, 130, 125, 150]),
      true,
    );
    expect(scored).toBeNull();
  });

  it("rejects a count where wave 4 overlaps wave 1's territory", () => {
    // Wave 4 ends at 125, below wave 1's top of 130.
    expect(
      __internal.scoreImpulse(legsFromPrices([100, 130, 118, 170, 125, 185]), true),
    ).toBeNull();
  });

  it("rejects legs whose directions do not alternate as an impulse", () => {
    expect(
      __internal.scoreImpulse(legsFromPrices([100, 130, 140, 170, 180, 200]), true),
    ).toBeNull();
  });

  it("scores a wave 3 extended to 1.618x more highly than a short one", () => {
    // Both counts hold wave 2 and wave 4 at a 0.382 retracement and give wave 5
    // the same size, so wave 3's extension is the only thing that differs.
    const modest = __internal.scoreImpulse(
      legsFromPrices([100, 130, 118.54, 151.54, 138.93, 168.93]),
      true,
    );
    const extended = __internal.scoreImpulse(
      legsFromPrices([100, 130, 118.54, 167.08, 148.54, 178.54]),
      true,
    );
    expect(modest).not.toBeNull();
    expect(extended).not.toBeNull();
    expect(extended?.confidence).toBeGreaterThan(modest?.confidence ?? 1);
    expect(extended?.notes.join(" ")).toContain("1.618");
  });
});

describe("elliott corrections", () => {
  it("accepts an A-B-C zigzag down", () => {
    const scored = __internal.scoreCorrection(legsFromPrices([200, 160, 180, 140]), true);
    expect(scored).not.toBeNull();
    expect(scored?.waves.map((w) => w.label)).toEqual(["A", "B", "C"]);
  });

  it("rejects a B wave that retraces more than 138% of A", () => {
    expect(
      __internal.scoreCorrection(legsFromPrices([200, 160, 220, 140]), true),
    ).toBeNull();
  });
});

describe("analyseElliott", () => {
  it("returns no pattern when there are too few swings", () => {
    const result = analyseElliott(makeCandles(linear(100, 110, 60)), "1h");
    expect(result.pattern).toBe("none");
    expect(result.confidence).toBe(0);
    expect(result.bias).toBe("flat");
  });

  it("labels a constructed five-wave impulse and expects a correction after it", () => {
    const result = analyseElliott(makeCandles(impulseCloses()), "1h", {
      atrMultiple: 1.2,
    });
    expect(result.pattern).not.toBe("none");
    expect(result.waves.length).toBeGreaterThanOrEqual(3);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("always produces an invalidation price for a usable count", () => {
    const result = analyseElliott(makeCandles(impulseCloses()), "4h", {
      atrMultiple: 1.2,
    });
    if (result.pattern !== "none") {
      expect(result.invalidation).not.toBeNull();
      expect(Number.isFinite(result.invalidation as number)).toBe(true);
    }
  });
});

describe("elliott scoring", () => {
  const base = {
    timeframe: "1h" as const,
    pattern: "impulse" as const,
    currentWave: "A" as const,
    waves: [],
    targets: [90, 80],
    notes: [],
  };

  it("maps bias and confidence onto a bounded directional score", () => {
    expect(
      elliottScore({ ...base, bias: "long", confidence: 0.8, invalidation: 50 }, 100),
    ).toBeCloseTo(0.8);
    expect(
      elliottScore({ ...base, bias: "short", confidence: 0.8, invalidation: 150 }, 100),
    ).toBeCloseTo(-0.8);
  });

  it("scores zero once the count's invalidation level is breached", () => {
    expect(
      elliottScore({ ...base, bias: "long", confidence: 0.9, invalidation: 120 }, 100),
    ).toBe(0);
  });

  it("scores zero when there is no pattern", () => {
    expect(
      elliottScore(
        { ...base, pattern: "none", bias: "flat", confidence: 0, invalidation: null },
        100,
      ),
    ).toBe(0);
  });

  it("only returns targets on the correct side of price", () => {
    const targets = elliottTargets(
      { ...base, bias: "short", confidence: 0.5, invalidation: null },
      100,
    );
    expect(targets.every((t) => t < 100)).toBe(true);
  });
});
