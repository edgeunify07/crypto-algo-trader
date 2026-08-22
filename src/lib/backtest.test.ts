import { describe, expect, it } from "vitest";
import { backtest, BINANCE_SPOT_COSTS } from "./backtest";
import { getStrategy, buyAndHoldBenchmark } from "./strategies/registry";
import type { Candle } from "./types";

const ZERO_COSTS = { ...BINANCE_SPOT_COSTS, feeRate: 0, slippageRate: 0, tdsRate: 0 };

function makeCandles(prices: number[], startTime = 1_700_000_000): Candle[] {
  return prices.map((close, i) => ({
    time: startTime + i * 3600,
    open: i === 0 ? close : prices[i - 1],
    high: Math.max(close, i === 0 ? close : prices[i - 1]) * 1.001,
    low: Math.min(close, i === 0 ? close : prices[i - 1]) * 0.999,
    close,
    volume: 1000,
  }));
}

describe("backtest engine", () => {
  it("buy-and-hold with zero costs matches benchmark return", () => {
    const prices = [100, 102, 105, 103, 110, 108];
    const candles = makeCandles(prices);
    const strategy = buyAndHoldBenchmark;
    const result = backtest(strategy, candles, { warmup: 0 }, 10_000, ZERO_COSTS);

    const expectedReturn = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    expect(result.numTrades).toBe(0); // never sells
    expect(result.buyHoldReturnPct).toBeCloseTo(expectedReturn, 4);
    // Entry at bar 1 open (= bar 0 close = 100), mark at last close 108
    expect(result.totalReturnPct).toBeCloseTo(((108 - 100) / 100) * 100, 4);
  });

  it("fills on next bar open, not signal bar close", () => {
    const candles: Candle[] = [
      { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: 2, open: 200, high: 201, low: 199, close: 200, volume: 1 }, // gap up
      { time: 3, open: 200, high: 201, low: 199, close: 200, volume: 1 },
    ];
    const strategy = buyAndHoldBenchmark;
    const result = backtest(strategy, candles, { warmup: 0 }, 10_000, ZERO_COSTS);
    // Signal bar 0, fill bar 1 open at 200 (not 100)
    expect(result.endEquity).toBeCloseTo(10_000 * (200 / 200), 0);
    expect(result.totalReturnPct).toBeCloseTo(0, 1); // bought at 200, ends at 200
  });

  it("charges fees on fill notional, not full equity repeatedly per side", () => {
    const prices = [100, 100, 100, 100, 100];
    const candles = makeCandles(prices);
    const strategy = getStrategy("confluence-swing")!;
    const result = backtest(strategy, candles, { entryThreshold: 3, mode: 0 }, 10_000, {
      ...BINANCE_SPOT_COSTS,
      slippageRate: 0,
    });
    // Total fees should be << 10% of equity for few trades
    expect(result.totalFeesPaid).toBeLessThan(10_000 * 0.05);
    for (const t of result.trades) {
      expect(t.entryFee).toBeCloseTo(t.entryNotional * 0.001, 2);
      expect(t.exitFee).toBeCloseTo(t.exitNotional * 0.001, 2);
      expect(t.entryPrice).not.toBe(t.exitPrice);
    }
  });

  it("entry and exit prices come from different bars", () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const candles = makeCandles(prices);
    const strategy = getStrategy("confluence-swing")!;
    const result = backtest(strategy, candles, { entryThreshold: 4, mode: 0 }, 10_000, ZERO_COSTS);
    for (const t of result.trades) {
      expect(t.exitBar).toBeGreaterThan(t.entryBar);
      expect(t.entryTime).toBeLessThan(t.exitTime);
    }
  });

  it("max drawdown is independent of net return when equity recovers", () => {
    const prices = [100, 120, 90, 130];
    const candles = makeCandles(prices);
    const strategy = buyAndHoldBenchmark;
    const result = backtest(strategy, candles, { warmup: 0 }, 10_000, ZERO_COSTS);
    expect(result.maxDrawdownPct).toBeGreaterThan(0);
    expect(result.totalReturnPct).toBeGreaterThan(result.maxDrawdownPct * -1);
  });
});
