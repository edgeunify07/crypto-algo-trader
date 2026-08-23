import { describe, it, expect } from "vitest";
import { evaluateConfluence, buildConfluenceContext, DEFAULT_CONFLUENCE_PARAMS, DEFAULT_SCALP_PARAMS } from "./confluence";
import type { Candle } from "../types";

/**
 * `minConfidence` used to be compared against `entryThreshold`:
 *   confNeeded = max(entryThreshold * minConfidence/100, entryThreshold * 0.85)
 *   veto if score < confNeeded AND score >= entryThreshold
 * For any minConfidence <= 100 that made confNeeded <= entryThreshold, so the
 * second condition already guaranteed the first was false — the veto could never
 * fire and the entire 0–100 UI range was dead. Both shipped defaults (scalp 75,
 * swing 70) sat in that dead zone.
 *
 * It is now a percentage of the MAXIMUM ACHIEVABLE score, so the whole range works.
 */

/** Rising, high-volume candles so a decent number of factors fire. */
function trendCandles(count: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price *= 1.004;
    const low = price * 0.998;
    out.push({
      time: 1_700_000_000 + i * 900,
      open: low,
      high: price * 1.001,
      low,
      close: price,
      volume: 1000 + i,
    });
  }
  return out;
}

function ctxFor(candles: Candle[]) {
  return buildConfluenceContext(candles, candles, "1h");
}

describe("minConfidence gate", () => {
  const candles = trendCandles(200);
  const ctx = ctxFor(candles);
  const idx = candles.length - 1;
  const base = { ...DEFAULT_CONFLUENCE_PARAMS, minConfidence: 0 } as Record<string, number>;

  it("reports confidence as a percentage of the achievable maximum", () => {
    const d = evaluateConfluence(ctx, idx, "flat", base);
    expect(d.maxScore).toBeGreaterThan(0);
    expect(d.confidencePct).toBeCloseTo((d.score / d.maxScore) * 100, 8);
    expect(d.confidencePct).toBeGreaterThanOrEqual(0);
  });

  it("maxScore is a true maximum, not just the achieved score", () => {
    const d = evaluateConfluence(ctx, idx, "flat", base);
    // The old implementation summed the positive factors, making maxScore == score.
    expect(d.maxScore).toBeGreaterThan(d.score);
    // With all toggles on and default weights: 3+3+2+2+1+2*1.2+1*1.5+2 = 16.9
    expect(d.maxScore).toBeCloseTo(16.9, 6);
  });

  it("is OFF at 0 — no confidence veto regardless of score", () => {
    const d = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: 0 });
    expect(d.vetoes.some((v) => v.startsWith("Confidence"))).toBe(false);
  });

  it("VETOES when confidence is below the requirement (this could never fire before)", () => {
    const d = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: 100 });
    expect(d.confidencePct).toBeLessThan(100);
    expect(d.vetoes.some((v) => v.startsWith("Confidence"))).toBe(true);
  });

  it("passes when the requirement sits below the achieved confidence", () => {
    const d = evaluateConfluence(ctx, idx, "flat", base);
    const justBelow = Math.max(1, Math.floor(d.confidencePct) - 1);
    const d2 = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: justBelow });
    expect(d2.vetoes.some((v) => v.startsWith("Confidence"))).toBe(false);
  });

  it("is monotonic: raising the requirement can only add the veto, never remove it", () => {
    let seenVeto = false;
    for (const mc of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      const vetoed = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: mc })
        .vetoes.some((v) => v.startsWith("Confidence"));
      if (seenVeto) expect(vetoed).toBe(true); // once strict enough to veto, stays vetoed
      if (vetoed) seenVeto = true;
    }
    expect(seenVeto).toBe(true); // 100% is unreachable here, so the veto must appear
  });

  it("clamps above 100 instead of becoming unsatisfiable-by-typo", () => {
    const at100 = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: 100 });
    const at130 = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: 130 });
    const v100 = at100.vetoes.find((v) => v.startsWith("Confidence"));
    const v130 = at130.vetoes.find((v) => v.startsWith("Confidence"));
    expect(v130).toBe(v100); // 130 behaves exactly as 100
  });

  it("treats negative values as off", () => {
    const d = evaluateConfluence(ctx, idx, "flat", { ...base, minConfidence: -50 });
    expect(d.vetoes.some((v) => v.startsWith("Confidence"))).toBe(false);
  });

  it("shipped defaults are 0 so the fix does not silently tighten live configs", () => {
    expect(DEFAULT_CONFLUENCE_PARAMS.minConfidence).toBe(0);
    expect(DEFAULT_SCALP_PARAMS.minConfidence).toBe(0);
  });

  it("tracks the weights and toggles that define the maximum", () => {
    const heavier = evaluateConfluence(ctx, idx, "flat", { ...base, weightTrend: 10 });
    const lighter = evaluateConfluence(ctx, idx, "flat", base);
    expect(heavier.maxScore).toBeGreaterThan(lighter.maxScore);

    const fewerFactors = evaluateConfluence(ctx, idx, "flat", { ...base, useSr: 0, useStructure: 0 });
    expect(fewerFactors.maxScore).toBeLessThan(lighter.maxScore);
  });
});
