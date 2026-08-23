/**
 * Auto-select engine — searches strategy configurations across the top-N liquid
 * USDT universe and returns only those that survive HARD out-of-sample gates.
 *
 * Methodology (this matters more than the search itself):
 *   1. Split each symbol's history chronologically into TRAIN (70%) / TEST (30%).
 *   2. Grid-search parameters on TRAIN only.
 *   3. Evaluate the single winning config ONCE on TEST, which is never used for
 *      selection. That TEST result is what the gates judge.
 *
 * Selecting on the test window would be curve-fitting with extra steps, so we
 * deliberately do not.
 *
 * CRITICAL: the confluence context stores its own candle array and signals index
 * into it, so a sliced backtest MUST get a context rebuilt on that exact slice.
 * Reusing a full-history context against a suffix slice silently misaligns every
 * signal. prepareStrategyData is therefore called per slice with a distinct key.
 */
import { backtest, BINANCE_SPOT_COSTS, LIVE_EXIT_POLICY, type BacktestResult, type ExitPolicy } from "../backtest";
import { prepareStrategyData } from "./signals";
import { confluenceSwing } from "../strategies/registry";
import { getHistoricalCandles } from "../data/historical";
import { resolveUniverse } from "../universe";
import type { Candle, CandleInterval } from "../types";

export interface SelectionGates {
  /** OOS trades required before a win rate or expectancy means anything. */
  minOosTrades: number;
  /** Net USDT per trade after fees+slippage, out-of-sample. */
  minOosExpectancy: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  /** Win-rate floor, percent. Set 80 to enforce the ">=80% win rate" ask. */
  minWinRatePct: number;
  /** Reject configs that fail to beat simply holding the asset. */
  mustBeatBuyHold: boolean;
  /** Trades required on TRAIN for a config to be eligible for the OOS test. */
  minTrainTrades: number;
}

export const DEFAULT_GATES: SelectionGates = {
  minOosTrades: 10,
  minOosExpectancy: 0,
  minProfitFactor: 1.2,
  maxDrawdownPct: 25,
  minWinRatePct: 0,
  mustBeatBuyHold: true,
  minTrainTrades: 5,
};

export interface GateCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface CandidateMetrics {
  numTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  avgWinPct: number;
  avgLossPct: number;
  totalFeesPaid: number;
}

export interface Candidate {
  symbol: string;
  interval: CandleInterval;
  strategyId: string;
  params: Record<string, number>;
  train: CandidateMetrics;
  oos: CandidateMetrics;
  gates: GateCheck[];
  passed: boolean;
  /** Ranking score — OOS excess return over buy & hold, penalised by drawdown. */
  score: number;
  bars: { train: number; test: number };
}

export interface SelectionRun {
  startedAt: string;
  finishedAt: string;
  gates: SelectionGates;
  symbolsScanned: string[];
  intervals: CandleInterval[];
  configsPerSymbol: number;
  totalBacktests: number;
  candidates: Candidate[];
  /** Best PASSING candidate, or null when nothing cleared the gates. */
  best: Candidate | null;
  /** Highest OOS win rate seen at >= minOosTrades, for honesty reporting. */
  bestValidWinRate: { winRate: number; symbol: string; interval: string; numTrades: number } | null;
  notes: string[];
}

export interface SelectOptions {
  universeLimit?: number;
  symbols?: string[];
  intervals?: CandleInterval[];
  bars?: number;
  /**
   * Pull this many days of history instead of a bar count. Deep history is what
   * makes the OOS window large enough for the trade-count gate to be passable —
   * 1000 bars leaves only ~300 OOS bars, which yields single-digit trades.
   */
  days?: number;
  startEquity?: number;
  gates?: Partial<SelectionGates>;
  /** Grid size: 'small' (12 configs) is much faster; 'full' is 36. */
  gridSize?: "small" | "full";
  /** Cap the parameter grid (useful to keep a scan responsive). */
  maxConfigs?: number;
  /** Exit rules to simulate. Defaults to the LIVE bot policy so selection
   *  measures what will actually trade. */
  exitPolicy?: ExitPolicy;
}

