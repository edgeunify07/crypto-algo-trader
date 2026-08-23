import { atrForBar } from "../indicators/structure";
import { BINANCE_SPOT_COSTS } from "../costs";
import type { Candle } from "../types";

/**
 * Round-trip cost as a fraction of notional: taker fee + slippage, both sides.
 * 0.1% + 0.05% entry, 0.1% + 0.05% exit = 0.30%.
 * Any take-profit tighter than this is mathematically unable to pay for itself.
 */
export const ROUND_TRIP_COST = (BINANCE_SPOT_COSTS.feeRate + BINANCE_SPOT_COSTS.slippageRate) * 2;

/** A target must clear cost by this multiple to be worth taking. */
export const MIN_TARGET_COST_MULTIPLE = 1.5;

/** Minimum viable take-profit distance: 0.45% by default. */
export const MIN_TARGET_PCT = ROUND_TRIP_COST * MIN_TARGET_COST_MULTIPLE;

/** Stops tighter than this get chewed up by noise + cost; wider than this is reckless. */
const MIN_STOP_PCT = ROUND_TRIP_COST * 2; // 0.6%
const MAX_STOP_PCT = 0.1; // 10%

export const DEFAULT_STOP_ATR_MULT = 2;
export const DEFAULT_TAKE_PROFIT_RR = 1.5;

export interface Protection {
  stopLoss: number;
  takeProfit: number;
  atr: number;
  /** Stop distance as a fraction of entry price. */
  riskPct: number;
  /** Target distance as a fraction of entry price. */
  targetPct: number;
  /** True when the target was widened to clear the fee+slippage floor. */
  widenedForCost: boolean;
  /** Reward:risk actually achieved after clamping. */
  effectiveRr: number;
}

export interface ProtectionOptions {
  stopLossAtrMult?: number;
  takeProfitRr?: number;
  atrPeriod?: number;
  /** Used when ATR is unavailable (too few bars). */
  fallbackStopPct?: number;
}

/**
 * Derive a protective stop-loss and take-profit for a long entry.
 *
 * Stop is ATR-based (volatility-adaptive), clamped to a sane band. The target is
 * `rr` multiples of the stop distance, but is never allowed to sit below the
 * round-trip cost floor — otherwise a "winning" trade still loses money after
 * fees, which silently inflates win rate while draining the account.
 */
export function computeProtection(
  candles: Candle[],
  index: number,
  entryPrice: number,
  opts: ProtectionOptions = {},
): Protection | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const atrPeriod = Math.max(2, Math.floor(opts.atrPeriod ?? 14));
  const stopMult = opts.stopLossAtrMult && opts.stopLossAtrMult > 0 ? opts.stopLossAtrMult : DEFAULT_STOP_ATR_MULT;
  const rr = opts.takeProfitRr && opts.takeProfitRr > 0 ? opts.takeProfitRr : DEFAULT_TAKE_PROFIT_RR;
  const fallbackStopPct = opts.fallbackStopPct ?? 0.015;

  const atr = index >= 0 && index < candles.length ? atrForBar(candles, index, atrPeriod) : 0;

  // Stop distance in price terms.
  let stopDist = atr > 0 ? atr * stopMult : entryPrice * fallbackStopPct;

  // Clamp so the stop is neither inside the noise/cost band nor absurdly wide.
  const minStopDist = entryPrice * MIN_STOP_PCT;
  const maxStopDist = entryPrice * MAX_STOP_PCT;
  if (stopDist < minStopDist) stopDist = minStopDist;
  if (stopDist > maxStopDist) stopDist = maxStopDist;

  let targetDist = stopDist * rr;
  let widenedForCost = false;
  const minTargetDist = entryPrice * MIN_TARGET_PCT;
  if (targetDist < minTargetDist) {
    targetDist = minTargetDist;
    widenedForCost = true;
  }

  const stopLoss = entryPrice - stopDist;
  const takeProfit = entryPrice + targetDist;
  if (!(stopLoss > 0) || !(takeProfit > entryPrice)) return null;

  return {
    stopLoss,
    takeProfit,
    atr,
    riskPct: stopDist / entryPrice,
    targetPct: targetDist / entryPrice,
    widenedForCost,
    effectiveRr: targetDist / stopDist,
  };
}

/** True when a take-profit target is too tight to survive fees + slippage. */
export function isTargetBelowCostFloor(targetPct: number): boolean {
  return targetPct < ROUND_TRIP_COST;
}

/** Human-readable summary for the execution log. */
export function describeProtection(p: Protection): string {
  const parts = [
    `SL ${p.stopLoss.toFixed(6)} (-${(p.riskPct * 100).toFixed(2)}%)`,
    `TP ${p.takeProfit.toFixed(6)} (+${(p.targetPct * 100).toFixed(2)}%)`,
    `RR ${p.effectiveRr.toFixed(2)}`,
  ];
  if (p.widenedForCost) parts.push(`TP widened to clear ${(ROUND_TRIP_COST * 100).toFixed(2)}% cost floor`);
  return parts.join(" · ");
}
