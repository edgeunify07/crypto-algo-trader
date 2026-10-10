import { describe, expect, it } from "vitest";
import {
  adx,
  atr,
  bollinger,
  ema,
  last,
  macd,
  obv,
  rsi,
  sma,
  slope,
  wilderSmooth,
} from "./index.js";
import { clusterLevels, findFractals, findPivots } from "./pivots.js";
import { joinLegs, linear, makeCandles } from "../testUtils.js";

describe("moving averages", () => {
  it("computes an SMA over the trailing window", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const result = sma(values, 3);
    expect(result.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(result[2]).toBeCloseTo(2);
    expect(result[5]).toBeCloseTo(5);
  });

  it("leaves the warm-up region as NaN and keeps array alignment", () => {
    const values = linear(10, 20, 40);
    const result = ema(values, 10);
    expect(result).toHaveLength(values.length);
    expect(Number.isNaN(result[8] as number)).toBe(true);
    expect(Number.isFinite(result[9] as number)).toBe(true);
  });

  it("tracks a rising series upward", () => {
    const rising = ema(linear(100, 200, 60), 10);
    expect(last(rising)).toBeGreaterThan(rising[30] as number);
  });

  it("returns all-NaN when the series is shorter than the period", () => {
    expect(ema([1, 2, 3], 10).every(Number.isNaN)).toBe(true);
    expect(sma([1, 2, 3], 10).every(Number.isNaN)).toBe(true);
  });
});

describe("rsi", () => {
  it("pins near 100 for a monotonic rally and near 0 for a monotonic selloff", () => {
    expect(last(rsi(linear(100, 200, 60), 14))).toBeGreaterThan(90);
    expect(last(rsi(linear(200, 100, 60), 14))).toBeLessThan(10);
  });

  it("sits near 50 for an oscillating series", () => {
    const oscillating = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 2) * 5);
    expect(last(rsi(oscillating, 14))).toBeGreaterThan(30);
    expect(last(rsi(oscillating, 14))).toBeLessThan(70);
  });
});

describe("atr and wilder smoothing", () => {
  it("grows with the bar range", () => {
    const tight = atr(makeCandles(linear(100, 110, 60), { range: 0.002 }), 14);
    const wide = atr(makeCandles(linear(100, 110, 60), { range: 0.02 }), 14);
    expect(last(wide)).toBeGreaterThan(last(tight));
  });

  it("smooths toward the mean of a constant series", () => {
    const result = wilderSmooth(new Array(40).fill(5), 14);
    expect(last(result)).toBeCloseTo(5, 6);
  });
});

describe("macd", () => {
  it("prints a positive histogram on an accelerating rally", () => {
    const result = macd(joinLegs(linear(100, 101, 40), linear(101, 150, 40)), 12, 26, 9);
    expect(last(result.macd)).toBeGreaterThan(0);
    expect(last(result.histogram)).toBeGreaterThan(0);
  });

  it("keeps all three arrays aligned to the input length", () => {
    const values = linear(100, 120, 80);
    const result = macd(values);
    expect(result.macd).toHaveLength(values.length);
    expect(result.signal).toHaveLength(values.length);
    expect(result.histogram).toHaveLength(values.length);
  });
});

describe("adx", () => {
  it("reports a strong trend with +DI leading on a sustained rally", () => {
    const result = adx(makeCandles(linear(100, 200, 90)), 14);
    expect(last(result.adx)).toBeGreaterThan(25);
    expect(last(result.plusDi)).toBeGreaterThan(last(result.minusDi));
  });

  it("reports -DI leading on a sustained decline", () => {
    const result = adx(makeCandles(linear(200, 100, 90)), 14);
    expect(last(result.minusDi)).toBeGreaterThan(last(result.plusDi));
  });
});

describe("bollinger", () => {
  it("brackets price and widens with volatility", () => {
    const steady = bollinger(new Array(60).fill(100).map((v, i) => v + (i % 2)), 20, 2);
    const wild = bollinger(
      Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 20),
      20,
      2,
    );
    expect(last(wild.width)).toBeGreaterThan(last(steady.width));
    expect(last(steady.upper)).toBeGreaterThan(last(steady.middle));
    expect(last(steady.lower)).toBeLessThan(last(steady.middle));
  });
});

describe("obv and slope", () => {
  it("rises with an advancing series and falls with a declining one", () => {
    expect(last(obv(makeCandles(linear(100, 150, 40))))).toBeGreaterThan(0);
    expect(last(obv(makeCandles(linear(150, 100, 40))))).toBeLessThan(0);
  });

  it("returns a signed, price-normalised slope", () => {
    expect(slope(linear(100, 150, 30), 30)).toBeGreaterThan(0);
    expect(slope(linear(150, 100, 30), 30)).toBeLessThan(0);
    expect(slope(new Array(30).fill(100), 30)).toBeCloseTo(0, 6);
  });
});

describe("pivots", () => {
  const zigzag = joinLegs(
    linear(100, 100, 20),
    linear(100, 140, 20),
    linear(140, 110, 20),
    linear(110, 165, 20),
    linear(165, 130, 20),
  );

  it("finds alternating highs and lows", () => {
    const pivots = findPivots(makeCandles(zigzag), { atrMultiple: 1.5 });
    expect(pivots.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i]!.type).not.toBe(pivots[i - 1]!.type);
    }
  });

  it("emits pivots in chronological order", () => {
    const pivots = findPivots(makeCandles(zigzag), { atrMultiple: 1.5 });
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i]!.index).toBeGreaterThan(pivots[i - 1]!.index);
    }
  });

  it("drops the provisional trailing pivot when asked", () => {
    const candles = makeCandles(zigzag);
    const all = findPivots(candles, { atrMultiple: 1.5 });
    const confirmed = findPivots(candles, { atrMultiple: 1.5, confirmedOnly: true });
    expect(confirmed.length).toBe(all.length - 1);
  });

  it("finds fewer pivots as the threshold rises", () => {
    const candles = makeCandles(zigzag);
    expect(findPivots(candles, { atrMultiple: 6 }).length).toBeLessThanOrEqual(
      findPivots(candles, { atrMultiple: 1 }).length,
    );
  });

  it("returns nothing for a series shorter than the ATR warm-up", () => {
    expect(findPivots(makeCandles(linear(100, 110, 5)))).toEqual([]);
  });
});

describe("fractals and level clustering", () => {
  it("identifies local extremes", () => {
    const candles = makeCandles(joinLegs(linear(100, 120, 10), linear(120, 100, 10)));
    const { highs, lows } = findFractals(candles, 2);
    expect(highs.length + lows.length).toBeGreaterThan(0);
  });

  it("merges nearby pivots into one weighted level", () => {
    const pivots = [
      { index: 0, time: 1, price: 100, type: "high" as const },
      { index: 5, time: 2, price: 100.2, type: "high" as const },
      { index: 9, time: 3, price: 130, type: "high" as const },
    ];
    const clusters = clusterLevels(pivots, 115, 0.01);
    expect(clusters).toHaveLength(2);
    const merged = clusters.find((c) => c.touches === 2);
    expect(merged?.price).toBeCloseTo(100.1, 1);
  });
});
