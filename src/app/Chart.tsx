"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Candlestick chart with indicator overlays, drawn as inline SVG.
 *
 * A charting library was removed in favour of this: the whole chart is a few
 * hundred lines of SVG, it costs nothing in bundle size on a phone, and every
 * overlay the strategy actually uses — EMA pair, Bollinger envelope, swing
 * pivots, stop and liquidation lines, executed fills — can be drawn exactly
 * where the engine computed it. All series come from the server so the chart
 * shows the same numbers the strategy traded on.
 */

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Component {
  name: string;
  score: number;
  confidence: number;
  note: string;
}

export interface ChartData {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  indicators: {
    emaFast: (number | null)[];
    emaSlow: (number | null)[];
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsi: (number | null)[];
    rsiOverbought: number;
    rsiOversold: number;
    macdHistogram: (number | null)[];
    bbUpper: (number | null)[];
    bbLower: (number | null)[];
    adx: (number | null)[];
  };
  pivots: { t: number; price: number; type: "high" | "low" }[];
  analysis: {
    score: number;
    confidence: number;
    direction: string;
    regime: { kind: string; adx: number; atrPct: number };
    components: Component[];
    elliott: {
      pattern: string;
      currentWave: string;
      bias: string;
      confidence: number;
      targets: number[];
      invalidation: number | null;
      notes: string[];
    };
    gann: {
      bias: string;
      confidence: number;
      timeCycle: { barsSinceAnchor: number; nearestCycle: number; distance: number };
      notes: string[];
    };
  } | null;
  position: {
    side: "long" | "short";
    entryPrice: number;
    stopLoss: number;
    liquidationPrice: number;
    takeProfits: { price: number; fraction: number; hit: boolean }[];
    openedAt: number;
  } | null;
  fills: {
    side: "long" | "short";
    entryPrice: number;
    exitPrice: number;
    openedAt: number;
    closedAt: number;
    netPnl: number;
    exitReason: string;
  }[];
}

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

/**
 * Refresh cadence per timeframe.
 *
 * A 1m chart prints a new bar every minute, so polling it every 15s is the
 * difference between a live chart and a stale one. Slower timeframes gain
 * nothing from fast polling — the bar has not changed — so they back off and
 * leave the rate limit alone.
 */
const REFRESH_MS: Record<string, number> = {
  "1m": 4000,
  "5m": 8000,
  "15m": 15000,
  "1h": 20000,
  "4h": 30000,
  "1d": 60000,
};

const UP = "#22c98b";
const DOWN = "#ff5570";
const MUTED = "#8a99b3";

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(6);
}

