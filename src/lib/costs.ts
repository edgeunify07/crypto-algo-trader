/**
 * Trading cost models. Kept in their own module so both the backtest engine and
 * the protection/exit logic can import them without a circular dependency.
 */
export interface CostModel {
  /** Exchange fee per trade side, as a fraction (0.001 = 0.1%). Applied to fill notional. */
  feeRate: number;
  /** Slippage per side as a fraction of price (0.0005 = 5 bps). Buys pay more, sells receive less. */
  slippageRate: number;
  /** Legacy India TDS on sell proceeds (fraction). Binance spot = 0. */
  tdsRate: number;
  /** Post-run capital gains tax on net profit (fraction). Not auto-applied for Binance. */
  capitalGainsRate: number;
}

export const INDIA_SPOT_COSTS: CostModel = {
  feeRate: 0.005,
  tdsRate: 0.01,
  capitalGainsRate: 0.3,
  slippageRate: 0.001,
};

export const BINANCE_SPOT_COSTS: CostModel = {
  feeRate: 0.001,
  tdsRate: 0,
  capitalGainsRate: 0,
  slippageRate: 0.0005,
};

/** Total round-trip drag for a taker in/taker out trade: 0.30% by default. */
export function roundTripCost(costs: CostModel = BINANCE_SPOT_COSTS): number {
  return (costs.feeRate + costs.slippageRate) * 2;
}
