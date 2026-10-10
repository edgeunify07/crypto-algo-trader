import { z } from "zod";
import { StrategyParamsSchema, type StrategyParams } from "@/lib/algo/strategy/params";

/**
 * OpenRouter client for the improvement loop.
 *
 * The model proposes a small **patch**, not a whole parameter object. Asking a
 * free model to re-emit the full nested params (nine weights, thirteen
 * timeframe weights, and five more sections) reliably produced truncated or
 * malformed JSON: ~1500 output tokens per candidate, and any single missing
 * field invalidates the whole response. A patch is a handful of path/value
 * pairs, so it is fast, cheap and almost impossible to get structurally wrong,
 * and the engine applies it to the incumbent itself — which also guarantees
 * the model can never touch a field that is not on the whitelist.
 */

/** The only parameters a model is allowed to change. */
export const TUNABLE_PATHS = [
  "weights.emaTrend", "weights.macd", "weights.rsi", "weights.adx",
  "weights.bollinger", "weights.volume", "weights.structure",
  "weights.elliott", "weights.gann",
  "indicators.emaFast", "indicators.emaSlow", "indicators.rsiPeriod",
  "indicators.rsiOverbought", "indicators.rsiOversold", "indicators.atrPeriod",
  "indicators.adxThreshold", "indicators.zigzagAtrMultiple",
  "timeframeWeights.5m", "timeframeWeights.15m", "timeframeWeights.1h",
  "timeframeWeights.4h", "timeframeWeights.1d",
  "entry.minScore", "entry.minConfidence", "entry.minAlignment",
  "entry.requireElliottAgreement", "entry.requireGannAgreement",
  "entry.avoidGannTimeCycle", "entry.allowShorts",
  "exit.atrStopMultiple", "exit.trailStartR", "exit.trailAtrMultiple",
  "exit.breakEvenR", "exit.maxHoldBars", "exit.exitOnScoreFlip",
  "exit.useStructuralTargets",
] as const;

const PatchSchema = z.object({
  path: z.string(),
  value: z.union([z.number(), z.boolean()]),
});

const CandidateSchema = z.object({
  name: z.string(),
  hypothesis: z.string(),
  patch: z.array(PatchSchema).min(1).max(8),
});

const ProposalSchema = z.object({
  analysis: z.string(),
  candidates: z.array(CandidateSchema).min(1).max(4),
});

export interface ProposedCandidate {
  name: string;
  hypothesis: string;
  changes: string[];
  params: StrategyParams;
}

const MODELS = (
  process.env.OPENROUTER_MODELS ??
  "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/** Apply a whitelisted patch to a copy of the incumbent. */
export function applyPatch(
  incumbent: StrategyParams,
  patch: { path: string; value: number | boolean }[],
): { params: StrategyParams; changes: string[]; rejected: string[] } {
  const next = structuredClone(incumbent) as unknown as Record<string, unknown>;
  const changes: string[] = [];
  const rejected: string[] = [];

  for (const { path, value } of patch) {
    if (!(TUNABLE_PATHS as readonly string[]).includes(path)) {
      rejected.push(`${path} is not tunable`);
      continue;
    }
    const [section, key] = path.split(".") as [string, string];
    const target = next[section] as Record<string, unknown> | undefined;
    if (!target || !(key in target)) {
      rejected.push(`${path} does not exist`);
      continue;
    }
    const before = target[key];
    if (typeof before !== typeof value) {
      rejected.push(`${path} expects ${typeof before}, got ${typeof value}`);
      continue;
    }
    target[key] = value;
    changes.push(`${path}: ${String(before)} -> ${String(value)}`);
  }

  return {
    params: next as unknown as StrategyParams,
    changes,
    rejected,
  };
}

const SYSTEM = `You are a quantitative researcher tuning a crypto FUTURES strategy on Binance USDⓈ-M perpetuals at 3x leverage with a $100 account.

The strategy scores nine components (EMA trend, MACD, RSI, ADX, Bollinger, volume/OBV, market structure, Elliott Wave, Gann) across the 5m/15m/1h/4h/1d timeframes. Weights decide the blend; a trade opens only when blended score, confidence and cross-timeframe alignment all clear their thresholds. Stops are ATR-based.

What makes futures different, and must drive your reasoning:
- Every trade pays 0.05% taker commission on entry AND exit. On $100 that is material against the edge.
- Open positions pay funding every 8 hours, so a slow swing bleeds even when price is flat.
- At 3x, liquidation is ~33% against entry. A stop wider than that never triggers — the position liquidates and loses ALL its margin. Any candidate producing a liquidation is rejected outright.

Return a PATCH, not a full parameter object: a short list of {path, value} changes applied to the incumbent.

Rules:
- 2 to 5 changes per candidate, all serving one stated hypothesis.
- Candidates must test DIFFERENT hypotheses from each other.
- Only use paths from the allowed list. Values must be numbers or booleans and stay in sensible ranges.
- Do not raise risk to raise return: drawdown and liquidations are punished far harder than return is rewarded.

ALLOWED PATHS:
${TUNABLE_PATHS.join(", ")}

OUTPUT: one JSON object only — no markdown fences, no text before or after:
{"analysis": "...", "candidates": [{"name": "...", "hypothesis": "...", "patch": [{"path": "exit.atrStopMultiple", "value": 2.5}]}]}`;

function extractJson(text: string): unknown {
  const attempts = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) attempts.push(fence[1].trim());

  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i] as string;
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { if (inString) escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { attempts.push(text.slice(start, i + 1)); break; }
    }
  }

  for (const candidate of attempts) {
    for (const variant of [candidate, candidate.replace(/,(\s*[}\]])/g, "$1")]) {
      try {
        const parsed: unknown = JSON.parse(variant);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* try the next variant */ }
    }
  }
  throw new Error(`no JSON object in response (starts: ${text.slice(0, 120)})`);
}

