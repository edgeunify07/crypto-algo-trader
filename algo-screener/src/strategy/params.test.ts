import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  StrategyParamsSchema,
  defaultVersionedParams,
  paramsVersionId,
  sanitiseParams,
  timeframeWeight,
} from "./params.js";
import { evaluateExits } from "./strategy.js";
import type { Position } from "../types.js";

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "BTCUSDT",
    side: "long",
    quantity: 1,
    entryPrice: 100,
    openedAt: 0,
    stopLoss: 95,
    takeProfits: [
      { price: 110, fraction: 0.5, hit: false },
      { price: 120, fraction: 0.5, hit: false },
    ],
    extreme: 100,
    feesPaid: 0,
    timeframe: "1h",
    paramsVersion: "test",
    tags: [],
    ...overrides,
  };
}

describe("default params", () => {
  it("satisfies its own schema", () => {
    expect(StrategyParamsSchema.safeParse(DEFAULT_PARAMS).success).toBe(true);
  });

  it("weights higher timeframes above lower ones", () => {
    expect(timeframeWeight(DEFAULT_PARAMS, "1d")).toBeGreaterThan(
      timeframeWeight(DEFAULT_PARAMS, "5m"),
    );
  });

  it("mints unique version ids", () => {
    expect(paramsVersionId("llm")).not.toBe(paramsVersionId("llm"));
    expect(paramsVersionId("llm").startsWith("llm-")).toBe(true);
    expect(defaultVersionedParams().source).toBe("default");
  });
});

describe("sanitiseParams", () => {
  it("leaves valid params untouched", () => {
    const { params, repairs } = sanitiseParams(DEFAULT_PARAMS);
    expect(repairs).toEqual([]);
    expect(params).toEqual(DEFAULT_PARAMS);
  });

  it("repairs an inverted EMA pair", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.indicators.emaFast = 60;
    broken.indicators.emaSlow = 30;
    const { params, repairs } = sanitiseParams(broken);
    expect(params.indicators.emaSlow).toBeGreaterThan(params.indicators.emaFast);
    expect(repairs.join(" ")).toContain("emaSlow");
  });

  it("repairs inverted RSI bands", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.indicators.rsiOversold = 80;
    broken.indicators.rsiOverbought = 60;
    const { params } = sanitiseParams(broken);
    expect(params.indicators.rsiOversold).toBeLessThan(params.indicators.rsiOverbought);
  });

  it("normalises take-profit fractions that sum above 1", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.exit.takeProfitFractions = [0.8, 0.8, 0.8];
    const { params } = sanitiseParams(broken);
    const total = params.exit.takeProfitFractions.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });

  it("sorts the take-profit ladder ascending", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.exit.takeProfitRMultiples = [3, 1, 2];
    const { params } = sanitiseParams(broken);
    expect(params.exit.takeProfitRMultiples).toEqual([1, 2, 3]);
  });

  it("truncates a mismatched ladder to equal lengths", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.exit.takeProfitRMultiples = [1, 2, 3];
    broken.exit.takeProfitFractions = [0.5];
    const { params, repairs } = sanitiseParams(broken);
    expect(params.exit.takeProfitRMultiples).toHaveLength(1);
    expect(repairs.join(" ")).toContain("truncated");
  });

  it("restores defaults when every component weight is zero", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    for (const key of Object.keys(broken.weights) as (keyof typeof broken.weights)[]) {
      broken.weights[key] = 0;
    }
    const { params, repairs } = sanitiseParams(broken);
    expect(params.weights).toEqual(DEFAULT_PARAMS.weights);
    expect(repairs.join(" ")).toContain("reset to defaults");
  });

  it("does not mutate the input", () => {
    const input = structuredClone(DEFAULT_PARAMS);
    input.indicators.emaFast = 60;
    input.indicators.emaSlow = 30;
    sanitiseParams(input);
    expect(input.indicators.emaSlow).toBe(30);
  });
});

