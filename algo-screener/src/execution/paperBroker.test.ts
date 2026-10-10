import { describe, expect, it } from "vitest";
import { PaperBroker } from "./paperBroker.js";
import { checkRisk, scalePlan } from "./riskManager.js";
import { DEFAULT_PARAMS } from "../strategy/params.js";
import type { TradePlan } from "../types.js";

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: "BTCUSDT",
    side: "long",
    timeframe: "1h",
    entry: 100,
    stopLoss: 95,
    takeProfits: [
      { price: 110, fraction: 0.5 },
      { price: 120, fraction: 0.5 },
    ],
    riskFraction: 0.01,
    quantity: 10,
    notional: 1000,
    rMultiple: 2,
    confidence: 0.7,
    reasons: ["test"],
    createdAt: 0,
    ...overrides,
  };
}

/** Broker with fees and slippage off, so arithmetic is exact. */
function cleanBroker(cash = 10_000): PaperBroker {
  return new PaperBroker(cash, { feeRate: 0, slippageRate: 0 });
}

describe("paper broker — longs", () => {
  it("debits cash on entry and credits it on exit", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    expect(broker.availableCash).toBeCloseTo(9000);
    broker.close("BTCUSDT", 110, 1, "take_profit", 1);
    expect(broker.availableCash).toBeCloseTo(10_100);
  });

  it("computes PnL, percentage and R multiple on a winner", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    const trade = broker.close("BTCUSDT", 110, 1, "take_profit", 1);
    expect(trade?.pnl).toBeCloseTo(100);
    expect(trade?.pnlPct).toBeCloseTo(0.1);
    // Risk was 5/unit; a 10/unit gain is 2R.
    expect(trade?.rMultiple).toBeCloseTo(2);
  });

  it("computes a -1R loss when stopped at the stop price", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    const trade = broker.close("BTCUSDT", 95, 1, "stop_loss", 1);
    expect(trade?.rMultiple).toBeCloseTo(-1);
    expect(trade?.pnl).toBeCloseTo(-50);
  });

  it("supports partial exits and keeps the remainder open", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    broker.close("BTCUSDT", 110, 1, "take_profit", 0.5);
    const position = broker.position("BTCUSDT");
    expect(position?.quantity).toBeCloseTo(5);
    expect(broker.closedTrades).toHaveLength(1);
    broker.close("BTCUSDT", 120, 2, "take_profit", 1);
    expect(broker.position("BTCUSDT")).toBeUndefined();
    expect(broker.closedTrades).toHaveLength(2);
  });

  it("refuses an order it cannot fund", () => {
    const broker = cleanBroker(500);
    expect(broker.open(plan(), 0)).toBeNull();
  });

  it("refuses a second position in the same symbol", () => {
    const broker = cleanBroker();
    expect(broker.open(plan(), 0)).not.toBeNull();
    expect(broker.open(plan(), 1)).toBeNull();
  });
});

describe("paper broker — shorts", () => {
  it("profits when price falls", () => {
    const broker = cleanBroker();
    broker.open(plan({ side: "short", stopLoss: 105 }), 0);
    const trade = broker.close("BTCUSDT", 90, 1, "take_profit", 1);
    expect(trade?.pnl).toBeCloseTo(100);
    expect(trade?.rMultiple).toBeCloseTo(2);
  });

  it("loses when price rises", () => {
    const broker = cleanBroker();
    broker.open(plan({ side: "short", stopLoss: 105 }), 0);
    const trade = broker.close("BTCUSDT", 105, 1, "stop_loss", 1);
    expect(trade?.pnl).toBeCloseTo(-50);
    expect(trade?.rMultiple).toBeCloseTo(-1);
  });

  it("marks equity down as a short moves against it", () => {
    const broker = cleanBroker();
    broker.open(plan({ side: "short", stopLoss: 105 }), 0);
    expect(broker.equity(new Map([["BTCUSDT", 110]]))).toBeCloseTo(10_000 - 100);
  });
});

