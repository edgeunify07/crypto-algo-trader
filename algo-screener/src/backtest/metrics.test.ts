import { describe, expect, it } from "vitest";
import { EMPTY_METRICS, computeMetrics, fitnessScore, groupMetrics } from "./metrics.js";
import type { AccountSnapshot, ClosedTrade } from "../types.js";

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    symbol: "BTCUSDT",
    side: "long",
    timeframe: "1h",
    quantity: 1,
    entryPrice: 100,
    exitPrice: 110,
    openedAt: 0,
    closedAt: 3_600_000,
    pnl: 10,
    pnlPct: 0.1,
    rMultiple: 1,
    fees: 0.2,
    exitReason: "take_profit",
    paramsVersion: "test",
    tags: [],
    ...overrides,
  };
}

function curve(equities: number[]): AccountSnapshot[] {
  return equities.map((equity, i) => ({
    time: i * 3_600_000,
    equity,
    cash: equity,
    unrealisedPnl: 0,
    realisedPnl: equity - (equities[0] as number),
    openPositions: 0,
  }));
}

describe("computeMetrics", () => {
  it("returns a zeroed result with no data", () => {
    expect(computeMetrics([], [], 1000)).toEqual({ ...EMPTY_METRICS, finalEquity: 1000 });
  });

  it("counts wins, losses and win rate", () => {
    const m = computeMetrics(
      [trade(), trade({ pnl: -5, rMultiple: -1 }), trade()],
      curve([1000, 1010, 1005, 1015]),
      1000,
    );
    expect(m.trades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3);
    expect(m.totalPnl).toBeCloseTo(15);
  });

  it("computes profit factor as gross profit over gross loss", () => {
    const m = computeMetrics(
      [trade({ pnl: 30 }), trade({ pnl: -10 })],
      curve([1000, 1030, 1020]),
      1000,
    );
    expect(m.profitFactor).toBeCloseTo(3);
  });

  it("caps profit factor instead of returning Infinity when nothing lost", () => {
    const m = computeMetrics([trade({ pnl: 30 })], curve([1000, 1030]), 1000);
    expect(Number.isFinite(m.profitFactor)).toBe(true);
    expect(m.profitFactor).toBe(10);
  });

  it("measures max drawdown from the running peak", () => {
    const m = computeMetrics([], curve([1000, 1200, 900, 1100]), 1000);
    // Peak 1200 down to 900 is 25%.
    expect(m.maxDrawdown).toBeCloseTo(0.25);
  });

  it("reports expectancy as the mean R multiple", () => {
    const m = computeMetrics(
      [trade({ rMultiple: 2 }), trade({ rMultiple: -1 }), trade({ rMultiple: 2 })],
      curve([1000, 1010, 1005, 1015]),
      1000,
    );
    expect(m.expectancy).toBeCloseTo(1);
  });

  it("gives a rising equity curve a positive Sharpe and a falling one a negative Sharpe", () => {
    expect(computeMetrics([], curve([1000, 1010, 1020, 1030]), 1000).sharpe).toBeGreaterThan(0);
    expect(computeMetrics([], curve([1000, 990, 980, 970]), 1000).sharpe).toBeLessThan(0);
  });

  it("counts the longest losing streak", () => {
    const m = computeMetrics(
      [
        trade({ pnl: -1 }),
        trade({ pnl: -1 }),
        trade({ pnl: 5 }),
        trade({ pnl: -1 }),
        trade({ pnl: -1 }),
        trade({ pnl: -1 }),
      ],
      curve([1000, 999, 998, 1003, 1002, 1001, 1000]),
      1000,
    );
    expect(m.maxConsecutiveLosses).toBe(3);
  });

  it("reports total return against the starting equity", () => {
    const m = computeMetrics([trade({ pnl: 100 })], curve([1000, 1100]), 1000);
    expect(m.totalReturn).toBeCloseTo(0.1);
    expect(m.finalEquity).toBeCloseTo(1100);
  });
});

describe("fitnessScore", () => {
  const good = computeMetrics(
    Array.from({ length: 50 }, (_, i) => trade({ pnl: i % 3 === 0 ? -5 : 10, rMultiple: i % 3 === 0 ? -1 : 1.5 })),
    curve(Array.from({ length: 60 }, (_, i) => 1000 + i * 5)),
    1000,
  );

  it("penalises a sample below the minimum trade count", () => {
    const thin = computeMetrics([trade()], curve([1000, 1010]), 1000);
    expect(fitnessScore(thin, 20)).toBeLessThan(0);
  });

  it("rewards a healthy sample", () => {
    expect(fitnessScore(good, 20)).toBeGreaterThan(0);
  });

  it("punishes drawdown", () => {
    const drawn = { ...good, maxDrawdown: 0.5 };
    expect(fitnessScore(drawn, 20)).toBeLessThan(fitnessScore(good, 20));
  });

  it("stays finite for degenerate inputs", () => {
    expect(Number.isFinite(fitnessScore(EMPTY_METRICS, 20))).toBe(true);
  });
});

describe("groupMetrics", () => {
  it("splits trades by key and aggregates each bucket", () => {
    const grouped = groupMetrics(
      [
        trade({ symbol: "BTCUSDT", pnl: 10 }),
        trade({ symbol: "BTCUSDT", pnl: -4 }),
        trade({ symbol: "ETHUSDT", pnl: 7 }),
      ],
      (t) => t.symbol,
    );
    expect(grouped.get("BTCUSDT")?.trades).toBe(2);
    expect(grouped.get("BTCUSDT")?.totalPnl).toBeCloseTo(6);
    expect(grouped.get("BTCUSDT")?.winRate).toBeCloseTo(0.5);
    expect(grouped.get("ETHUSDT")?.trades).toBe(1);
  });
});
