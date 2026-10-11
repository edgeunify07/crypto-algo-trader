import { describe, expect, it } from "vitest";
import { pointInTimeUniverse, runFuturesBacktest, type BacktestInput } from "./backtest";
import { DEFAULT_PARAMS } from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";

const HOUR = 3_600_000;

/**
 * Bars with a prescribed quote volume per hour.
 *
 * `volumeAt` receives the bar index so a test can make a symbol quiet early
 * and busy later, which is the case the ranking exists to handle.
 */
function series(bars: number, volumeAt: (i: number) => number, priceAt: (i: number) => number = () => 100): Candle[] {
  return Array.from({ length: bars }, (_, i) => {
    const close = priceAt(i);
    return {
      openTime: i * HOUR,
      open: close,
      high: close * 1.002,
      low: close * 0.998,
      close,
      volume: volumeAt(i) / close,
      closeTime: (i + 1) * HOUR - 1,
      quoteVolume: volumeAt(i),
      trades: 10,
      closed: true,
    };
  });
}

function input(symbol: string, candles: Candle[]): BacktestInput {
  return { symbol, byTimeframe: new Map<Timeframe, Candle[]>([["1h", candles]]) };
}

describe("pointInTimeUniverse", () => {
  const clockOf = (candles: Candle[]) => candles.map((c) => c.closeTime);

  it("ranks on the trailing 24h of volume, not the whole series", () => {
    // QUIET out-trades BUSY for the first day, then stops entirely. A ranking
    // that summed the whole series would keep QUIET ahead long after.
    const busy = series(96, () => 1_000);
    const quiet = series(96, (i) => (i < 24 ? 5_000 : 1));
    const data = [input("BUSY", busy), input("QUIET", quiet)];
    const eligible = pointInTimeUniverse(data, "1h", clockOf(busy), 1);

    expect(eligible.get(busy[20]!.closeTime)).toEqual(new Set(["QUIET"]));
    // A full day after QUIET went silent its trailing window is empty.
    expect(eligible.get(busy[60]!.closeTime)).toEqual(new Set(["BUSY"]));
  });

  it("excludes a symbol that has not started trading yet", () => {
    const old = series(48, () => 100);
    // Listed halfway through: no bars before hour 24.
    const fresh = series(48, () => 10_000).slice(24);
    const data = [input("OLD", old), input("NEW", fresh)];
    const eligible = pointInTimeUniverse(data, "1h", clockOf(old), 2);

    expect(eligible.get(old[10]!.closeTime)).toEqual(new Set(["OLD"]));
    expect(eligible.get(old[40]!.closeTime)).toEqual(new Set(["OLD", "NEW"]));
  });

  it("keeps every symbol when the universe is as wide as the pool", () => {
    const a = series(48, () => 100);
    const data = [input("A", a), input("B", series(48, () => 1))];
    const eligible = pointInTimeUniverse(data, "1h", clockOf(a), 2);
    expect(eligible.get(a[30]!.closeTime)).toEqual(new Set(["A", "B"]));
  });
});

describe("runFuturesBacktest universe gate", () => {
  /**
   * A trending, volatile series, which is what it takes to get the strategy
   * to open anything at all. The point of the test is not the trades
   * themselves but which symbols they are allowed to happen in.
   */
  const trend = (bars: number, seed: number) =>
    series(
      bars,
      () => 1_000,
      (i) => 100 * (1 + 0.004 * i + 0.02 * Math.sin((i + seed) / 7)),
    );

  it("never enters a symbol outside the point-in-time ranking", () => {
    const bars = 600;
    // POOR carries a tenth of RICH's volume throughout, so with room for one
    // symbol it is never eligible.
    const data: BacktestInput[] = [
      input("RICH", trend(bars, 0)),
      input("POOR", trend(bars, 3).map((c) => ({ ...c, quoteVolume: 100 }))),
    ];

    const ungated = runFuturesBacktest(data, DEFAULT_PARAMS, {
      stepTimeframe: "1h",
      startingBalance: 100,
    });
    const gated = runFuturesBacktest(data, DEFAULT_PARAMS, {
      stepTimeframe: "1h",
      startingBalance: 100,
      universeSize: 1,
    });

    // Without this the assertion below would pass on a run that never traded.
    expect(ungated.trades.some((t) => t.symbol === "POOR")).toBe(true);
    expect(gated.trades.every((t) => t.symbol === "RICH")).toBe(true);
  });

  it("is a no-op when the universe is wider than the pool", () => {
    const data = [input("A", trend(400, 0)), input("B", trend(400, 5))];
    const open = runFuturesBacktest(data, DEFAULT_PARAMS, {
      stepTimeframe: "1h",
      startingBalance: 100,
    });
    const wide = runFuturesBacktest(data, DEFAULT_PARAMS, {
      stepTimeframe: "1h",
      startingBalance: 100,
      universeSize: 10,
    });
    expect(wide.trades.length).toBe(open.trades.length);
    expect(wide.totalReturn).toBeCloseTo(open.totalReturn, 10);
  });
});

describe("runFuturesBacktest risk limits", () => {
  /** Choppy enough to lose, so a drawdown halt has something to stop. */
  const choppy = (bars: number, seed: number) =>
    series(
      bars,
      () => 1_000,
      (i) => 100 * (1 + 0.05 * Math.sin((i + seed) / 11) + 0.02 * Math.sin((i + seed) / 3)),
    );

  it("stops opening positions once drawdown passes the halt", () => {
    const data = [input("A", choppy(700, 0)), input("B", choppy(700, 17))];
    const common = { stepTimeframe: "1h" as const, startingBalance: 100 };

    const unhalted = runFuturesBacktest(data, DEFAULT_PARAMS, { ...common, maxDrawdownHalt: 1 });
    const halted = runFuturesBacktest(data, DEFAULT_PARAMS, { ...common, maxDrawdownHalt: 0.02 });

    // Guards against a vacuous pass: the run has to lose enough to trip a 2%
    // halt, and to have kept trading without one.
    expect(unhalted.maxDrawdown).toBeGreaterThan(0.02);
    expect(halted.trades.length).toBeLessThan(unhalted.trades.length);
  });

  it("caps a position's notional at the configured multiple of equity", () => {
    const data = [input("A", choppy(500, 0))];
    const common = { stepTimeframe: "1h" as const, startingBalance: 100 };

    const capped = runFuturesBacktest(data, DEFAULT_PARAMS, {
      ...common,
      maxPositionFraction: 0.25,
    });
    for (const t of capped.trades) {
      // Entry notional, against the equity the account could have held at
      // its very best — a looser bound than the real one, but one that a
      // missing cap still breaks.
      expect(t.quantity * t.entryPrice).toBeLessThanOrEqual(100 * 0.25 * 3);
    }
    expect(capped.trades.length).toBeGreaterThan(0);
  });
});
