import type { Candle, Timeframe } from "./types.js";
import { TIMEFRAME_MS } from "./types.js";

/** Build a candle series from closes, with highs/lows derived from a range. */
export function makeCandles(
  closes: number[],
  options: { timeframe?: Timeframe; start?: number; range?: number; volume?: number } = {},
): Candle[] {
  const { timeframe = "1h", start = 1_700_000_000_000, range = 0.01, volume = 100 } = options;
  const step = TIMEFRAME_MS[timeframe];
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1] as number);
    const spread = close * range;
    return {
      openTime: start + i * step,
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume,
      closeTime: start + (i + 1) * step - 1,
      quoteVolume: volume * close,
      trades: 10,
      closed: true,
    };
  });
}

/** Closes tracing a straight line from `from` to `to`. */
export function linear(from: number, to: number, steps: number): number[] {
  if (steps <= 1) return [to];
  return Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / (steps - 1));
}

/** Concatenate legs, dropping each leg's duplicated first point. */
export function joinLegs(...legs: number[][]): number[] {
  const out: number[] = [];
  for (const leg of legs) {
    out.push(...(out.length === 0 ? leg : leg.slice(1)));
  }
  return out;
}

/** A clean five-wave Elliott impulse followed by enough bars to confirm it. */
export function impulseCloses(): number[] {
  return joinLegs(
    linear(100, 100, 30), // flat warm-up so ATR settles
    linear(100, 130, 25), // wave 1
    linear(130, 118, 15), // wave 2 — 40% retrace
    linear(118, 170, 35), // wave 3 — extended
    linear(170, 152, 15), // wave 4 — no overlap with wave 1's top
    linear(152, 185, 25), // wave 5
    linear(185, 168, 18), // reversal that confirms wave 5's high
  );
}