/** Compact, deliberately small grid — a wide grid mostly buys overfitting. */
function paramGrid(size: "small" | "full", maxConfigs: number): Record<string, number>[] {
  const base = confluenceSwing.params;
  const thresholds = [6, 8, 10];
  const confidences = size === "small" ? [100, 130] : [100, 115, 130];
  const rvols = size === "small" ? [1.2] : [1.0, 1.2];
  const grid: Record<string, number>[] = [];
  for (const entryThreshold of thresholds) {
    for (const minConfidence of confidences) {
      for (const minRvol of rvols) {
        for (const requireTrending of [0, 1]) {
          grid.push({
            ...base,
            mode: 0,
            entryThreshold,
            minConfidence,
            minRvol,
            requireTrending,
            minConfirmFactors: 2,
            requireCoreFactors: 1,
          });
        }
      }
    }
  }
  return grid.slice(0, maxConfigs);
}

function metricsOf(r: BacktestResult): CandidateMetrics {
  const wins = r.trades.filter((t) => t.pnl > 0);
  const losses = r.trades.filter((t) => t.pnl <= 0);
  const avg = (xs: typeof r.trades) => (xs.length ? xs.reduce((s, t) => s + t.returnPct, 0) / xs.length : 0);
  return {
    numTrades: r.numTrades,
    winRate: r.winRate,
    profitFactor: r.profitFactor === Infinity ? 99 : r.profitFactor,
    expectancy: r.expectancy,
    totalReturnPct: r.totalReturnPct,
    buyHoldReturnPct: r.buyHoldReturnPct,
    alphaPct: r.totalReturnPct - r.buyHoldReturnPct,
    maxDrawdownPct: r.maxDrawdownPct,
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    totalFeesPaid: r.totalFeesPaid,
  };
}

function evaluateGates(oos: CandidateMetrics, g: SelectionGates): GateCheck[] {
  return [
    {
      id: "min_oos_trades",
      label: `>=${g.minOosTrades} out-of-sample trades`,
      pass: oos.numTrades >= g.minOosTrades,
      detail: `${oos.numTrades} trades`,
    },
    {
      id: "oos_expectancy",
      label: "Positive OOS expectancy (net of fees)",
      pass: oos.expectancy > g.minOosExpectancy,
      detail: `$${oos.expectancy.toFixed(2)}/trade`,
    },
    {
      id: "profit_factor",
      label: `Profit factor >= ${g.minProfitFactor}`,
      pass: oos.profitFactor >= g.minProfitFactor,
      detail: oos.profitFactor.toFixed(2),
    },
    {
      id: "max_drawdown",
      label: `Max drawdown <= ${g.maxDrawdownPct}%`,
      pass: oos.maxDrawdownPct <= g.maxDrawdownPct,
      detail: `${oos.maxDrawdownPct.toFixed(1)}%`,
    },
    {
      id: "win_rate",
      label: `Win rate >= ${g.minWinRatePct}%`,
      pass: oos.winRate >= g.minWinRatePct,
      detail: `${oos.winRate.toFixed(1)}%`,
    },
    {
      id: "beats_buy_hold",
      label: "Beats buy & hold",
      pass: !g.mustBeatBuyHold || oos.alphaPct > 0,
      detail: `alpha ${oos.alphaPct >= 0 ? "+" : ""}${oos.alphaPct.toFixed(2)}%`,
    },
  ];
}

function scoreOf(oos: CandidateMetrics): number {
  // Excess return over just holding, penalised for drawdown. A strategy that
  // trails buy & hold is worse than doing nothing, so alpha leads.
  return oos.alphaPct - oos.maxDrawdownPct * 0.2;
}

async function evaluateSymbolInterval(
  symbol: string,
  interval: CandleInterval,
  candles: Candle[],
  grid: Record<string, number>[],
  startEquity: number,
  gates: SelectionGates,
  exitPolicy: ExitPolicy,
): Promise<{ candidate: Candidate | null; backtests: number }> {
  const cut = Math.floor(candles.length * 0.7);
  const train = candles.slice(0, cut);
  const test = candles.slice(cut);
  if (train.length < 100 || test.length < 50) return { candidate: null, backtests: 0 };

  const strategyId = confluenceSwing.id;
  const trainKey = `select:train:${symbol}:${interval}`;
  const testKey = `select:test:${symbol}:${interval}`;

  // Context must match the exact slice being backtested (see file header).
  await prepareStrategyData(strategyId, symbol, interval, train, trainKey);

  let bestParams: Record<string, number> | null = null;
  let bestTrain: BacktestResult | null = null;
  let backtests = 0;

  for (const params of grid) {
    const r = backtest(confluenceSwing, train, params, startEquity, BINANCE_SPOT_COSTS, trainKey, exitPolicy);
    backtests++;
    if (r.numTrades < gates.minTrainTrades) continue;
    if (r.expectancy <= 0) continue;
    if (!bestTrain || r.expectancy > bestTrain.expectancy) {
      bestTrain = r;
      bestParams = params;
    }
  }

  if (!bestParams || !bestTrain) return { candidate: null, backtests };

  // Single evaluation on untouched TEST data.
  await prepareStrategyData(strategyId, symbol, interval, test, testKey);
  const testResult = backtest(confluenceSwing, test, bestParams, startEquity, BINANCE_SPOT_COSTS, testKey, exitPolicy);
  backtests++;

  const oos = metricsOf(testResult);
  const gateChecks = evaluateGates(oos, gates);

  return {
    candidate: {
      symbol,
      interval,
      strategyId,
      params: bestParams,
      train: metricsOf(bestTrain),
      oos,
      gates: gateChecks,
      passed: gateChecks.every((c) => c.pass),
      score: scoreOf(oos),
      bars: { train: train.length, test: test.length },
    },
    backtests,
  };
}

