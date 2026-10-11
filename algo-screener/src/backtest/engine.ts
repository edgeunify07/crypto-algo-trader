import type {
  AccountSnapshot,
  Candle,
  ClosedTrade,
  Timeframe,
  TimeframeAnalysis,
  TradePlan,
} from "../types.js";
import { TIMEFRAME_MS } from "../types.js";
import { analyseTimeframe } from "../screener/analyse.js";
import { aggregate } from "../screener/screener.js";
import { evaluateExits } from "../strategy/strategy.js";
import { PaperBroker } from "../execution/paperBroker.js";
import { checkRisk, scalePlan } from "../execution/riskManager.js";
import { computeMetrics, fitnessScore, type PerformanceMetrics } from "./metrics.js";
import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import type { StrategyParams } from "../strategy/params.js";

const log = createLogger("backtest");

export interface SymbolData {
  symbol: string;
  /** Candles per timeframe, oldest first, closed bars only. */
  byTimeframe: Map<Timeframe, Candle[]>;
  quoteVolume24h: number;
}

export interface BacktestOptions {
  params: StrategyParams;
  startingCash?: number;
  /** Timeframe the simulation clock advances on. Defaults to the fastest tradeable one. */
  stepTimeframe?: Timeframe;
  /** Restrict the run to this time range. */
  from?: number;
  to?: number;
  /** Bars of history fed to each analysis — bounds indicator cost. */
  windowBars?: number;
  paramsVersion?: string;
  /** Report progress every N steps. */
  progressEvery?: number;
}

export interface BacktestResult {
  metrics: PerformanceMetrics;
  fitness: number;
  trades: ClosedTrade[];
  curve: AccountSnapshot[];
  startingEquity: number;
  from: number;
  to: number;
  symbols: string[];
  stepTimeframe: Timeframe;
  /** Entries the risk manager or strategy rejected, by reason. */
  rejections: Record<string, number>;
}

/** Index of the last candle whose bar has closed at or before `time`. */
function lastClosedIndex(candles: Candle[], time: number, hint = 0): number {
  let i = Math.max(0, hint);
  // Linear scan forward from the hint — the clock only ever moves forward.
  while (i < candles.length && (candles[i] as Candle).closeTime <= time) i++;
  return i - 1;
}

/**
 * Event-driven backtester.
 *
 * Two properties matter more than speed here:
 *
 *  1. **No lookahead.** Analysis at step `i` only ever sees bars that closed at
 *     or before the step's timestamp. Orders fill at the *next* bar's open, and
 *     intrabar exits are checked against the next bar's high/low.
 *  2. **Same code path as live.** The screener, strategy and broker used here
 *     are the ones the real-time loop uses, so an improvement measured in the
 *     backtest is an improvement in paper and live trading too.
 *
 * Per-timeframe analyses are cached and only recomputed when that timeframe
 * prints a new closed bar, which is what makes a 13-timeframe scan tractable.
 */
