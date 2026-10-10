import type {
  Position,
  PriceLevel,
  ScreenerRow,
  Side,
  TimeframeAnalysis,
  TradePlan,
} from "../types.js";
import { clamp } from "../util/math.js";
import { elliottTargets } from "../analysis/elliott.js";
import type { StrategyParams } from "./params.js";

/**
 * Turn a screener verdict into an executable trade plan, or reject it.
 *
 * Stops are placed at the nearest *structural* level beyond an ATR floor, not
 * at a naive fixed percentage: a stop that sits just past a swing low or a Gann
 * angle is where the trade thesis is actually wrong. Targets prefer Elliott
 * projections and Gann levels when `useStructuralTargets` is on, falling back
 * to R multiples.
 */
export function buildTradePlan(
  row: ScreenerRow,
  anchor: TimeframeAnalysis,
  params: StrategyParams,
  equity: number,
): TradePlan | null {
  const { entry, exit, risk } = params;
  const reasons: string[] = [];

  if (row.direction === "flat") return null;
  const side: Side = row.direction;
  if (side === "short" && !entry.allowShorts) return null;

  if (Math.abs(row.score) < entry.minScore) return null;
  if (row.confidence < entry.minConfidence) return null;
  if (row.alignment < entry.minAlignment) return null;
  if (row.quoteVolume24h < entry.minQuoteVolume24h) return null;

  // Optional theory gates.
  if (entry.requireElliottAgreement) {
    if (anchor.elliott.pattern === "none" || anchor.elliott.bias !== side) return null;
    reasons.push(
      `Elliott ${anchor.elliott.pattern} count agrees (wave ${anchor.elliott.currentWave})`,
    );
  }
  if (entry.requireGannAgreement) {
    if (anchor.gann.bias !== side) return null;
    reasons.push("Gann fan bias agrees");
  }
  if (entry.avoidGannTimeCycle) {
    const { barsSinceAnchor, nearestCycle, distance } = anchor.gann.timeCycle;
    const window = Math.max(1, Math.round(nearestCycle * 0.05));
    if (nearestCycle > 0 && distance <= window && barsSinceAnchor > 0) {
      // Inside a Gann reversal window — stand aside rather than fight it.
      return null;
    }
  }

  const price = anchor.price;
  const atr = anchor.atr;
  if (!(price > 0) || !(atr > 0)) return null;

  const stopLoss = chooseStop(side, price, atr, anchor.levels, params);
  const riskPerUnit = Math.abs(price - stopLoss);
  if (!(riskPerUnit > 0)) return null;

  // Reject stops that are absurdly wide relative to the move we expect.
  if (riskPerUnit / price > 0.25) return null;

  const takeProfits = chooseTargets(side, price, riskPerUnit, anchor, params);
  if (takeProfits.length === 0) return null;

  // --- Position sizing --------------------------------------------------
  // Risk a fixed fraction of equity, then scale down when realised volatility
  // is above target so a volatile symbol doesn't quietly take more risk.
  const volScale = clamp(
    risk.volatilityTargetAtrPct / Math.max(anchor.regime.atrPct, 1e-6),
    0.25,
    1,
  );
  const riskFraction = risk.riskPerTrade * volScale;
  const riskCapital = equity * riskFraction;
  let quantity = riskCapital / riskPerUnit;

  // Cap the notional regardless of how tight the stop is.
  const maxNotional = equity * risk.maxPositionFraction;
  if (quantity * price > maxNotional) {
    quantity = maxNotional / price;
  }
  if (!(quantity > 0)) return null;

  const bestTarget = takeProfits.at(-1)?.price ?? price;
  const rMultiple = Math.abs(bestTarget - price) / riskPerUnit;

  reasons.unshift(
    `${side} on ${row.symbol} ${anchor.timeframe}: score ${row.score.toFixed(2)}, alignment ${(row.alignment * 100).toFixed(0)}%, regime ${anchor.regime.kind}`,
  );
  for (const component of anchor.components) {
    if (Math.abs(component.score) >= 0.4 && component.confidence >= 0.4) {
      reasons.push(`${component.name}: ${component.note}`);
    }
  }

  return {
    symbol: row.symbol,
    side,
    timeframe: anchor.timeframe,
    entry: price,
    stopLoss,
    takeProfits,
    riskFraction,
    quantity,
    notional: quantity * price,
    rMultiple,
    confidence: row.confidence,
    reasons,
    createdAt: anchor.asOf,
  };
}

/**
 * Stop placement: start from an ATR stop, then extend to just beyond the
 * nearest meaningful structural level in the stop's direction (within reason),
 * so the stop sits where the thesis breaks rather than where noise reaches.
 */
function chooseStop(
  side: Side,
  price: number,
  atr: number,
  levels: PriceLevel[],
  params: StrategyParams,
): number {
  const atrStop =
    side === "long"
      ? price - atr * params.exit.atrStopMultiple
      : price + atr * params.exit.atrStopMultiple;

  const candidates = levels
    .filter((l) => l.weight >= 0.35)
    .filter((l) => (side === "long" ? l.price < price : l.price > price))
    // Only consider levels within 1.5x the ATR stop distance.
    .filter((l) => Math.abs(price - l.price) <= atr * params.exit.atrStopMultiple * 1.5)
    .sort((a, b) =>
      side === "long" ? b.price - a.price : a.price - b.price,
    );

  const structural = candidates[0];
  if (!structural) return atrStop;

  // Place the stop just beyond the level (0.15 ATR of buffer).
  const buffer = atr * 0.15;
  const structuralStop =
    side === "long" ? structural.price - buffer : structural.price + buffer;

  // Never tighten inside half the ATR stop — that invites noise stop-outs.
  const minDistance = atr * params.exit.atrStopMultiple * 0.5;
  if (Math.abs(price - structuralStop) < minDistance) return atrStop;

  return side === "long"
    ? Math.min(atrStop, structuralStop)
    : Math.max(atrStop, structuralStop);
}

