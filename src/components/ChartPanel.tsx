"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, CandleInterval } from "@/lib/types";
import { useMarketSub, type WsKline } from "@/lib/useMarketStream";

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export default function ChartPanel({
  symbol,
  interval,
  onInterval,
}: {
  symbol: string;
  interval: CandleInterval;
  onInterval: (i: CandleInterval) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastTimeRef = useRef(0); // newest bar time (s); gates live updates
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#181a20" },
        textColor: "#848e9c",
        fontFamily: "var(--font-geist-sans), sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "#1e2329" }, horzLines: { color: "#1e2329" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2b3139" },
      rightPriceScale: { borderColor: "#2b3139" },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#2ebd85", downColor: "#f6465d", borderVisible: false,
      wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
    });
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    return () => {
      chart.remove();
      chartRef.current = candleRef.current = volRef.current = null;
    };
  }, []);

  // Load history via REST when symbol/interval change; WS then streams updates.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    lastTimeRef.current = 0;
    (async () => {
      try {
        const res = await fetch(`/api/candles?symbol=${symbol}&interval=${interval}&limit=500`);
        const json = await res.json();
        if (!alive || !candleRef.current || !volRef.current) return;
        const candles: Candle[] = json.candles ?? [];
        candleRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        volRef.current.setData(candles.map((c) => ({
          time: c.time as UTCTimestamp, value: c.volume,
          color: c.close >= c.open ? "rgba(46,189,133,0.5)" : "rgba(246,70,93,0.5)",
        })));
        lastTimeRef.current = candles.at(-1)?.time ?? 0;
        chartRef.current?.timeScale().fitContent();
        setLoading(false);
      } catch {
        /* keep whatever is shown */
      }
    })();
    return () => { alive = false; };
  }, [symbol, interval]);

  // Live candle updates pushed over WebSocket.
  useMarketSub<WsKline>("kline", (d) => {
    const k = d.k;
    if (!k || !candleRef.current || !volRef.current) return;
    const t = Math.floor(k.t / 1000) as UTCTimestamp;
    if ((t as number) < lastTimeRef.current) return; // stale (symbol just switched)
    const open = Number(k.o), close = Number(k.c);
    candleRef.current.update({ time: t, open, high: Number(k.h), low: Number(k.l), close });
    volRef.current.update({ time: t, value: Number(k.v), color: close >= open ? "rgba(46,189,133,0.5)" : "rgba(246,70,93,0.5)" });
    lastTimeRef.current = t as number;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => onInterval(iv)}
            className={`rounded px-2.5 py-1 text-xs ${interval === iv ? "bg-panel2 text-accent" : "text-muted hover:text-text"}`}
          >
            {iv}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-up">{loading ? "loading…" : "● live"}</span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
