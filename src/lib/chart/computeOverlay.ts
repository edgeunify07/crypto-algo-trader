import type { Candle, CandleInterval } from "../types";
import { closes, ema, sma } from "../indicators/common";
import { rmi, rmiAtBar } from "../indicators/rmi";
import { adx, adxAtBar } from "../indicators/adx";
import {
  atrForBar,
  clusterZones,
  donchianHigh,
  findPivots,
} from "../indicators/structure";
import {
  buildConfluenceContext,
  DEFAULT_CONFLUENCE_PARAMS,
  DEFAULT_SCALP_PARAMS,
  evaluateConfluence,
} from "../strategies/confluence";
import { togglesFromParams, type IndicatorToggleKey } from "../strategies/indicatorToggles";

export interface OverlayPoint {
  time: number;
  value: number;
}

export interface OverlayLineSpec {
  id: string;
  label: string;
  color: string;
  data: OverlayPoint[];
  lineWidth?: 1 | 2 | 3 | 4;
  lineStyle?: 0 | 1 | 2 | 3 | 4;
  pane?: "main" | "osc";
}

export interface PriceLineSpec {
  price: number;
  title: string;
  color: string;
}

export interface ChartOverlayData {
  lines: OverlayLineSpec[];
  priceLines: PriceLineSpec[];
  confluence: {
    score: number;
    threshold: number;
    regime: string;
    factors: Record<string, number>;
  };
  activeToggles: Record<IndicatorToggleKey, boolean>;
}

function padSeries(series: number[], totalLen: number): (number | null)[] {
  const offset = totalLen - series.length;
  return Array(Math.max(0, offset)).fill(null).concat(series);
}

function toPoints(ltf: Candle[], values: (number | null)[]): OverlayPoint[] {
  const out: OverlayPoint[] = [];
  for (let i = 0; i < ltf.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push({ time: ltf[i].time, value: v });
  }
  return out;
}

function vwapSeries(candles: Candle[]): number[] {
  const out: number[] = [];
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += tp * candles[i].volume;
    vol += candles[i].volume;
    out.push(vol > 0 ? pv / vol : candles[i].close);
  }
  return out;
}

function donchianLow(candles: Candle[], period: number, index: number): number {
  const start = Math.max(0, index - period + 1);
  let m = Infinity;
  for (let i = start; i <= index; i++) m = Math.min(m, candles[i].low);
  return m;
}

export function computeChartOverlay(
  ltf: Candle[],
  htf: Candle[],
  htfInterval: CandleInterval,
  rawParams: Record<string, number>,
): ChartOverlayData {
  const p = { ...DEFAULT_CONFLUENCE_PARAMS, ...DEFAULT_SCALP_PARAMS, ...rawParams };
  const toggles = togglesFromParams(rawParams);
  const ctx = buildConfluenceContext(ltf, htf, htfInterval);
  const c = closes(ltf);
  const lines: OverlayLineSpec[] = [];

  if (toggles.useEma) {
    const ef = ema(c, p.emaFast);
    const es = ema(c, p.emaSlow);
    lines.push(
      { id: "emaFast", label: `EMA ${p.emaFast}`, color: "#f0b90b", data: toPoints(ltf, padSeries(ef, ltf.length)), lineWidth: 2 },
      { id: "emaSlow", label: `EMA ${p.emaSlow}`, color: "#848e9c", data: toPoints(ltf, padSeries(es, ltf.length)), lineWidth: 1 },
    );
  }

  if (toggles.useSma) {
    const sf = sma(c, p.smaFast);
    const ss = sma(c, p.smaSlow);
    lines.push(
      { id: "smaFast", label: `SMA ${p.smaFast}`, color: "#2ebd85", data: toPoints(ltf, padSeries(sf, ltf.length)), lineWidth: 1, lineStyle: 2 },
      { id: "smaSlow", label: `SMA ${p.smaSlow}`, color: "#f6465d", data: toPoints(ltf, padSeries(ss, ltf.length)), lineWidth: 1, lineStyle: 2 },
    );
  }

  if (toggles.useVwap) {
    lines.push({
      id: "vwap",
      label: "VWAP",
      color: "#a855f7",
      data: toPoints(ltf, vwapSeries(ltf)),
      lineWidth: 2,
    });
  }

  if (toggles.useBreakout) {
    const upper: number[] = [];
    const lower: number[] = [];
    for (let i = 0; i < ltf.length; i++) {
      upper.push(donchianHigh(ltf, p.donchianPeriod, i));
      lower.push(donchianLow(ltf, p.donchianPeriod, i));
    }
    lines.push(
      { id: "donchianUpper", label: `Donchian ${p.donchianPeriod}`, color: "rgba(91,140,255,0.85)", data: toPoints(ltf, upper), lineWidth: 1, lineStyle: 2 },
      { id: "donchianLower", label: `Donchian low`, color: "rgba(91,140,255,0.55)", data: toPoints(ltf, lower), lineWidth: 1, lineStyle: 2 },
    );
  }

  if (toggles.useRmi) {
    const rmiSeries = rmi(c, p.rmiLength, p.rmiMomentum);
    const rmiPts: OverlayPoint[] = [];
    for (let i = 0; i < ltf.length; i++) {
      const v = rmiAtBar(rmiSeries, i, p.rmiMomentum, p.rmiLength);
      if (v != null) rmiPts.push({ time: ltf[i].time, value: v });
    }
    lines.push({ id: "rmi", label: "RMI", color: "#9b59b6", data: rmiPts, lineWidth: 2, pane: "osc" });
  }

  if (toggles.useAdxRegime) {
    const adxRes = adx(
      ltf.map((x) => x.high),
      ltf.map((x) => x.low),
      c,
      p.adxPeriod,
    );
    const adxPts: OverlayPoint[] = [];
    for (let i = 0; i < ltf.length; i++) {
      const v = adxAtBar(adxRes.adx, i, p.adxPeriod);
      if (v != null) adxPts.push({ time: ltf[i].time, value: v });
    }
    lines.push({ id: "adx", label: "ADX", color: "#3498db", data: adxPts, lineWidth: 2, pane: "osc" });
  }

  const priceLines: PriceLineSpec[] = [];
  if (toggles.useSr && ltf.length > 0) {
    const lastIdx = ltf.length - 1;
    const pivots = findPivots(ltf.slice(0, lastIdx + 1), p.pivotLookback);
    const atrVal = atrForBar(ltf, lastIdx, p.adxPeriod);
    const zones = clusterZones(pivots, atrVal, 3);
    zones.forEach((z, i) => {
      const mid = (z.low + z.high) / 2;
      priceLines.push({
        price: mid,
        title: `S/R ${i + 1}`,
        color: i === 0 ? "rgba(91,140,255,0.9)" : "rgba(91,140,255,0.45)",
      });
    });
  }

  const diag = evaluateConfluence(ctx, ltf.length - 1, "flat", rawParams);

  return {
    lines,
    priceLines,
    confluence: {
      score: diag.score,
      threshold: diag.threshold,
      regime: diag.regime,
      factors: diag.factors,
    },
    activeToggles: toggles,
  };
}
