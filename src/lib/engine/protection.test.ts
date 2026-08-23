import { describe, it, expect } from "vitest";
import {
  computeProtection,
  isTargetBelowCostFloor,
  ROUND_TRIP_COST,
  MIN_TARGET_PCT,
} from "./protection";
import type { Candle } from "../types";

/** Build candles with a fixed true range so ATR is predictable. */
function candles(count: number, close: number, range: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      time: 1_700_000_000 + i * 900,
      open: close,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: 100,
    });
  }
  return out;
}

describe("round-trip cost model", () => {
  it("is 0.30% — fees and slippage on both sides", () => {
    expect(ROUND_TRIP_COST).toBeCloseTo(0.003, 10);
  });

  it("flags targets that cannot pay for themselves", () => {
    // The old DEFAULT_SCALP_PARAMS target of 0.25% sits below the 0.30% floor.
    expect(isTargetBelowCostFloor(0.0025)).toBe(true);
    expect(isTargetBelowCostFloor(0.005)).toBe(false);
  });
});

describe("computeProtection", () => {
  it("places the stop below and the target above entry", () => {
    const c = candles(60, 100, 2);
    const p = computeProtection(c, c.length - 1, 100, { stopLossAtrMult: 2, takeProfitRr: 1.5 })!;
    expect(p).not.toBeNull();
    expect(p.stopLoss).toBeLessThan(100);
    expect(p.takeProfit).toBeGreaterThan(100);
    expect(p.stopLoss).toBeGreaterThan(0);
  });

  it("never returns a target below the fee+slippage floor", () => {
    // Very low volatility → ATR-derived target would be tiny.
    const c = candles(60, 100, 0.0001);
    const p = computeProtection(c, c.length - 1, 100, { stopLossAtrMult: 0.1, takeProfitRr: 0.1 })!;
    expect(p.targetPct).toBeGreaterThanOrEqual(MIN_TARGET_PCT - 1e-12);
    expect(isTargetBelowCostFloor(p.targetPct)).toBe(false);
    expect(p.widenedForCost).toBe(true);
  });

  it("scales the stop with volatility", () => {
    const calm = computeProtection(candles(60, 100, 1), 59, 100, { stopLossAtrMult: 2 })!;
    const wild = computeProtection(candles(60, 100, 8), 59, 100, { stopLossAtrMult: 2 })!;
    expect(wild.riskPct).toBeGreaterThan(calm.riskPct);
  });

  it("clamps an absurdly wide stop to 10%", () => {
    const p = computeProtection(candles(60, 100, 40), 59, 100, { stopLossAtrMult: 10 })!;
    expect(p.riskPct).toBeLessThanOrEqual(0.1 + 1e-12);
  });

  it("clamps a too-tight stop above the noise/cost band", () => {
    const p = computeProtection(candles(60, 100, 0.0001), 59, 100, { stopLossAtrMult: 0.01 })!;
    expect(p.riskPct).toBeGreaterThanOrEqual(ROUND_TRIP_COST * 2 - 1e-12);
  });

  it("falls back to a percentage stop when ATR is unavailable", () => {
    const p = computeProtection(candles(3, 100, 1), 2, 100, { fallbackStopPct: 0.02 })!;
    expect(p).not.toBeNull();
    expect(p.stopLoss).toBeLessThan(100);
  });

  it("rejects a non-positive entry price", () => {
    expect(computeProtection(candles(60, 100, 2), 59, 0)).toBeNull();
    expect(computeProtection(candles(60, 100, 2), 59, -5)).toBeNull();
  });

  it("reports effective reward:risk after clamping", () => {
    const c = candles(60, 100, 2);
    const p = computeProtection(c, c.length - 1, 100, { stopLossAtrMult: 2, takeProfitRr: 2 })!;
    expect(p.effectiveRr).toBeCloseTo(p.targetPct / p.riskPct, 10);
    expect(p.effectiveRr).toBeGreaterThan(0);
  });
});
