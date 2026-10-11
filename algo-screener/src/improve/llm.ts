import { z } from "zod";
import { config } from "../config.js";
import { createLogger } from "../util/logger.js";
import { TIMEFRAMES } from "../types.js";
import {
  StrategyParamsSchema,
  sanitiseParams,
  type StrategyParams,
} from "../strategy/params.js";
import {
  LlmRequestError,
  LlmUnavailableError,
  describeIssues,
  extractJson,
  type LlmProvider,
} from "./llmProvider.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { AnthropicProvider } from "./providers/anthropic.js";

const log = createLogger("llm");

export { LlmUnavailableError };

/**
 * Response schema for parameter proposals.
 *
 * `timeframeWeights` is spelled out key-by-key rather than as a record: an
 * `additionalProperties` map is awkward for strict structured output and is
 * the first thing weaker models get wrong, and an explicit shape also stops a
 * model inventing timeframes the engine doesn't trade.
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

/** Cached because Zod regenerates the schema object on every call. */
let cachedJsonSchema: Record<string, unknown> | null = null;
function proposalJsonSchema(): Record<string, unknown> {
  cachedJsonSchema ??= z.toJSONSchema(ProposalSchema, {
    io: "input",
    target: "draft-7",
  }) as Record<string, unknown>;
  return cachedJsonSchema;
}

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
- riskPerTrade above 0.02 is almost never justified. Account-level limits are enforced outside your control, so raising risk here mostly just raises drawdown.

OUTPUT FORMAT — this is critical:
Reply with a single JSON object and nothing else. No markdown fences, no commentary before or after, no explanation outside the JSON. Every field in the schema is required, including the complete "params" object for every candidate with all of its nested sections (weights, indicators, timeframeWeights, entry, exit, risk). "timeframeWeights" must contain exactly these keys: ${TIMEFRAMES.join(", ")}.`;

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
${JSON.stringify(incumbent, null, 2)}

Return one JSON object matching the required schema, with a "candidates" array of exactly ${candidateCount} entries.`;
}

/** Build the configured provider. */
export function createProvider(): LlmProvider {
  const choice = config.llm.provider;
  const hasOpenRouter = config.llm.openrouter.apiKey !== "";
  const hasAnthropic = config.llm.anthropic.apiKey !== "";

  if (choice === "openrouter") return new OpenRouterProvider();
  if (choice === "anthropic") return new AnthropicProvider();

  // auto
  if (hasOpenRouter) return new OpenRouterProvider();
  if (hasAnthropic) return new AnthropicProvider();

  throw new LlmUnavailableError(
    "No LLM credentials found. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY), " +
      "or run with --no-llm to use local mutation search instead.",
  );
}

/**
 * Ask the configured model for parameter proposals.
 *
 * The response is extracted, validated against the strategy's own Zod schema,
 * and — when a model gets the shape wrong — sent back with its specific
 * validation errors for repair. Weaker and cheaper models get the shape wrong
 * often enough that this repair step is what makes them usable at all.
 */
export async function proposeParameters(options: {
  report: string;
  incumbent: StrategyParams;
  history?: string;
  candidateCount?: number;
  provider?: LlmProvider;
}): Promise<Proposal & { servedBy: string }> {
  const {
    report,
    incumbent,
    history = "",
    candidateCount = config.llm.candidatesPerRound,
  } = options;

  const provider = options.provider ?? createProvider();
  const jsonSchema = proposalJsonSchema();
  const system = SYSTEM_PROMPT;
  let user = buildUserPrompt(report, incumbent, history, candidateCount);

  log.info(
    `asking ${provider.name} [${provider.models.join(" -> ")}] for ${candidateCount} candidates`,
  );

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= config.llm.repairAttempts; attempt++) {
    const completion = await provider.complete({
      system,
      user,
      jsonSchema,
      schemaName: "strategy_parameter_proposal",
      maxTokens: config.llm.maxTokens,
    });

    const cost =
      completion.usage.costUsd === null
        ? ""
        : `, $${completion.usage.costUsd.toFixed(5)}`;
    log.info(
      `served by ${completion.model} (${completion.usage.inputTokens} in / ${completion.usage.outputTokens} out${cost})`,
    );

    try {
      const raw = extractJson(completion.text);
      const parsed = ProposalSchema.safeParse(raw);
      if (parsed.success) {
        return { ...parsed.data, servedBy: completion.model };
      }
      lastError = describeIssues(parsed.error);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt === config.llm.repairAttempts) break;

    log.warn(
      `response failed validation (attempt ${attempt + 1}/${config.llm.repairAttempts + 1}); asking for a correction`,
    );
    user =
      `${buildUserPrompt(report, incumbent, history, candidateCount)}\n\n` +
      `IMPORTANT — your previous reply was rejected. Fix exactly these problems and return ONLY the corrected JSON object:\n${lastError}\n\n` +
      `Do not apologise or explain. Output the JSON object alone.`;
  }

  throw new LlmRequestError(
    `model did not return a valid proposal after ${config.llm.repairAttempts + 1} attempts: ${lastError}`,
  );
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
