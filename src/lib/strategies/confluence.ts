import type { Candle, CandleInterval } from "../types";
import { regimeFromAdx, type Regime } from "../indicators/adx";
import { mapLtfToHtfIndex } from "../indicators/mtf";
import { clusterZones, donchianHigh, isBullishEngulfing, nearSupport } from "../indicators/structure";
import { DEFAULT_TOGGLES, togglesFromParams } from "./indicatorToggles";
import { strongBullClose } from "./signals";
import {
  adxValueAt,
  atrForBarAt,
  breakoutConfirmedAt,
  emaAt,
  emaBullStackAt,
  rmiValueAt,
  rvolAt,
  smaAt,
  smaBearCrossAt,
  smaBullCrossAt,
  structureStateAt,
  visiblePivots,
  vwapAtCached,
} from "./confluenceCache";

export type HtfTrend = "bullish" | "bearish" | "neutral";

export interface ConfluenceDiagnostics {
  regime: Regime;
  htfTrend: HtfTrend;
  score: number;
  maxScore: number;
  /** score as a % of the maximum achievable score (0–100). */
  confidencePct: number;
  threshold: number;
  factors: Record<string, number>;
  vetoes: string[];
  adx: number | null;
  rmi: number | null;
  scalpSubStrategy?: string;
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
  /**
   * 0–100: minimum `score` as a percentage of the MAXIMUM ACHIEVABLE score
   * (see maxAchievableScore). 0 = off. Raising it demands that more of the
   * available confluence actually fired, independently of `entryThreshold`.
   *
   * Was previously compared against `entryThreshold` in a way that could never
   * fire for any value <= 100 (the entry already required score >= threshold),
   * so the whole 0–100 UI range was a no-op. Default is 0 so that fix does not
   * silently tighten existing configs.
   */
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
  entryThreshold: 5,
  minConfirmFactors: 2,
  minConfidence: 0, // was 75, which was a no-op; see ConfluenceParams.minConfidence
  requireCoreFactors: 1,
  requireTrending: 0,
  minRvol: 1.2,
  donchianPeriod: 12,
  weightTrend: 2,
  weightRmi: 2,
  weightVolume: 2,
  maxHoldBars: 12,
  // Cost-aware: target ≥ MIN_TARGET_PCT (0.45%) and stop ≥ MIN_STOP_PCT (0.6%),
  // so a bracket clears the 0.30% round-trip instead of booking fake wins. RR≈1.
  targetPct: 0.006,
  stopPct: 0.006,
  // Real Binance spot fees (maker == taker == 0.10%); override for VIP/BNB discount.
  makerFeeRate: 0.001,
  takerFeeRate: 0.001,
  minMakerFillRatio: 0.7,
};

/**
 * Tuned swing defaults — BTCUSDT 15m grid (Aug 2026):
 * +13.2% net after fees · 50% WR · PF 8.6 · 8 trades · expectancy ~$1.66 · maxDD 3.3%.
 */
