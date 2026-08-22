/**
 * Indicator toggles (1=on, 0=off) — user-configurable in Strategy Engine.
 * When off, factor weight is zero and related vetoes are skipped.
 */
export const INDICATOR_TOGGLES = {
  useSma: "SMA crossover",
  useEma: "EMA trend",
  useRmi: "RMI momentum",
  useSr: "Support / resistance",
  useStructure: "Market structure",
  useBreakout: "Breakout + Donchian",
  useVolume: "Volume (RVOL)",
  usePriceAction: "Price action candles",
  useVwap: "VWAP (scalp)",
  useAdxRegime: "ADX regime filter",
  useHtfFilter: "HTF trend filter",
} as const;

export type IndicatorToggleKey = keyof typeof INDICATOR_TOGGLES;

export const DEFAULT_TOGGLES: Record<IndicatorToggleKey, number> = {
  useSma: 1,
  useEma: 1,
  useRmi: 1,
  useSr: 1,
  useStructure: 1,
  useBreakout: 1,
  useVolume: 1,
  usePriceAction: 1,
  useVwap: 1,
  useAdxRegime: 1,
  useHtfFilter: 1,
};

export function togglesFromParams(params: Record<string, number>): Record<IndicatorToggleKey, boolean> {
  const out = {} as Record<IndicatorToggleKey, boolean>;
  for (const k of Object.keys(DEFAULT_TOGGLES) as IndicatorToggleKey[]) {
    out[k] = (params[k] ?? DEFAULT_TOGGLES[k]) >= 1;
  }
  return out;
}

/** Params exposed in UI grouped by category. */
export const PARAM_GROUPS = {
  indicators: Object.keys(INDICATOR_TOGGLES),
  trend: ["emaFast", "emaSlow", "smaFast", "smaSlow", "htfEmaPeriod"],
  momentum: ["rmiLength", "rmiMomentum", "rmiMode", "rmiBullTrend", "rmiBearTrend", "rmiOversold", "rmiOverbought"],
  regime: ["adxPeriod", "adxTrending", "adxRanging", "entryThreshold", "minConfirmFactors", "minConfidence", "requireCoreFactors", "requireTrending", "allowRangingMr"],
  risk: ["targetPct", "stopPct", "maxHoldBars", "minRvol"],
  weights: ["weightTrend", "weightRmi", "weightStructure", "weightSr", "weightBreakout", "weightCandle", "weightVolume"],
} as const;
