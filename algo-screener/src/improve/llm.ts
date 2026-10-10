import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { TIMEFRAMES } from "../types.js";
import {
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "../strategy/params.js";

const log = createLogger("llm");

/**
 * Structured-output schema for parameter proposals.
 *
 * `timeframeWeights` is spelled out key-by-key rather than as a record: a
 * JSON-Schema `additionalProperties` map is awkward for strict structured
 * output, and an explicit shape also stops the model inventing timeframes the
 * engine doesn't trade.
 */
const TimeframeWeightsSchema = z.object(
  Object.fromEntries(
    TIMEFRAMES.map((tf) => [tf, z.number().min(0).max(5)]),
  ) as Record<(typeof TIMEFRAMES)[number], z.ZodNumber>,
);

const ProposalParamsSchema = StrategyParamsSchema.extend({
  timeframeWeights: TimeframeWeightsSchema,
});

const ProposalSchema = z.object({
  analysis: z
    .string()
    .describe(
      "What the performance report shows: the specific failure modes you identified, in 2-5 sentences.",
    ),
  candidates: z
    .array(
      z.object({
        name: z
          .string()
          .describe("Short label for this hypothesis, e.g. 'wider-stops-trend-filter'."),
        hypothesis: z
          .string()
          .describe(
            "The causal claim being tested: what is going wrong, what change addresses it, and what metric should move.",
          ),
        changes: z
          .array(z.string())
          .describe("Human-readable list of the parameter changes made vs. the incumbent."),
        params: ProposalParamsSchema,
      }),
    )
    .min(1)
    .max(6),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalCandidate = Proposal["candidates"][number];

const SYSTEM_PROMPT = `You are a quantitative trading researcher tuning a multi-timeframe crypto strategy.

The strategy blends nine analysis components (EMA trend, MACD, RSI, ADX, Bollinger, volume/OBV, market structure, Elliott Wave, Gann) across up to thirteen Binance timeframes. Each component emits a score in [-1, +1]; component weights and timeframe weights decide the blend. A trade plan is produced only when the blended score, confidence and cross-timeframe alignment all clear their thresholds. Stops are ATR-based and snapped to structural levels; targets are an R-multiple ladder optionally snapped to Elliott/Gann levels.

Your job each round: read the performance report, form specific causal hypotheses about what is costing money, and return parameter sets that test them.

Rules you must follow:
- Every candidate must be a COMPLETE parameter object, not a diff. Copy the incumbent and change only what your hypothesis requires.
- Change few things per candidate (typically 2-5 related parameters). A candidate that changes everything teaches nothing, because you cannot attribute the result.
- Make candidates DIFFERENT from each other — each should test a distinct hypothesis, not a slight variation of the same one.
- Respect every schema bound. Keep emaFast < emaSlow and macdFast < macdSlow. takeProfitRMultiples must ascend and takeProfitFractions must sum to <= 1 with the same length.
- Do not chase the reported return. A candidate that lifts return by widening risk is not an improvement; the selection score weights Sharpe, Calmar, expectancy and drawdown, and candidates are re-tested out of sample.
- Be suspicious of small samples. If the report shows few trades, prefer loosening entry thresholds to collect evidence over fine-tuning exits on noise.
- riskPerTrade above 0.02 is almost never justified. Account-level limits are enforced outside your control, so raising risk here mostly just raises drawdown.`;

function buildUserPrompt(
  report: string,
  incumbent: StrategyParams,
  history: string,
  candidateCount: number,
): string {
  return `Here is the latest evaluation of the incumbent parameter set.

${report}

${history ? `\n=== RECENT ATTEMPTS (do not repeat these) ===\n${history}\n` : ""}

Propose exactly ${candidateCount} candidate parameter sets that test distinct hypotheses about what is limiting performance.

The incumbent parameters you are modifying are:
${JSON.stringify(incumbent, null, 2)}`;
}

export class LlmUnavailableError extends Error {}

/**
 * Ask Claude for parameter proposals.
 *
 * Uses structured output so the response is guaranteed to match the strategy's
 * own schema — the model cannot return a params object the engine can't run.
 * Everything it returns is still sanitised and bounds-checked before use.
 */
export async function proposeParameters(options: {
  report: string;
  incumbent: StrategyParams;
  history?: string;
  candidateCount?: number;
}): Promise<Proposal> {
  const {
    report,
    incumbent,
    history = "",
    candidateCount = config.llm.candidatesPerRound,
  } = options;

  if (!config.llm.apiKey) {
    throw new LlmUnavailableError(
      "ANTHROPIC_API_KEY is not set — run with --no-llm to use local mutation search instead.",
    );
  }

  const client = new Anthropic({ apiKey: config.llm.apiKey });

  log.info(
    `asking ${config.llm.model} for ${candidateCount} candidate parameter sets`,
  );

  const response = await client.messages.parse({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: config.llm.effort as "low" | "medium" | "high" | "xhigh" | "max",
      format: zodOutputFormat(ProposalSchema),
    },
    messages: [
      {
        role: "user",
        content: buildUserPrompt(report, incumbent, history, candidateCount),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `model declined the request: ${response.stop_details?.explanation ?? "no explanation given"}`,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("model returned no parseable proposal");
  }

  const usage = response.usage;
  log.info(
    `received ${parsed.candidates.length} candidates (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`,
  );

  return parsed;
}

/** Validate and repair a proposed params object before it is backtested. */
export function acceptCandidate(candidate: ProposalCandidate): {
  params: StrategyParams;
  repairs: string[];
} {
  const parsed = StrategyParamsSchema.safeParse(candidate.params);
  if (!parsed.success) {
    throw new Error(
      `candidate "${candidate.name}" failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return sanitiseParams(parsed.data);
}