/**
 * Build the take-profit ladder. Structural targets (Elliott projections, Gann
 * levels, swing resistance) replace the R-multiple rungs when they fall in a
 * sensible range, because price actually reacts there.
 */
function chooseTargets(
  side: Side,
  price: number,
  riskPerUnit: number,
  anchor: TimeframeAnalysis,
  params: StrategyParams,
): { price: number; fraction: number }[] {
  const { takeProfitRMultiples, takeProfitFractions, useStructuralTargets } =
    params.exit;

  const rungs = takeProfitRMultiples.map((r, i) => ({
    price: side === "long" ? price + riskPerUnit * r : price - riskPerUnit * r,
    fraction: takeProfitFractions[i] ?? 0,
    r,
  }));

  if (!useStructuralTargets) {
    return rungs
      .filter((t) => t.fraction > 0)
      .map(({ price: p, fraction }) => ({ price: p, fraction }));
  }

  const structural = [
    ...elliottTargets(anchor.elliott, price).map((p) => ({ price: p, weight: 0.8 })),
    ...anchor.levels
      .filter((l) => (side === "long" ? l.kind === "resistance" : l.kind === "support"))
      .map((l) => ({ price: l.price, weight: l.weight })),
  ].filter((t) => (side === "long" ? t.price > price : t.price < price));

  return rungs
    .filter((rung) => rung.fraction > 0)
    .map((rung) => {
      // Snap a rung to a nearby structural level if one sits within 35% of the
      // rung's distance — close enough to be the same idea, better located.
      const rungDistance = Math.abs(rung.price - price);
      const match = structural
        .filter((t) => Math.abs(Math.abs(t.price - price) - rungDistance) <= rungDistance * 0.35)
        .sort((a, b) => b.weight - a.weight)[0];
      return {
        price: match ? match.price : rung.price,
        fraction: rung.fraction,
      };
    })
    .filter((t) => (side === "long" ? t.price > price : t.price < price));
}

export type ExitReasonLite =
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "signal_flip"
  | "max_hold";

export type ExitDecision =
  | { action: "hold" }
  | { action: "close"; reason: ExitReasonLite; fraction: number }
  | { action: "update_stop"; stopLoss: number };

/**
 * Evaluate an open position against the current bar and signal.
 *
 * Returns every action that applies this bar, in priority order — stops are
 * checked before targets so a bar that touches both is resolved conservatively
 * (a backtest that assumes the target filled first overstates results).
 */
export function evaluateExits(
  position: Position,
  bar: { high: number; low: number; close: number },
  currentScore: number,
  atr: number,
  barsHeld: number,
  params: StrategyParams,
): ExitDecision[] {
  const decisions: ExitDecision[] = [];
  const long = position.side === "long";
  const riskPerUnit = Math.abs(position.entryPrice - position.stopLoss);

  // 1. Stop loss — assumed to fill first on any bar that touches it.
  const stopHit = long ? bar.low <= position.stopLoss : bar.high >= position.stopLoss;
  if (stopHit) {
    return [{ action: "close", reason: "stop_loss", fraction: 1 }];
  }

  // 2. Take-profit ladder.
  for (const tp of position.takeProfits) {
    if (tp.hit || tp.fraction <= 0) continue;
    const hit = long ? bar.high >= tp.price : bar.low <= tp.price;
    if (hit) {
      decisions.push({ action: "close", reason: "take_profit", fraction: tp.fraction });
    }
  }

  // 3. Stop management — break-even, then trailing.
  if (riskPerUnit > 0) {
    const favourable = long
      ? position.extreme - position.entryPrice
      : position.entryPrice - position.extreme;
    const rEarned = favourable / riskPerUnit;

    let newStop = position.stopLoss;

    if (params.exit.breakEvenR > 0 && rEarned >= params.exit.breakEvenR) {
      newStop = long
        ? Math.max(newStop, position.entryPrice)
        : Math.min(newStop, position.entryPrice);
    }
    if (
      params.exit.trailStartR > 0 &&
      rEarned >= params.exit.trailStartR &&
      atr > 0
    ) {
      const trail = long
        ? position.extreme - atr * params.exit.trailAtrMultiple
        : position.extreme + atr * params.exit.trailAtrMultiple;
      newStop = long ? Math.max(newStop, trail) : Math.min(newStop, trail);
    }

    // Only ever tighten — a widening stop would increase risk after entry.
    const tightened = long ? newStop > position.stopLoss : newStop < position.stopLoss;
    if (tightened) decisions.push({ action: "update_stop", stopLoss: newStop });
  }

  // 4. Signal flip.
  if (params.exit.exitOnScoreFlip > 0) {
    const against = long ? -currentScore : currentScore;
    if (against >= params.exit.exitOnScoreFlip) {
      decisions.push({ action: "close", reason: "signal_flip", fraction: 1 });
    }
  }

  // 5. Time stop.
  if (barsHeld >= params.exit.maxHoldBars) {
    decisions.push({ action: "close", reason: "max_hold", fraction: 1 });
  }

  return decisions.length > 0 ? decisions : [{ action: "hold" }];
}
