import type {
  Candle,
  Direction,
  ScreenerRow,
  Timeframe,
  TimeframeAnalysis,
} from "../types.js";
import { TIMEFRAME_MS } from "../types.js";
import { analyseTimeframe } from "./analyse.js";
import { buildTradePlan } from "../strategy/strategy.js";
import { clamp, clamp1, weightedAverage } from "../util/math.js";
import { timeframeWeight, type StrategyParams } from "../strategy/params.js";
import type { MarketData } from "../data/marketData.js";
import { config } from "../config.js";

/**
 * Multi-timeframe confluence.
 *
 * Each timeframe is analysed independently, then blended with weights from the
 * params (higher timeframes dominate by default). `alignment` measures how much
 * of the weighted timeframe mass agrees with the net direction — it is the key
 * filter that keeps the engine out of trades where a 5m signal fights the daily.
 */
export function aggregate(
  symbol: string,
  perTimeframe: Map<Timeframe, TimeframeAnalysis>,
  params: StrategyParams,
  quoteVolume24h: number,
  equity: number,
): ScreenerRow | null {
  if (perTimeframe.size === 0) return null;

  const entries = [...perTimeframe.entries()];
  const weighted = entries.map(([tf, analysis]) => ({
    tf,
    analysis,
    weight: timeframeWeight(params, tf) * Math.max(analysis.confidence, 0.05),
  }));

  const score = clamp1(
    weightedAverage(weighted.map((w) => ({ value: w.analysis.score, weight: w.weight }))),
  );
  const confidence = clamp(
    weightedAverage(
      weighted.map((w) => ({
        value: w.analysis.confidence,
        weight: timeframeWeight(params, w.tf),
      })),
    ),
    0,
    1,
  );

  const direction: Direction = score > 0.1 ? "long" : score < -0.1 ? "short" : "flat";

  // Alignment: weighted share of timeframes pointing the same way as the net
  // score. Flat timeframes count as neither agreement nor disagreement.
  let agreeing = 0;
  let total = 0;
  for (const w of weighted) {
    const tfWeight = timeframeWeight(params, w.tf);
    total += tfWeight;
    if (direction === "flat") continue;
    if (w.analysis.direction === direction) agreeing += tfWeight;
    else if (w.analysis.direction !== "flat") agreeing -= tfWeight * 0.5;
  }
  const alignment = total === 0 ? 0 : clamp(agreeing / total, 0, 1);

  // The anchor is the tradeable timeframe with the strongest aligned signal —
  // it sets the ATR used for stops and the bar clock for max-hold.
  const tradeable = weighted.filter(
    (w) =>
      config.tradeTimeframes.includes(w.tf) &&
      (direction === "flat" || w.analysis.direction === direction),
  );
  const anchor =
    (tradeable.length > 0 ? tradeable : weighted)
      .slice()
      .sort(
        (a, b) =>
          Math.abs(b.analysis.score) * b.weight - Math.abs(a.analysis.score) * a.weight,
      )[0] ?? weighted[0];
  if (!anchor) return null;

  const price = anchor.analysis.price;
  const perTimeframeRecord: Record<string, TimeframeAnalysis> = {};
  for (const [tf, analysis] of entries) perTimeframeRecord[tf] = analysis;

  const row: ScreenerRow = {
    symbol,
    price,
    score,
    confidence,
    direction,
    alignment,
    anchorTimeframe: anchor.tf,
    perTimeframe: perTimeframeRecord,
    quoteVolume24h,
    plan: null,
  };

  row.plan = buildTradePlan(row, anchor.analysis, params, equity);
  return row;
}

/** Analyse one symbol across every timeframe the market data holds. */
export function screenSymbol(
  market: MarketData,
  symbol: string,
  params: StrategyParams,
  equity: number,
): ScreenerRow | null {
  const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
  for (const [tf, series] of market.forSymbol(symbol)) {
    const analysis = analyseTimeframe(symbol, tf, [...series.closed], params);
    if (analysis) perTimeframe.set(tf, analysis);
  }
  return aggregate(
    symbol,
    perTimeframe,
    params,
    market.quoteVolume24h(symbol),
    equity,
  );
}

/** Rank the whole universe. Strongest absolute conviction first. */
export function screenAll(
  market: MarketData,
  params: StrategyParams,
  equity: number,
): ScreenerRow[] {
  const rows: ScreenerRow[] = [];
  for (const symbol of market.symbols) {
    const row = screenSymbol(market, symbol, params, equity);
    if (row) rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      Math.abs(b.score) * b.confidence * (0.5 + b.alignment) -
      Math.abs(a.score) * a.confidence * (0.5 + a.alignment),
  );
}

/**
 * Backtest-side variant: analyse a single symbol from pre-sliced candle data
 * for each timeframe, as of a point in history.
 */
export function screenHistorical(
  symbol: string,
  candlesByTimeframe: Map<Timeframe, Candle[]>,
  params: StrategyParams,
  quoteVolume24h: number,
  equity: number,
): ScreenerRow | null {
  const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
  for (const [tf, candles] of candlesByTimeframe) {
    const analysis = analyseTimeframe(symbol, tf, candles, params);
    if (analysis) perTimeframe.set(tf, analysis);
  }
  return aggregate(symbol, perTimeframe, params, quoteVolume24h, equity);
}

/** Bars of the given timeframe spanned by a millisecond duration. */
export function barsInSpan(timeframe: Timeframe, spanMs: number): number {
  return Math.floor(spanMs / TIMEFRAME_MS[timeframe]);
}