export default function Chart({ symbol }: { symbol: string }) {
  const [timeframe, setTimeframe] = useState("1h");
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tickAt, setTickAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/v2/candles?symbol=${symbol}&timeframe=${timeframe}&limit=80&live=1`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as ChartData & { error?: string };
        if (cancelled) return;
        if (body.error) setError(body.error);
        else {
          setData(body);
          setTickAt(Date.now());
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Could not load chart data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    // Deferred: a synchronous setState inside an effect triggers a cascading
    // re-render before the first paint.
    const kick = setTimeout(() => {
      setLoading(true);
      void load();
    }, 0);
    const id = setInterval(load, REFRESH_MS[timeframe] ?? 15_000);
    return () => {
      cancelled = true;
      clearTimeout(kick);
      clearInterval(id);
    };
  }, [symbol, timeframe]);

  const geom = useMemo(() => {
    if (!data || data.candles.length === 0) return null;

    const W = 1000;
    const H = 320;
    const PAD_R = 62;
    const PAD_B = 18;
    const n = data.candles.length;

    // The price band must include anything we draw on it, or stop and
    // liquidation lines silently fall outside the viewport.
    const extras: number[] = [];
    if (data.position) {
      extras.push(data.position.entryPrice, data.position.stopLoss);
      for (const tp of data.position.takeProfits) extras.push(tp.price);
      // Liquidation is often far away; include it only when it is close
      // enough to be worth seeing, so it cannot flatten the whole chart.
      const last = data.candles.at(-1)!.c;
      if (Math.abs(data.position.liquidationPrice - last) / last < 0.25) {
        extras.push(data.position.liquidationPrice);
      }
    }

    const highs = data.candles.map((c) => c.h);
    const lows = data.candles.map((c) => c.l);
    const hi = Math.max(...highs, ...extras);
    const lo = Math.min(...lows, ...extras);
    const span = hi - lo || hi * 0.01 || 1;
    const pad = span * 0.06;

    const x = (i: number) => (i / Math.max(1, n - 1)) * (W - PAD_R);
    const y = (p: number) => H - PAD_B - ((p - (lo - pad)) / (span + pad * 2)) * (H - PAD_B);
    const bw = Math.max(1.5, ((W - PAD_R) / n) * 0.62);

    const path = (series: (number | null)[]) => {
      let d = "";
      let open = false;
      series.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) {
          open = false;
          return;
        }
        d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        open = true;
      });
      return d;
    };

    return { W, H, PAD_R, PAD_B, x, y, bw, path, hi, lo, n };
  }, [data]);

  return (
    <div className="rounded-xl bg-[var(--surface)] overflow-hidden">
      {/* timeframe switcher */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <span
          key={tickAt}
          className="live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--up)]"
          title="updating live"
        />
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            className={`flex-1 rounded-md py-1.5 text-[11px] font-medium ${
              timeframe === tf
                ? "bg-[var(--surface-2)] text-[var(--text)]"
                : "text-[var(--muted)]"
            }`}
          >
            {tf}
          </button>
        ))}
      </div>

      {error && (
        <div className="px-3 py-6 text-center text-[11px] text-[var(--down)]">{error}</div>
      )}
      {loading && !data && (
        <div className="px-3 py-10 text-center text-[11px] text-[var(--muted)]">
          loading {symbol}…
        </div>
      )}

      {data && geom && (
        <>
          <svg
            viewBox={`0 0 ${geom.W} ${geom.H}`}
            className="w-full"
            style={{ height: 210 }}
            preserveAspectRatio="none"
          >
            {/* Bollinger envelope */}
            <path d={geom.path(data.indicators.bbUpper)} fill="none" stroke="#3a4a63" strokeWidth={1.2} />
            <path d={geom.path(data.indicators.bbLower)} fill="none" stroke="#3a4a63" strokeWidth={1.2} />

            {/* candles */}
            {data.candles.map((c, i) => {
              const up = c.c >= c.o;
              const colour = up ? UP : DOWN;
              const yO = geom.y(c.o);
              const yC = geom.y(c.c);
              return (
                <g key={c.t}>
                  <line
                    x1={geom.x(i)} x2={geom.x(i)}
                    y1={geom.y(c.h)} y2={geom.y(c.l)}
                    stroke={colour} strokeWidth={1.1}
                  />
                  <rect
                    x={geom.x(i) - geom.bw / 2}
                    y={Math.min(yO, yC)}
                    width={geom.bw}
                    height={Math.max(1, Math.abs(yC - yO))}
                    fill={colour}
                  />
                </g>
              );
            })}

            {/* EMA pair */}
            <path d={geom.path(data.indicators.emaFast)} fill="none" stroke="#5aa9ff" strokeWidth={1.6} />
            <path d={geom.path(data.indicators.emaSlow)} fill="none" stroke="#f5b942" strokeWidth={1.6} />

            {/* swing pivots — what Elliott and Gann are built from */}
            {data.pivots.map((p) => {
              const i = data.candles.findIndex((c) => c.t >= p.t);
              if (i < 0) return null;
              return (
                <circle
                  key={`${p.t}-${p.type}`}
                  cx={geom.x(i)} cy={geom.y(p.price)} r={3}
                  fill="none" stroke={p.type === "high" ? DOWN : UP} strokeWidth={1.5}
                />
              );
            })}

            {/* open position levels */}
            {data.position && (
              <>
                <PriceLine geom={geom} price={data.position.entryPrice} colour="#5aa9ff" label="entry" />
                <PriceLine geom={geom} price={data.position.stopLoss} colour={DOWN} label="stop" dashed />
                {data.position.takeProfits
                  .filter((tp) => !tp.hit)
                  .map((tp, i) => (
                    <PriceLine key={i} geom={geom} price={tp.price} colour={UP} label={`tp${i + 1}`} dashed />
                  ))}
              </>
            )}

            {/* executed fills */}
            {data.fills.map((f, i) => {
              const ei = data.candles.findIndex((c) => c.t >= f.openedAt);
              const xi = data.candles.findIndex((c) => c.t >= f.closedAt);
              return (
                <g key={i}>
                  {ei >= 0 && (
                    <polygon
                      points={`${geom.x(ei)},${geom.y(f.entryPrice) - 7} ${geom.x(ei) - 4},${geom.y(f.entryPrice) + 1} ${geom.x(ei) + 4},${geom.y(f.entryPrice) + 1}`}
                      fill={f.side === "long" ? UP : DOWN}
                    />
                  )}
                  {xi >= 0 && (
                    <rect
                      x={geom.x(xi) - 3} y={geom.y(f.exitPrice) - 3}
                      width={6} height={6}
                      fill={f.netPnl >= 0 ? UP : DOWN}
                    />
                  )}
                </g>
              );
            })}

            {/* last price tag */}
            <PriceLine
              geom={geom}
              price={data.candles.at(-1)!.c}
              colour={MUTED}
              label={fmt(data.candles.at(-1)!.c)}
              solidTag
            />
          </svg>

          {/* RSI / MACD strip */}
          <svg viewBox={`0 0 ${geom.W} 70`} className="w-full" style={{ height: 52 }} preserveAspectRatio="none">
            <SubPlot
              series={data.indicators.rsi}
              width={geom.W - geom.PAD_R}
              min={0}
              max={100}
              bands={[data.indicators.rsiOversold, data.indicators.rsiOverbought]}
              colour="#a78bfa"
            />
          </svg>

          <div className="flex items-center gap-3 px-3 pb-1 text-[9px] text-[var(--muted)]">
            <Legend colour="#5aa9ff" label={`EMA${data.indicators.emaFastPeriod}`} />
            <Legend colour="#f5b942" label={`EMA${data.indicators.emaSlowPeriod}`} />
            <Legend colour="#3a4a63" label="Bollinger" />
            <Legend colour="#a78bfa" label="RSI" />
            <span className="ml-auto">pivots ○ · fills ▲■</span>
          </div>

          {data.analysis && <Readout data={data} />}
        </>
      )}
    </div>
  );
}

interface Geom {
  W: number;
  PAD_R: number;
  y: (p: number) => number;
}

function PriceLine({
  geom, price, colour, label, dashed, solidTag,
}: {
  geom: Geom;
  price: number;
  colour: string;
  label: string;
  dashed?: boolean;
  solidTag?: boolean;
}) {
  const y = geom.y(price);
  if (!Number.isFinite(y)) return null;
  return (
    <g>
      <line
        x1={0} x2={geom.W - geom.PAD_R} y1={y} y2={y}
        stroke={colour} strokeWidth={1}
        strokeDasharray={dashed ? "4 3" : undefined}
        opacity={0.85}
      />
      <rect
        x={geom.W - geom.PAD_R + 2} y={y - 8}
        width={geom.PAD_R - 4} height={16}
        fill={solidTag ? colour : "transparent"}
        rx={2}
      />
      <text
        x={geom.W - geom.PAD_R + 5} y={y + 4}
        fontSize={11}
        fill={solidTag ? "#0a0d13" : colour}
      >
        {label}
      </text>
    </g>
  );
}

function SubPlot({
  series, width, min, max, bands, colour,
}: {
  series: (number | null)[];
  width: number;
  min: number;
  max: number;
  bands: number[];
  colour: string;
}) {
  const n = series.length;
  const x = (i: number) => (i / Math.max(1, n - 1)) * width;
  const y = (v: number) => 66 - ((v - min) / (max - min)) * 62;

  let d = "";
  let open = false;
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      open = false;
      return;
    }
    d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    open = true;
  });

  return (
    <g>
      {bands.map((b) => (
        <line key={b} x1={0} x2={width} y1={y(b)} y2={y(b)} stroke="#2a3447" strokeWidth={1} strokeDasharray="3 3" />
      ))}
      <path d={d} fill="none" stroke={colour} strokeWidth={1.5} />
    </g>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-[2px] w-3 rounded" style={{ background: colour }} />
      {label}
    </span>
  );
}

/** The per-component breakdown: what each part of the strategy currently says. */
function Readout({ data }: { data: ChartData }) {
  const a = data.analysis!;
  return (
    <div className="border-t border-[var(--line)] px-3 py-2 space-y-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[var(--muted)]">
          {a.regime.kind} · ADX {a.regime.adx.toFixed(0)} · ATR {(a.regime.atrPct * 100).toFixed(2)}%
        </span>
        <span
          className={
            a.score > 0 ? "text-[var(--up)]" : a.score < 0 ? "text-[var(--down)]" : "text-[var(--muted)]"
          }
        >
          score {a.score >= 0 ? "+" : ""}{a.score.toFixed(2)}
        </span>
      </div>

      {/* Component bars: how each input votes, and how strongly. */}
      <div className="space-y-1">
        {a.components.map((c) => (
          <div key={c.name} className="flex items-center gap-2">
            <span className="w-[64px] shrink-0 text-[9px] text-[var(--muted)]">
              {c.name.replace("_", " ")}
            </span>
            <span className="relative h-[10px] flex-1 rounded bg-[var(--surface-2)]">
              <span
                className="absolute top-0 h-[10px] rounded"
                style={{
                  left: c.score >= 0 ? "50%" : `${50 + c.score * 50}%`,
                  width: `${Math.abs(c.score) * 50}%`,
                  background: c.score >= 0 ? UP : DOWN,
                  opacity: 0.35 + c.confidence * 0.65,
                }}
              />
              <span className="absolute left-1/2 top-0 h-[10px] w-px bg-[var(--line)]" />
            </span>
            <span className="w-8 shrink-0 text-right text-[9px] tabular-nums text-[var(--muted)]">
              {c.score >= 0 ? "+" : ""}{c.score.toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-0.5 text-[10px] leading-relaxed text-[var(--muted)]">
        <p>
          <span className="text-[var(--text)]">Elliott:</span> {a.elliott.pattern}
          {a.elliott.pattern !== "none" && ` wave ${a.elliott.currentWave}`} → {a.elliott.bias} (
          {(a.elliott.confidence * 100).toFixed(0)}%)
          {a.elliott.invalidation !== null && ` · invalid below ${fmt(a.elliott.invalidation)}`}
        </p>
        <p>
          <span className="text-[var(--text)]">Gann:</span> {a.gann.bias} · bar{" "}
          {a.gann.timeCycle.barsSinceAnchor} of the {a.gann.timeCycle.nearestCycle}-bar cycle
          {a.gann.timeCycle.distance <= 2 && " · reversal window"}
        </p>
      </div>
    </div>
  );
}