export const DEFAULT_CONFLUENCE_PARAMS: ConfluenceParams = {
  ...DEFAULT_TOGGLES,
  adxPeriod: 14,
  adxTrending: 22,
  adxRanging: 18,
  htfEmaPeriod: 50,
  emaFast: 12,
  emaSlow: 26,
  smaFast: 12,
  smaSlow: 26,
  rmiLength: 14,
  rmiMomentum: 5,
  rmiMode: 1,
  rmiBullTrend: 55,
  rmiBearTrend: 45,
  rmiOversold: 32,
  rmiOverbought: 68,
  pivotLookback: 3,
  donchianPeriod: 20,
  minRvol: 1.4,
  entryThreshold: 9,
  minConfirmFactors: 2,
  minConfidence: 0, // was 70, which was a no-op; see ConfluenceParams.minConfidence
  requireCoreFactors: 1,
  requireTrending: 1,
  weightTrend: 3,
  weightRmi: 2,
  weightStructure: 2,
  weightSr: 1,
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
  // Read the memoized HTF ema by bar index rather than re-slicing + recomputing
  // the whole prefix each call. `e.length >= 2` in the old code ⇔ htfIdx >= emaPeriod
  // ⇔ both of these reads are defined; otherwise fall back to neutral.
  const eNow = emaAt(ctx.htfCandles, htfIdx, emaPeriod);
  const ePrev = emaAt(ctx.htfCandles, htfIdx - 1, emaPeriod);
  if (Number.isNaN(eNow) || Number.isNaN(ePrev)) return "neutral";
  const slope = eNow - ePrev;
  const price = ctx.htfCandles[htfIdx].close;
  if (slope > 0 && price > eNow) return "bullish";
  if (slope < 0 && price < eNow) return "bearish";
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
  const vwap = vwapAtCached(candles, index);
  const atrVal = atrForBarAt(candles, index, 10);
  const distToVwap = (c.close - vwap) / vwap;
  const volOk = !toggles.useVolume || rvolAt(candles, index) >= p.minRvol;

  if (regime === "ranging" && toggles.useVwap) {
    if (distToVwap < -0.0008 && c.close > c.open && volOk && strongBullClose(candles, index)) {
      return { ok: true, sub: "vwap-mr" };
    }
  }
  if (regime === "trending") {
    if (toggles.useEma && emaBullStackAt(candles, index, p.emaFast, p.emaSlow) && c.close > vwap && volOk) {
      return { ok: true, sub: "momentum" };
    }
    if (toggles.useBreakout) {
      const level = donchianHigh(candles, p.donchianPeriod, index - 1);
      if (breakoutConfirmedAt(candles, index, level, "long", atrVal, p.minRvol)) {
        return { ok: true, sub: "micro-breakout" };
      }
    }
    if (toggles.useSma && smaBullCrossAt(candles, index, p.smaFast, p.smaSlow) && volOk) {
      return { ok: true, sub: "sma-cross" };
    }
  }
  return { ok: false, sub: "none" };
}

/**
 * Highest `score` the factor stack can produce with the current toggles and
 * weights — the honest denominator for a confidence percentage. `score` reaches
 * this only if every enabled factor fires at full strength.
 *
 * The breakout weight carries 1.2x because a trending regime adds
 * `factors.breakout * 0.2` on top of the raw factor sum. Price action can score
 * 1.5x its weight (bullish engulfing + strong bull close both fire).
 */