describe("paper broker — costs", () => {
  it("charges fees on both sides of a round trip", () => {
    const broker = new PaperBroker(10_000, { feeRate: 0.001, slippageRate: 0 });
    broker.open(plan(), 0);
    const trade = broker.close("BTCUSDT", 100, 1, "manual", 1);
    // Flat price, so PnL is exactly the two fees: 1000*0.001 * 2.
    expect(trade?.pnl).toBeCloseTo(-2);
    expect(trade?.fees).toBeCloseTo(2);
  });

  it("applies slippage against the trader on entry and exit", () => {
    const broker = new PaperBroker(10_000, { feeRate: 0, slippageRate: 0.01 });
    const position = broker.open(plan(), 0);
    expect(position?.entryPrice).toBeCloseTo(101); // paid up to buy
    const trade = broker.close("BTCUSDT", 100, 1, "manual", 1);
    expect(trade?.exitPrice).toBeCloseTo(99); // sold down
    expect(trade?.pnl).toBeLessThan(0);
  });
});

describe("paper broker — accounting", () => {
  it("tracks the favourable extreme in each direction", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    broker.updateExtreme("BTCUSDT", 130, 90);
    expect(broker.position("BTCUSDT")?.extreme).toBeCloseTo(130);

    const shortBroker = cleanBroker();
    shortBroker.open(plan({ symbol: "ETHUSDT", side: "short", stopLoss: 105 }), 0);
    shortBroker.updateExtreme("ETHUSDT", 130, 90);
    expect(shortBroker.position("ETHUSDT")?.extreme).toBeCloseTo(90);
  });

  it("reports mark-to-market equity and unrealised PnL", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    const prices = new Map([["BTCUSDT", 110]]);
    expect(broker.equity(prices)).toBeCloseTo(10_100);
    expect(broker.unrealised(prices)).toBeCloseTo(100);
  });

  it("measures drawdown from peak equity", () => {
    const broker = cleanBroker();
    broker.snapshot(0, new Map());
    broker.open(plan(), 0);
    broker.snapshot(1, new Map([["BTCUSDT", 120]])); // peak 10,200
    expect(broker.drawdown(new Map([["BTCUSDT", 100]]))).toBeCloseTo(200 / 10_200);
  });

  it("round-trips state through toJSON/restore", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    broker.close("BTCUSDT", 110, 1, "take_profit", 0.5);
    const snapshot = broker.toJSON();

    const restored = cleanBroker();
    restored.restore(snapshot);
    expect(restored.availableCash).toBeCloseTo(broker.availableCash);
    expect(restored.openPositions).toHaveLength(1);
    expect(restored.closedTrades).toHaveLength(1);
  });
});

describe("risk manager", () => {
  const prices = new Map([["BTCUSDT", 100]]);

  it("allows a normal entry", () => {
    const broker = cleanBroker();
    expect(checkRisk(plan(), broker, prices, DEFAULT_PARAMS).allowed).toBe(true);
  });

  it("blocks a second position in the same symbol", () => {
    const broker = cleanBroker();
    broker.open(plan(), 0);
    const verdict = checkRisk(plan(), broker, prices, DEFAULT_PARAMS);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("already holding");
  });

  it("blocks entries once the position limit is reached", () => {
    const broker = cleanBroker(1_000_000);
    const params = { ...DEFAULT_PARAMS, risk: { ...DEFAULT_PARAMS.risk, maxOpenPositions: 2 } };
    broker.open(plan({ symbol: "AAAUSDT" }), 0);
    broker.open(plan({ symbol: "BBBUSDT" }), 0);
    const verdict = checkRisk(plan({ symbol: "CCCUSDT" }), broker, prices, params);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("max open positions");
  });

  it("scales an oversized position down instead of rejecting it", () => {
    const broker = cleanBroker(10_000);
    const oversized = plan({ quantity: 50, notional: 5000 });
    const verdict = checkRisk(oversized, broker, prices, DEFAULT_PARAMS);
    expect(verdict.allowed).toBe(true);
    expect(verdict.sizeMultiplier).toBeLessThan(1);
    const scaled = scalePlan(oversized, verdict.sizeMultiplier);
    // Default maxPositionFraction is 0.25 of 10,000 equity.
    expect(scaled.notional).toBeLessThanOrEqual(2500.001);
  });

  it("refuses to size a position on a dead account", () => {
    const broker = new PaperBroker(0, { feeRate: 0, slippageRate: 0 });
    expect(checkRisk(plan(), broker, prices, DEFAULT_PARAMS).allowed).toBe(false);
  });

  it("leaves price levels untouched when scaling", () => {
    const scaled = scalePlan(plan(), 0.5);
    expect(scaled.quantity).toBeCloseTo(5);
    expect(scaled.stopLoss).toBe(95);
    expect(scaled.takeProfits).toEqual(plan().takeProfits);
  });
});
