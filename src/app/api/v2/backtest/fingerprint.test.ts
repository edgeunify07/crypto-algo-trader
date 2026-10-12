import { describe, expect, it } from "vitest";
import { fingerprint } from "./route";
import { DEFAULT_PARAMS } from "@/lib/algo/strategy/params";

describe("backtest cache fingerprint", () => {
  it("is stable across property order", () => {
    // A record read back from storage carries whatever order the serialiser
    // chose, and must not look like different parameters because of it.
    const shuffled = Object.fromEntries(
      Object.entries(DEFAULT_PARAMS as unknown as Record<string, unknown>).reverse(),
    );
    expect(fingerprint(shuffled)).toBe(fingerprint(DEFAULT_PARAMS));
  });

  it("changes when any parameter changes", () => {
    const before = fingerprint(DEFAULT_PARAMS);
    expect(
      fingerprint({
        ...DEFAULT_PARAMS,
        entry: { ...DEFAULT_PARAMS.entry, minScore: DEFAULT_PARAMS.entry.minScore + 0.01 },
      }),
    ).not.toBe(before);
    // Derived from the current value rather than written out: a literal here
    // was 0.7, and the day the default became 0.7 this assertion started
    // comparing the defaults with themselves and passing for the wrong
    // reason — which is the same mistake as the bug the fingerprint fixes.
    expect(
      fingerprint({
        ...DEFAULT_PARAMS,
        scalp: {
          ...DEFAULT_PARAMS.scalp,
          minConfidence: DEFAULT_PARAMS.scalp.minConfidence + 0.01,
        },
      }),
    ).not.toBe(before);
  });

  /**
   * The bug this exists for: the key held only the version label, which for
   * the shipped defaults never changes, so a retune served the old results.
   */
  it("separates two parameter sets that share a version label", () => {
    const retuned = {
      ...DEFAULT_PARAMS,
      exit: { ...DEFAULT_PARAMS.exit, atrStopMultiple: 2.5 },
    };
    expect(fingerprint(retuned)).not.toBe(fingerprint(DEFAULT_PARAMS));
  });
});