function maxAchievableScore(p: ConfluenceParams, toggles: ReturnType<typeof togglesFromParams>): number {
  let max = 0;
  if (toggles.useSma) max += p.weightTrend;
  if (toggles.useEma) max += p.weightTrend;
  if (toggles.useRmi) max += p.weightRmi;
  if (toggles.useStructure) max += p.weightStructure;
  if (toggles.useSr) max += p.weightSr;
  if (toggles.useBreakout) max += p.weightBreakout * 1.2;
  if (toggles.usePriceAction) max += p.weightCandle * 1.5;
  if (toggles.useVolume) max += p.weightVolume;
  return max;
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
      confidencePct: 0,
      threshold: p.entryThreshold,
      factors: {},
      vetoes: ["invalid bar index"],
      adx: null,
      rmi: null,
    };
  }
  const vetoes: string[] = [];
  const factors: Record<string, number> = {};

  const adxVal = toggles.useAdxRegime ? adxValueAt(candles, index, p.adxPeriod) : 30;
  const regime = toggles.useAdxRegime ? regimeFromAdx(adxVal, p.adxTrending, p.adxRanging) : "trending";
  const htfTrend = toggles.useHtfFilter ? htfTrendAt(ctx, index, p.htfEmaPeriod) : "bullish";

  // SMA crossover factor
  if (toggles.useSma) {
    if (smaBullCrossAt(candles, index, p.smaFast, p.smaSlow)) factors.smaCross = p.weightTrend;
    else if (emaBullStackAt(candles, index, p.smaFast, p.smaSlow)) factors.smaCross = p.weightTrend * 0.6;
    else factors.smaCross = 0;
  }

  // EMA trend factor (collapsed with SMA per spec — primary EMA, SMA confirms)
  if (toggles.useEma) {
    const eNow = emaAt(candles, index, p.emaFast);
    const sNow = emaAt(candles, index, p.emaSlow);
    let trendScore = 0;
    if (!Number.isNaN(eNow) && !Number.isNaN(sNow)) {
      const sfNow = smaAt(candles, index, p.smaFast);
      const ssNow = smaAt(candles, index, p.smaSlow);
      const smaConfirm = !Number.isNaN(sfNow) && !Number.isNaN(ssNow) && sfNow > ssNow;
      if (eNow > sNow && smaConfirm) trendScore = p.weightTrend;
      else if (eNow > sNow) trendScore = p.weightTrend * 0.5;
    }
    factors.trend = trendScore;
  }

  if (toggles.useRmi) {
    const rmiVal = rmiValueAt(candles, index, p.rmiLength, p.rmiMomentum);
    if (rmiVal != null) {
      if (p.rmiMode >= 1) {
        factors.rmi = rmiVal >= p.rmiBullTrend ? p.weightRmi : rmiVal <= p.rmiBearTrend ? 0 : p.weightRmi * 0.4;
      } else {
        factors.rmi = rmiVal < p.rmiOversold ? p.weightRmi : 0;
      }
    }
  }

  if (toggles.useStructure) {
    const struct = structureStateAt(candles, index, p.pivotLookback);
    factors.structure = struct === "uptrend" ? p.weightStructure : struct === "neutral" ? p.weightStructure * 0.5 : 0;
  }

  if (toggles.useSr) {
    const pivots = visiblePivots(candles, index, p.pivotLookback);
    const atrVal = atrForBarAt(candles, index, p.adxPeriod);
    const zones = clusterZones(pivots, atrVal, 3);
    factors.sr = nearSupport(candles[index].close, zones) ? p.weightSr : 0;
  }

  if (toggles.useBreakout) {
    const atrVal = atrForBarAt(candles, index, p.adxPeriod);
    const level = donchianHigh(candles, p.donchianPeriod, index - 1);
    factors.breakout = breakoutConfirmedAt(candles, index, level, "long", atrVal, p.minRvol) ? p.weightBreakout : 0;
  }

  if (toggles.usePriceAction) {
    let pa = 0;
    if (isBullishEngulfing(candles, index)) pa += p.weightCandle;
    if (strongBullClose(candles, index)) pa += p.weightCandle * 0.5;
    factors.priceAction = pa;
  }

  if (toggles.useVolume) {
    const rv = rvolAt(candles, index);
    factors.volume = rv >= p.minRvol ? p.weightVolume : rv >= 1 ? p.weightVolume * 0.5 : 0;
    if (rv < 1 && factors.breakout > 0) vetoes.push("RVOL too low for breakout");
  }

  let score = Object.values(factors).reduce((a, b) => a + b, 0);
  const activeFactors = Object.values(factors).filter((v) => v > 0).length;
  const maxScore = maxAchievableScore(p, toggles) || 12;

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

  // Confidence gate: how much of the AVAILABLE confluence actually fired.
  // 0 disables it. Clamped to 100 — above that it would be unsatisfiable.
  const confidencePct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const minConf = Math.min(Math.max(p.minConfidence ?? 0, 0), 100);
  if (minConf > 0 && confidencePct < minConf) {
    vetoes.push(`Confidence ${confidencePct.toFixed(0)}% below required ${minConf.toFixed(0)}%`);
  }

  if (toggles.useHtfFilter && htfTrend !== "bullish") vetoes.push("HTF trend not bullish");
  if (toggles.useAdxRegime && regime === "ranging" && p.allowRangingMr < 1 && p.mode < 1) {
    vetoes.push("ADX ranging — stand aside");
  }

  const rmiVal = rmiValueAt(candles, index, p.rmiLength, p.rmiMomentum);

  return {
    regime,
    htfTrend,
    score,
    maxScore,
    confidencePct,
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
  if (toggles.useSma && smaBearCrossAt(candles, index, p.smaFast, p.smaSlow)) return "SMA bear cross";
  if (toggles.useRmi && diag.rmi != null) {
    if (p.rmiMode >= 1 && diag.rmi <= p.rmiBearTrend) return "RMI weak";
    if (p.rmiMode < 1 && diag.rmi >= p.rmiOverbought) return "RMI overbought";
  }
  if (toggles.useStructure) {
    if (structureStateAt(candles, index, p.pivotLookback) === "downtrend") return "structure break";
  }
  // Don't exit solely on score fade in a still-bullish HTF trend — locks too many small losses
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
