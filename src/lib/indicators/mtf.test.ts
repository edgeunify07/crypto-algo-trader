import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { mapLtfToHtfIndex, assertNoLookahead } from "./mtf";

function candle(timeSec: number, closeTimeSec?: number): Candle {
  return { time: timeSec, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, closeTime: closeTimeSec };
}

describe("MTF merge — no lookahead", () => {
  it("LTF bar cannot see HTF bar before HTF close", () => {
    const htf: Candle[] = [candle(0, 3599), candle(3600, 7199)];
    const ltf: Candle[] = [0, 900, 1800, 2700, 3600, 4500, 7200].map((t) => candle(t));
    const mapping = mapLtfToHtfIndex(ltf, htf, "1h");
    const check = assertNoLookahead(ltf, htf, "1h", mapping);
    expect(check.ok).toBe(true);
    // HTF bar 0 closes at 3599 — not visible at LTF 2700
    expect(mapping[3]).toBe(-1);
    // Visible from LTF 3600 onward
    expect(mapping[4]).toBe(0);
    // HTF bar 1 closes at 7199 — visible at LTF 7200
    expect(mapping[6]).toBe(1);
  });
});
