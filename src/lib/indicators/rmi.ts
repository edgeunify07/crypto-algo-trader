import { wilderSmooth } from "./common";

/**
 * Relative Momentum Index (Roger Altman).
 * RMI(length, momentum=1) must equal RSI(length).
 */
export function rmi(closes: number[], length: number, momentum = 5): number[] {
  if (closes.length < length + momentum + 1) return [];
  const changes: number[] = [];
  for (let i = momentum; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - momentum]);
  }
  const ups = changes.map((c) => (c > 0 ? c : 0));
  const downs = changes.map((c) => (c < 0 ? -c : 0));
  const avgUp = wilderSmooth(ups, length);
  const avgDown = wilderSmooth(downs, length);
  const out: number[] = [];
  const offset = length - 1;
  for (let i = 0; i < avgUp.length; i++) {
    const u = avgUp[i];
    const d = avgDown[i];
    out.push(d === 0 ? 100 : u === 0 ? 0 : 100 * (u / (u + d)));
  }
  // Align: first RMI value corresponds to bar index = momentum + offset
  return out;
}

/** Map RMI series back to bar index. */
export function rmiAtBar(rmiSeries: number[], barIndex: number, momentum: number, length: number): number | null {
  const idx = barIndex - momentum - (length - 1);
  if (idx < 0 || idx >= rmiSeries.length) return null;
  return rmiSeries[idx];
}
