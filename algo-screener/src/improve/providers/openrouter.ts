import { config } from "../../config.js";
import { createLogger } from "../../util/logger.js";
import { sleep } from "../../util/time.js";
import {
  LlmRequestError,
  LlmUnavailableError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from "../llmProvider.js";

const log = createLogger("llm:openrouter");

interface ChatChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    /** Nemotron and other reasoning models return this alongside content. */
    reasoning?: string | null;
  };
  error?: { message?: string };
}

interface ChatResponse {
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: { message?: string; code?: number };
}

/**
 * OpenRouter provider (OpenAI-compatible chat completions).
 *
 * Failover works at two levels:
 *
 *  1. **Server-side.** OpenRouter's `models` array routes to the next model in
 *     the list when the first is unavailable, rate-limited or errors. This is
 *     one request and one round trip, and `response.model` reports who served.
 *  2. **Client-side.** If the whole request fails — OpenRouter itself is down,
 *     the route is exhausted, or the served model returns something unusable —
 *     each model is retried individually. Server-side routing covers upstream
 *     failures; it cannot cover a model that answers successfully with
 *     unparseable content, which is a real failure mode for small free models.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";

  constructor(
    readonly models: string[] = [
      config.llm.openrouter.model,
      ...config.llm.openrouter.fallbackModels,
    ].filter(Boolean),
    private readonly apiKey: string = config.llm.openrouter.apiKey,
    private readonly baseUrl: string = config.llm.openrouter.baseUrl,
  ) {
    if (this.models.length === 0) {
      throw new LlmUnavailableError("no OpenRouter models configured");
    }
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new LlmUnavailableError(
        "OPENROUTER_API_KEY is not set — run with --no-llm to use local mutation search instead.",
      );
    }

    // First attempt uses the whole list so OpenRouter can route internally.
    // Later attempts pin one model at a time, because a route-level failure
    // (an invalid id anywhere in the list rejects the whole request with a
    // 400) tells us nothing about whether the individual models work.
    const routes: string[][] =
      this.models.length === 1
        ? [this.models]
        : [this.models, ...this.models.map((m) => [m])];
    let lastError: unknown;

    for (const route of routes) {
      try {
        return await this.request(request, route);
      } catch (err) {
        lastError = err;
        const label = route.length > 1 ? `route [${route.join(", ")}]` : route[0];
        log.warn(
          `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new LlmRequestError("every configured OpenRouter model failed");
  }

  private async request(
    request: LlmCompletionRequest,
    models: string[],
  ): Promise<LlmCompletion> {
    const primary = models[0] as string;
    const body: Record<string, unknown> = {
      model: primary,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_tokens: request.maxTokens,
      temperature: config.llm.openrouter.temperature,
      // Ask for schema-shaped output. Support varies by model, and OpenRouter
      // passes it through rather than enforcing it, so the caller still
      // validates — this only improves the hit rate.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.jsonSchema,
        },
      },
    };
    // OpenRouter treats a `models` array as an ordered fallback route.
    if (models.length > 1) body.models = models;

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            // Optional attribution headers OpenRouter surfaces in dashboards.
            "HTTP-Referer": config.llm.openrouter.siteUrl,
            "X-Title": config.llm.openrouter.appName,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.llm.openrouter.timeoutMs),
        });

        const raw = await res.text();

        if (!res.ok) {
          // Free-tier models rate-limit readily; back off and retry.
          if (res.status === 429 || res.status >= 500) {
            const waitMs = 2 ** attempt * 1500;
            log.warn(`${primary}: HTTP ${res.status}; retrying in ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          throw new LlmRequestError(
            `OpenRouter returned ${res.status}: ${raw.slice(0, 300)}`,
            res.status,
          );
        }

        const parsed = JSON.parse(raw) as ChatResponse;
        if (parsed.error) {
          throw new LlmRequestError(
            `OpenRouter error: ${parsed.error.message ?? "unknown"}`,
            parsed.error.code,
          );
        }

        const choice = parsed.choices?.[0];
        const content = choice?.message?.content?.trim() ?? "";

        if (choice?.finish_reason === "length") {
          throw new LlmRequestError(
            `response hit the ${request.maxTokens}-token cap before completing its JSON`,
          );
        }
        if (content === "") {
          // Reasoning models sometimes spend the whole budget on reasoning and
          // return empty content; that is a failure worth failing over on.
          const reasoned = choice?.message?.reasoning ? " (reasoning only)" : "";
          throw new LlmRequestError(`model returned empty content${reasoned}`);
        }

        return {
          text: content,
          model: parsed.model ?? primary,
          usage: {
            inputTokens: parsed.usage?.prompt_tokens ?? 0,
            outputTokens: parsed.usage?.completion_tokens ?? 0,
            costUsd: parsed.usage?.cost ?? null,
          },
        };
      } catch (err) {
        lastError = err;
        // A bad request or auth failure will not improve with retrying.
        if (err instanceof LlmRequestError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt === 3) break;
        await sleep(2 ** attempt * 1000);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new LlmRequestError(`${primary}: request failed`);
  }
}
