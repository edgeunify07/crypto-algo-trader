import { describe, expect, it } from "vitest";
import { pointInTimeUniverse, runFuturesBacktest, type BacktestInput } from "./backtest";
import { DEFAULT_PARAMS, type StrategyParams } from "@/lib/algo/strategy/params";
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

/**
 * Entry thresholds loose enough that a synthetic series actually trades.
 *
 * These tests are about mechanics — the universe gate, the drawdown halt,
 * what a scalp does once taken — not about how the live strategy happens to
 * be tuned. Running them on `DEFAULT_PARAMS` tied them to that tuning, and
 * they duly went silent the first time it was retuned to require Gann
 * agreement: every assertion still passed except the ones checking a trade
 * had happened at all, which is the worst way for a test to fail.
 */
const TRADES_READILY: StrategyParams = {
  ...DEFAULT_PARAMS,
  entry: {
    ...DEFAULT_PARAMS.entry,
    minScore: 0.15,
    minConfidence: 0.15,
    minAlignment: 0.2,
    requireElliottAgreement: false,
    requireGannAgreement: false,
    avoidGannTimeCycle: false,
  },
  scalp: { ...DEFAULT_PARAMS.scalp, enabled: false },
};

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

    const ungated = runFuturesBacktest(data, TRADES_READILY, {
      stepTimeframe: "1h",
      startingBalance: 100,
    });
    const gated = runFuturesBacktest(data, TRADES_READILY, {
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
    const open = runFuturesBacktest(data, TRADES_READILY, {
      stepTimeframe: "1h",
      startingBalance: 100,
    });
    const wide = runFuturesBacktest(data, TRADES_READILY, {
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

    const unhalted = runFuturesBacktest(data, TRADES_READILY, { ...common, maxDrawdownHalt: 1 });
    const halted = runFuturesBacktest(data, TRADES_READILY, { ...common, maxDrawdownHalt: 0.02 });

    // Guards against a vacuous pass: the run has to lose enough to trip a 2%
    // halt, and to have kept trading without one.
    expect(unhalted.maxDrawdown).toBeGreaterThan(0.02);
    expect(halted.trades.length).toBeLessThan(unhalted.trades.length);
  });

  it("caps a position's notional at the configured multiple of equity", () => {
    const data = [input("A", choppy(500, 0))];
    const common = { stepTimeframe: "1h" as const, startingBalance: 100 };

    const capped = runFuturesBacktest(data, TRADES_READILY, {
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

describe("runFuturesBacktest scalp rule", () => {
  /** A clean rising series, so a long that is opened will reach its target. */
  const rising = (bars: number) =>
    series(bars, () => 1_000, (i) => 100 * (1 + 0.004 * i + 0.015 * Math.sin(i / 9)));

  /**
   * Confidence never reaches 0.8 in practice, so these drive the rule from a
   * threshold low enough to fire. The behaviour under test is what a scalp
   * does once taken, not how often the blend is sure.
   */
  const withScalp = (over: Partial<typeof DEFAULT_PARAMS.scalp>) => ({
    ...TRADES_READILY,
    scalp: { ...DEFAULT_PARAMS.scalp, enabled: true, minConfidence: 0.1, ...over },
  });

  const common = { stepTimeframe: "1h" as const, startingBalance: 100 };
  const data = [input("A", rising(600)), input("B", rising(600).slice(40))];

  it("exits at the configured move, and labels only that exit as the scalp's", () => {
    const r = runFuturesBacktest(
      data,
      withScalp({ targetPct: 0.03, closeFraction: 1 }),
      common,
    );
    const hits = r.trades.filter((t) => t.exitReason === "scalp_target");
    expect(hits.length).toBeGreaterThan(0);
    for (const t of hits) {
      // Filled at the target, so the move is the configured one either way.
      const move = t.side === "long"
        ? (t.exitPrice - t.entryPrice) / t.entryPrice
        : (t.entryPrice - t.exitPrice) / t.entryPrice;
      expect(move).toBeCloseTo(0.03, 6);
    }
  });

  it("leaves the rest on the swing ladder when it closes only part", () => {
    const r = runFuturesBacktest(
      data,
      withScalp({ targetPct: 0.03, closeFraction: 0.5 }),
      common,
    );
    const scalpExits = r.trades.filter((t) => t.exitReason === "scalp_target");
    expect(scalpExits.length).toBeGreaterThan(0);
    // The scalp's own exit still lands exactly on its target...
    for (const t of scalpExits) {
      const move =
        t.side === "long"
          ? (t.exitPrice - t.entryPrice) / t.entryPrice
          : (t.entryPrice - t.exitPrice) / t.entryPrice;
      expect(move).toBeCloseTo(0.03, 6);
    }
    // ...and the remainder leaves under a different name, which is the whole
    // point of giving the scalp its own exit reasons.
    expect(r.trades.some((t) => !t.exitReason.startsWith("scalp_"))).toBe(true);
  });

  it("gives up on its own clock, not the swing one", () => {
    // Far enough away that the clock runs out first.
    const r = runFuturesBacktest(
      data,
      withScalp({ targetPct: 0.45, maxHoldBars: 6, closeFraction: 1 }),
      common,
    );
    const timeouts = r.trades.filter((t) => t.exitReason === "scalp_timeout");
    expect(timeouts.length).toBeGreaterThan(0);
    // The swing limit is far longer, so nothing should exit under its name.
    expect(r.trades.some((t) => t.exitReason === "max_hold")).toBe(false);
  });

  it("does nothing when disabled", () => {
    const off = runFuturesBacktest(data, TRADES_READILY, common);
    expect(off.trades.some((t) => t.exitReason.startsWith("scalp_"))).toBe(false);
  });

  it("does not disturb the swing book at the shipped threshold", () => {
    // The shipped config is selective enough that it never triggers on this
    // series, so the swing results have to come out bit-identical. If a
    // future retune makes it fire here, this is the test that notices.
    const shipped = runFuturesBacktest(
      data,
      { ...TRADES_READILY, scalp: DEFAULT_PARAMS.scalp },
      common,
    );
    const off = runFuturesBacktest(data, TRADES_READILY, common);
    expect(shipped.trades.length).toBe(off.trades.length);
    expect(shipped.totalReturn).toBeCloseTo(off.totalReturn, 10);
  });
});
