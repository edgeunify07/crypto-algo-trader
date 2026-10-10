import {
  DEFAULT_PARAMS,
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
      return { ...stored, params: sanitiseParams(parsed.data).params };
    }
  }
  return {
    version: "default-v1",
    source: "default",
    rationale: "Baseline parameters shipped with the engine.",
    parentVersion: null,
    updatedAt: Date.now(),
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
  const symbols =
    options.symbols ?? universe.entries.slice(0, 2).map((e) => e.symbol);
  const timeframes = options.timeframes ?? (["1h", "4h"] as Timeframe[]);
  const stepTimeframe = options.stepTimeframe ?? "1h";
  const bars = options.bars ?? 500;

  const incumbent = await loadParams();
  const data = await loadBacktestData(symbols, timeframes, bars);

  const run = (p: StrategyParams) =>
    runFuturesBacktest(data, p, { stepTimeframe, startingBalance: 100 });

  const incumbentResult = run(incumbent.params);
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
    const proposal = await proposeParams({
      report: buildReport(incumbentResult, incumbent.params, symbols),
      incumbent: incumbent.params,
      candidateCount: options.candidates ?? 2,
    });
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

  const winner = report.candidates
    .filter((c) => c.rejectedBecause === null)
    .sort((a, b) => b.result.fitness - a.result.fitness)[0];

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