async function call(
  models: string[],
  user: string,
  maxTokens: number,
  perAttemptMs: number,
): Promise<{ text: string; model: string }> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const body: Record<string, unknown> = {
    model: models[0],
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.5,
  };
  if (models.length > 1) body.models = models;

  const res = await fetch(
    `${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "algo-futures",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(perAttemptMs),
      cache: "no-store",
    },
  );

  const raw = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${raw.slice(0, 180)}`);

  const parsed = JSON.parse(raw) as {
    model?: string;
    error?: { message?: string };
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  };
  if (parsed.error) throw new Error(`OpenRouter: ${parsed.error.message}`);

  const choice = parsed.choices?.[0];
  const content = choice?.message?.content?.trim() ?? "";
  if (choice?.finish_reason === "length") {
    throw new Error(`hit the ${maxTokens}-token cap before finishing`);
  }
  if (!content) throw new Error("model returned empty content");
  return { text: content, model: parsed.model ?? (models[0] as string) };
}

export async function proposeParams(options: {
  report: string;
  incumbent: StrategyParams;
  candidateCount?: number;
  maxTokens?: number;
  budgetMs?: number;
}): Promise<{ analysis: string; candidates: ProposedCandidate[]; servedBy: string }> {
  const {
    report,
    incumbent,
    candidateCount = 2,
    maxTokens = 3000,
    // A serverless function is killed at its wall-clock limit, so the whole
    // proposal — including every failover attempt — has to fit in a budget.
    // Without this, one slow model burns the entire invocation and the round
    // returns nothing at all.
    budgetMs = Number(process.env.LLM_BUDGET_MS ?? "40000"),
  } = options;
  const deadline = Date.now() + budgetMs;

  const user = `Latest futures backtest of the incumbent parameters:

${report}

Current values of the tunable parameters:
${JSON.stringify(
  {
    weights: incumbent.weights,
    indicators: incumbent.indicators,
    timeframeWeights: incumbent.timeframeWeights,
    entry: incumbent.entry,
    exit: incumbent.exit,
  },
  null,
  1,
)}

Propose exactly ${candidateCount} candidate patches testing distinct hypotheses. Return ONE JSON object.`;

  /**
   * Each model is tried pinned, with its own timeout, rather than handing
   * OpenRouter the whole list. OpenRouter's internal routing only fails over
   * on an upstream error, so a primary that is merely *slow* holds the request
   * until the function itself is killed — and a large reasoning model is
   * routinely slower than a serverless budget allows. Pinning makes the
   * failover deterministic: the primary gets a fixed slice, then the next
   * model gets what remains.
   */
  const perModelMs = Number(process.env.LLM_PER_MODEL_MS ?? "20000");
  const routes = MODELS.map((m) => [m]);
  let lastError: unknown;

  for (const route of routes) {
    const remaining = deadline - Date.now();
    // Leave no attempt less than 6s; a shorter one cannot finish anyway.
    if (remaining < 6000) {
      lastError = lastError ?? new Error("ran out of time budget before a model answered");
      break;
    }
    try {
      const { text, model } = await call(
        route,
        user,
        maxTokens,
        Math.min(remaining, perModelMs),
      );
      const parsed = ProposalSchema.safeParse(extractJson(text));
      if (!parsed.success) {
        lastError = new Error(
          `schema: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
        continue;
      }

      const candidates: ProposedCandidate[] = [];
      for (const c of parsed.data.candidates) {
        const applied = applyPatch(incumbent, c.patch);
        if (applied.changes.length === 0) continue; // nothing valid to test
        const validated = StrategyParamsSchema.safeParse(applied.params);
        if (!validated.success) continue;
        candidates.push({
          name: c.name,
          hypothesis: c.hypothesis,
          changes: [
            ...applied.changes,
            ...applied.rejected.map((r) => `rejected: ${r}`),
          ],
          params: validated.data,
        });
      }

      if (candidates.length > 0) {
        return { analysis: parsed.data.analysis, candidates, servedBy: model };
      }
      lastError = new Error("no candidate produced a valid parameter change");
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("all models failed");
}
