import type { Candle, CandleInterval } from "../types";
import { intervalMs } from "../data/intervalMs";

/**
 * Map each LTF bar to the index of the last **fully closed** HTF bar visible at
 * that LTF timestamp. HTF values are shifted forward by one HTF period so no
 * lookahead leaks future OHLC into earlier LTF bars (§4.2).
 */
export function mapLtfToHtfIndex(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  htfInterval: CandleInterval,
): number[] {
  const htfMs = intervalMs(htfInterval);
  const result: number[] = [];

  for (const ltf of ltfCandles) {
    const ltfMs = ltf.time * 1000;
    let htfIdx = -1;
    for (let i = 0; i < htfCandles.length; i++) {
      const closeSec = htfCandles[i].closeTime ?? htfCandles[i].time + htfMs / 1000 - 1;
      const htfCloseMs = closeSec * 1000;
      if (htfCloseMs <= ltfMs) htfIdx = i;
      else break;
    }
    result.push(htfIdx);
  }
  return result;
}

/** Assert no HTF bar is visible before its close time (unit test helper). */
export function assertNoLookahead(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  htfInterval: CandleInterval,
  mapping: number[],
): { ok: boolean; violations: number[] } {
  const htfMs = intervalMs(htfInterval);
  const violations: number[] = [];
  for (let i = 0; i < ltfCandles.length; i++) {
    const htfIdx = mapping[i];
    if (htfIdx < 0) continue;
    const closeSec = htfCandles[htfIdx].closeTime ?? htfCandles[htfIdx].time + htfMs / 1000 - 1;
    const htfCloseMs = closeSec * 1000;
    const ltfOpenMs = ltfCandles[i].time * 1000;
    if (htfCloseMs > ltfOpenMs) violations.push(i);
  }
  return { ok: violations.length === 0, violations };
}
