import {
  DEFAULT_PARAMS,
  DEFAULT_PARAMS_FITTED_THROUGH,
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "@/lib/algo/strategy/params";
import type { Candle, Timeframe } from "@/lib/algo/types";
import { fetchFuturesKlines } from "@/lib/futures/rest";
import { KEYS, kv } from "@/lib/store/kv";
import { resolveUniverse } from "@/lib/engine2/universe";
import { runFuturesBacktest, type BacktestInput, type BacktestResult } from "./backtest";
import { proposeParams, type ProposedCandidate } from "./llm";

/**
 * Backtest-driven self-improvement, sized to run inside a serverless function.
 *
 * The contract is the same as the research loop: the model only ever proposes
 * values for the strategy parameters, and a proposal is promoted only if it
 * beats the incumbent on a backtest the engine ran itself. The model cannot
 * write to the live parameters directly, and the account-level risk limits it
 * trades under are read from env, outside anything it can influence.
 */

export interface ImproveOptions {
  symbols?: string[];
  timeframes?: Timeframe[];
  stepTimeframe?: Timeframe;
  bars?: number;
  candidates?: number;
  /** Evaluate but never promote. */
  dryRun?: boolean;
  /** Skip the model and only re-measure the incumbent. */
  measureOnly?: boolean;
}

export interface CandidateResult {
  name: string;
  hypothesis: string;
  changes: string[];
  result: BacktestResult;
  rejectedBecause: string | null;
}

export interface ImproveReport {
  ranAt: number;
  durationMs: number;
  servedBy: string | null;
  analysis: string | null;
  symbols: string[];
  incumbent: { version: string; result: BacktestResult };
  candidates: CandidateResult[];
  promoted: { version: string; name: string } | null;
  notes: string[];
}

export interface StoredParams {
  version: string;
  source: string;
  rationale: string;
  parentVersion: string | null;
  updatedAt: number;
  /**
   * Last moment of market data that influenced these parameters. A backtest
   * window at or before this is in-sample and the dashboard labels it as such.
   */
  fittedThrough: number;
  params: StrategyParams;
  evidence?: {
    totalReturn: number;
    maxDrawdown: number;
    trades: number;
    winRate: number;
    fitness: number;
    liquidations: number;
  };
}

/**
 * Wall-clock allowance for a whole round.
 *
 * Under the platform's 60s function limit with headroom, because being killed
 * mid-round loses the work and leaves the lock held until its TTL expires.
 */
const TOTAL_BUDGET_MS = Number(process.env.IMPROVE_BUDGET_MS ?? "52000");

/** Minimum evidence a candidate needs before it can replace the incumbent. */
const GUARDS = {
  minTrades: Number(process.env.IMPROVE_MIN_TRADES ?? "12"),
  maxDrawdown: Number(process.env.IMPROVE_MAX_DRAWDOWN ?? "0.35"),
  minImprovement: Number(process.env.IMPROVE_MIN_DELTA ?? "0.05"),
};

export async function loadParams(): Promise<StoredParams> {
  const stored = await kv().get<StoredParams>(KEYS.params);
  if (stored) {
    const parsed = StrategyParamsSchema.safeParse(stored.params);
    if (parsed.success) {
      return {
        ...stored,
        // Records written before this field existed: fall back to when they
        // were promoted. Defaulting to 0 instead would present a window the
        // search had seen as untouched, which is the error this field exists
        // to prevent.
        fittedThrough: stored.fittedThrough ?? stored.updatedAt ?? Date.now(),
        params: sanitiseParams(parsed.data).params,
      };
    }
  }
  return {
    version: "default-v1",
    source: "default",
    rationale: "Baseline parameters shipped with the engine.",
    parentVersion: null,
    updatedAt: Date.now(),
    fittedThrough: DEFAULT_PARAMS_FITTED_THROUGH,
    params: structuredClone(DEFAULT_PARAMS),
  };
}

async function loadBacktestData(
  symbols: string[],
  timeframes: Timeframe[],
  bars: number,
): Promise<BacktestInput[]> {
  // Every series is fetched concurrently. Loading symbols in series was the
  // single biggest cost in a round — the backtests themselves take under a
  // second, so the budget goes almost entirely on network and the model.
  const jobs = symbols.flatMap((symbol) =>
    timeframes.map(async (tf) => {
      try {
        return { symbol, tf, candles: await fetchFuturesKlines(symbol, tf, bars) };
      } catch {
        return { symbol, tf, candles: [] as Candle[] };
      }
    }),
  );
  const loaded = await Promise.all(jobs);

  const bySymbol = new Map<string, Map<Timeframe, Candle[]>>();
  for (const { symbol, tf, candles } of loaded) {
    if (candles.length === 0) continue;
    const m = bySymbol.get(symbol) ?? new Map<Timeframe, Candle[]>();
    m.set(tf, candles);
    bySymbol.set(symbol, m);
  }
  return [...bySymbol.entries()].map(([symbol, byTimeframe]) => ({ symbol, byTimeframe }));
}

function screen(result: BacktestResult, incumbentFitness: number): string | null {
  if (result.trades.length < GUARDS.minTrades) {
    return `only ${result.trades.length} trades (minimum ${GUARDS.minTrades})`;
  }
  if (result.liquidations > 0) {
    return `${result.liquidations} liquidation(s) — unacceptable on a small account`;
  }
  if (result.maxDrawdown > GUARDS.maxDrawdown) {
    return `drawdown ${(result.maxDrawdown * 100).toFixed(1)}% exceeds the ${(GUARDS.maxDrawdown * 100).toFixed(0)}% cap`;
  }
  if (result.totalReturn <= 0) return "return is not positive after fees and funding";
  if (result.fitness < incumbentFitness + GUARDS.minImprovement) {
    return `fitness ${result.fitness.toFixed(3)} does not beat the incumbent (${incumbentFitness.toFixed(3)})`;
  }
  return null;
}

function buildReport(
  result: BacktestResult,
  params: StrategyParams,
  symbols: string[],
): string {
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of result.trades) {
    const b = byReason.get(t.exitReason) ?? { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.netPnl;
    byReason.set(t.exitReason, b);
  }
  const bySymbol = new Map<string, { n: number; pnl: number }>();
  for (const t of result.trades) {
    const b = bySymbol.get(t.symbol) ?? { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.netPnl;
    bySymbol.set(t.symbol, b);
  }

  const lines = [
    "=== FUTURES BACKTEST (USDⓈ-M perps, 3x, real taker fees + funding) ===",
    `Symbols: ${symbols.join(", ")}`,
    `Window: ${new Date(result.from).toISOString().slice(0, 16)} -> ${new Date(result.to).toISOString().slice(0, 16)}`,
    `Start $${result.startingBalance.toFixed(2)} -> end $${result.finalEquity.toFixed(2)} (${(result.totalReturn * 100).toFixed(2)}%)`,
    `Trades ${result.trades.length} | win rate ${(result.winRate * 100).toFixed(1)}% | expectancy ${result.expectancy.toFixed(3)}R`,
    `Profit factor ${result.profitFactor.toFixed(2)} | max drawdown ${(result.maxDrawdown * 100).toFixed(1)}%`,
    `Fees paid $${result.totalFees.toFixed(4)} | funding paid $${result.totalFunding.toFixed(4)} | LIQUIDATIONS ${result.liquidations}`,
    "",
    "=== BY EXIT REASON ===",
    ...[...byReason.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([r, v]) => `  ${r.padEnd(14)} ${String(v.n).padStart(3)} trades | net $${v.pnl.toFixed(3)}`),
    "",
    "=== BY SYMBOL ===",
    ...[...bySymbol.entries()]
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .map(([s, v]) => `  ${s.padEnd(12)} ${String(v.n).padStart(3)} trades | net $${v.pnl.toFixed(3)}`),
    "",
    "=== DIAGNOSTICS ===",
  ];

  const stops = byReason.get("stop_loss");
  if (stops && result.trades.length > 0 && stops.n / result.trades.length > 0.5) {
    lines.push(
      `  - ${((stops.n / result.trades.length) * 100).toFixed(0)}% of trades stopped out; stops may be too tight for 3x futures volatility.`,
    );
  }
  if (result.liquidations > 0) {
    lines.push(
      `  - ${result.liquidations} liquidation(s). At 3x, a stop wider than ~30% of entry can sit beyond the liquidation price.`,
    );
  }
  if (result.totalFees > Math.abs(result.finalEquity - result.startingBalance)) {
    lines.push(
      "  - Fees exceed net P&L: the strategy is trading too often for its edge. Prefer fewer, higher-conviction entries.",
    );
  }
  if (result.trades.length < GUARDS.minTrades) {
    lines.push(
      `  - Only ${result.trades.length} trades; entry thresholds (minScore ${params.entry.minScore}, minAlignment ${params.entry.minAlignment}) may be too strict to measure anything.`,
    );
  }

  lines.push("", "=== CURRENT PARAMETERS ===", JSON.stringify(params, null, 2));
  return lines.join("\n");
}

export async function runImprovement(options: ImproveOptions = {}): Promise<ImproveReport> {
  const startedAt = Date.now();
  const notes: string[] = [];

  const universe = await resolveUniverse();
  // Wide enough that the ranking below has something to choose between. Two
  // symbols — what this used to load — cannot be ranked at all, so a round
  // scored itself on whichever pair happened to top the board today.
  const poolSize = Number(process.env.IMPROVE_POOL_SIZE ?? "6");
  const symbols =
    options.symbols ?? universe.entries.slice(0, poolSize).map((e) => e.symbol);
  const timeframes = options.timeframes ?? (["1h", "4h"] as Timeframe[]);
  const stepTimeframe = options.stepTimeframe ?? "1h";
  // ~33 days of 1h bars. Fewer and a round routinely produces under the
  // twelve trades its own guardrail demands, so it can never promote
  // anything; the whole loop then runs every hour and does nothing.
  const bars = options.bars ?? 800;

  const incumbent = await loadParams();
  const data = await loadBacktestData(symbols, timeframes, bars);

  const tradable = Math.max(1, Math.min(data.length - 1, Number(process.env.MAX_OPEN_POSITIONS ?? "3")));
  const run = (p: StrategyParams, window: { from?: number; to?: number } = {}) =>
    runFuturesBacktest(data, p, {
      stepTimeframe,
      startingBalance: 100,
      universeSize: tradable,
      ...window,
    });

  const incumbentRunStart = Date.now();
  const incumbentResult = run(incumbent.params);
  // How long one backtest of this data costs, used to reserve time below.
  const incumbentCostMs = Date.now() - incumbentRunStart;

  /**
   * The newer half of the loaded bars, kept back from the comparison that
   * picks a winner.
   *
   * A candidate is chosen because it scored well on this exact data, so its
   * score here is partly a measurement of the search. Re-checking it on the
   * newer half before promoting costs one backtest and is the difference
   * between "beat the incumbent" and "beat the incumbent in a way that held
   * up on bars it was not selected over".
   */
  const stepBars = data.flatMap((d) => d.byTimeframe.get(stepTimeframe) ?? []);
  const holdoutFrom =
    stepBars.length > 0
      ? (() => {
          const first = Math.min(...stepBars.map((c) => c.closeTime));
          const last = Math.max(...stepBars.map((c) => c.closeTime));
          return first + (last - first) * 0.5;
        })()
      : undefined;
  const holdout = (p: StrategyParams) =>
    holdoutFrom === undefined ? null : run(p, { from: holdoutFrom });
  const incumbentHoldout = holdout(incumbent.params);
  notes.push(
    `incumbent ${incumbent.version}: ${incumbentResult.trades.length} trades, ` +
      `${(incumbentResult.totalReturn * 100).toFixed(2)}%, fitness ${incumbentResult.fitness.toFixed(3)}`,
  );

  const report: ImproveReport = {
    ranAt: startedAt,
    durationMs: 0,
    servedBy: null,
    analysis: null,
    symbols,
    incumbent: { version: incumbent.version, result: incumbentResult },
    candidates: [],
    promoted: null,
    notes,
  };

  if (options.measureOnly) {
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  let proposed: ProposedCandidate[] = [];
  try {
    /**
     * Whatever is left of the invocation, not a fixed slice.
     *
     * The fetch and the backtests either side of this vary with how many
     * symbols and bars a round loads, and the platform kills the function at
     * its wall-clock limit regardless. Handing the model a constant budget
     * means either wasting time on a fast round or being killed mid-request
     * on a slow one; deriving it from the clock makes the round degrade by
     * asking for less thinking rather than by dying.
     */
    const spent = Date.now() - startedAt;
    const llmBudget = Math.max(
      8_000,
      Math.min(
        Number(process.env.LLM_BUDGET_MS ?? "44000"),
        // Leave room for the candidate backtests and the held-out re-check,
        // scaled by what the incumbent's own run just cost.
        TOTAL_BUDGET_MS - spent - incumbentCostMs * ((options.candidates ?? 2) + 1),
      ),
    );
    const proposal = await proposeParams({
      report: buildReport(incumbentResult, incumbent.params, symbols),
      incumbent: incumbent.params,
      candidateCount: options.candidates ?? 2,
      budgetMs: llmBudget,
    });
    notes.push(`model budget ${(llmBudget / 1000).toFixed(0)}s after ${(spent / 1000).toFixed(0)}s of data and backtests`);
    proposed = proposal.candidates;
    report.servedBy = proposal.servedBy;
    report.analysis = proposal.analysis;
  } catch (err) {
    notes.push(
      `model unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  for (const candidate of proposed) {
    const parsed = StrategyParamsSchema.safeParse(candidate.params);
    if (!parsed.success) {
      notes.push(`discarded "${candidate.name}": failed schema validation`);
      continue;
    }
    const { params, repairs } = sanitiseParams(parsed.data);
    const result = run(params);
    report.candidates.push({
      name: candidate.name,
      hypothesis: candidate.hypothesis,
      changes: [...candidate.changes, ...repairs.map((r) => `repair: ${r}`)],
      result,
      rejectedBecause: screen(result, incumbentResult.fitness),
    });
  }

  let winner: CandidateResult | undefined = report.candidates
    .filter((c) => c.rejectedBecause === null)
    .sort((a, b) => b.result.fitness - a.result.fitness)[0];

  // The held-out re-check. A candidate that cannot carry its edge into the
  // newer half is a reading of this window, not an improvement to the
  // strategy, and promoting it would walk the live parameters steadily
  // further into whatever the last few weeks happened to do.
  if (winner && incumbentHoldout) {
    const matching = proposed.find((c) => c.name === winner!.name);
    const check = matching
      ? holdout(sanitiseParams(StrategyParamsSchema.parse(matching.params)).params)
      : null;
    if (!check) {
      notes.push(`"${winner.name}" could not be re-checked on the holdout; not promoting`);
      winner = undefined;
    } else if (check.totalReturn <= 0 || check.fitness < incumbentHoldout.fitness) {
      const reason =
        `held out: ${(check.totalReturn * 100).toFixed(2)}% over ${check.trades.length} trades ` +
        `(incumbent ${(incumbentHoldout.totalReturn * 100).toFixed(2)}%)`;
      notes.push(`rejected "${winner.name}" — ${reason}`);
      const entry = report.candidates.find((c) => c.name === winner!.name);
      if (entry) entry.rejectedBecause = reason;
      winner = undefined;
    } else {
      notes.push(
        `"${winner.name}" held up out of sample: ${(check.totalReturn * 100).toFixed(2)}% ` +
          `over ${check.trades.length} trades`,
      );
    }
  }

  if (winner && !options.dryRun) {
    const matching = proposed.find((p) => p.name === winner.name);
    const params = matching
      ? sanitiseParams(StrategyParamsSchema.parse(matching.params)).params
      : incumbent.params;

    const next: StoredParams = {
      version: `llm-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
      source: report.servedBy ? `openrouter:${report.servedBy}` : "llm",
      rationale: `${winner.name}: ${winner.hypothesis}`,
      parentVersion: incumbent.version,
      updatedAt: Date.now(),
      // The round scored this candidate on bars up to the latest one it
      // loaded, so everything through now is in-sample for it.
      fittedThrough: incumbentResult.to || Date.now(),
      params,
      evidence: {
        totalReturn: winner.result.totalReturn,
        maxDrawdown: winner.result.maxDrawdown,
        trades: winner.result.trades.length,
        winRate: winner.result.winRate,
        fitness: winner.result.fitness,
        liquidations: winner.result.liquidations,
      },
    };
    await kv().set(KEYS.params, next);
    await kv().push(KEYS.paramsHistory, next, 100);
    report.promoted = { version: next.version, name: winner.name };
    notes.push(`promoted ${next.version} from "${winner.name}"`);
  } else if (winner) {
    notes.push(`dry run — would have promoted "${winner.name}"`);
  } else {
    notes.push("no candidate beat the incumbent; parameters unchanged");
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}
