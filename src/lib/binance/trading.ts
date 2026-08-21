// Signed Binance spot trading calls. Every function here moves real (or
// testnet) money — they are only ever called server-side, behind the risk
// guard and env checks.
import { signedRequest } from "./client";

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface AccountInfo {
  canTrade: boolean;
  balances: Balance[];
}

export async function getAccount(): Promise<AccountInfo> {
  const raw = await signedRequest<{
    canTrade: boolean;
    balances: { asset: string; free: string; locked: string }[];
  }>("GET", "/api/v3/account");
  return {
    canTrade: raw.canTrade,
    balances: raw.balances
      .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
      .filter((b) => b.free > 0 || b.locked > 0),
  };
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number; // base asset qty
  quoteOrderQty?: number; // for MARKET buys sized in quote (USDT)
  price?: number; // required for LIMIT
  clientOrderId?: string;
}

export interface OrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status: string;
  executedQty: number;
  cummulativeQuoteQty: number;
  price: number;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
}

export async function placeOrder(p: PlaceOrderParams): Promise<OrderResult> {
  const params: Record<string, string | number | undefined> = {
    symbol: p.symbol.toUpperCase(),
    side: p.side,
    type: p.type,
    quantity: p.quantity,
    quoteOrderQty: p.quoteOrderQty,
    newClientOrderId: p.clientOrderId,
  };
  if (p.type === "LIMIT") {
    params.price = p.price;
    params.timeInForce = "GTC";
  }
  const raw = await signedRequest<{
    orderId: number;
    clientOrderId: string;
    symbol: string;
    side: OrderSide;
    type: string;
    status: string;
    executedQty: string;
    cummulativeQuoteQty: string;
    price: string;
    fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
  }>("POST", "/api/v3/order", params);
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    side: raw.side,
    type: raw.type,
    status: raw.status,
    executedQty: Number(raw.executedQty),
    cummulativeQuoteQty: Number(raw.cummulativeQuoteQty),
    price: Number(raw.price),
    fills: raw.fills,
  };
}

export async function cancelOrder(symbol: string, orderId: number) {
  return signedRequest("DELETE", "/api/v3/order", { symbol: symbol.toUpperCase(), orderId });
}

export async function getOpenOrders(symbol?: string) {
  return signedRequest<unknown[]>("GET", "/api/v3/openOrders", symbol ? { symbol: symbol.toUpperCase() } : {});
}
