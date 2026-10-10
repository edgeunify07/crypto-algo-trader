/** Small numeric helpers used across indicators and analysis. */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp into the canonical signal range. */
export function clamp1(value: number): number {
  return clamp(value, -1, 1);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

export function sum(values: number[]): number {
  let acc = 0;
  for (const v of values) acc += v;
  return acc;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] as number;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] as number;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/** Weighted average that ignores zero-weight entries; returns 0 if all weights are 0. */
export function weightedAverage(
  items: { value: number; weight: number }[],
): number {
  let num = 0;
  let den = 0;
  for (const { value, weight } of items) {
    if (weight <= 0) continue;
    num += value * weight;
    den += weight;
  }
  return den === 0 ? 0 : num / den;
}

/** Round to a multiple of `step` (Binance LOT_SIZE / PRICE_FILTER semantics). */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

/** Relative difference between two prices, as a fraction of `reference`. */
export function pctDiff(value: number, reference: number): number {
  if (reference === 0) return 0;
  return (value - reference) / reference;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
