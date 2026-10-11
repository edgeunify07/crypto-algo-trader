import { config } from "../config.js";
import type { TradePlan } from "../types.js";
import type { PaperBroker } from "./paperBroker.js";
import type { StrategyParams } from "../strategy/params.js";

export interface RiskVerdict {
  allowed: boolean;
  reason: string;
  /** Size multiplier to apply to the plan (1 = unchanged). */
  sizeMultiplier: number;
}

const ALLOW: RiskVerdict = { allowed: true, reason: "ok", sizeMultiplier: 1 };

/**
 * Account-level risk gate, applied after the strategy has produced a plan.
 *
 * The strategy decides *whether the setup is good*; this decides *whether the
 * account can afford it right now*. Keeping them separate means the LLM can
 * tune the strategy freely without ever being able to tune away the account's
 * loss limits — those come from config, not from the params it edits.
 */
export function checkRisk(
  plan: TradePlan,
  broker: PaperBroker,
  prices: Map<string, number>,
  params: StrategyParams,
): RiskVerdict {
  const equity = broker.equity(prices);
  if (equity <= 0) {
    return { allowed: false, reason: "account equity is exhausted", sizeMultiplier: 0 };
  }

  // Hard account limits — config-owned, never LLM-tunable.
  const drawdown = broker.drawdown(prices);
  if (drawdown >= config.risk.maxDrawdown) {
    return {
      allowed: false,
      reason: `max drawdown reached (${(drawdown * 100).toFixed(1)}%)`,
      sizeMultiplier: 0,
    };
  }

  const dailyLoss = broker.dailyLoss(prices);
  if (dailyLoss >= config.risk.maxDailyLoss) {
    return {
      allowed: false,
      reason: `daily loss limit reached (${(dailyLoss * 100).toFixed(1)}%)`,
      sizeMultiplier: 0,
    };
  }

  const open = broker.openPositions;
  const maxOpen = Math.min(params.risk.maxOpenPositions, config.risk.maxOpenPositions);
  if (open.length >= maxOpen) {
    return { allowed: false, reason: `max open positions (${maxOpen})`, sizeMultiplier: 0 };
  }

  if (config.risk.oneTradePerSymbol && broker.position(plan.symbol)) {
    return {
      allowed: false,
      reason: `already holding ${plan.symbol}`,
      sizeMultiplier: 0,
    };
  }

  // Notional cap.
  const maxNotional =
    equity * Math.min(params.risk.maxPositionFraction, config.risk.maxPositionFraction);
  let sizeMultiplier = 1;
  if (plan.notional > maxNotional) {
    sizeMultiplier = maxNotional / plan.notional;
  }

  // Long entries must be funded with cash on hand.
  if (plan.side === "long") {
    const affordable = broker.availableCash * 0.995; // leave room for fees
    if (plan.notional * sizeMultiplier > affordable) {
      sizeMultiplier = affordable / plan.notional;
    }
  }

  if (sizeMultiplier <= 0.05) {
    return { allowed: false, reason: "insufficient free capital", sizeMultiplier: 0 };
  }

  // Scale down as drawdown deepens: half the risk at half the limit.
  const drawdownScale = Math.max(0.3, 1 - drawdown / config.risk.maxDrawdown);
  sizeMultiplier *= drawdownScale;

  return { ...ALLOW, sizeMultiplier };
}

/** Apply a size multiplier to a plan, preserving its price levels. */
export function scalePlan(plan: TradePlan, multiplier: number): TradePlan {
  if (multiplier === 1) return plan;
  return {
    ...plan,
    quantity: plan.quantity * multiplier,
    notional: plan.notional * multiplier,
    riskFraction: plan.riskFraction * multiplier,
  };
}
