import { describe, it, expect, beforeAll } from "vitest";
import { backtestScalp } from "./scalpEngine";
import { ALL_STRATEGIES, buyAndHoldBenchmark } from "../strategies/registry";
import { MIN_TARGET_PCT } from "../engine/protection";
import { BINANCE_SPOT_COSTS } from "../costs";
import type { Candle } from "../types";
import type { Strategy } from "../strategies/types";
import type { AggTrade } from "../data/aggTrades";

/**
 * These tests pin the *honesty* properties of the scalp engine: per-exit-type
 * costs, gap-through pricing, the take-profit cost floor, force-close, and the
 * no-lookahead rule on the entry bar. Each was an optimistic bug that inflated
 * win rate or return before the repair.
 */

const T0 = 1_700_000_000;
const MAKER = 0.001;
const TAKER = 0.002; // deliberately ≠ MAKER so the applied rate is provable
const SLIP = BINANCE_SPOT_COSTS.slippageRate;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: T0 + i * 60, open: o, high: h, low: l, close: c, volume: 100, closeTime: T0 + i * 60 + 59 };
}

/** Sells while long on `sellAt`; buys once when flat. Drives the signal-exit path. */
const stubSeller: Strategy = {
  id: "test-scalp-stub-seller",
  name: "stub",
  description: "test fixture",
  params: { sellAt: 2 },
  next(ctx, params) {
    if (ctx.position === "flat" && ctx.index === 0) return "buy";
    if (ctx.position === "long" && ctx.index >= params.sellAt) return "sell";
    return "hold";
  },
};

beforeAll(() => {
  if (!ALL_STRATEGIES.some((s) => s.id === stubSeller.id)) ALL_STRATEGIES.push(stubSeller);
});

/** buy-and-hold fixture: buys on bar 0, never sells → exits come from the engine. */
function run(candles: Candle[], over: Record<string, number> = {}, aggTrades: AggTrade[] = [], klineOnly?: boolean) {
  return backtestScalp(
    buyAndHoldBenchmark,
    candles,
    { warmup: 0, ...over },
    {
      startEquity: 10_000,
      interval: "1m",
      aggTrades,
      ...(klineOnly === undefined ? {} : { klineOnly }),
      spreadBps: 0, // limit == prior close, keeps the arithmetic exact
      makerFeeRate: MAKER,
      takerFeeRate: TAKER,
      maxHoldBars: 50,
      ...over,
    },
  );
}

describe("scalp engine — gap-through stop", () => {
  it("books a gapped stop at the open, not at the (better) stop price", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),      // signal → limit 100
      bar(1, 100, 100.2, 99.5, 100),      // fills at 100; stop 99, target 101
      bar(2, 98, 98.1, 97.5, 97.8),       // gaps BELOW the stop
      bar(3, 98.5, 99, 98.0, 98.6),       // limit 97.8 unfilled (low 98.0 > 97.8)
    ];
    const r = run(c, { targetPct: 0.01, stopPct: 0.01 });

    expect(r.numTrades).toBe(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("SL-kline");
    expect(t.exitPrice).toBeCloseTo(98 * (1 - SLIP), 10); // open 98, not stop 99
    expect(t.exitPrice).toBeLessThan(99);
    expect(t.slippageCost).toBeGreaterThan(0);
    // A stop booked at 99 would have lost ~1%; the honest gap loss is ~2%.
    expect(t.returnPct).toBeLessThan(-1.9);
  });

  it("never books a stop better than the stop level when there is no gap", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.2, 99.5, 100),
      bar(2, 100, 100.1, 98.5, 99.2),     // trades through the stop intrabar
      bar(3, 99.5, 99.6, 99.4, 99.5),
    ];
    const r = run(c, { targetPct: 0.01, stopPct: 0.01 });
    const t = r.trades[0];
    expect(t.exitReason).toBe("SL-kline");
    expect(t.exitPrice).toBeCloseTo(99 * (1 - SLIP), 10); // min(stop 99, open 100) = 99
  });
});