/**
 * Scan the universe and rank configurations by out-of-sample performance.
 * Only `confluence-swing` is scanned: the scalp variant needs aggTrade replay,
 * which is far too heavy for a universe-wide sweep.
 */
export async function runAutoSelect(opts: SelectOptions = {}): Promise<SelectionRun> {
  const startedAt = new Date().toISOString();
  const gates: SelectionGates = { ...DEFAULT_GATES, ...(opts.gates ?? {}) };
  const intervals = opts.intervals ?? (["15m", "1h"] as CandleInterval[]);
  const bars = Math.min(opts.bars ?? 1000, 1000);
  const days = opts.days;
  const startEquity = opts.startEquity ?? 1000;
  const grid = paramGrid(opts.gridSize ?? "full", opts.maxConfigs ?? 36);
  const exitPolicy = opts.exitPolicy ?? LIVE_EXIT_POLICY;

  const symbols = opts.symbols?.length
    ? opts.symbols.map((s) => s.toUpperCase())
    : await resolveUniverse(opts.universeLimit ?? 20);

  const candidates: Candidate[] = [];
  const notes: string[] = [];
  let totalBacktests = 0;

  for (const symbol of symbols) {
    for (const interval of intervals) {
      try {
        const startTime = days ? Math.floor(Date.now() / 1000) - days * 86_400 : undefined;
        const { candles } = await getHistoricalCandles(
          startTime
            ? { symbol, interval, startTime, useCache: true }
            : { symbol, interval, limit: bars, useCache: true },
        );
        if (candles.length < 200) {
          notes.push(`${symbol} ${interval}: only ${candles.length} bars — skipped`);
          continue;
        }
        const { candidate, backtests } = await evaluateSymbolInterval(
          symbol, interval, candles, grid, startEquity, gates, exitPolicy,
        );
        totalBacktests += backtests;
        if (candidate) candidates.push(candidate);
        else notes.push(`${symbol} ${interval}: no config had positive TRAIN expectancy at >=${gates.minTrainTrades} trades`);
      } catch (err) {
        notes.push(`${symbol} ${interval}: ${err instanceof Error ? err.message : "scan failed"}`);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const passing = candidates.filter((c) => c.passed);

  // Honesty metric: best win rate among results with a statistically usable
  // number of OOS trades — reported whether or not anything passed the gates.
  const usable = candidates.filter((c) => c.oos.numTrades >= gates.minOosTrades);
  const bestWr = usable.reduce<Candidate | null>((acc, c) => (!acc || c.oos.winRate > acc.oos.winRate ? c : acc), null);

  if (!passing.length) {
    notes.unshift(
      `NO configuration passed the gates across ${symbols.length} symbols × ${intervals.length} intervals. ` +
      `The safe action is to trade nothing.`,
    );
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    gates,
    symbolsScanned: symbols,
    intervals,
    configsPerSymbol: grid.length,
    totalBacktests,
    candidates,
    best: passing[0] ?? null,
    bestValidWinRate: bestWr
      ? {
          winRate: bestWr.oos.winRate,
          symbol: bestWr.symbol,
          interval: bestWr.interval,
          numTrades: bestWr.oos.numTrades,
        }
      : null,
    notes,
  };
}

/** Last completed run, so the UI and bot can share one result. */
const store = globalThis as unknown as { __lastSelection?: SelectionRun };

export function setLastSelection(run: SelectionRun) {
  store.__lastSelection = run;
}
export function getLastSelection(): SelectionRun | null {
  return store.__lastSelection ?? null;
}
