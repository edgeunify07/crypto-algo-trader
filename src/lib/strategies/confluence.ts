import type { Candle, CandleInterval } from "../types";
import { adx, adxAtBar, regimeFromAdx, type Regime } from "../indicators/adx";
import { closes, ema, highs, lows, sma } from "../indicators/common";
import { mapLtfToHtfIndex } from "../indicators/mtf";
import { rmi, rmiAtBar } from "../indicators/rmi";
import {
  atrForBar,
  breakoutConfirmed,
  clusterZones,
  donchianHigh,
  findPivots,
  isBullishEngulfing,
  nearSupport,
  rvol,
  structureState,
} from "../indicators/structure";
import { DEFAULT_TOGGLES, togglesFromParams } from "./indicatorToggles";
import { emaBullStack, smaBearCross, smaBullCross, strongBullClose } from "./signals";

export type HtfTrend = "bullish" | "bearish" | "neutral";

export interface ConfluenceDiagnostics {
  regime: Regime;
  htfTrend: HtfTrend;
  score: number;
  maxScore: number;
  threshold: number;
  factors: Record<string, number>;
  vetoes: string[];
  adx: number | null;
  rmi: number | null;
  scalpSubStrategy?: string;
}

function vwapAt(candles: Candle[], index: number): number {
  let pv = 0;
  let vol = 0;
  for (let i = 0; i <= index; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += tp * candles[i].volume;
    vol += candles[i].volume;
  }
  return vol > 0 ? pv / vol : candles[index].close;
}

export interface ConfluenceParams {
  adxPeriod: number;
  adxTrending: number;
  adxRanging: number;
  htfEmaPeriod: number;
  emaFast: number;
  emaSlow: number;
  smaFast: number;
  smaSlow: number;
  rmiLength: number;
  rmiMomentum: number;
  rmiMode: number;
  rmiBullTrend: number;
  rmiBearTrend: number;
  rmiOversold: number;
  rmiOverbought: number;
  pivotLookback: number;
  donchianPeriod: number;
  minRvol: number;
  entryThreshold: number;
  weightTrend: number;
  weightRmi: number;
  weightStructure: number;
  weightSr: number;
  weightBreakout: number;
  weightCandle: number;
  weightVolume: number;
  allowRangingMr: number;
  transitionSizePct: number;
  mode: number;
  minConfirmFactors: number;
  /** 0–100: score must be ≥ threshold × (minConfidence/100). Default 85 = high-confidence only. */
  minConfidence: number;
  /** 1 = require trend/SMA + volume factors before BUY. */
  requireCoreFactors: number;
  /** 1 = only enter when ADX regime is trending. */
  requireTrending: number;
  [key: string]: number;
}

export const DEFAULT_SCALP_PARAMS: Partial<ConfluenceParams> & Record<string, number> = {
  ...DEFAULT_TOGGLES,
  mode: 1,
  adxPeriod: 10,
  adxTrending: 25,
  adxRanging: 18,
  htfEmaPeriod: 21,
  emaFast: 8,
  emaSlow: 21,
  smaFast: 5,
  smaSlow: 13,
  rmiLength: 14,
  rmiMomentum: 3,
  rmiBullTrend: 58,
  rmiBearTrend: 42,
  entryThreshold: 6,
  minConfirmFactors: 2,
  minConfidence: 90,
  requireCoreFactors: 1,
  requireTrending: 1,
  minRvol: 1.6,
  donchianPeriod: 12,
  weightTrend: 2,
  weightRmi: 2,
  weightVolume: 2,
  maxHoldBars: 12,
  targetPct: 0.002,
  stopPct: 0.0015,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0005,
  minMakerFillRatio: 0.7,
};

/**
 * High-confidence swing defaults — grid-tuned BTCUSDT 15m (Aug 2026):
 * +12.5% return · 66.7% WR · PF 20.9 · 6 trades · maxDD 3.3%.
 * Stricter gates cut weak entries; bot often sits FLAT waiting for setups.
 */
