import { describe, expect, it } from "vitest";
import { CandleSeries } from "./candleSeries.js";
import { makeCandles, linear } from "../testUtils.js";
import type { Candle } from "../types.js";

function series(bars = 100): CandleSeries {
  return new CandleSeries("BTCUSDT", "1h", bars);
}

describe("CandleSeries", () => {
  it("seeds from closed candles only and keeps them ordered", () => {
    const candles = makeCandles(linear(100, 120, 20));
    const forming = { ...(candles.at(-1) as Candle), closed: false };
    const s = series();
    s.seed([...candles, forming]);
    expect(s.length).toBe(20);
    expect(s.closed.at(-1)?.closed).toBe(true);
  });

  it("honours the max-bars cap", () => {
    const s = series(10);
    s.seed(makeCandles(linear(100, 200, 50)));
    expect(s.length).toBe(10);
  });

  it("keeps a forming candle out of the closed series", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    const next = { ...(candles.at(-1) as Candle), openTime: 9e12, closeTime: 9e12 + 1, closed: false, close: 999 };
    expect(s.apply(next)).toBe(false);
    expect(s.length).toBe(5);
    expect(s.live?.close).toBe(999);
    // Live price reads through to the forming candle.
    expect(s.price).toBe(999);
  });

  it("reports a bar close and appends it", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    const next: Candle = { ...(candles.at(-1) as Candle), openTime: 9e12, closeTime: 9e12 + 1, close: 150 };
    expect(s.apply(next)).toBe(true);
    expect(s.length).toBe(6);
    expect(s.lastClosed?.close).toBe(150);
  });

  it("replaces a late correction to the newest bar rather than duplicating it", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    const corrected: Candle = { ...(candles.at(-1) as Candle), close: 555 };
    expect(s.apply(corrected)).toBe(true);
    expect(s.length).toBe(5);
    expect(s.lastClosed?.close).toBe(555);
  });

  it("ignores an out-of-order historical bar", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    const stale: Candle = { ...(candles[0] as Candle), close: 1 };
    expect(s.apply(stale)).toBe(false);
    expect(s.lastClosed?.close).toBe(candles.at(-1)?.close);
  });

  it("clears the forming candle once its bar closes", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    s.apply({ ...(candles.at(-1) as Candle), openTime: 9e12, closeTime: 9e12 + 1, closed: false, close: 120 });
    expect(s.live).not.toBeNull();
    s.apply({ ...(candles.at(-1) as Candle), openTime: 9e12, closeTime: 9e12 + 1, closed: true, close: 121 });
    expect(s.live).toBeNull();
    expect(s.price).toBe(121);
  });

  it("flags staleness once two intervals have elapsed", () => {
    const s = series();
    const candles = makeCandles(linear(100, 110, 5));
    s.seed(candles);
    const lastClose = candles.at(-1)!.closeTime;
    expect(s.isStale(lastClose + 1000)).toBe(false);
    expect(s.isStale(lastClose + 3 * 3_600_000)).toBe(true);
  });

  it("treats an empty series as stale", () => {
    expect(series().isStale()).toBe(true);
  });

  it("exposes aligned column extractors", () => {
    const s = series();
    s.seed(makeCandles(linear(100, 110, 8)));
    expect(s.closes()).toHaveLength(8);
    expect(s.highs()).toHaveLength(8);
    expect(s.lows()).toHaveLength(8);
    expect(s.volumes()).toHaveLength(8);
    expect(Math.max(...s.highs())).toBeGreaterThanOrEqual(Math.max(...s.closes()));
  });
});
