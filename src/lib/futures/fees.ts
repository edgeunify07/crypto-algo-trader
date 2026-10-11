/**
 * Binance USDⓈ-M perpetual futures cost model.
 *
 * Every number a trader actually pays is modelled here, because a paper
 * account that ignores them reports a profit the real account would not have
 * made. On a $100 account at 3x, costs are not a rounding error: one round
 * trip at taker fees is 0.10% of notional, which at $300 notional is $0.30 —
 * 0.3% of the whole account.
 */

/**
 * Standard VIP-0 USDⓈ-M futures commission.
 * Maker 0.0200%, taker 0.0500%. BNB discounts and higher VIP tiers lower
 * these; set the env vars if your account differs.
 */
export const FUTURES_FEES = {
  maker: Number(process.env.FUTURES_MAKER_FEE ?? "0.0002"),
  taker: Number(process.env.FUTURES_TAKER_FEE ?? "0.0005"),
} as const;

/** Funding settles every 8 hours, at 00:00, 08:00 and 16:00 UTC. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * Tier-1 maintenance margin rates.
 *
 * The real per-symbol bracket table is only available from the authenticated
 * `/fapi/v1/leverageBracket` endpoint, so these are the published tier-1
 * values for majors with a conservative default for everything else. At 3x on
 * a small account every position sits in tier 1, so tier 1 is the only row
 * that matters here. A higher MMR than reality makes liquidation trigger
 * slightly *early*, which is the safe direction to be wrong in.
 */
const TIER1_MMR: Record<string, number> = {
  BTCUSDT: 0.004,
  ETHUSDT: 0.004,
  BNBUSDT: 0.005,
  SOLUSDT: 0.005,
  XRPUSDT: 0.005,
  ADAUSDT: 0.005,
  DOGEUSDT: 0.005,
};
const DEFAULT_MMR = Number(process.env.FUTURES_DEFAULT_MMR ?? "0.01");

export function maintenanceMarginRate(symbol: string): number {
  return TIER1_MMR[symbol] ?? DEFAULT_MMR;
}

export type FeeRole = "maker" | "taker";

/** Commission on a fill, in quote currency (USDT). */
export function commission(notional: number, role: FeeRole = "taker"): number {
  return Math.abs(notional) * FUTURES_FEES[role];
}

/** Initial margin locked by a position at the given leverage. */
export function initialMargin(notional: number, leverage: number): number {
  if (leverage <= 0) return Math.abs(notional);
  return Math.abs(notional) / leverage;
}

/**
 * Liquidation price for an isolated-margin position.
 *
 * Derived from Binance's isolated formula: the position liquidates when
 * equity (margin + unrealised PnL) falls to the maintenance margin.
 *
 *   long:  liq = (entry·qty − margin) / (qty · (1 − mmr))
 *   short: liq = (entry·qty + margin) / (qty · (1 + mmr))
 *
 * The familiar entry·(1 − 1/L + mmr) shorthand is only an approximation of
 * this — it is off by roughly 0.2% at 3x — so the exact form is used.
 */
export function liquidationPrice(options: {
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  leverage: number;
  symbol: string;
  /** Extra margin added beyond the initial requirement. */
  extraMargin?: number;
}): number {
  const { side, entryPrice, quantity, leverage, symbol, extraMargin = 0 } = options;
  if (!(entryPrice > 0) || !(quantity > 0)) return 0;

  const mmr = maintenanceMarginRate(symbol);
  const notional = entryPrice * quantity;
  const margin = initialMargin(notional, leverage) + extraMargin;

  const price =
    side === "long"
      ? (notional - margin) / (quantity * (1 - mmr))
      : (notional + margin) / (quantity * (1 + mmr));

  return Math.max(0, price);
}

/**
 * Funding payment for a position over a settlement.
 *
 * Positive `fundingRate` means longs pay shorts. The payment is on the
 * position's notional at the mark price, so it scales with leverage — which is
 * why a leveraged position held through many settlements bleeds even when the
 * price is flat.
 */
export function fundingPayment(options: {
  side: "long" | "short";
  quantity: number;
  markPrice: number;
  fundingRate: number;
}): number {
  const { side, quantity, markPrice, fundingRate } = options;
  const notional = quantity * markPrice;
  const payment = notional * fundingRate;
  // Returned as a signed cash flow: negative means the position paid.
  return side === "long" ? -payment : payment;
}

/** Funding settlement boundaries crossed between two timestamps. */
export function fundingSettlementsBetween(from: number, to: number): number[] {
  if (!(to > from)) return [];
  const out: number[] = [];
  let boundary = Math.ceil(from / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
  while (boundary <= to) {
    out.push(boundary);
    boundary += FUNDING_INTERVAL_MS;
  }
  return out;
}

/** Unrealised PnL at the mark price, before fees. */
export function unrealisedPnl(options: {
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  markPrice: number;
}): number {
  const { side, entryPrice, quantity, markPrice } = options;
  return side === "long"
    ? (markPrice - entryPrice) * quantity
    : (entryPrice - markPrice) * quantity;
}

export interface RoundTripCost {
  entryFee: number;
  exitFee: number;
  funding: number;
  total: number;
}

/** Full cost of a round trip, used for both reporting and position sizing. */
export function roundTripCost(options: {
  entryNotional: number;
  exitNotional: number;
  fundingPaid: number;
  entryRole?: FeeRole;
  exitRole?: FeeRole;
}): RoundTripCost {
  const {
    entryNotional,
    exitNotional,
    fundingPaid,
    entryRole = "taker",
    exitRole = "taker",
  } = options;
  const entryFee = commission(entryNotional, entryRole);
  const exitFee = commission(exitNotional, exitRole);
  // `fundingPaid` is a signed cash flow; as a cost it is the negative of it.
  const funding = -fundingPaid;
  return { entryFee, exitFee, funding, total: entryFee + exitFee + funding };
}

/** Round a quantity down to the symbol's step size. */
export function roundQuantity(quantity: number, stepSize: number): number {
  if (!(stepSize > 0)) return quantity;
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  return Number((Math.floor(quantity / stepSize) * stepSize).toFixed(decimals));
}

export function roundPrice(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
  return Number((Math.round(price / tickSize) * tickSize).toFixed(decimals));
}
