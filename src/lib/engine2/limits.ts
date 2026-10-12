/**
 * The risk limits both engines trade under.
 *
 * Its own module so the backtester can ask for them without importing the
 * live tick, which drags in storage, the exchange client and the universe
 * resolver — none of which a pure simulation should need to load.
 */
import { DEFAULT_PARAMS, type StrategyParams } from "@/lib/algo/strategy/params";
import { DEFAULT_LEVERAGE } from "@/lib/store/account";

export interface TickRiskLimits {
  maxOpenPositions: number;
  maxDrawdown: number;
  /** Fraction of equity a stop-out may cost. The brake. */
  riskPerTrade: number;
  /** Share of equity to commit as margin when the brake allows. The ambition. */
  capitalPerTrade: number;
  /** Cap on one position's notional as a fraction of equity. */
  maxPositionFraction: number;
  leverage: number;
}

/**
 * The limits this tick trades under.
 *
 * These come from the strategy parameters, which is where the dashboard,
 * the backtester and the improvement loop all read them. They did not: every
 * value here was an environment variable with a hardcoded fallback, so
 * `risk.riskPerTrade`, `risk.maxPositionFraction` and `risk.maxOpenPositions`
 * in the shipped parameters were dead settings that nothing read. The account
 * was described by one set of numbers and traded by another — the shipped
 * parameters said a stop costs 1% of equity and capped a position at 25% of
 * it, while the engine risked 2% and allowed 150%.
 *
 * An environment variable still wins where one is set, because that is how a
 * deployment pins a limit without editing parameters the improvement loop may
 * rewrite. But absent one, the parameters decide.
 */
export function riskLimits(params: StrategyParams = DEFAULT_PARAMS): TickRiskLimits {
  const env = (name: string, fallback: number) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    maxOpenPositions: env("MAX_OPEN_POSITIONS", params.risk.maxOpenPositions),
    maxDrawdown: env("MAX_DRAWDOWN", 0.3),
    riskPerTrade: env("RISK_PER_TRADE", params.risk.riskPerTrade),
    capitalPerTrade: env("CAPITAL_PER_TRADE", params.risk.capitalPerTrade),
    maxPositionFraction: env("MAX_POSITION_FRACTION", params.risk.maxPositionFraction),
    leverage: DEFAULT_LEVERAGE,
  };
}