describe("scalp engine — force-close", () => {
  it("books the still-open position at the last close so win rate includes it", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),      // fills at 100
      bar(2, 100, 100.5, 99.8, 100.4),    // no SL/TP → still open at the end
    ];
    const r = run(c, { targetPct: 0.01, stopPct: 0.01 });

    expect(r.numTrades).toBe(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("eod-close");
    expect(t.exitBar).toBe(2);
    expect(t.exitPrice).toBeCloseTo(100.4 * (1 - SLIP), 10);
    expect(t.slippageCost).toBeGreaterThan(0);            // forced exit is a taker
    expect(t.exitFee).toBeCloseTo(t.qty * t.exitPrice * TAKER, 8);
    expect(r.winRate).toBe(100);
    // endEquity is realized cash, not a marked-to-market open position
    expect(r.endEquity).toBeCloseTo(10_000 + t.pnl, 6);
  });
});

describe("scalp engine — take-profit cost floor", () => {
  it("clamps a sub-floor target up to MIN_TARGET_PCT and flags it", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),      // fills at 100 → floored target 100.45
      bar(2, 100, 100.3, 99.8, 100.25),   // clears the OLD 0.2% target (100.20) only
    ];
    const r = run(c, { targetPct: 0.002, stopPct: 0.01 });

    expect(r.scalpMeta.widenedForCost).toBe(true);
    expect(MIN_TARGET_PCT).toBeCloseTo(0.0045, 10);
    // The 0.2% "win" must not be booked — it cannot pay the 0.30% round-trip.
    expect(r.trades.some((t) => (t.exitReason ?? "").startsWith("TP"))).toBe(false);
    expect(r.trades[0].exitReason).toBe("eod-close");
  });

  it("leaves a target above the floor untouched", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.6, 100), bar(2, 100, 100.3, 99.8, 100.2)];
    const r = run(c, { targetPct: 0.006, stopPct: 0.006 });
    expect(r.scalpMeta.widenedForCost).toBe(false);
  });
});

describe("scalp engine — per-exit-type costs", () => {
  it("charges the maker fee and zero slippage on a resting take-profit", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),      // fills at 100 → target 100.6
      bar(2, 100, 100.7, 99.5, 100.65),   // lifts the resting sell
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01 });
    const t = r.trades[0];
    expect(t.exitReason).toBe("TP-kline");
    expect(t.exitPrice).toBeCloseTo(100.6, 10);           // exactly the target, no slippage
    expect(t.slippageCost).toBe(0);
    expect(t.exitFee).toBeCloseTo(t.qty * 100.6 * MAKER, 8);
    expect(r.scalpMeta.takerFills).toBe(0);
  });

  it("charges the taker fee plus slippage on a stop-loss", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),
      bar(2, 100, 100.1, 98.5, 99.2),     // stop 99 hit intrabar
      bar(3, 99.5, 99.6, 99.4, 99.5),
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01 });
    const t = r.trades[0];
    expect(t.exitReason).toBe("SL-kline");
    expect(t.exitFee).toBeCloseTo(t.qty * t.exitPrice * TAKER, 8);
    expect(t.slippageCost).toBeCloseTo(t.qty * 99 * SLIP, 8);
    expect(r.scalpMeta.takerFills).toBe(1);
  });

  it("charges the maker fee on the resting limit entry", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.6, 100), bar(2, 100, 100.2, 99.8, 100.1)];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01 });
    const t = r.trades[0];
    expect(t.entryFee).toBeCloseTo(10_000 * MAKER, 8);
    expect(t.entryPrice).toBeCloseTo(100, 10);            // filled at the limit, no slippage
    expect(t.qty).toBeCloseTo((10_000 - 10_000 * MAKER) / 100, 10);
  });

  it("charges the taker fee plus slippage on a signal exit", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),
      bar(2, 100, 100.2, 99.8, 100.1),    // stub sells here
      bar(3, 100.1, 100.2, 100.05, 100.15),
    ];
    const r = backtestScalp(stubSeller, c, { sellAt: 2, targetPct: 0.006, stopPct: 0.01 }, {
      startEquity: 10_000, interval: "1m", aggTrades: [], spreadBps: 0,
      makerFeeRate: MAKER, takerFeeRate: TAKER, maxHoldBars: 50,
    });
    const t = r.trades[0];
    expect(t.exitReason).toBe("signal");
    expect(t.exitPrice).toBeCloseTo(100.1 * (1 - SLIP), 10);
    expect(t.exitFee).toBeCloseTo(t.qty * t.exitPrice * TAKER, 8);
    expect(t.slippageCost).toBeGreaterThan(0);
  });

  it("charges the taker fee plus slippage on a max-hold timeout", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),      // entry bar (held 0)
      bar(2, 100, 100.2, 99.8, 100.05),   // held 1
      bar(3, 100, 100.2, 99.8, 100.1),    // held 2 → max-hold
      bar(4, 100, 100.2, 99.8, 100.1),
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01, maxHoldBars: 2 });
    const t = r.trades[0];
    expect(t.exitReason).toBe("max-hold");
    expect(t.exitBar).toBe(3);
    expect(r.scalpMeta.maxHoldExits).toBe(1);
    expect(t.exitFee).toBeCloseTo(t.qty * t.exitPrice * TAKER, 8);
    expect(t.slippageCost).toBeGreaterThan(0);
  });
});

