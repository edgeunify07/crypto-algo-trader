import type {
  Candle,
  PriceLevel,
  SignalComponent,
  Timeframe,
  TimeframeAnalysis,
} from "../types";
import {
  adx,
  atr,
  bollinger,
  ema,
  last,
  macd,
  obv,
  rsi,
  slope,
} from "../indicators/index";
import { clusterLevels, findPivots } from "../indicators/pivots";
import { analyseElliott, elliottScore } from "../analysis/elliott";
import { analyseGann, gannLevels, gannScore } from "../analysis/gann";
import { classifyRegime, regimeWeight } from "../analysis/regime";
import { clamp, clamp1, weightedAverage } from "../util/math";
import type { StrategyParams } from "../strategy/params";

/**
 * Analyse one symbol on one timeframe.
 *
 * Every component returns a bounded -1..+1 score and a 0..1 confidence; the
 * blend is a confidence- and regime-weighted average. Keeping components
 * independent and bounded is what lets the LLM tune the weights safely — no
 * single component can dominate by emitting a huge number.
 */
export function analyseTimeframe(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  params: StrategyParams,
): TimeframeAnalysis | null {
  const ind = params.indicators;
  const minBars = Math.max(ind.emaSlow, ind.bbPeriod, ind.macdSlow) + 30;
  if (candles.length < minBars) return null;

  const closes = candles.map((c) => c.close);
  const lastCandle = candles.at(-1) as Candle;
  const price = lastCandle.close;
  if (!(price > 0)) return null;

  const atrValues = atr(candles, ind.atrPeriod);
  const atrValue = last(atrValues, price * 0.01);
  const regime = classifyRegime(candles);
  const components: SignalComponent[] = [];

  // --- EMA trend --------------------------------------------------------
  const emaFast = ema(closes, ind.emaFast);
  const emaSlow = ema(closes, ind.emaSlow);
  const fast = last(emaFast, price);
  const slow = last(emaSlow, price);
  if (Number.isFinite(fast) && Number.isFinite(slow) && slow > 0) {
    const separation = (fast - slow) / slow;
    // Normalise separation by ATR% so the score means the same across symbols.
    const normalised = clamp1(separation / Math.max(regime.atrPct * 2, 1e-6));
    const priceAbove = price > fast ? 0.2 : -0.2;
    components.push({
      name: "ema_trend",
      score: clamp1(normalised * 0.8 + priceAbove),
      confidence: clamp(Math.abs(normalised), 0.2, 1),
      note: `EMA${ind.emaFast}/${ind.emaSlow} ${separation >= 0 ? "bullish" : "bearish"} by ${(separation * 100).toFixed(2)}%`,
    });
  }

  // --- MACD -------------------------------------------------------------
  const macdResult = macd(closes, ind.macdFast, ind.macdSlow, ind.macdSignal);
  const hist = last(macdResult.histogram, 0);
  const histPrev = macdResult.histogram.at(-2) ?? 0;
  if (Number.isFinite(hist)) {
    const scale = Math.max(price * regime.atrPct * 0.5, 1e-9);
    const momentum = clamp1(hist / scale);
    const accelerating = Number.isFinite(histPrev) && Math.abs(hist) > Math.abs(histPrev);
    components.push({
      name: "macd",
      score: momentum,
      confidence: clamp(Math.abs(momentum) * (accelerating ? 1 : 0.7), 0.15, 1),
      note: `MACD histogram ${hist >= 0 ? "positive" : "negative"}${accelerating ? " and expanding" : " and contracting"}`,
    });
  }

  // --- RSI --------------------------------------------------------------
  const rsiValues = rsi(closes, ind.rsiPeriod);
  const rsiValue = last(rsiValues, 50);
  if (Number.isFinite(rsiValue)) {
    // In a trend, RSI extremes mean continuation; in a range, exhaustion.
    const trending = regime.kind === "trending_up" || regime.kind === "trending_down";
    const centred = (rsiValue - 50) / 50;
    let score: number;
    let note: string;
    if (trending) {
      score = clamp1(centred * 1.2);
      note = `RSI ${rsiValue.toFixed(1)} confirms trend momentum`;
    } else if (rsiValue >= ind.rsiOverbought) {
      score = clamp1(-(rsiValue - ind.rsiOverbought) / (100 - ind.rsiOverbought));
      note = `RSI ${rsiValue.toFixed(1)} overbought in a range — fade`;
    } else if (rsiValue <= ind.rsiOversold) {
      score = clamp1((ind.rsiOversold - rsiValue) / ind.rsiOversold);
      note = `RSI ${rsiValue.toFixed(1)} oversold in a range — fade`;
    } else {
      score = clamp1(centred * 0.5);
      note = `RSI ${rsiValue.toFixed(1)} neutral`;
    }
    components.push({
      name: "rsi",
      score,
      confidence: clamp(Math.abs(score) + 0.2, 0.2, 1),
      note,
    });
  }

  // --- ADX / directional strength --------------------------------------
  const adxResult = adx(candles, 14);
  const adxValue = last(adxResult.adx, 0);
  const plusDi = last(adxResult.plusDi, 0);
  const minusDi = last(adxResult.minusDi, 0);
  if (Number.isFinite(adxValue) && adxValue > 0) {
    const diSpread = plusDi + minusDi === 0 ? 0 : (plusDi - minusDi) / (plusDi + minusDi);
    const strength = clamp((adxValue - ind.adxThreshold) / 25, 0, 1);
    components.push({
      name: "adx",
      score: clamp1(diSpread * (0.4 + 0.6 * strength)),
      confidence: clamp(strength + 0.2, 0.2, 1),
      note: `ADX ${adxValue.toFixed(1)} with ${plusDi > minusDi ? "+DI" : "-DI"} leading`,
    });
  }

  // --- Bollinger position / squeeze ------------------------------------
  const bb = bollinger(closes, ind.bbPeriod, ind.bbMultiplier);
  const upper = last(bb.upper, price);
  const lower = last(bb.lower, price);
  const middle = last(bb.middle, price);
  if (Number.isFinite(upper) && Number.isFinite(lower) && upper > lower) {
    // -1 at the lower band, +1 at the upper band.
    const position = ((price - middle) / ((upper - lower) / 2)) || 0;
    const trending = regime.kind === "trending_up" || regime.kind === "trending_down";
    // Riding a band is continuation in a trend, exhaustion in a range.
    const score = clamp1(trending ? position * 0.7 : -position * 0.8);
    components.push({
      name: "bollinger",
      score,
      confidence: clamp(Math.abs(position) * 0.8, 0.15, 1),
      note: `price at ${(position * 100).toFixed(0)}% of the Bollinger envelope${trending ? " (trend)" : " (range)"}`,
    });
  }

  // --- Volume participation --------------------------------------------
  const obvValues = obv(candles);
  const obvSlope = slope(obvValues, 20);
  const priceSlope = slope(closes, 20);
  if (Number.isFinite(obvSlope)) {
    const agree = Math.sign(obvSlope) === Math.sign(priceSlope) && priceSlope !== 0;
    const score = clamp1(Math.sign(obvSlope) * Math.min(1, Math.abs(obvSlope) * 50));
    components.push({
      name: "volume",
      score,
      confidence: agree ? 0.7 : 0.35,
      note: agree
        ? "OBV confirms the price trend"
        : "OBV diverges from price — weak participation",
    });
  }

  // --- Market structure (pivots, support/resistance) --------------------
  const pivots = findPivots(candles, {
    atrMultiple: ind.zigzagAtrMultiple,
    atrPeriod: ind.atrPeriod,
    confirmedOnly: true,
  });
  const levels: PriceLevel[] = [];
  if (pivots.length >= 4) {
    const highs = pivots.filter((p) => p.type === "high").slice(-3);
    const lows = pivots.filter((p) => p.type === "low").slice(-3);
    const higherHighs =
      highs.length >= 2 && (highs.at(-1) as { price: number }).price > (highs.at(-2) as { price: number }).price;
    const higherLows =
      lows.length >= 2 && (lows.at(-1) as { price: number }).price > (lows.at(-2) as { price: number }).price;
    const lowerHighs =
      highs.length >= 2 && (highs.at(-1) as { price: number }).price < (highs.at(-2) as { price: number }).price;
    const lowerLows =
      lows.length >= 2 && (lows.at(-1) as { price: number }).price < (lows.at(-2) as { price: number }).price;

    let structureScore = 0;
    let note = "structure is mixed";
    if (higherHighs && higherLows) {
      structureScore = 0.9;
      note = "higher highs and higher lows — uptrend structure";
    } else if (lowerHighs && lowerLows) {
      structureScore = -0.9;
      note = "lower highs and lower lows — downtrend structure";
    } else if (higherLows) {
      structureScore = 0.4;
      note = "higher lows into resistance";
    } else if (lowerHighs) {
      structureScore = -0.4;
      note = "lower highs into support";
    }
    components.push({
      name: "structure",
      score: structureScore,
      confidence: clamp(Math.abs(structureScore) + 0.2, 0.2, 1),
      note,
    });

    for (const cluster of clusterLevels(pivots, price).slice(0, 6)) {
      levels.push({
        price: cluster.price,
        kind: cluster.price < price ? "support" : "resistance",
        weight: cluster.weight,
        source: `swing x${cluster.touches}`,
      });
    }
  }

  // --- Elliott Wave -----------------------------------------------------
  const elliott = analyseElliott(candles, timeframe, {
    atrMultiple: ind.zigzagAtrMultiple,
  });
  components.push({
    name: "elliott",
    score: elliottScore(elliott, price),
    confidence: elliott.confidence,
    note:
      elliott.pattern === "none"
        ? "no valid Elliott count"
        : `${elliott.pattern} count, wave ${elliott.currentWave} in progress, bias ${elliott.bias}`,
  });

  // --- Gann -------------------------------------------------------------
  const gann = analyseGann(candles, timeframe, {
    atrMultiple: ind.zigzagAtrMultiple,
    atrPeriod: ind.atrPeriod,
  });
  components.push({
    name: "gann",
    score: gannScore(gann),
    confidence: gann.confidence,
    note:
      gann.anchor === null
        ? "no Gann anchor"
        : `fan from ${gann.anchor.type} @ ${gann.anchor.price.toFixed(4)}, bias ${gann.bias}`,
  });

  for (const level of gannLevels(gann, price).slice(0, 6)) {
    levels.push({ ...level, weight: 0.5 });
  }
  for (const target of elliott.targets) {
    if (!Number.isFinite(target) || target <= 0) continue;
    levels.push({
      price: target,
      kind: target < price ? "support" : "resistance",
      weight: 0.4 * elliott.confidence,
      source: `elliott wave ${elliott.currentWave} target`,
    });
  }

  // --- Blend ------------------------------------------------------------
  const categories: Record<string, Parameters<typeof regimeWeight>[1]> = {
    ema_trend: "trend",
    macd: "momentum",
    rsi: "meanReversion",
    adx: "trend",
    bollinger: "meanReversion",
    volume: "volume",
    structure: "structure",
    elliott: "structure",
    gann: "structure",
  };
  const weightFor = (name: string): number => {
    const base =
      params.weights[
        ({
          ema_trend: "emaTrend",
          macd: "macd",
          rsi: "rsi",
          adx: "adx",
          bollinger: "bollinger",
          volume: "volume",
          structure: "structure",
          elliott: "elliott",
          gann: "gann",
        }[name] ?? "structure") as keyof StrategyParams["weights"]
      ] ?? 0;
    const category = categories[name] ?? "structure";
    return base * regimeWeight(regime, category);
  };

  const score = clamp1(
    weightedAverage(
      components.map((c) => ({
        value: c.score,
        weight: weightFor(c.name) * c.confidence,
      })),
    ),
  );
  const confidence = clamp(
    weightedAverage(
      components.map((c) => ({ value: c.confidence, weight: weightFor(c.name) })),
    ),
    0,
    1,
  );

  return {
    symbol,
    timeframe,
    asOf: lastCandle.closeTime,
    price,
    atr: atrValue,
    score,
    confidence,
    direction: score > 0.1 ? "long" : score < -0.1 ? "short" : "flat",
    regime,
    components,
    elliott,
    gann,
    levels: levels.sort((a, b) => b.weight - a.weight).slice(0, 12),
  };
}
