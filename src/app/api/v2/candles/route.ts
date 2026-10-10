import { NextResponse } from "next/server";
import { getCandles } from "@/lib/engine2/candles";
import { analyseTimeframe } from "@/lib/algo/screener/analyse";
import { ema, rsi, macd, atr, bollinger, adx } from "@/lib/algo/indicators";
import { findPivots } from "@/lib/algo/indicators/pivots";
import { loadParams } from "@/lib/improve2/improve";
import { isTimeframe, type Timeframe } from "@/lib/algo/types";
import { KEYS, kv } from "@/lib/store/kv";
import type { FuturesPosition, FuturesTrade } from "@/lib/store/account";

/**
 * The currently-forming bar, straight from the exchange.
 *
 * `getCandles` deliberately returns closed bars only, because every indicator
 * in the engine would repaint if fed a partial one. The chart wants it anyway,
 * so it is fetched separately and never passed to analysis.
 */
async function fetchFuturesKlinesRaw(
  symbol: string,
  interval: Timeframe,
): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number } | null> {
  const hosts = (
    process.env.BINANCE_FUTURES_HOSTS ?? "https://www.binance.com,https://fapi.binance.com"
  ).split(",").map((h) => h.trim()).filter(Boolean);

  for (const host of hosts) {
    try {
      const res = await fetch(
        `${host}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1`,
        { cache: "no-store", signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) continue;
      const raw = (await res.json()) as [number, string, string, string, string, string, number][];
      const k = raw[0];
      if (!k) continue;
      return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
    } catch {
      // Try the next host.
    }
  }
  return null;
}

/**
 * Chart data for one symbol: candles, indicator series, the Elliott/Gann read,
 * and every marker the UI needs to show what the engine did and why.
 *
 * Indicators are computed here rather than in the browser so the chart shows
 * exactly the series the strategy traded on — a second implementation in the
 * client would eventually disagree with the engine, and the chart would then
 * be quietly lying about the decision.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  const tfParam = url.searchParams.get("timeframe") ?? "1h";
  const timeframe: Timeframe = isTimeframe(tfParam) ? tfParam : "1h";
  const limit = Math.min(300, Number(url.searchParams.get("limit") ?? "150") || 150);
  // The in-progress bar is excluded from analysis — indicators must never
  // read a partial candle — but the chart should still show price moving
  // inside it, so it is appended only after every series is computed.
  const wantLive = url.searchParams.get("live") === "1";

  try {
    const [candles, stored, positions, trades] = await Promise.all([
      getCandles(symbol, timeframe),
      loadParams(),
      kv().get<FuturesPosition[]>(KEYS.positions),
      kv().list<FuturesTrade>(KEYS.trades, 200),
    ]);

    if (candles.length === 0) {
      return NextResponse.json({ error: `no candles for ${symbol} ${timeframe}` }, { status: 404 });
    }

    const params = stored.params;
    const ind = params.indicators;

    // The forming bar, fetched separately. `getCandles` returns closed bars
    // only — feeding a partial candle to the engine would make every
    // indicator repaint — so it is used for display series and nothing else.
    let live: { t: number; o: number; h: number; l: number; c: number; v: number } | null = null;
    if (wantLive) {
      try {
        const fresh = await fetchFuturesKlinesRaw(symbol, timeframe);
        const lastClosed = candles.at(-1);
        if (fresh && (!lastClosed || fresh.t > lastClosed.openTime)) live = fresh;
      } catch {
        // No live bar just means the chart ends at the last close.
      }
    }

    /**
     * Display series include the forming bar so the lines move in real time.
     * The analysis below deliberately does not: the strategy must only ever
     * decide on closed data, and the chart showing a provisional EMA while the
     * engine waits for the close is the honest depiction of that.
     */
    const displayCandles = live
      ? [...candles, { ...live, openTime: live.t, open: live.o, high: live.h, low: live.l,
          close: live.c, volume: live.v, closeTime: live.t, quoteVolume: 0, trades: 0, closed: false }]
      : candles;
    const closes = displayCandles.map((c) => c.close);

    const emaFast = ema(closes, ind.emaFast);
    const emaSlow = ema(closes, ind.emaSlow);
    const rsiSeries = rsi(closes, ind.rsiPeriod);
    const macdSeries = macd(closes, ind.macdFast, ind.macdSlow, ind.macdSignal);
    const bb = bollinger(closes, ind.bbPeriod, ind.bbMultiplier);
    const atrSeries = atr(displayCandles, ind.atrPeriod);
    const adxSeries = adx(displayCandles, 14);

    // Closed bars only — this is what the engine actually decides on.
    const analysis = analyseTimeframe(symbol, timeframe, candles, params);

    // Swing pivots drive both the Elliott count and the Gann fan anchor, so
    // drawing them makes those two components inspectable rather than opaque.
    const pivots = findPivots(displayCandles, {
      atrMultiple: ind.zigzagAtrMultiple,
      atrPeriod: ind.atrPeriod,
      confirmedOnly: true,
    }).slice(-12);

    const tail = <T,>(a: T[]) => a.slice(-limit);
    const clean = (a: number[]) =>
      tail(a).map((v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null));

    const position = (positions ?? []).find((p) => p.symbol === symbol) ?? null;
    const firstTime = (tail(displayCandles)[0]?.openTime) ?? 0;

    return NextResponse.json(
      {
        symbol,
        timeframe,
        candles: tail(displayCandles).map((c) => ({
          t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
          // Marks the still-forming bar so the chart can render it distinctly.
          live: c.closed === false,
        })),
        liveBar: live !== null,
        indicators: {
          emaFast: clean(emaFast),
          emaSlow: clean(emaSlow),
          emaFastPeriod: ind.emaFast,
          emaSlowPeriod: ind.emaSlow,
          rsi: clean(rsiSeries),
          rsiOverbought: ind.rsiOverbought,
          rsiOversold: ind.rsiOversold,
          macd: clean(macdSeries.macd),
          macdSignal: clean(macdSeries.signal),
          macdHistogram: clean(macdSeries.histogram),
          bbUpper: clean(bb.upper),
          bbLower: clean(bb.lower),
          atr: clean(atrSeries),
          adx: clean(adxSeries.adx),
        },
        pivots: pivots
          .filter((p) => p.time >= firstTime)
          .map((p) => ({ t: p.time, price: p.price, type: p.type })),
        analysis: analysis
          ? {
              score: analysis.score,
              confidence: analysis.confidence,
              direction: analysis.direction,
              regime: analysis.regime,
              atr: analysis.atr,
              components: analysis.components,
              elliott: {
                pattern: analysis.elliott.pattern,
                currentWave: analysis.elliott.currentWave,
                bias: analysis.elliott.bias,
                confidence: analysis.elliott.confidence,
                targets: analysis.elliott.targets,
                invalidation: analysis.elliott.invalidation,
                waves: analysis.elliott.waves,
                notes: analysis.elliott.notes,
              },
              gann: {
                bias: analysis.gann.bias,
                confidence: analysis.gann.confidence,
                anchor: analysis.gann.anchor,
                angles: analysis.gann.angles,
                timeCycle: analysis.gann.timeCycle,
                notes: analysis.gann.notes,
              },
              levels: analysis.levels,
            }
          : null,
        position: position
          ? {
              side: position.side,
              entryPrice: position.entryPrice,
              stopLoss: position.stopLoss,
              liquidationPrice: position.liquidationPrice,
              takeProfits: position.takeProfits,
              openedAt: position.openedAt,
            }
          : null,
        // Executed fills on this symbol, so the chart shows what actually happened.
        fills: trades
          .filter((t) => t.symbol === symbol && t.closedAt >= firstTime)
          .map((t) => ({
            side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
            openedAt: t.openedAt, closedAt: t.closedAt,
            netPnl: t.netPnl, exitReason: t.exitReason,
          })),
        paramsVersion: stored.version,
        updatedAt: Date.now(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
