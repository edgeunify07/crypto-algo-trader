import { describe, expect, it } from "vitest";
import { RSI } from "technicalindicators";
import { rmi, rmiAtBar } from "./rmi";
import { closes } from "./common";

describe("RMI", () => {
  it("RMI(14,1) equals RSI(14)", () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
    const rmiSeries = rmi(prices, 14, 1);
    const rsiSeries = RSI.calculate({ period: 14, values: prices });
    const compareFrom = 14 + 13;
    for (let i = compareFrom; i < prices.length; i++) {
      const r = rmiAtBar(rmiSeries, i, 1, 14);
      const rsi = rsiSeries[i - 14];
      if (r != null && rsi != null) {
        expect(r).toBeCloseTo(rsi, 1);
      }
    }
  });
});