export const DEFAULT_CONFLUENCE_PARAMS: ConfluenceParams = {
  ...DEFAULT_TOGGLES,
  adxPeriod: 14,
  adxTrending: 25,
  adxRanging: 18,
  htfEmaPeriod: 50,
  emaFast: 12,
  emaSlow: 26,
  smaFast: 12,
  smaSlow: 26,
  rmiLength: 14,
  rmiMomentum: 5,
  rmiMode: 1,
  rmiBullTrend: 58,
  rmiBearTrend: 42,
  rmiOversold: 32,
  rmiOverbought: 68,
  pivotLookback: 3,
  donchianPeriod: 20,
  minRvol: 1.3,
  entryThreshold: 12,
  minConfirmFactors: 3,
  minConfidence: 85,
  requireCoreFactors: 1,
  requireTrending: 1,
  weightTrend: 3,
  weightRmi: 2,
  weightStructure: 2,
  weightSr: 2,
  weightBreakout: 2,
  weightCandle: 1,
  weightVolume: 2,
  allowRangingMr: 0,
  transitionSizePct: 50,
  mode: 0,
};

export interface ConfluenceContext {
  ltfCandles: Candle[];
  htfCandles: Candle[];
  htfInterval: CandleInterval;
  htfMapping: number[];
}

export function buildConfluenceContext(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  htfInterval: CandleInterval,
): ConfluenceContext {
  return {
    ltfCandles,
    htfCandles,
    htfInterval,
    htfMapping: mapLtfToHtfIndex(ltfCandles, htfCandles, htfInterval),
  };
}

function htfTrendAt(ctx: ConfluenceContext, index: number, emaPeriod: number): HtfTrend {
  const htfIdx = ctx.htfMapping[index];
  if (htfIdx < 1) return "neutral";
  const slice = ctx.htfCandles.slice(0, htfIdx + 1);
  const c = closes(slice);
  const e = ema(c, emaPeriod);
  if (e.length < 2) return "neutral";
  const slope = e[e.length - 1] - e[e.length - 2];
  const price = c[c.length - 1];
  if (slope > 0 && price > e[e.length - 1]) return "bullish";
  if (slope < 0 && price < e[e.length - 1]) return "bearish";
  return "neutral";
}

function scalpEntrySignal(
  ctx: ConfluenceContext,
  index: number,
  p: ConfluenceParams,
  regime: Regime,
  toggles: ReturnType<typeof togglesFromParams>,
): { ok: boolean; sub: string } {
  const candles = ctx.ltfCandles;
  const c = candles[index];
  const vwap = vwapAt(candles, index);
  const atrVal = atrForBar(candles, index, 10);
  const distToVwap = (c.close - vwap) / vwap;
  const volOk = !toggles.useVolume || rvol(candles, index) >= p.minRvol;

  if (regime === "ranging" && toggles.useVwap) {
    if (distToVwap < -0.0008 && c.close > c.open && volOk && strongBullClose(candles, index)) {
      return { ok: true, sub: "vwap-mr" };
    }
  }
  if (regime === "trending") {
    if (toggles.useEma && emaBullStack(candles, index, p.emaFast, p.emaSlow) && c.close > vwap && volOk) {
      return { ok: true, sub: "momentum" };
    }
    if (toggles.useBreakout) {
      const level = donchianHigh(candles, p.donchianPeriod, index - 1);
      if (breakoutConfirmed(candles, index, level, "long", atrVal, p.minRvol)) {
        return { ok: true, sub: "micro-breakout" };
      }
    }
    if (toggles.useSma && smaBullCross(candles, index, p.smaFast, p.smaSlow) && volOk) {
      return { ok: true, sub: "sma-cross" };
    }
  }
  return { ok: false, sub: "none" };
}

function mergeParams(rawParams: Record<string, number>): ConfluenceParams {
  // Never let scalp defaults overwrite swing mode — mode comes from rawParams only.
  const isScalp = (rawParams.mode ?? 0) >= 1;
  return {
    ...DEFAULT_CONFLUENCE_PARAMS,
    ...(isScalp ? DEFAULT_SCALP_PARAMS : {}),
    ...rawParams,
    mode: rawParams.mode ?? (isScalp ? 1 : 0),
  } as ConfluenceParams;
}

