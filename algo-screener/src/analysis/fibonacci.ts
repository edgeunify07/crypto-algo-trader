/** Fibonacci ratios shared by the Elliott and Gann modules. */

export const RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
export const EXTENSIONS = [1.0, 1.272, 1.618, 2.0, 2.618, 4.236] as const;

/** Price at `ratio` retracement of the move from `from` to `to`. */
export function retrace(from: number, to: number, ratio: number): number {
  return to - (to - from) * ratio;
}

/** Project `ratio` of the `from`→`to` move forward from `origin`. */
export function project(
  from: number,
  to: number,
  origin: number,
  ratio: number,
): number {
  return origin + (to - from) * ratio;
}

/** How far through a move a price sits: 0 at `to`, 1 at `from`. */
export function retracementRatio(from: number, to: number, price: number): number {
  const range = to - from;
  if (range === 0) return 0;
  return (to - price) / range;
}

/**
 * Closeness of `ratio` to any canonical Fibonacci value, as 0..1.
 * Used to score how "textbook" a wave relationship is.
 */
export function fibAffinity(
  ratio: number,
  targets: readonly number[] = RETRACEMENTS,
  tolerance = 0.08,
): number {
  let best = 0;
  for (const target of targets) {
    const distance = Math.abs(ratio - target);
    if (distance <= tolerance) {
      best = Math.max(best, 1 - distance / tolerance);
    }
  }
  return best;
}

/** Nearest canonical ratio to `ratio`, for reporting. */
export function nearestFib(
  ratio: number,
  targets: readonly number[] = RETRACEMENTS,
): number {
  let best = targets[0] ?? 0;
  let bestDistance = Infinity;
  for (const target of targets) {
    const d = Math.abs(ratio - target);
    if (d < bestDistance) {
      bestDistance = d;
      best = target;
    }
  }
  return best;
}
