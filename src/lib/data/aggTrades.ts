import { publicGet } from "../binance/client";

export interface AggTrade {
  aggId: number;
  price: number;
  qty: number;
  time: number; // ms
  isBuyerMaker: boolean;
}

type RawAgg = { a: number; p: string; q: string; T: number; m: boolean };

/** Fetch aggTrades for a time window (paginated, mainnet public data). */
export async function fetchAggTrades(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<AggTrade[]> {
  const all: AggTrade[] = [];
  let cursor = startMs;
  const sym = symbol.toUpperCase();

  while (cursor < endMs) {
    const batch = await publicGet<RawAgg[]>("/api/v3/aggTrades", {
      symbol: sym,
      startTime: cursor,
      endTime: endMs,
      limit: 1000,
    });
    if (batch.length === 0) break;
    for (const t of batch) {
      all.push({
        aggId: t.a,
        price: Number(t.p),
        qty: Number(t.q),
        time: t.T,
        isBuyerMaker: t.m,
      });
    }
    const last = batch[batch.length - 1].T;
    if (last <= cursor) break;
    cursor = last + 1;
    if (batch.length < 1000) break;
  }

  return all;
}

/** Trades within [barOpenMs, barCloseMs). */
export function aggTradesForBar(trades: AggTrade[], barOpenSec: number, barCloseSec: number): AggTrade[] {
  const open = barOpenSec * 1000;
  const close = barCloseSec * 1000;
  return trades.filter((t) => t.time >= open && t.time < close);
}

/**
 * Pessimistic intra-bar replay: if both stop and target inside bar range,
 * assume stop hit first (worst case for long).
 */
export function barHitsStopBeforeTarget(
  trades: AggTrade[],
  entryPrice: number,
  stop: number,
  target: number,
): "stop" | "target" | "none" {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  for (const t of sorted) {
    if (t.price <= stop) return "stop";
    if (t.price >= target) return "target";
  }
  // Fallback if no agg trades: use pessimistic assumption when both in range
  if (sorted.length === 0) {
    const lo = Math.min(...trades.map((x) => x.price), entryPrice);
    const hi = Math.max(...trades.map((x) => x.price), entryPrice);
    if (lo <= stop && hi >= target) return "stop";
  }
  return "none";
}

/** Would a maker buy limit at `limitPrice` fill within these trades? (no cross) */
export function makerBuyFills(trades: AggTrade[], limitPrice: number): boolean {
  return trades.some((t) => t.price <= limitPrice);
}

/** Would a maker sell limit at `limitPrice` fill? */
export function makerSellFills(trades: AggTrade[], limitPrice: number): boolean {
  return trades.some((t) => t.price >= limitPrice);
}