describe("schema bounds", () => {
  it("rejects risk per trade above the cap", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.risk.riskPerTrade = 0.5;
    expect(StrategyParamsSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a negative component weight", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.weights.elliott = -1;
    expect(StrategyParamsSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an empty take-profit ladder", () => {
    const broken = structuredClone(DEFAULT_PARAMS);
    broken.exit.takeProfitRMultiples = [];
    expect(StrategyParamsSchema.safeParse(broken).success).toBe(false);
  });
});

describe("evaluateExits", () => {
  const params = DEFAULT_PARAMS;

  it("closes the whole position when the stop is touched", () => {
    const decisions = evaluateExits(
      position(),
      { high: 101, low: 94, close: 96 },
      0.5,
      2,
      1,
      params,
    );
    expect(decisions).toEqual([{ action: "close", reason: "stop_loss", fraction: 1 }]);
  });

  it("prioritises the stop over a target touched in the same bar", () => {
    // A bar spanning both levels must resolve conservatively.
    const decisions = evaluateExits(
      position(),
      { high: 115, low: 94, close: 100 },
      0.5,
      2,
      1,
      params,
    );
    expect(decisions[0]).toEqual({ action: "close", reason: "stop_loss", fraction: 1 });
  });

  it("takes partial profit when a rung is reached", () => {
    const decisions = evaluateExits(
      position(),
      { high: 111, low: 99, close: 110 },
      0.5,
      2,
      1,
      params,
    );
    expect(decisions.some((d) => d.action === "close" && d.reason === "take_profit")).toBe(true);
  });

  it("raises the stop to break-even once the trade is 1R ahead", () => {
    const decisions = evaluateExits(
      position({ extreme: 105 }),
      { high: 105, low: 103, close: 104 },
      0.5,
      2,
      1,
      params,
    );
    const update = decisions.find((d) => d.action === "update_stop");
    expect(update).toBeDefined();
    if (update?.action === "update_stop") {
      expect(update.stopLoss).toBeGreaterThanOrEqual(100);
    }
  });

  it("never widens the stop", () => {
    const decisions = evaluateExits(
      position({ extreme: 101 }),
      { high: 101, low: 99, close: 100 },
      0.5,
      2,
      1,
      params,
    );
    const update = decisions.find((d) => d.action === "update_stop");
    if (update?.action === "update_stop") {
      expect(update.stopLoss).toBeGreaterThanOrEqual(95);
    }
  });

  it("exits on a signal flip against the position", () => {
    const decisions = evaluateExits(
      position(),
      { high: 101, low: 99, close: 100 },
      -0.9,
      2,
      1,
      params,
    );
    expect(decisions.some((d) => d.action === "close" && d.reason === "signal_flip")).toBe(true);
  });

  it("exits a short on a positive signal flip", () => {
    const decisions = evaluateExits(
      position({ side: "short", stopLoss: 105, takeProfits: [{ price: 90, fraction: 1, hit: false }] }),
      { high: 101, low: 99, close: 100 },
      0.9,
      2,
      1,
      params,
    );
    expect(decisions.some((d) => d.action === "close" && d.reason === "signal_flip")).toBe(true);
  });

  it("closes on the time stop", () => {
    const decisions = evaluateExits(
      position(),
      { high: 101, low: 99, close: 100 },
      0.1,
      2,
      params.exit.maxHoldBars + 1,
      params,
    );
    expect(decisions.some((d) => d.action === "close" && d.reason === "max_hold")).toBe(true);
  });

  it("holds when nothing is triggered", () => {
    const quiet = { ...params, exit: { ...params.exit, breakEvenR: 0, trailStartR: 0 } };
    const decisions = evaluateExits(
      position(),
      { high: 101, low: 99, close: 100 },
      0.1,
      2,
      1,
      quiet,
    );
    expect(decisions).toEqual([{ action: "hold" }]);
  });
});