export function runBacktest(
  data: SymbolData[],
  options: BacktestOptions,
): BacktestResult {
  const {
    params,
    startingCash = config.account.startingCash,
    windowBars = 320,
    paramsVersion = "backtest",
    progressEvery = 0,
  } = options;

  const stepTimeframe =
    options.stepTimeframe ??
    config.tradeTimeframes.find((tf) =>
      data.some((d) => (d.byTimeframe.get(tf)?.length ?? 0) > 0),
    ) ??
    "1h";

  const broker = new PaperBroker(startingCash);
  const rejections: Record<string, number> = {};
  const noteRejection = (reason: string) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  // Build the simulation clock from the union of step-timeframe bars.
  const clockTimes = new Set<number>();
  for (const symbol of data) {
    for (const candle of symbol.byTimeframe.get(stepTimeframe) ?? []) {
      if (options.from !== undefined && candle.closeTime < options.from) continue;
      if (options.to !== undefined && candle.closeTime > options.to) continue;
      clockTimes.add(candle.closeTime);
    }
  }
  const clock = [...clockTimes].sort((a, b) => a - b);
  if (clock.length < 10) {
    log.warn("not enough bars in range to run a backtest");
    return {
      metrics: computeMetrics([], [], startingCash),
      fitness: -1,
      trades: [],
      curve: [],
      startingEquity: startingCash,
      from: clock[0] ?? 0,
      to: clock.at(-1) ?? 0,
      symbols: data.map((d) => d.symbol),
      stepTimeframe,
      rejections,
    };
  }

  // Per-symbol caches.
  interface SymbolState {
    data: SymbolData;
    /** Scan hints so index lookup stays O(1) amortised. */
    hints: Map<Timeframe, number>;
    /** Cached analysis, keyed by timeframe, with the bar it was computed on. */
    analyses: Map<Timeframe, { index: number; analysis: TimeframeAnalysis | null }>;
    /** Bar index on the position's timeframe when it was opened. */
    entryBarIndex: number;
    lastScore: number;
  }

  const states = new Map<string, SymbolState>(
    data.map((d) => [
      d.symbol,
      {
        data: d,
        hints: new Map(),
        analyses: new Map(),
        entryBarIndex: 0,
        lastScore: 0,
      },
    ]),
  );

  let openedCount = 0;

  for (let step = 0; step < clock.length - 1; step++) {
    const now = clock[step] as number;
    const prices = new Map<string, number>();
    const pendingEntries: { plan: TradePlan; state: SymbolState; time: number }[] = [];

    for (const state of states.values()) {
      const { data: symbolData } = state;
      const stepCandles = symbolData.byTimeframe.get(stepTimeframe) ?? [];
      const stepIndex = lastClosedIndex(
        stepCandles,
        now,
        state.hints.get(stepTimeframe) ?? 0,
      );
      state.hints.set(stepTimeframe, Math.max(0, stepIndex));
      if (stepIndex < 0) continue;

      const currentBar = stepCandles[stepIndex] as Candle;
      // The bar that will execute any decision made now.
      const nextBar = stepCandles[stepIndex + 1];
      prices.set(symbolData.symbol, currentBar.close);

      // --- Re-analyse only the timeframes that printed a new closed bar ---
      const perTimeframe = new Map<Timeframe, TimeframeAnalysis>();
      for (const [tf, candles] of symbolData.byTimeframe) {
        if (candles.length === 0) continue;
        const idx = lastClosedIndex(candles, now, state.hints.get(tf) ?? 0);
        state.hints.set(tf, Math.max(0, idx));
        if (idx < 0) continue;

        const cached = state.analyses.get(tf);
        if (cached && cached.index === idx) {
          if (cached.analysis) perTimeframe.set(tf, cached.analysis);
          continue;
        }
        const window = candles.slice(Math.max(0, idx - windowBars + 1), idx + 1);
        const analysis = analyseTimeframe(symbolData.symbol, tf, window, params);
        state.analyses.set(tf, { index: idx, analysis });
        if (analysis) perTimeframe.set(tf, analysis);
      }
      if (perTimeframe.size === 0) continue;

      const equity = broker.equity(prices);
      const row = aggregate(
        symbolData.symbol,
        perTimeframe,
        params,
        symbolData.quoteVolume24h,
        equity,
      );
      if (!row) continue;
      state.lastScore = row.score;

      // --- Manage an open position on the NEXT bar -----------------------
      let exitedThisStep = false;
      const position = broker.position(symbolData.symbol);
      if (position && nextBar) {
        broker.updateExtreme(symbolData.symbol, nextBar.high, nextBar.low);
        const anchorAnalysis =
          perTimeframe.get(position.timeframe) ?? [...perTimeframe.values()][0];
        const atr = anchorAnalysis?.atr ?? 0;
        const barsHeld = Math.max(
          0,
          Math.floor(
            (now - position.openedAt) / TIMEFRAME_MS[position.timeframe],
          ),
        );

        for (const decision of evaluateExits(
          position,
          nextBar,
          row.score,
          atr,
          barsHeld,
          params,
        )) {
          if (decision.action === "update_stop") {
            broker.setStop(symbolData.symbol, decision.stopLoss);
          } else if (decision.action === "close") {
            // Stops and targets fill at their trigger price, not the close.
            let fillPrice = nextBar.close;
            if (decision.reason === "stop_loss") {
              fillPrice = position.stopLoss;
              // Model a gap through the stop: you get the open, not the stop.
              if (position.side === "long" && nextBar.open < position.stopLoss) {
                fillPrice = nextBar.open;
              } else if (position.side === "short" && nextBar.open > position.stopLoss) {
                fillPrice = nextBar.open;
              }
            } else if (decision.reason === "take_profit") {
              const tp = position.takeProfits.find(
                (t) =>
                  !t.hit &&
                  (position.side === "long"
                    ? nextBar.high >= t.price
                    : nextBar.low <= t.price),
              );
              if (tp) {
                fillPrice = tp.price;
                tp.hit = true;
              }
            }
            broker.close(
              symbolData.symbol,
              fillPrice,
              nextBar.closeTime,
              decision.reason,
              decision.fraction,
            );
            exitedThisStep = true;
            if (decision.fraction >= 1) break;
          }
        }
      }

      // --- Queue an entry for the next bar's open ------------------------
      // An exit filled somewhere inside `nextBar`, so re-entering at that same
      // bar's open would buy at a price that occurred *before* the exit. Wait
      // for the following bar instead.
      if (!exitedThisStep && !broker.position(symbolData.symbol) && row.plan && nextBar) {
        pendingEntries.push({
          plan: { ...row.plan, entry: nextBar.open },
          state,
          // Entries fill at the next bar's open but are stamped with that
          // bar's close, matching how exits are stamped. Both actions are
          // decided at the same step and execute on the same bar, so using one
          // bar-aligned timestamp for both keeps trade intervals from
          // overlapping on intrabar precision the simulation doesn't have.
          time: nextBar.closeTime,
        });
      }
    }

    // Entries are applied after every symbol has been evaluated so the risk
    // manager sees one consistent account snapshot per step.
    for (const { plan, state, time } of pendingEntries) {
      const verdict = checkRisk(plan, broker, prices, params);
      if (!verdict.allowed) {
        noteRejection(verdict.reason);
        continue;
      }
      const sized = scalePlan(plan, verdict.sizeMultiplier);
      const opened = broker.open(sized, time, { paramsVersion });
      if (opened) {
        openedCount++;
        state.entryBarIndex = step;
      } else {
        noteRejection("broker rejected the order");
      }
    }

    broker.snapshot(now, prices);

    if (progressEvery > 0 && step % progressEvery === 0) {
      log.debug(
        `step ${step}/${clock.length} — equity ${broker.equity(prices).toFixed(2)}, ${openedCount} entries`,
      );
    }
  }

  // Close anything still open at the final price so metrics are complete.
  const finalTime = clock.at(-1) as number;
  const finalPrices = new Map<string, number>();
  for (const state of states.values()) {
    const candles = state.data.byTimeframe.get(stepTimeframe) ?? [];
    const lastCandle = candles.at(-1);
    if (lastCandle) finalPrices.set(state.data.symbol, lastCandle.close);
  }
  for (const position of broker.openPositions) {
    const price = finalPrices.get(position.symbol) ?? position.entryPrice;
    broker.close(position.symbol, price, finalTime, "end_of_data", 1);
  }
  broker.snapshot(finalTime, finalPrices);

  const trades = [...broker.closedTrades];
  const curve = [...broker.curve];
  const metrics = computeMetrics(trades, curve, startingCash);

  return {
    metrics,
    fitness: fitnessScore(metrics, config.improve.minTrades),
    trades,
    curve,
    startingEquity: startingCash,
    from: clock[0] as number,
    to: finalTime,
    symbols: data.map((d) => d.symbol),
    stepTimeframe,
    rejections,
  };
}
