// Low-level Binance REST client: lightweight, zero heavy deps. Uses Node's
// built-in crypto for HMAC-SHA256 request signing (Binance's auth scheme).
import crypto from "node:crypto";
import { API_KEY, API_SECRET, DATA_BASE, TRADE_BASE, hasCredentials } from "./config";

export class BinanceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "BinanceError";
  }
}

function toQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** Unsigned public request (market data). */
export async function publicGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  base = DATA_BASE,
): Promise<T> {
  const qs = toQuery(params);
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new BinanceError(`Binance ${res.status} ${path}: ${body}`, res.status);
  }
  return res.json() as Promise<T>;
}

/**
 * Signed request against the trading base (spot). Timestamp + HMAC-SHA256
 * signature are appended automatically. Throws if credentials are missing so
 * we never silently send an unauthenticated order.
 */
export async function signedRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  if (!hasCredentials()) {
    throw new BinanceError("Binance API credentials are not configured", 401);
  }
  const withTs = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const query = toQuery(withTs);
  const signature = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  const url = `${TRADE_BASE}${path}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const c = json as { code?: number; msg?: string };
    throw new BinanceError(c.msg ?? `Binance ${res.status} ${path}`, res.status, c.code);
  }
  return json as T;
}
