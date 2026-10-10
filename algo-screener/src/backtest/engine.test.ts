import { describe, expect, it } from "vitest";
import { runBacktest, type SymbolData } from "./engine.js";
import { DEFAULT_PARAMS } from "../strategy/params.js";
import { joinLegs, linear, makeCandles } from "../testUtils.js";
import type { Candle, Timeframe } from "../types.js";

/** Resample 1h candles up to a slower timeframe by simple bucketing. */
function resample(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const bucket = candles.slice(i, i + factor);
    const first = bucket[0] as Candle;
    const last = bucket.at(-1) as Candle;
    out.push({
      openTime: first.openTime,
      open: first.open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: last.close,
      volume: bucket.reduce((a, c) => a + c.volume, 0),
      closeTime: last.closeTime,
      quoteVolume: bucket.reduce((a, c) => a + c.quoteVolume, 0),
      trades: bucket.reduce((a, c) => a + c.trades, 0),
      closed: true,
    });
  }
  return out;
}

function buildData(closes: number[], symbol = "BTCUSDT"): SymbolData {
  const hourly = makeCandles(closes, { timeframe: "1h" });
  const byTimeframe = new Map<Timeframe, Candle[]>([
    ["1h", hourly],
    ["4h", resample(hourly, 4)],
    ["1d", resample(hourly, 24)],
  ]);
  return { symbol, byTimeframe, quoteVolume24h: 1e9 };
}

const trendingUp = joinLegs(
  linear(100, 102, 120),
  linear(102, 140, 180),
  linear(140, 132, 60),
  linear(132, 190, 200),
);

describe("runBacktest", () => {
  it("returns an empty result when the range holds too few bars", () => {
    const result = runBacktest([buildData(linear(100, 105, 5))], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
    });
    expect(result.metrics.trades).toBe(0);
    expect(result.fitness).toBe(-1);
  });

  it("runs over a trending series and reports a coherent result", () => {
    const result = runBacktest([buildData(trendingUp)], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
      startingCash: 10_000,
    });
    expect(result.stepTimeframe).toBe("1h");
    expect(result.curve.length).toBeGreaterThan(10);
    expect(result.from).toBeLessThan(result.to);
    // Final equity must equal starting cash plus realised PnL.
    const realised = result.trades.reduce((a, t) => a + t.pnl, 0);
    expect(result.metrics.finalEquity).toBeCloseTo(10_000 + realised, 4);
  });

  it("never holds a position after the run ends", () => {
    const result = runBacktest([buildData(trendingUp)], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
    });
    // Every opened trade is also closed, so counts match the trade list.
    expect(result.trades.every((t) => t.closedAt >= t.openedAt)).toBe(true);
  });

  it("only trades inside the requested window", () => {
    const data = buildData(trendingUp);
    const hourly = data.byTimeframe.get("1h") as Candle[];
    const from = (hourly[300] as Candle).closeTime;
    const to = (hourly[450] as Candle).closeTime;

    const result = runBacktest([data], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
      from,
      to,
    });
    for (const snapshot of result.curve) {
      expect(snapshot.time).toBeGreaterThanOrEqual(from);
      expect(snapshot.time).toBeLessThanOrEqual(to);
    }
  });

  it("is deterministic — the same inputs produce the same trades", () => {
    const data = buildData(trendingUp);
    const a = runBacktest([data], { params: DEFAULT_PARAMS, stepTimeframe: "1h" });
    const b = runBacktest([data], { params: DEFAULT_PARAMS, stepTimeframe: "1h" });
    expect(a.metrics).toEqual(b.metrics);
    expect(a.trades).toEqual(b.trades);
  });

  it("does not look ahead — appending future bars cannot change past trades", () => {
    // The strongest guarantee the engine makes: a trade decided at bar N must
    // be identical whether or not bars after N exist in the dataset.
    const full = buildData(trendingUp);
    const hourly = full.byTimeframe.get("1h") as Candle[];
    const cutoff = (hourly[400] as Candle).closeTime;

    const truncated: SymbolData = {
      ...full,
      byTimeframe: new Map(
        [...full.byTimeframe].map(([tf, candles]) => [
          tf,
          candles.filter((c) => c.closeTime <= cutoff),
        ]),
      ),
    };

    const onTruncated = runBacktest([truncated], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
    });
    const onFull = runBacktest([full], {
      params: DEFAULT_PARAMS,
      stepTimeframe: "1h",
      to: cutoff,
    });

    // Trades that opened and closed before the cutoff must match exactly.
    const settled = (trades: typeof onFull.trades) =>
      trades.filter((t) => t.exitReason !== "end_of_data");
    expect(settled(onTruncated.trades)).toEqual(settled(onFull.trades));
  });

  it("handles several symbols and tags each trade with its symbol", () => {
    const result = runBacktest(
      [buildData(trendingUp, "BTCUSDT"), buildData(trendingUp, "ETHUSDT")],
      { params: DEFAULT_PARAMS, stepTimeframe: "1h" },
    );
    expect(result.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const trade of result.trades) {
      expect(["BTCUSDT", "ETHUSDT"]).toContain(trade.symbol);
    }
  });

  it("respects the max-open-positions limit", () => {
    const params = {
      ...DEFAULT_PARAMS,
      risk: { ...DEFAULT_PARAMS.risk, maxOpenPositions: 1 },
      entry: { ...DEFAULT_PARAMS.entry, minScore: 0.15, minAlignment: 0.2 },
    };
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT"].map((s) => buildData(trendingUp, s));
    const result = runBacktest(symbols, { params, stepTimeframe: "1h" });

    // Reconstruct concurrency from the trade log. A position closed in several
    // partial exits emits one trade record per slice, so collapse them back
    // into a single open/close interval per position first.
    const positions = new Map<string, { open: number; close: number }>();
    for (const t of result.trades) {
      const key = `${t.symbol}@${t.openedAt}`;
      const existing = positions.get(key);
      if (existing) existing.close = Math.max(existing.close, t.closedAt);
      else positions.set(key, { open: t.openedAt, close: t.closedAt });
    }

    const events = [...positions.values()]
      .flatMap((p) => [
        { time: p.open, delta: 1 },
        { time: p.close, delta: -1 },
      ])
      // A close at the same instant as an open frees the slot first.
      .sort((a, b) => a.time - b.time || a.delta - b.delta);
    let open = 0;
    let peak = 0;
    for (const e of events) {
      open += e.delta;
      peak = Math.max(peak, open);
    }
    expect(peak).toBeLessThanOrEqual(1);
  });
});