export function evaluateConfluence(
  ctx: ConfluenceContext,
  index: number,
  _position: "long" | "flat",
  rawParams: Record<string, number>,
): ConfluenceDiagnostics {
  const p = mergeParams(rawParams);
  const toggles = togglesFromParams(rawParams);
  const candles = ctx.ltfCandles;
  if (index < 0 || index >= candles.length || !candles[index]) {
    return {
      regime: "transition",
      htfTrend: "neutral",
      score: 0,
      maxScore: 0,
      threshold: p.entryThreshold,
      factors: {},
      vetoes: ["invalid bar index"],
      adx: null,
      rmi: null,
    };
  }
  const c = closes(candles, index);
  const h = highs(candles, index);
  const l = lows(candles, index);
  const vetoes: string[] = [];
  const factors: Record<string, number> = {};

  const adxRes = toggles.useAdxRegime ? adx(h, l, c, p.adxPeriod) : { adx: [] as number[] };
  const adxVal = toggles.useAdxRegime ? adxAtBar(adxRes.adx, index, p.adxPeriod) : 30;
  const regime = toggles.useAdxRegime ? regimeFromAdx(adxVal, p.adxTrending, p.adxRanging) : "trending";
  const htfTrend = toggles.useHtfFilter ? htfTrendAt(ctx, index, p.htfEmaPeriod) : "bullish";

  // SMA crossover factor
  if (toggles.useSma) {
    if (smaBullCross(candles, index, p.smaFast, p.smaSlow)) factors.smaCross = p.weightTrend;
    else if (emaBullStack(candles, index, p.smaFast, p.smaSlow)) factors.smaCross = p.weightTrend * 0.6;
    else factors.smaCross = 0;
  }

  // EMA trend factor (collapsed with SMA per spec — primary EMA, SMA confirms)
  if (toggles.useEma) {
    const ef = ema(c, p.emaFast);
    const es = ema(c, p.emaSlow);
    let trendScore = 0;
    if (ef.length && es.length) {
      const eNow = ef[ef.length - 1];
      const sNow = es[es.length - 1];
      const sf = sma(c, p.smaFast);
      const ss = sma(c, p.smaSlow);
      const smaConfirm = sf.length && ss.length && sf[sf.length - 1] > ss[ss.length - 1];
      if (eNow > sNow && smaConfirm) trendScore = p.weightTrend;
      else if (eNow > sNow) trendScore = p.weightTrend * 0.5;
    }
    factors.trend = trendScore;
  }

  if (toggles.useRmi) {
    const rmiSeries = rmi(c, p.rmiLength, p.rmiMomentum);
    const rmiVal = rmiAtBar(rmiSeries, index, p.rmiMomentum, p.rmiLength);
    if (rmiVal != null) {
      if (p.rmiMode >= 1) {
        factors.rmi = rmiVal >= p.rmiBullTrend ? p.weightRmi : rmiVal <= p.rmiBearTrend ? 0 : p.weightRmi * 0.4;
      } else {
        factors.rmi = rmiVal < p.rmiOversold ? p.weightRmi : 0;
      }
    }
  }

  if (toggles.useStructure) {
    const pivots = findPivots(candles.slice(0, index + 1), p.pivotLookback);
    const struct = structureState(pivots, index);
    factors.structure = struct === "uptrend" ? p.weightStructure : struct === "neutral" ? p.weightStructure * 0.5 : 0;
  }

  if (toggles.useSr) {
    const pivots = findPivots(candles.slice(0, index + 1), p.pivotLookback);
    const atrVal = atrForBar(candles, index, p.adxPeriod);
    const zones = clusterZones(pivots, atrVal, 3);
    factors.sr = nearSupport(candles[index].close, zones) ? p.weightSr : 0;
  }

  if (toggles.useBreakout) {
    const atrVal = atrForBar(candles, index, p.adxPeriod);
    const level = donchianHigh(candles, p.donchianPeriod, index - 1);
    factors.breakout = breakoutConfirmed(candles, index, level, "long", atrVal, p.minRvol) ? p.weightBreakout : 0;
  }

  if (toggles.usePriceAction) {
    let pa = 0;
    if (isBullishEngulfing(candles, index)) pa += p.weightCandle;
    if (strongBullClose(candles, index)) pa += p.weightCandle * 0.5;
    factors.priceAction = pa;
  }

  if (toggles.useVolume) {
    const rv = rvol(candles, index);
    factors.volume = rv >= p.minRvol ? p.weightVolume : rv >= 1 ? p.weightVolume * 0.5 : 0;
    if (rv < 1 && factors.breakout > 0) vetoes.push("RVOL too low for breakout");
  }

  let score = Object.values(factors).reduce((a, b) => a + b, 0);
  const activeFactors = Object.values(factors).filter((v) => v > 0).length;
  const maxScore = Object.values(factors).reduce((a, b) => a + Math.max(b, 0), 0) || 12;

  if (regime === "trending") score += (factors.breakout ?? 0) * 0.2;
  if (regime === "ranging" && p.allowRangingMr < 1 && (factors.breakout ?? 0) > 0) {
    vetoes.push("Breakout in ranging regime");
  }
  if (activeFactors < p.minConfirmFactors) vetoes.push(`Need ${p.minConfirmFactors} confirming factors`);

  if (p.requireCoreFactors >= 1) {
    const hasTrend = (factors.trend ?? 0) > 0 || (factors.smaCross ?? 0) > 0;
    const hasVol = (factors.volume ?? 0) > 0;
    if (!hasTrend) vetoes.push("Need trend/SMA confirmation");
    if (!hasVol) vetoes.push("Need volume confirmation");
  }
  if (p.requireTrending >= 1 && toggles.useAdxRegime && regime !== "trending") {
    vetoes.push("ADX not trending — high-confidence only");
  }

  const confNeeded = Math.max(p.entryThreshold * ((p.minConfidence ?? 85) / 100), p.entryThreshold * 0.85);
  if (score < confNeeded && score >= p.entryThreshold) {
    vetoes.push(`Confidence below ${p.minConfidence}% of threshold`);
  }

  if (toggles.useHtfFilter && htfTrend !== "bullish") vetoes.push("HTF trend not bullish");
  if (toggles.useAdxRegime && regime === "ranging" && p.allowRangingMr < 1 && p.mode < 1) {
    vetoes.push("ADX ranging — stand aside");
  }

  const rmiSeries = rmi(c, p.rmiLength, p.rmiMomentum);
  const rmiVal = rmiAtBar(rmiSeries, index, p.rmiMomentum, p.rmiLength);

  return {
    regime,
    htfTrend,
    score,
    maxScore,
    threshold: p.entryThreshold,
    factors,
    vetoes,
    adx: adxVal,
    rmi: rmiVal,
  };
}

