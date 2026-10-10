import type { z } from "zod";

/**
 * Provider-agnostic interface for the one thing the improvement loop needs
 * from a model: a JSON object matching a Zod schema.
 *
 * Models differ a lot in how reliably they honour a schema. Rather than trust
 * any of them, every provider returns raw text and this layer does the
 * extraction, validation and repair. A provider's native structured-output
 * mode is an optimisation, never the correctness guarantee.
 */

export interface LlmCompletionRequest {
  system: string;
  user: string;
  /** JSON Schema describing the expected response shape. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD when the provider reports it. */
  costUsd: number | null;
}

export interface LlmCompletion {
  /** Raw assistant text, which should contain the JSON object. */
  text: string;
  /** The model that actually served the request (may be a fallback). */
  model: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  /** Model ids this provider will try, in order. For display and logging. */
  readonly models: string[];
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

export class LlmUnavailableError extends Error {}
export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

/**
 * Pull a JSON object out of model text.
 *
 * Smaller and reasoning-tuned models routinely wrap JSON in prose or markdown
 * fences, or leave a trailing comma, even when asked for strict JSON. Each
 * strategy below is tried in order; none of them accepts invalid data, they
 * only widen what counts as "the JSON part" of a response.
 */
export function extractJson(text: string): unknown {
  const attempts: string[] = [];

  const trimmed = text.trim();
  attempts.push(trimmed);

  // ```json … ``` or bare ``` … ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) attempts.push(fence[1].trim());

  // The outermost balanced {...}, ignoring braces inside strings.
  const balanced = findBalancedObject(trimmed);
  if (balanced) attempts.push(balanced);

  for (const candidate of attempts) {
    for (const variant of [candidate, stripTrailingCommas(candidate)]) {
      try {
        const parsed: unknown = JSON.parse(variant);
        if (parsed !== null && typeof parsed === "object") return parsed;
      } catch {
        // Try the next variant.
      }
    }
  }

  throw new LlmRequestError(
    `no JSON object found in model response (${text.length} chars, starts: ${text.slice(0, 120)})`,
  );
}

/** Outermost `{ … }` span, skipping braces that appear inside JSON strings. */
function findBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      // Backslashes only escape inside strings, but treating them uniformly is
      // harmless here and keeps the scanner simple.
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Remove commas that sit immediately before a closing brace or bracket. */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/** Readable summary of Zod issues, used to ask a model to correct itself. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 25)
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
