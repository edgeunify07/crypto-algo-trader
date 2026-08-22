"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, CandleInterval } from "@/lib/types";
import { useMarketSub, type WsKline } from "@/lib/useMarketStream";
import { INDICATOR_TOGGLES } from "@/lib/strategies/indicatorToggles";
import { formatIstChartTime, formatIstTickMark } from "@/lib/time/ist";

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface ChartMarker {
  time: number;
  price: number;
  side: "buy" | "sell";
  reason?: string;
}

interface OverlayLineSpec {
  id: string;
  label: string;
  color: string;
  data: { time: number; value: number }[];
  lineWidth?: number;
  lineStyle?: number;
  pane?: "main" | "osc";
}

interface PriceLineSpec {
  price: number;
  title: string;
  color: string;
}

interface OverlayResponse {
  lines: OverlayLineSpec[];
  priceLines: PriceLineSpec[];
  confluence?: { score: number; threshold: number; regime: string; factors: Record<string, number> };
  activeToggles?: Record<string, boolean>;
}

export default function ChartPanel({
  symbol,
  interval,
  onInterval,
  params = {},
  tradeMarkers = [],
}: {
  symbol: string;
  interval: CandleInterval;
  onInterval: (i: CandleInterval) => void;
  params?: Record<string, number>;
  tradeMarkers?: ChartMarker[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const oscPaneRef = useRef<ReturnType<IChartApi["addPane"]> | null>(null);
  const lineRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const priceLineRefs = useRef<IPriceLine[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any>(null);
  const lastTimeRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [confluence, setConfluence] = useState<{ score: number; threshold: number; regime: string } | null>(null);
  const [activeLabels, setActiveLabels] = useState<string[]>([]);

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
      localization: {
        locale: "en-IN",
        timeFormatter: formatIstChartTime,
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "#2b3139",
        tickMarkFormatter: (time: number, tickMarkType: number) => formatIstTickMark(time, tickMarkType),
      },
      rightPriceScale: { borderColor: "#2b3139" },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#2ebd85", downColor: "#f6465d", borderVisible: false,
      wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
    });
    markersRef.current = createSeriesMarkers(candle);
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    return () => {
      chart.remove();
      chartRef.current = candleRef.current = volRef.current = null;
      oscPaneRef.current = null;
      lineRefs.current.clear();
      priceLineRefs.current = [];
      markersRef.current = null;
    };
  }, []);

  const applyOverlay = (overlay: OverlayResponse) => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;

    // Remove stale price lines
    for (const pl of priceLineRefs.current) {
      try { candle.removePriceLine(pl); } catch { /* ignore */ }
    }
    priceLineRefs.current = [];

    const wantIds = new Set(overlay.lines.map((l) => l.id));
    for (const [id, series] of lineRefs.current) {
      if (!wantIds.has(id)) {
        try { chart.removeSeries(series); } catch { /* ignore */ }
        lineRefs.current.delete(id);
      }
    }

    const hasOsc = overlay.lines.some((l) => l.pane === "osc");
    if (hasOsc && !oscPaneRef.current) {
      oscPaneRef.current = chart.addPane(false);
      oscPaneRef.current.setHeight(72);
    }
    if (!hasOsc && oscPaneRef.current) {
      for (const [id, series] of lineRefs.current) {
        if (id === "rmi" || id === "adx") {
          try { chart.removeSeries(series); } catch { /* ignore */ }
          lineRefs.current.delete(id);
        }
      }
      try {
        chart.removePane(oscPaneRef.current.paneIndex());
      } catch { /* ignore */ }
      oscPaneRef.current = null;
    }

    for (const spec of overlay.lines) {
      let series = lineRefs.current.get(spec.id);
      const data = spec.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

      if (!series) {
        if (spec.pane === "osc" && oscPaneRef.current) {
          series = oscPaneRef.current.addSeries(LineSeries, {
            color: spec.color,
            lineWidth: (spec.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            title: spec.label,
            priceScaleId: "right",
          });
        } else {
          series = chart.addSeries(LineSeries, {
            color: spec.color,
            lineWidth: (spec.lineWidth ?? 1) as 1 | 2 | 3 | 4,
            lineStyle: (spec.lineStyle ?? 0) as 0 | 1 | 2 | 3 | 4,
            title: spec.label,
            priceScaleId: "right",
          });
        }
        lineRefs.current.set(spec.id, series);
      } else {
        series.applyOptions({
          color: spec.color,
          lineWidth: (spec.lineWidth ?? 1) as 1 | 2 | 3 | 4,
          lineStyle: (spec.lineStyle ?? 0) as 0 | 1 | 2 | 3 | 4,
          title: spec.label,
        });
      }
      series.setData(data);
    }

    for (const pl of overlay.priceLines) {
      const line = candle.createPriceLine({
        price: pl.price,
        color: pl.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: pl.title,
      });
      priceLineRefs.current.push(line);
    }

    if (overlay.confluence) {
      setConfluence({
        score: overlay.confluence.score,
        threshold: overlay.confluence.threshold,
        regime: overlay.confluence.regime,
      });
    }

    const labels = overlay.lines.map((l) => l.label);
    if (overlay.priceLines.length) labels.push(`S/R ×${overlay.priceLines.length}`);
    setActiveLabels(labels);
  };

  useEffect(() => {
    if (!markersRef.current) return;
    markersRef.current.setMarkers(
      tradeMarkers.map((m) => ({
        time: m.time as UTCTimestamp,
        position: m.side === "buy" ? "belowBar" as const : "aboveBar" as const,
        color: m.side === "buy" ? "#2ebd85" : "#f6465d",
        shape: m.side === "buy" ? "arrowUp" as const : "arrowDown" as const,
        text: m.reason ? `${m.side.toUpperCase()} · ${m.reason}` : m.side.toUpperCase(),
      })),
    );
  }, [tradeMarkers]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    lastTimeRef.current = 0;
    const paramsQ = encodeURIComponent(JSON.stringify(params));
    (async () => {
      try {
        const [candleRes, overlayRes] = await Promise.all([
          fetch(`/api/candles?symbol=${symbol}&interval=${interval}&limit=500`),
          fetch(`/api/chart-overlay?symbol=${symbol}&interval=${interval}&limit=500&params=${paramsQ}`),
        ]);
        const json = await candleRes.json();
        const overlay: OverlayResponse = await overlayRes.json();
        if (!alive || !candleRef.current || !volRef.current) return;
        const candles: Candle[] = json.candles ?? [];
        candleRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        volRef.current.setData(candles.map((c) => ({
          time: c.time as UTCTimestamp, value: c.volume,
          color: c.close >= c.open ? "rgba(46,189,133,0.5)" : "rgba(246,70,93,0.5)",
        })));
        applyOverlay(overlay);
        lastTimeRef.current = candles.at(-1)?.time ?? 0;
        chartRef.current?.timeScale().fitContent();
        setLoading(false);
      } catch {
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [symbol, interval, JSON.stringify(params)]);

  useMarketSub<WsKline>("kline", (d) => {
    const k = d.k;
    if (!k || !candleRef.current || !volRef.current) return;
    const t = Math.floor(k.t / 1000) as UTCTimestamp;
    if ((t as number) < lastTimeRef.current) return;
    const open = Number(k.o), close = Number(k.c);
    candleRef.current.update({ time: t, open, high: Number(k.h), low: Number(k.l), close });
    volRef.current.update({ time: t, value: Number(k.v), color: close >= open ? "rgba(46,189,133,0.5)" : "rgba(246,70,93,0.5)" });
    lastTimeRef.current = t as number;
  });

  const toggleCount = Object.keys(INDICATOR_TOGGLES).filter((k) => (params[k] ?? 1) >= 1).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {INTERVALS.map((iv) => (
          <button key={iv} onClick={() => onInterval(iv)}
            className={`rounded px-2.5 py-1 text-xs ${interval === iv ? "bg-panel2 text-accent" : "text-muted hover:text-text"}`}>
            {iv}
          </button>
        ))}
        {confluence && (
          <span className="ml-2 text-[10px] text-muted">
            {confluence.regime} · score {confluence.score.toFixed(1)}/{confluence.threshold}
          </span>
        )}
        {activeLabels.length > 0 && (
          <span className="ml-2 hidden text-[10px] text-accent lg:inline" title={activeLabels.join(", ")}>
            {activeLabels.length} overlays ({toggleCount} toggles)
          </span>
        )}
        {tradeMarkers.length > 0 && (
          <span className="ml-2 text-[10px] text-up">{tradeMarkers.length} executions</span>
        )}
        <span className="ml-auto text-[10px] text-muted">IST</span>
        <span className="text-[10px] text-up">{loading ? "loading…" : "● live"}</span>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 border-b border-line px-2 py-1">
        {activeLabels.map((label) => (
          <span key={label} className="text-[9px] text-muted">{label}</span>
        ))}
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
