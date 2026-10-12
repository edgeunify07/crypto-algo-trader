"use client";

import { useEffect, useMemo, useState } from "react";
import type { LiveKline, LiveMark } from "./useBinanceStream";

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
  /** True for the bar still forming; drawn hollow. */
  live?: boolean;
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

/**
 * Every timeframe this chart can draw, when the caller does not narrow it.
 *
 * The scalp tab passes a shorter list: an engine reading 1m/5m/15m has
 * nothing to say about a daily candle, and offering one invites reading the
 * chart on a timeframe the engine never looked at.
 */
const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];

/**
 * The server poll now only refreshes closed history and the analysis — the
 * websocket carries the live bar — so it can be slow and cheap.
 */
/**
 * How often the server candles are refetched.
 *
 * When the websocket is delivering, the forming bar moves on every tick and
 * this poll only needs to correct the closed history. When it is not — a
 * region where Binance's stream is blocked, a network that drops it — this
 * poll is the only thing moving the chart at all, so it runs much more often.
 */
const REFRESH_MS = 15_000;
const REFRESH_MS_NO_SOCKET = 4_000;

const UP = "#22c98b";
const DOWN = "#ff5570";
const MUTED = "#8a99b3";

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(6);
}

export default function Chart({
  symbol,
  liveKline,
  mark,
  onTimeframe,
  streaming,
  timeframes = TIMEFRAMES,
}: {
  symbol: string;
  /** Latest bar from the websocket; redraws between server refreshes. */
  liveKline?: LiveKline | null;
  /**
   * Best bid/ask mid, used when the kline stream is withheld in this region.
   * It moves the forming bar's close without inventing one: the open and the
   * volume still come from the server poll, and only the extremes the browser
   * has actually observed extend the high and low.
   */
  mark?: LiveMark | null;
  onTimeframe?: (tf: string) => void;
  streaming?: boolean;
  /** Which intervals to offer, fastest first. The first one is the default. */
  timeframes?: string[];
}) {
  const [timeframe, setTimeframe] = useState(timeframes[0] ?? "1h");
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
    const id = setInterval(load, streaming ? REFRESH_MS : REFRESH_MS_NO_SOCKET);
    return () => {
      cancelled = true;
      clearTimeout(kick);
      clearInterval(id);
    };
  }, [symbol, timeframe, streaming]);

  /**
   * Server candles with the websocket bar merged in.
   *
   * The server poll is the source of closed history; the socket supplies the
   * bar currently forming. Merging here rather than in the fetch means the
   * chart redraws on every tick from the exchange instead of waiting for the
   * next poll, and the price scale is recomputed with it so a fast move does
   * not run off the top of the view.
   */
  const merged = useMemo(() => {
    if (!data) return null;
    const candles = [...data.candles];
    if (liveKline) {
      const last = candles.at(-1);
      const bar: Candle = {
        t: liveKline.t, o: liveKline.o, h: liveKline.h,
        l: liveKline.l, c: liveKline.c, v: liveKline.v,
        live: !liveKline.closed,
      };
      if (last && last.t === bar.t) candles[candles.length - 1] = bar;
      else if (!last || bar.t > last.t) candles.push(bar);
    } else if (mark) {
      // No kline stream here. The server poll still supplies the forming
      // bar — open, volume, and the extremes up to the last poll — so the
      // mid only has to carry the close and push the range out if the price
      // has since gone beyond it.
      const last = candles.at(-1);
      if (last) {
        candles[candles.length - 1] = {
          ...last,
          h: Math.max(last.h, mark.price),
          l: Math.min(last.l, mark.price),
          c: mark.price,
          live: true,
        };
      }
    }
    return { ...data, candles };
  }, [data, liveKline, mark]);

  const geom = useMemo(() => {
    const data = merged;
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
      if (Math.abs(merged.position!.liquidationPrice - last) / last < 0.25) {
        extras.push(merged.position!.liquidationPrice);
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

    /**
     * Evenly spaced prices for the scale, snapped to readable steps.
     *
     * Dividing the range into equal parts gives labels like 109.3471, which
     * nobody reads; the step is rounded to a 1/2/5 multiple of its own
     * magnitude so the numbers land where the eye expects them.
     */
    const top = hi + pad;
    const bottom = lo - pad;
    const rough = (top - bottom) / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rough || 1));
    const step =
      [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= rough) ?? magnitude * 10;
    const scale: number[] = [];
    for (let v = Math.ceil(bottom / step) * step; v <= top; v += step) scale.push(v);

    return { W, H, PAD_R, PAD_B, x, y, bw, path, hi, lo, n, scale };
  }, [merged]);

  return (
    <div className="rounded-xl bg-[var(--surface)] overflow-hidden">
      {/* timeframe switcher */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <span
          key={tickAt}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${streaming ? "live-dot bg-[var(--up)]" : "bg-[var(--muted)]"}`}
          title={streaming ? "streaming from Binance" : "polling"}
        />
        {timeframes.map((tf) => (
          <button
            key={tf}
            onClick={() => {
              setTimeframe(tf);
              onTimeframe?.(tf);
            }}
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

      {merged && geom && (
        <>
          <svg
            viewBox={`0 0 ${geom.W} ${geom.H}`}
            className="w-full"
            style={{ height: 210 }}
            preserveAspectRatio="none"
          >
            {/*
              Price scale.

              Without it the chart has a right-hand gutter holding a tag for
              the last price and nothing else, so every other candle has to be
              eyeballed against that single number — the view shows the shape
              of the move but never says what any level is worth.
            */}
            {geom.scale.map((p) => (
              <g key={p}>
                <line
                  x1={0}
                  x2={geom.W - geom.PAD_R}
                  y1={geom.y(p)}
                  y2={geom.y(p)}
                  stroke="#1c2433"
                  strokeWidth={1}
                />
                <text
                  x={geom.W - geom.PAD_R + 5}
                  y={geom.y(p) + 3.5}
                  fill={MUTED}
                  fontSize={9}
                  fontFamily="ui-monospace, monospace"
                >
                  {fmt(p)}
                </text>
              </g>
            ))}

            {/* Bollinger envelope */}
            <path d={geom.path(merged.indicators.bbUpper)} fill="none" stroke="#3a4a63" strokeWidth={1.2} />
            <path d={geom.path(merged.indicators.bbLower)} fill="none" stroke="#3a4a63" strokeWidth={1.2} />

            {/* candles */}
            {merged.candles.map((c, i) => {
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
                    fill={c.live ? "none" : colour}
                    stroke={c.live ? colour : "none"}
                    strokeWidth={c.live ? 1.2 : 0}
                  />
                </g>
              );
            })}

            {/* EMA pair */}
            <path d={geom.path(merged.indicators.emaFast)} fill="none" stroke="#5aa9ff" strokeWidth={1.6} />
            <path d={geom.path(merged.indicators.emaSlow)} fill="none" stroke="#f5b942" strokeWidth={1.6} />

            {/* swing pivots — what Elliott and Gann are built from */}
            {merged.pivots.map((p) => {
              const i = merged.candles.findIndex((c) => c.t >= p.t);
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
            {merged.position && (
              <>
                <PriceLine geom={geom} price={merged.position.entryPrice} colour="#5aa9ff" label="entry" />
                <PriceLine geom={geom} price={merged.position.stopLoss} colour={DOWN} label="stop" dashed />
                {merged.position.takeProfits
                  .filter((tp) => !tp.hit)
                  .map((tp, i) => (
                    <PriceLine key={i} geom={geom} price={tp.price} colour={UP} label={`tp${i + 1}`} dashed />
                  ))}
              </>
            )}

            {/* executed fills */}
            {merged.fills.map((f, i) => {
              const ei = merged.candles.findIndex((c) => c.t >= f.openedAt);
              const xi = merged.candles.findIndex((c) => c.t >= f.closedAt);
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
              price={merged.candles.at(-1)!.c}
              colour={MUTED}
              label={fmt(merged.candles.at(-1)!.c)}
              solidTag
            />
          </svg>

          {/* RSI / MACD strip */}
          <svg viewBox={`0 0 ${geom.W} 70`} className="w-full" style={{ height: 52 }} preserveAspectRatio="none">
            <SubPlot
              series={merged.indicators.rsi}
              width={geom.W - geom.PAD_R}
              min={0}
              max={100}
              bands={[merged.indicators.rsiOversold, merged.indicators.rsiOverbought]}
              colour="#a78bfa"
            />
          </svg>

          <div className="flex items-center gap-3 px-3 pb-1 text-[9px] text-[var(--muted)]">
            <Legend colour="#5aa9ff" label={`EMA${merged.indicators.emaFastPeriod}`} />
            <Legend colour="#f5b942" label={`EMA${merged.indicators.emaSlowPeriod}`} />
            <Legend colour="#3a4a63" label="Bollinger" />
            <Legend colour="#a78bfa" label="RSI" />
            <span className="ml-auto">pivots ○ · fills ▲■ · hollow = forming</span>
          </div>

          {merged.analysis && <Readout data={merged} />}
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
