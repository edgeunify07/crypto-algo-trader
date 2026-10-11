import { NextResponse } from "next/server";

/**
 * Order book, recent market trades and the 24h ticker for one symbol.
 *
 * Bundled into one route because the terminal view needs all three together
 * and three separate polls would triple the request count for no benefit.
 * Nothing here is cached — a stale order book is worse than none.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const HOSTS = (
  process.env.BINANCE_FUTURES_HOSTS ?? "https://www.binance.com,https://fapi.binance.com"
)
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

async function get<T>(path: string): Promise<T | null> {
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(7000),
      });
      if (res.ok) return (await res.json()) as T;
    } catch {
      // Try the next host.
    }
  }
  return null;
}

interface RawDepth {
  bids: [string, string][];
  asks: [string, string][];
}
interface RawTrade {
  id: number;
  price: string;
  qty: string;
  time: number;
  isBuyerMaker: boolean;
}
interface RawTicker {
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  volume: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  /**
   * Binance futures depth accepts only a fixed set of limits and rejects
   * anything else with -4021, which returns an empty book rather than an
   * obvious error. Snap the request up to the nearest allowed value.
   */
  const ALLOWED_DEPTHS = [5, 10, 20, 50, 100, 500, 1000];
  const requested = Number(url.searchParams.get("depth") ?? "10") || 10;
  const depthLimit =
    ALLOWED_DEPTHS.find((d) => d >= requested) ?? ALLOWED_DEPTHS[ALLOWED_DEPTHS.length - 1]!;

  const [depth, trades, ticker] = await Promise.all([
    get<RawDepth>(`/fapi/v1/depth?symbol=${symbol}&limit=${depthLimit}`),
    get<RawTrade[]>(`/fapi/v1/trades?symbol=${symbol}&limit=20`),
    get<RawTicker>(`/fapi/v1/ticker/24hr?symbol=${symbol}`),
  ]);

  if (!depth && !trades && !ticker) {
    return NextResponse.json(
      { error: `market data unreachable for ${symbol}` },
      { status: 503 },
    );
  }

  const bids = (depth?.bids ?? []).map(([p, q]) => ({ price: +p, qty: +q }));
  const asks = (depth?.asks ?? []).map(([p, q]) => ({ price: +p, qty: +q }));

  // Running totals let the UI draw depth bars without recomputing per render.
  let bidTotal = 0;
  let askTotal = 0;
  const bidRows = bids.map((b) => ({ ...b, total: (bidTotal += b.qty) }));
  const askRows = asks.map((a) => ({ ...a, total: (askTotal += a.qty) }));

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;

  return NextResponse.json(
    {
      symbol,
      bids: bidRows,
      asks: askRows,
      maxTotal: Math.max(bidTotal, askTotal),
      spread: bestAsk && bestBid ? bestAsk - bestBid : 0,
      spreadPct: bestAsk && bestBid ? (bestAsk - bestBid) / bestBid : 0,
      trades: (trades ?? []).reverse().map((t) => ({
        id: t.id,
        price: +t.price,
        qty: +t.qty,
        time: t.time,
        // isBuyerMaker true means the aggressor was a seller.
        side: t.isBuyerMaker ? "sell" : "buy",
      })),
      ticker: ticker
        ? {
            lastPrice: +ticker.lastPrice,
            changePct: +ticker.priceChangePercent / 100,
            high: +ticker.highPrice,
            low: +ticker.lowPrice,
            quoteVolume: +ticker.quoteVolume,
            volume: +ticker.volume,
          }
        : null,
      updatedAt: Date.now(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
