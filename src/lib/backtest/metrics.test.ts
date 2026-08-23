import { describe, it, expect } from "vitest";
import { deflatedSharpe, expectedMaxSharpeZ, computeExtendedMetrics } from "./metrics";
import type { BacktestResult } from "../backtest";

/**
 * The Deflated Sharpe Ratio exists to answer "given that I tried N configurations,
 * is this winner distinguishable from luck?". The previous implementation had the
 * penalty shrinking as N grew, so a huge grid search looked MORE credible — the
 * exact opposite of the metric's purpose, and dangerous when picking a config to
 * trade real money. These tests pin the direction.
 */
describe("expectedMaxSharpeZ", () => {
  it("is zero for a single trial (nothing was selected)", () => {
    expect(expectedMaxSharpeZ(1)).toBe(0);
    expect(expectedMaxSharpeZ(0)).toBe(0);
  });

  it("grows with the number of trials", () => {
    const z10 = expectedMaxSharpeZ(10);
    const z100 = expectedMaxSharpeZ(100);
    const z10000 = expectedMaxSharpeZ(10_000);
    expect(z10).toBeGreaterThan(0);
    expect(z100).toBeGreaterThan(z10);
    expect(z10000).toBeGreaterThan(z100);
  });

  it("matches the known scale of the max of N normals (~3.9 at N=10k)", () => {
    expect(expectedMaxSharpeZ(10_000)).toBeGreaterThan(3.0);
    expect(expectedMaxSharpeZ(10_000)).toBeLessThan(4.5);
  });
});

describe("deflatedSharpe", () => {
  const SR = 0.05;   // per-observation Sharpe
  const OBS = 2000;

  it("returns a probability in [0,1]", () => {
    for (const n of [1, 10, 500, 100_000]) {
      const d = deflatedSharpe(SR, n, OBS);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it("DECREASES as the number of trials grows (the bug that was fixed)", () => {
    const d1 = deflatedSharpe(SR, 1, OBS);
    const d10 = deflatedSharpe(SR, 10, OBS);
    const d100 = deflatedSharpe(SR, 100, OBS);
    const d10000 = deflatedSharpe(SR, 10_000, OBS);
    expect(d10).toBeLessThan(d1);
    expect(d100).toBeLessThan(d10);
    expect(d10000).toBeLessThan(d100);
  });

  it("a 200-config search materially discounts a marginal Sharpe", () => {
    // 246 configs were tested in the scalp search; a weak edge must not survive.
    const marginal = deflatedSharpe(0.02, 246, OBS);
    expect(marginal).toBeLessThan(0.95);
  });

  it("a strong edge on one trial is credible", () => {
    expect(deflatedSharpe(0.15, 1, OBS)).toBeGreaterThan(0.95);
  });

  it("a negative Sharpe is never credible", () => {
    expect(deflatedSharpe(-0.05, 1, OBS)).toBeLessThan(0.5);
    expect(deflatedSharpe(-0.05, 100, OBS)).toBeLessThan(0.5);
  });

  it("more observations make the same Sharpe more credible", () => {
    expect(deflatedSharpe(SR, 10, 5000)).toBeGreaterThan(deflatedSharpe(SR, 10, 200));
  });

  it("degrades safely on too little data", () => {
    expect(deflatedSharpe(SR, 10, 2)).toBe(0);
    expect(deflatedSharpe(Number.NaN, 10, OBS)).toBe(0);
  });

  it("fat tails reduce credibility versus normal returns", () => {
    const normal = deflatedSharpe(SR, 10, OBS, 0, 3);
    const fatTailed = deflatedSharpe(SR, 10, OBS, 0, 12);
    expect(fatTailed).toBeLessThan(normal);
  });
});

describe("computeExtendedMetrics DSR wiring", () => {
  function resultWith(equities: number[]): BacktestResult {
    return {
      strategyId: "test", startEquity: equities[0], endEquity: equities[equities.length - 1],
      endEquityAfterTax: equities[equities.length - 1],
      totalReturnPct: ((equities[equities.length - 1] - equities[0]) / equities[0]) * 100,
      buyHoldReturnPct: 0, trades: [], numTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0,
      maxDrawdownPct: 0, totalFeesPaid: 0, totalSlippagePaid: 0, totalTdsPaid: 0,
      equityCurve: equities.map((e, i) => ({ time: 1_700_000_000 + i * 3600, equity: e })),
    };
  }

  it("passes numTrials through so a grid search is discounted", () => {
    // Deterministic noisy random walk with a small positive drift, so the
    // per-observation Sharpe is realistic (~0.05) rather than saturating DSR at 1.
    let seed = 12345;
    const lcg = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const eq = [10_000];
    for (let i = 1; i < 600; i++) eq.push(eq[i - 1] * (1 + 0.0005 + lcg() * 0.02));
    const one = computeExtendedMetrics(resultWith(eq), 1);
    const many = computeExtendedMetrics(resultWith(eq), 5000);
    expect(many.deflatedSharpe).toBeLessThan(one.deflatedSharpe);
    expect(one.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(one.deflatedSharpe).toBeLessThanOrEqual(1);
  });

  it("reports a flat curve as not credible", () => {
    const flat = Array.from({ length: 300 }, () => 10_000);
    expect(computeExtendedMetrics(resultWith(flat), 100).deflatedSharpe).toBeLessThan(0.95);
  });
});