function shouldExitLong(
  ctx: ConfluenceContext,
  index: number,
  params: Record<string, number>,
  diag: ConfluenceDiagnostics,
): string | null {
  const p = mergeParams(params) as ConfluenceParams;
  const toggles = togglesFromParams(params);
  const candles = ctx.ltfCandles;

  if (toggles.useHtfFilter && diag.htfTrend === "bearish") return "HTF bearish";
  if (toggles.useSma && smaBearCross(candles, index, p.smaFast, p.smaSlow)) return "SMA bear cross";
  if (toggles.useRmi && diag.rmi != null) {
    if (p.rmiMode >= 1 && diag.rmi <= p.rmiBearTrend) return "RMI weak";
    if (p.rmiMode < 1 && diag.rmi >= p.rmiOverbought) return "RMI overbought";
  }
  if (toggles.useStructure) {
    const pivots = findPivots(candles.slice(0, index + 1), p.pivotLookback);
    if (structureState(pivots, index) === "downtrend") return "structure break";
  }
  return null;
}

export function confluenceSignal(
  ctx: ConfluenceContext,
  index: number,
  position: "long" | "flat",
  params: Record<string, number>,
): { signal: "buy" | "sell" | "hold"; diagnostics: ConfluenceDiagnostics; reason?: string } {
  const p = mergeParams(params);
  const isScalp = (params.mode ?? 0) >= 1;
  const diag = evaluateConfluence(ctx, index, position, params);

  if (position === "long") {
    const exitReason = shouldExitLong(ctx, index, params, diag);
    if (exitReason) return { signal: "sell", diagnostics: diag, reason: exitReason };
    // Early profit lock: if score collapses while in profit-friendly regime, exit
    if (diag.score < diag.threshold * 0.4 && diag.regime !== "trending") {
      return { signal: "sell", diagnostics: diag, reason: "confluence faded" };
    }
    return { signal: "hold", diagnostics: diag };
  }

  if (isScalp) {
    const scalp = scalpEntrySignal(ctx, index, p, diag.regime, togglesFromParams(params));
    diag.scalpSubStrategy = scalp.sub;
    if (diag.regime === "transition") return { signal: "hold", diagnostics: diag, reason: "transition" };
    // High-confidence scalp: need sub-strategy AND score gate AND no hard vetoes
    const hardVetoes = diag.vetoes.filter((v) => !v.startsWith("ADX ranging"));
    if (scalp.ok && hardVetoes.length === 0 && diag.score >= diag.threshold) {
      return { signal: "buy", diagnostics: diag, reason: `${scalp.sub}·hi-conf` };
    }
    return { signal: "hold", diagnostics: diag };
  }

  if (diag.vetoes.length > 0) return { signal: "hold", diagnostics: diag };
  if (diag.score >= diag.threshold) {
    const top = Object.entries(diag.factors).filter(([, v]) => v > 0).map(([k]) => k).join("+");
    return { signal: "buy", diagnostics: diag, reason: top || "confluence" };
  }
  return { signal: "hold", diagnostics: diag };
}