describe("scalp engine — no lookahead on the entry bar", () => {
  it("does not book a take-profit from a pre-fill high (kline)", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      // The 101.5 high may have occurred BEFORE the limit filled at 99.9 — booking
      // TP here would be a fabricated win. Target is 100.6.
      bar(1, 100.9, 101.5, 99.9, 100.05),
      bar(2, 100, 100.3, 99.8, 100.2),
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01 });
    expect(r.scalpMeta.makerFills).toBeGreaterThanOrEqual(1); // it did fill
    expect(r.trades.some((t) => (t.exitReason ?? "").startsWith("TP"))).toBe(false);
    expect(r.trades[0].exitReason).toBe("eod-close");
  });

  it("cannot exit on max-hold at held 0 when maxHoldBars is degenerate", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.6, 100), bar(2, 100, 100.2, 99.8, 100.1)];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01, maxHoldBars: 0 });
    expect(r.trades[0].exitReason).not.toBe("max-hold");
    expect(r.trades[0].exitReason).toBe("eod-close");
    expect(r.scalpMeta.maxHoldExits).toBe(0);
  });

  it("books a take-profit from a POST-fill trade but not a PRE-fill trade (aggTrade)", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 101.5, 99.9, 100.05), bar(2, 100, 100.3, 99.8, 100.2)];
    const b1 = (T0 + 60) * 1000;
    const mk = (offsetMs: number, price: number): AggTrade =>
      ({ aggId: offsetMs, price, qty: 1, time: b1 + offsetMs, isBuyerMaker: false });

    // Pre-fill spike only → must NOT book TP (target 100.6).
    const pre = run(c, { targetPct: 0.006, stopPct: 0.01 }, [mk(500, 101), mk(1000, 99.95)]);
    expect(pre.scalpMeta.klineOnly).toBe(false);
    expect(pre.scalpMeta.makerFills).toBeGreaterThanOrEqual(1);
    expect(pre.trades.some((t) => t.exitReason === "TP")).toBe(false);

    // Post-fill spike → TP is legitimate.
    const post = run(c, { targetPct: 0.006, stopPct: 0.01 }, [mk(1000, 99.95), mk(2000, 100.7)]);
    const tp = post.trades.find((t) => t.exitReason === "TP");
    expect(tp).toBeDefined();
    expect(tp!.exitPrice).toBeCloseTo(100.6, 10);
    expect(tp!.slippageCost).toBe(0);
  });
});

