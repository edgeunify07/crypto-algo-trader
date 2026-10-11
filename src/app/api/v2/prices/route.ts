import { NextResponse } from "next/server";
import { fetchMarkPrices } from "@/lib/futures/rest";

/**
 * Last price for every symbol, from the server.
 *
 * The dashboard normally takes prices straight from Binance's websocket in
 * the browser, which costs this deployment nothing and updates many times a
 * second. But Binance restricts that stream by region, and where it is
 * blocked the socket connects and then stays silent — so the prices sit
 * frozen between engine ticks, five minutes apart, on a screen whose whole
 * claim is that it is live.
 *
 * This is the fallback for those browsers. The server reaches Binance through
 * a host that answers from its region, so one small request here serves every
 * symbol on the page. It stays deliberately thin — one upstream call, no
 * analysis, no storage — because unlike the socket it costs an invocation
 * every time it is polled.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request) {
  /**
   * Only the symbols asked for.
   *
   * The upstream call returns every perpetual Binance lists — 927 of them,
   * some 23KB. Polled every three seconds that is 27MB an hour on a phone,
   * to show ten numbers. The caller names what it is displaying.
   */
  const wanted = new Set(
    (new URL(request.url).searchParams.get("symbols") ?? "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
  );

  try {
    const marks = await fetchMarkPrices();
    const prices: Record<string, number> = {};
    for (const m of marks) {
      if (!(m.markPrice > 0)) continue;
      if (wanted.size > 0 && !wanted.has(m.symbol)) continue;
      prices[m.symbol] = m.markPrice;
    }
    return NextResponse.json(
      { prices, at: Date.now() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
