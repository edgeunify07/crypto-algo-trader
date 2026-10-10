import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { runBacktest, type BacktestResult, type SymbolData } from "../backtest/engine.js";
import { walkForward, type WalkForwardResult } from "../backtest/walkforward.js";
import { buildPerformanceReport } from "./report.js";
import { LlmUnavailableError, acceptCandidate, proposeParameters } from "./llm.js";
import { mutateParams } from "./mutate.js";
import {
  loadActiveParams,
  newVersion,
  recentAttemptSummary,
  recordPromotion,
  type PromotionRecord,
} from "./paramStore.js";
import type { StrategyParams } from "../strategy/params.js";
import type { Timeframe } from "../types.js";

const log = createLogger("improve");

export interface ImproveOptions {
  data: SymbolData[];
  rounds?: number;
  candidatesPerRound?: number;
  stepTimeframe?: Timeframe;
  startingCash?: number;
  /** Skip the LLM and use local mutation search only. */
  useLlm?: boolean;
  /** Walk-forward folds used to validate a candidate before promotion. */
  folds?: number;
  /** Evaluate candidates but never write a promotion. */
  dryRun?: boolean;
}

export interface CandidateEvaluation {
  name: string;
  hypothesis: string;
  changes: string[];
  params: StrategyParams;
  train: BacktestResult;
  validation: WalkForwardResult;
  /** Promotion score: out-of-sample fitness, penalised for inconsistency. */
  score: number;
  rejectedBecause: string | null;
}

export interface ImproveRound {
  round: number;
  incumbentScore: number;
  evaluations: CandidateEvaluation[];
  promoted: PromotionRecord | null;
  source: "llm" | "mutation";
}

export interface ImproveReport {
  rounds: ImproveRound[];
  startingVersion: string;
  finalVersion: string;
  improved: boolean;
}

/**
 * Score a candidate for promotion.
 *
 * Deliberately built on the *out-of-sample* walk-forward result, not the
 * in-sample backtest: in-sample fitness is what over-fitting maximises. Fold
 * consistency is folded in so a candidate carried by one lucky window scores
 * below one that worked steadily.
 */
function promotionScore(validation: WalkForwardResult): number {
  const consistencyWeight = 0.5 + 0.5 * validation.foldConsistency;
  return validation.fitness * consistencyWeight;
}

/** Hard gates a candidate must clear regardless of its score. */
function screenCandidate(
  evaluation: Omit<CandidateEvaluation, "rejectedBecause">,
  incumbentScore: number,
): string | null {
  const m = evaluation.validation.aggregate;

  if (m.trades < config.improve.minTrades) {
    return `only ${m.trades} out-of-sample trades (minimum ${config.improve.minTrades})`;
  }
  if (m.maxDrawdown > config.improve.maxAcceptableDrawdown) {
    return `out-of-sample drawdown ${(m.maxDrawdown * 100).toFixed(1)}% exceeds the ${(config.improve.maxAcceptableDrawdown * 100).toFixed(0)}% cap`;
  }
  if (evaluation.validation.foldConsistency < 0.5) {
    return `only ${(evaluation.validation.foldConsistency * 100).toFixed(0)}% of walk-forward folds were profitable`;
  }
  if (m.totalReturn <= 0) {
    return "out-of-sample return is not positive";
  }
  if (evaluation.score < incumbentScore + config.improve.minImprovement) {
    return `score ${evaluation.score.toFixed(3)} does not beat the incumbent (${incumbentScore.toFixed(3)}) by the required margin`;
  }
  return null;
}

function evaluateCandidate(
  candidate: { name: string; hypothesis: string; changes: string[]; params: StrategyParams },
  data: SymbolData[],
  options: ImproveOptions,
): Omit<CandidateEvaluation, "rejectedBecause"> {
  const train = runBacktest(data, {
    params: candidate.params,
    ...(options.startingCash !== undefined ? { startingCash: options.startingCash } : {}),
    ...(options.stepTimeframe ? { stepTimeframe: options.stepTimeframe } : {}),
  });
  const validation = walkForward(data, candidate.params, {
    folds: options.folds ?? 4,
    ...(options.startingCash !== undefined ? { startingCash: options.startingCash } : {}),
    ...(options.stepTimeframe ? { stepTimeframe: options.stepTimeframe } : {}),
  });
  return {
    ...candidate,
    train,
    validation,
    score: promotionScore(validation),
  };
}

/**
 * Run the improvement loop.
 *
 * Each round: evaluate the incumbent, build a performance report, ask the model
 * (or the mutator) for candidates, backtest and walk-forward each one, and
 * promote only a candidate that clears every guardrail *and* beats the
 * incumbent out of sample by the configured margin. Promotion is the only way
 * parameters change — the model never writes to the live config directly.
 */
