import type { Candle } from "../types";

export type Signal = "buy" | "sell" | "hold";

export interface StrategyContext {
  /** Full candle series available up to and including the current bar. */
  candles: Candle[];
  /** Index of the current bar being evaluated. */
  index: number;
  /** Current position: are we holding the asset or in cash? */
  position: "long" | "flat";
}

/**
 * A strategy is evaluated bar-by-bar. The SAME interface is used for
 * backtesting (replay historical candles) and live/paper trading (feed the
 * newest candle each tick), so a strategy validated in backtest behaves
 * identically live. This is the "bring-your-own" plug point: implement `next`.
 */
export interface Strategy {
  id: string;
  name: string;
  description: string;
  /** Default, editable parameters (numeric only for a simple UI). */
  params: Record<string, number>;
  /**
   * Return a trading signal for the current bar. `buy` and `sell` are only
   * acted on when they change position (buy when flat, sell when long).
   */
  next(ctx: StrategyContext, params: Record<string, number>): Signal;
}

/** Helper: extract closing prices from candles up to `index` (inclusive). */
export function closes(candles: Candle[], index: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= index; i++) out.push(candles[i].close);
  return out;
}
