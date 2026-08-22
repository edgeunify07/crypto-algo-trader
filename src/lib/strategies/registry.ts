import type { Strategy } from "./types";
import { confluenceStrategy, CONFLUENCE_KEY, BACKTEST_KEY, prepareConfluenceStrategy, getConfluenceContext, defaultHtfFor } from "./confluenceStrategy";
import { DEFAULT_CONFLUENCE_PARAMS, DEFAULT_SCALP_PARAMS } from "./confluence";
import { closes } from "./types";

/** Benchmark / engine test fixture — NOT shown in strategy dropdown. */
export const buyAndHoldBenchmark: Strategy = {
  id: "buy-and-hold",
  name: "Buy & Hold (benchmark)",
  description: "Engine validation fixture only. Shown as benchmark line, not a selectable strategy.",
  params: { warmup: 1 },
  next(ctx, params) {
    const warmup = Math.max(0, Math.floor(params.warmup));
    if (ctx.index >= warmup && ctx.position === "flat") return "buy";
    return "hold";
  },
};

/** Exactly two user-facing strategies — shared confluence engine, mode param differs. */
export const confluenceSwing: Strategy = {
  id: "confluence-swing",
  name: "Confluence (Swing)",
  description: "Fee-aware swing · +edge after Binance fees on tune · HTF + ADX trending · EMA/SMA confluence. Best on 15m–4h.",
  params: { ...DEFAULT_CONFLUENCE_PARAMS, mode: 0 } as unknown as Record<string, number>,
  next: confluenceStrategy.next,
};

export const confluenceScalp: Strategy = {
  id: "confluence-scalp",
  name: "Confluence (Scalp)",
  description: "High-confidence scalp · VWAP/momentum/breakout only when score clears gate. Maker-first · max 12 bars. Requires aggTrade backtest.",
  params: { ...DEFAULT_CONFLUENCE_PARAMS, ...DEFAULT_SCALP_PARAMS, mode: 1 } as unknown as Record<string, number>,
  next: confluenceStrategy.next,
};

/** Dropdown registry — exactly two entries. */
export const UI_STRATEGIES: Strategy[] = [confluenceSwing, confluenceScalp];

/** All runnable strategies including internal benchmark. */
export const ALL_STRATEGIES: Strategy[] = [...UI_STRATEGIES, buyAndHoldBenchmark];

export function getStrategy(id: string): Strategy | undefined {
  return ALL_STRATEGIES.find((s) => s.id === id);
}

export function isScalpStrategy(id: string): boolean {
  return id === "confluence-scalp";
}

export function paramsForStrategy(id: string): Record<string, number> {
  const s = getStrategy(id);
  return s ? { ...s.params } : { mode: 0 };
}

export { CONFLUENCE_KEY, BACKTEST_KEY, prepareConfluenceStrategy, getConfluenceContext, defaultHtfFor };