export async function runImprovement(options: ImproveOptions): Promise<ImproveReport> {
  const {
    data,
    rounds = 1,
    candidatesPerRound = config.llm.candidatesPerRound,
    useLlm = true,
  } = options;

  const startingVersioned = loadActiveParams();
  let incumbent = startingVersioned;
  const roundReports: ImproveRound[] = [];

  for (let round = 1; round <= rounds; round++) {
    log.info(`--- improvement round ${round}/${rounds} (incumbent ${incumbent.version}) ---`);

    // 1. Evaluate the incumbent so we have a baseline and a report to reason over.
    const incumbentEval = evaluateCandidate(
      {
        name: "incumbent",
        hypothesis: "Current live parameters.",
        changes: [],
        params: incumbent.params,
      },
      data,
      options,
    );
    const incumbentScore = incumbentEval.score;
    log.info(
      `incumbent: ${incumbentEval.train.metrics.trades} in-sample trades, ` +
        `OOS fitness ${incumbentEval.validation.fitness.toFixed(3)}, score ${incumbentScore.toFixed(3)}`,
    );

    const report = buildPerformanceReport(
      incumbentEval.train,
      incumbent.params,
      incumbentEval.validation,
    );

    // 2. Get candidates, from the model where possible.
    let candidates: { name: string; hypothesis: string; changes: string[]; params: StrategyParams }[] = [];
    let source: "llm" | "mutation" = "mutation";
    let analysis = "";

    if (useLlm) {
      try {
        const proposal = await proposeParameters({
          report,
          incumbent: incumbent.params,
          history: recentAttemptSummary(),
          candidateCount: candidatesPerRound,
        });
        analysis = proposal.analysis;
        log.info(`model analysis: ${analysis}`);
        for (const candidate of proposal.candidates) {
          try {
            const { params, repairs } = acceptCandidate(candidate);
            if (repairs.length > 0) {
              log.warn(`repaired "${candidate.name}": ${repairs.join("; ")}`);
            }
            candidates.push({
              name: candidate.name,
              hypothesis: candidate.hypothesis,
              changes: [...candidate.changes, ...repairs.map((r) => `repair: ${r}`)],
              params,
            });
          } catch (err) {
            log.warn(`discarding invalid candidate`, err);
          }
        }
        source = "llm";
      } catch (err) {
        if (err instanceof LlmUnavailableError) {
          log.warn(`${err.message} Falling back to local mutation search.`);
        } else {
          log.error("LLM proposal failed; falling back to local mutation search", err);
        }
      }
    }

    if (candidates.length === 0) {
      candidates = mutateParams(incumbent.params, candidatesPerRound);
      source = "mutation";
    }

    // 3. Evaluate every candidate out of sample.
    const evaluations: CandidateEvaluation[] = [];
    for (const candidate of candidates) {
      const evaluated = evaluateCandidate(candidate, data, options);
      const rejectedBecause = screenCandidate(evaluated, incumbentScore);
      evaluations.push({ ...evaluated, rejectedBecause });
      log.info(
        `  ${candidate.name}: OOS ${evaluated.validation.aggregate.trades} trades, ` +
          `return ${(evaluated.validation.aggregate.totalReturn * 100).toFixed(1)}%, ` +
          `DD ${(evaluated.validation.aggregate.maxDrawdown * 100).toFixed(1)}%, ` +
          `score ${evaluated.score.toFixed(3)}` +
          (rejectedBecause ? ` — REJECTED: ${rejectedBecause}` : " — PASSES"),
      );
    }

    // 4. Promote the best survivor, if any.
    const survivors = evaluations
      .filter((e) => e.rejectedBecause === null)
      .sort((a, b) => b.score - a.score);
    const winner = survivors[0];

    let promoted: PromotionRecord | null = null;
    if (winner && !options.dryRun) {
      const versioned = newVersion(
        winner.params,
        source,
        `${winner.name}: ${winner.hypothesis}${analysis ? ` | round analysis: ${analysis}` : ""}`,
        incumbent.version,
      );
      promoted = {
        ...versioned,
        evidence: {
          trainFitness: winner.train.fitness,
          validationFitness: winner.validation.fitness,
          trades: winner.validation.aggregate.trades,
          totalReturn: winner.validation.aggregate.totalReturn,
          maxDrawdown: winner.validation.aggregate.maxDrawdown,
          sharpe: winner.validation.aggregate.sharpe,
          foldConsistency: winner.validation.foldConsistency,
        },
      };
      recordPromotion(promoted);
      incumbent = promoted;
    } else if (winner && options.dryRun) {
      log.info(`dry run — would have promoted "${winner.name}"`);
    } else {
      log.info("no candidate beat the incumbent; parameters unchanged");
    }

    roundReports.push({ round, incumbentScore, evaluations, promoted, source });
  }

  return {
    rounds: roundReports,
    startingVersion: startingVersioned.version,
    finalVersion: incumbent.version,
    improved: incumbent.version !== startingVersioned.version,
  };
}
