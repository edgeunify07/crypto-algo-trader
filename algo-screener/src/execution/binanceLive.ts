import { config } from "../config.js";
import { signedRequest, type SymbolFilters } from "../binance/rest.js";
import { createLogger } from "../util/logger.js";
import { roundToStep } from "../util/math.js";
import type { Order, TradePlan } from "../types.js";

const log = createLogger("binance:live");

interface RawOrderResponse {
  orderId: number;
  symbol: string;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  fills?: { price: string; qty: string; commission: string }[];
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

/**
 * Real Binance order routing.
 *
 * Every call here moves real money, so the guard is deliberately blunt: live
 * trading requires BOTH `LIVE_TRADING=true` and API credentials, and the
 * check runs on every single order rather than once at startup.
 */
function assertLiveEnabled(): void {
  if (!config.runtime.liveTrading) {
    throw new Error(
      "Live trading is disabled. Set LIVE_TRADING=true to enable real orders.",
    );
  }
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    throw new Error("BINANCE_API_KEY and BINANCE_API_SECRET are required for live trading.");
  }
}

export async function fetchBalances(): Promise<AccountBalance[]> {
  assertLiveEnabled();
  const account = await signedRequest<{
    balances: { asset: string; free: string; locked: string }[];
  }>("/api/v3/account", {});
  return account.balances
    .map((b) => ({
      asset: b.asset,
      free: Number(b.free),
      locked: Number(b.locked),
    }))
    .filter((b) => b.free > 0 || b.locked > 0);
}

/**
 * Place a market order sized to the plan, rounded to the symbol's filters.
 * Returns the resulting order, including the average fill price.
 */
export async function placeMarketOrder(
  plan: TradePlan,
  filters: SymbolFilters | undefined,
): Promise<Order & { avgPrice: number }> {
  assertLiveEnabled();

  const stepSize = filters?.stepSize ?? 0.000001;
  const quantity = roundToStep(plan.quantity, stepSize);
  const minNotional = filters?.minNotional ?? 5;

  if (quantity <= 0 || quantity * plan.entry < minNotional) {
    throw new Error(
      `${plan.symbol}: order of ${quantity} is below the exchange minimum notional (${minNotional})`,
    );
  }

  const side = plan.side === "long" ? "BUY" : "SELL";
  log.warn(`placing LIVE ${side} market order: ${quantity} ${plan.symbol}`);

  const response = await signedRequest<RawOrderResponse>(
    "/api/v3/order",
    { symbol: plan.symbol, side, type: "MARKET", quantity },
    "POST",
  );

  const executed = Number(response.executedQty);
  const quote = Number(response.cummulativeQuoteQty);
  const avgPrice = executed > 0 ? quote / executed : plan.entry;

  return {
    id: String(response.orderId),
    symbol: response.symbol,
    side: plan.side === "long" ? "buy" : "sell",
    type: "market",
    quantity: executed,
    price: avgPrice,
    createdAt: Date.now(),
    status: response.status === "FILLED" ? "filled" : "new",
    avgPrice,
  };
}

/**
 * Place a stop-loss order on the exchange so the stop survives this process
 * dying. Binance spot uses STOP_LOSS_LIMIT; the limit is offset past the
 * trigger so it fills rather than resting.
 */
export async function placeStopLoss(
  symbol: string,
  side: "long" | "short",
  quantity: number,
  stopPrice: number,
  filters: SymbolFilters | undefined,
): Promise<Order> {
  assertLiveEnabled();
  const tickSize = filters?.tickSize ?? 0.01;
  const stepSize = filters?.stepSize ?? 0.000001;

  const orderSide = side === "long" ? "SELL" : "BUY";
  // Offset the limit by 0.3% past the trigger so the order actually fills.
  const limitPrice =
    side === "long" ? stopPrice * 0.997 : stopPrice * 1.003;

  const response = await signedRequest<RawOrderResponse>(
    "/api/v3/order",
    {
      symbol,
      side: orderSide,
      type: "STOP_LOSS_LIMIT",
      timeInForce: "GTC",
      quantity: roundToStep(quantity, stepSize),
      stopPrice: roundToStep(stopPrice, tickSize),
      price: roundToStep(limitPrice, tickSize),
    },
    "POST",
  );

  return {
    id: String(response.orderId),
    symbol,
    side: orderSide === "SELL" ? "sell" : "buy",
    type: "limit",
    quantity: Number(response.executedQty) || quantity,
    price: limitPrice,
    createdAt: Date.now(),
    status: "new",
  };
}

export async function cancelOrder(symbol: string, orderId: string): Promise<void> {
  assertLiveEnabled();
  await signedRequest("/api/v3/order", { symbol, orderId }, "DELETE");
}

export async function cancelAllOrders(symbol: string): Promise<void> {
  assertLiveEnabled();
  await signedRequest("/api/v3/openOrders", { symbol }, "DELETE");
}
