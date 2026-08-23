import { describe, it, expect } from "vitest";
import { backtest, BINANCE_SPOT_COSTS, LIVE_EXIT_POLICY, type ExitPolicy } from "./backtest";
import { buyAndHoldBenchmark } from "./strategies/registry";
import type { Candle } from "./types";

/**
 * buyAndHoldBenchmark buys once and never sells, so every exit observed here is
 * produced by the bracket logic under test.
 */
const STRAT = buyAndHoldBenchmark;
const PARAMS = { warmup: 20 };

function bar(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 100 };
}

/** `flat` bars to warm up ATR, then caller-supplied bars. */
function series(tail: Candle[], base = 100, flatCount = 30): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < flatCount; i++) {
    out.push(bar(1_700_000_000 + i * 900, base, base + 1, base - 1, base));
  }
  const t0 = 1_700_000_000 + flatCount * 900;
  tail.forEach((b, i) => out.push({ ...b, time: t0 + i * 900 }));
  return out;
}

const policy: ExitPolicy = { stopLossAtrMult: 2, takeProfitRr: 1.5, atrPeriod: 14 };

describe("backtest bracket exits", () => {
  it("does not exit on stop/target when no exit policy is supplied", () => {
    const candles = series([bar(0, 100, 100, 50, 50), bar(0, 50, 50, 40, 45)]);
    const r = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS);
    // Only the end-of-data force close.
    expect(r.trades.map((t) => t.exitReason)).toEqual(["eod-close"]);
  });

  it("exits at the stop when the bar low breaches it", () => {
    const candles = series([
      bar(0, 100, 101, 99, 100),
      bar(0, 100, 100, 90, 91), // deep breach
      bar(0, 91, 92, 90, 91),
    ]);
    const r = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS, undefined, policy);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].exitReason).toBe("stop-loss");
    expect(r.trades[0].pnl).toBeLessThan(0);
  });

  it("fills a gap through the stop at the open, not at the stop price", () => {
    // Bar opens far below the stop — a real fill cannot be better than the open.
    const gapped = series([
      bar(0, 100, 101, 99, 100),
      bar(0, 80, 81, 79, 80), // gap down through any sane stop
    ]);
    const r = backtest(STRAT, gapped, PARAMS, 1000, BINANCE_SPOT_COSTS, undefined, policy);
    const t = r.trades[0];
    expect(t.exitReason).toBe("stop-loss");
    // Exit must be at/below the gapped open (plus sell slippage), i.e. ~80, not ~98.5.
    expect(t.exitPrice).toBeLessThanOrEqual(80);
    expect(t.returnPct).toBeLessThan(-15);
  });

  it("exits at the target when the bar high reaches it", () => {
    const candles = series([
      bar(0, 100, 101, 99, 100),
      bar(0, 100, 110, 100, 109),
      bar(0, 109, 110, 108, 109),
    ]);
    const r = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS, undefined, policy);
    expect(r.trades[0].exitReason).toBe("take-profit");
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it("assumes the STOP fills first when both levels are touchable in one bar", () => {
    // Wide bar that reaches both the target and the stop.
    const candles = series([
      bar(0, 100, 101, 99, 100),
      bar(0, 100, 115, 85, 100),
    ]);
    const r = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS, undefined, policy);
    expect(r.trades[0].exitReason).toBe("stop-loss");
  });

  it("force-exits after maxHoldBars", () => {
    const candles = series(
      Array.from({ length: 10 }, () => bar(0, 100, 100.2, 99.8, 100)),
    );
    const r = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS, undefined, {
      ...policy,
      maxHoldBars: 3,
    });
    expect(r.trades[0].exitReason).toBe("max-hold");
    expect(r.trades[0].exitBar - r.trades[0].entryBar).toBe(3);
  });

  it("LIVE_EXIT_POLICY mirrors the live runner defaults", () => {
    expect(LIVE_EXIT_POLICY.stopLossAtrMult).toBe(2);
    expect(LIVE_EXIT_POLICY.takeProfitRr).toBe(1.5);
    expect(LIVE_EXIT_POLICY.useSignalExit).toBe(true);
  });

  it("measures drawdown from bar lows, not closes", () => {
    // Price dips hard intrabar but closes flat; a close-only curve would miss it.
    const candles = series([
      bar(0, 100, 101, 99, 100),
      bar(0, 100, 100, 70, 100),
    ]);
    const noBracket = backtest(STRAT, candles, PARAMS, 1000, BINANCE_SPOT_COSTS);
    expect(noBracket.maxDrawdownPct).toBeGreaterThan(20);
  });
});
