import type { CandleInterval } from "../types";
import {
  buildConfluenceContext,
  confluenceSignal,
  DEFAULT_CONFLUENCE_PARAMS,
  DEFAULT_SCALP_PARAMS,
  type ConfluenceContext,
} from "./confluence";
import type { Strategy, StrategyContext, Signal } from "./types";

/** HTF for swing vs scalp stack (§3B: 1m/5m/15m). */
export function defaultHtfFor(ltf: CandleInterval, scalp = false): CandleInterval {
  if (scalp) {
    const map: Partial<Record<CandleInterval, CandleInterval>> = {
      "1m": "5m",
      "5m": "15m",
      "15m": "1h",
      "1h": "4h",
    };
    return map[ltf] ?? "15m";
  }
  const map: Partial<Record<CandleInterval, CandleInterval>> = {
    "1m": "15m",
    "5m": "1h",
    "15m": "1h",
    "1h": "4h",
    "4h": "1d",
    "1d": "1d",
  };
  return map[ltf] ?? "1h";
}

type ContextKey = string | object;

function toKey(key: ContextKey): string {
  if (typeof key === "string") return key;
  if (key === CONFLUENCE_KEY) return "live";
  if (key === BACKTEST_KEY) return "backtest";
  return "default";
}

/** String-keyed store so multi-symbol bot/backtest don't clobber each other. */
const prepStore = new Map<string, ConfluenceContext>();

export function prepareConfluenceStrategy(
  key: ContextKey,
  ltfCandles: Parameters<typeof buildConfluenceContext>[0],
  htfCandles: Parameters<typeof buildConfluenceContext>[1],
  htfInterval: CandleInterval,
): void {
  prepStore.set(toKey(key), buildConfluenceContext(ltfCandles, htfCandles, htfInterval));
}

export function getConfluenceContext(key: ContextKey): ConfluenceContext | undefined {
  return prepStore.get(toKey(key));
}

/** @deprecated Prefer liveContextKey(symbol) — kept for compatibility. */
export const CONFLUENCE_KEY = {};
/** @deprecated Prefer backtestContextKey(symbol). */
export const BACKTEST_KEY = {};

/** Shared engine — mode 0=swing, 1=scalp via params.mode or strategy id. */
export const confluenceStrategy: Strategy = {
  id: "confluence",
  name: "Confluence Engine",
  description: "Internal shared engine.",
  params: { ...DEFAULT_CONFLUENCE_PARAMS, ...DEFAULT_SCALP_PARAMS, mode: 0 } as unknown as Record<string, number>,
  next(ctx: StrategyContext, params: Record<string, number>): Signal {
    const cctx = getConfluenceContext(CONFLUENCE_KEY);
    if (!cctx) return "hold";
    const mode = params.mode ?? 0;
    const merged = { ...params, mode };
    const { signal } = confluenceSignal(cctx, ctx.index, ctx.position, merged);
    return signal;
  },
};
