import type { Candle, CandleInterval } from "../types";
import type { Signal, StrategyContext } from "../strategies/types";
import { getStrategy, prepareConfluenceStrategy, CONFLUENCE_KEY, BACKTEST_KEY, defaultHtfFor } from "../strategies/registry";
import { getHistoricalCandles } from "../data/historical";
import { getConfluenceContext } from "../strategies/confluenceStrategy";
import { confluenceSignal } from "../strategies/confluence";
import { backtestContextKey, liveContextKey } from "../universe";

export type ContextKey = string | object;

/** Load HTF candles and prepare confluence context when needed. */
export async function prepareStrategyData(
  strategyId: string,
  symbol: string,
  ltfInterval: CandleInterval,
  ltfCandles: Candle[],
  contextKey?: ContextKey,
): Promise<void> {
  if (!strategyId.startsWith("confluence")) return;
  const key = contextKey ?? liveContextKey(symbol);
  const htfInterval = defaultHtfFor(ltfInterval, strategyId === "confluence-scalp");
  const from = ltfCandles[0]?.time;
  const to = ltfCandles[ltfCandles.length - 1]?.time;
  const { candles: htfCandles } = await getHistoricalCandles({
    symbol,
    interval: htfInterval,
    startTime: from,
    endTime: to,
    useCache: true,
  });
  prepareConfluenceStrategy(key, ltfCandles, htfCandles, htfInterval);
}

export { BACKTEST_KEY, CONFLUENCE_KEY, backtestContextKey, liveContextKey };

export function evaluateStrategy(
  strategyId: string,
  candles: Candle[],
  index: number,
  position: "long" | "flat",
  params: Record<string, number>,
) {
  return evaluateStrategyDetail(strategyId, candles, index, position, params).signal;
}

export function evaluateStrategyDetail(
  strategyId: string,
  candles: Candle[],
  index: number,
  position: "long" | "flat",
  params: Record<string, number>,
  contextKey: ContextKey = CONFLUENCE_KEY,
): { signal: Signal; reason?: string; score?: number; threshold?: number } {
  const strategy = getStrategy(strategyId);
  if (!strategy) return { signal: "hold" };

  if (strategyId.startsWith("confluence")) {
    const cctx = getConfluenceContext(contextKey);
    if (!cctx || index < 0 || index >= cctx.ltfCandles.length) return { signal: "hold" };
    const { signal, reason, diagnostics } = confluenceSignal(cctx, index, position, params);
    return { signal, reason, score: diagnostics.score, threshold: diagnostics.threshold };
  }

  const signal = strategy.next({ candles, index, position } as StrategyContext, params);
  return { signal, reason: signal !== "hold" ? strategyId : undefined };
}