describe("scalp engine — data-quality guards", () => {
  it("forces klineOnly when there are no aggTrades even if told otherwise", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.6, 100), bar(2, 100, 100.2, 99.8, 100.1)];
    const r = run(c, { targetPct: 0.006, stopPct: 0.01 }, [], false);
    expect(r.scalpMeta.klineOnly).toBe(true);   // promotion gate must stay blocked
    expect(r.numTrades).toBeGreaterThan(0);     // the kline branch actually ran
  });

  it("falls back to a sane stop when stopPct is degenerate", () => {
    const c = [bar(0, 100, 100.1, 99.9, 100), bar(1, 100, 100.1, 99.6, 100), bar(2, 100, 100.2, 99.8, 100.1)];
    for (const stopPct of [0, -0.01, 0.9]) {
      const r = run(c, { targetPct: 0.006, stopPct });
      expect(r.numTrades).toBe(1);
      expect(r.trades[0].exitReason).toBe("eod-close"); // 0.6% stop → not hit here
    }
  });

  it("measures drawdown from the bar low, not the close", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),
      bar(2, 100, 100.2, 95, 100),        // deep wick, closes flat; stop is 10% away
      bar(3, 100, 100.2, 99.8, 100),
    ];
    const r = run(c, { targetPct: 0.02, stopPct: 0.1 });
    expect(r.maxDrawdownPct).toBeGreaterThan(4.5); // ~5% from the wick, ~0 from closes
  });

  it("returns an empty result for a degenerate window", () => {
    const r = run([bar(0, 100, 100.1, 99.9, 100)]);
    expect(r.numTrades).toBe(0);
    expect(r.endEquity).toBe(10_000);
  });
});

describe("scalp engine — accounting identities", () => {
  it("reconciles endEquity with the sum of realized trade P&L", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),
      bar(2, 100, 100.8, 99.5, 100.7),   // TP
      bar(3, 100.7, 100.8, 100.6, 100.7),
      bar(4, 100.7, 100.8, 99.0, 99.2),  // next entry stops out
      bar(5, 99.2, 99.3, 99.1, 99.2),
      bar(6, 99.2, 99.3, 99.1, 99.2),
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.006 });
    expect(r.numTrades).toBeGreaterThanOrEqual(2);
    const sumPnl = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.endEquity).toBeCloseTo(10_000 + sumPnl, 6);
    expect(r.totalReturnPct).toBeCloseTo((sumPnl / 10_000) * 100, 8);
    expect(r.expectancy).toBeCloseTo(sumPnl / r.numTrades, 8);
    // every fee/slippage the trades report is in the run totals
    expect(r.totalFeesPaid).toBeCloseTo(r.trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0), 6);
    expect(r.totalSlippagePaid).toBeCloseTo(r.trades.reduce((s, t) => s + t.slippageCost, 0), 6);
  });

  it("reports a maker fill ratio consistent with the fill counters", () => {
    const c = [
      bar(0, 100, 100.1, 99.9, 100),
      bar(1, 100, 100.1, 99.6, 100),
      bar(2, 100, 100.8, 99.5, 100.7),   // maker TP
      bar(3, 100.7, 100.8, 100.6, 100.7),
      bar(4, 100.7, 100.8, 99.0, 99.2),  // taker SL
      bar(5, 99.2, 99.3, 99.1, 99.2),
      bar(6, 99.2, 99.3, 99.1, 99.2),
    ];
    const r = run(c, { targetPct: 0.006, stopPct: 0.006 });
    const m = r.scalpMeta;
    expect(m.makerFills + m.takerFills).toBeGreaterThan(0);
    expect(m.makerFillRatio).toBeCloseTo(m.makerFills / (m.makerFills + m.takerFills), 10);
    expect(m.takerFills).toBeGreaterThan(0); // honest: stops/forced exits are takers
  });
});
