import { describe, expect, it } from "vitest";
import {
  FUNDING_INTERVAL_MS,
  commission,
  fundingPayment,
  fundingSettlementsBetween,
  initialMargin,
  liquidationPrice,
  maintenanceMarginRate,
  roundQuantity,
  roundTripCost,
  unrealisedPnl,
} from "./fees";

describe("commission", () => {
  it("charges the published VIP-0 taker and maker rates", () => {
    // $300 notional: taker 0.05% = $0.15, maker 0.02% = $0.06.
    expect(commission(300, "taker")).toBeCloseTo(0.15, 10);
    expect(commission(300, "maker")).toBeCloseTo(0.06, 10);
  });

  it("is sign-independent", () => {
    expect(commission(-300, "taker")).toBeCloseTo(0.15, 10);
  });
});

describe("margin and liquidation", () => {
  it("locks notional/leverage as initial margin", () => {
    // $100 account, 3x -> $300 notional costs $100 of margin.
    expect(initialMargin(300, 3)).toBeCloseTo(100);
  });

  it("liquidates a 3x long roughly 33% below entry", () => {
    const liq = liquidationPrice({
      side: "long",
      entryPrice: 100,
      quantity: 3,
      leverage: 3,
      symbol: "BTCUSDT",
    });
    // Exact isolated formula: (300 - 100) / (3 * (1 - 0.004)) = 66.934
    expect(liq).toBeCloseTo(66.93, 1);
    // Sanity: a 3x long must survive a 30% drawdown but not a 35% one.
    expect(liq).toBeLessThan(70);
    expect(liq).toBeGreaterThan(65);
  });

  it("liquidates a 3x short roughly 33% above entry", () => {
    const liq = liquidationPrice({
      side: "short",
      entryPrice: 100,
      quantity: 3,
      leverage: 3,
      symbol: "BTCUSDT",
    });
    // Exact: (300 + 100) / (3 * (1 + 0.004)) = 132.80
    expect(liq).toBeCloseTo(132.80, 1);
  });

  it("moves liquidation further away as leverage falls", () => {
    const base = { side: "long" as const, entryPrice: 100, quantity: 1, symbol: "BTCUSDT" };
    const at3x = liquidationPrice({ ...base, leverage: 3 });
    const at10x = liquidationPrice({ ...base, leverage: 10 });
    expect(at3x).toBeLessThan(at10x);
  });

  it("never liquidates above zero for 1x longs", () => {
    const liq = liquidationPrice({
      side: "long", entryPrice: 100, quantity: 1, leverage: 1, symbol: "BTCUSDT",
    });
    // At 1x the position is fully funded; liquidation sits at ~mmr*entry.
    expect(liq).toBeLessThan(1);
    expect(liq).toBeGreaterThanOrEqual(0);
  });

  it("pushes liquidation away when extra margin is added", () => {
    const base = {
      side: "long" as const, entryPrice: 100, quantity: 3, leverage: 3, symbol: "BTCUSDT",
    };
    expect(liquidationPrice({ ...base, extraMargin: 50 })).toBeLessThan(
      liquidationPrice(base),
    );
  });

  it("uses a conservative default MMR for unlisted symbols", () => {
    expect(maintenanceMarginRate("BTCUSDT")).toBe(0.004);
    expect(maintenanceMarginRate("SOMENEWCOINUSDT")).toBe(0.01);
  });
});

describe("funding", () => {
  it("charges longs when the rate is positive", () => {
    // $300 notional at 0.01% -> $0.03 paid by the long.
    const paid = fundingPayment({
      side: "long", quantity: 3, markPrice: 100, fundingRate: 0.0001,
    });
    expect(paid).toBeCloseTo(-0.03, 10);
  });

  it("pays shorts when the rate is positive", () => {
    const received = fundingPayment({
      side: "short", quantity: 3, markPrice: 100, fundingRate: 0.0001,
    });
    expect(received).toBeCloseTo(0.03, 10);
  });

  it("flips direction with a negative rate", () => {
    expect(
      fundingPayment({ side: "long", quantity: 3, markPrice: 100, fundingRate: -0.0001 }),
    ).toBeGreaterThan(0);
  });

  it("finds the 8-hour settlement boundaries in a window", () => {
    const start = Date.UTC(2026, 0, 1, 7, 0);
    const end = Date.UTC(2026, 0, 1, 17, 0);
    const settlements = fundingSettlementsBetween(start, end);
    // 08:00 and 16:00 UTC fall inside the window.
    expect(settlements).toHaveLength(2);
    expect(new Date(settlements[0]!).getUTCHours()).toBe(8);
    expect(new Date(settlements[1]!).getUTCHours()).toBe(16);
  });

  it("returns nothing when no boundary is crossed", () => {
    const start = Date.UTC(2026, 0, 1, 9, 0);
    expect(fundingSettlementsBetween(start, start + 3_600_000)).toEqual([]);
  });

  it("settles every 8 hours", () => {
    expect(FUNDING_INTERVAL_MS).toBe(28_800_000);
  });
});

describe("pnl and round-trip cost", () => {
  it("computes unrealised PnL from the mark price", () => {
    expect(
      unrealisedPnl({ side: "long", entryPrice: 100, quantity: 3, markPrice: 110 }),
    ).toBeCloseTo(30);
    expect(
      unrealisedPnl({ side: "short", entryPrice: 100, quantity: 3, markPrice: 110 }),
    ).toBeCloseTo(-30);
  });

  it("sums both commissions and funding into one cost", () => {
    const cost = roundTripCost({
      entryNotional: 300,
      exitNotional: 310,
      fundingPaid: -0.06, // paid two settlements
    });
    expect(cost.entryFee).toBeCloseTo(0.15, 10);
    expect(cost.exitFee).toBeCloseTo(0.155, 10);
    expect(cost.funding).toBeCloseTo(0.06, 10);
    expect(cost.total).toBeCloseTo(0.365, 10);
  });

  it("shows costs are material on a $100 account at 3x", () => {
    // One round trip on $300 notional, taker both sides.
    const cost = roundTripCost({ entryNotional: 300, exitNotional: 300, fundingPaid: 0 });
    // $0.30 of fees against $100 of equity is 0.3% per trade.
    expect(cost.total / 100).toBeCloseTo(0.003, 6);
  });
});

describe("rounding to exchange filters", () => {
  it("rounds quantity down to the step size", () => {
    expect(roundQuantity(0.123456, 0.001)).toBeCloseTo(0.123);
    expect(roundQuantity(1.9999, 1)).toBe(1);
  });

  it("never rounds up past what the account can afford", () => {
    expect(roundQuantity(0.0009, 0.001)).toBe(0);
  });
});
