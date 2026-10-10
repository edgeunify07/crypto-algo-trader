import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import {
  LlmRequestError,
  LlmUnavailableError,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmProvider,
} from "../llmProvider.js";

/**
 * Anthropic provider, kept as an alternative to OpenRouter.
 *
 * Claude honours `output_config.format` reliably, so the response needs no
 * extraction — but it still goes through the same validation path as every
 * other provider, so switching providers changes nothing downstream.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly models: string[];

  constructor(
    model: string = config.llm.anthropic.model,
    private readonly apiKey: string = config.llm.anthropic.apiKey,
  ) {
    this.models = [model];
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new LlmUnavailableError(
        "ANTHROPIC_API_KEY is not set — set LLM_PROVIDER=openrouter, or run with --no-llm.",
      );
    }
    const client = new Anthropic({ apiKey: this.apiKey });
    const model = this.models[0] as string;

    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      output_config: {
        effort: config.llm.anthropic.effort as
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max",
        format: {
          type: "json_schema",
          schema: request.jsonSchema,
        },
      },
      messages: [{ role: "user", content: request.user }],
    });

    if (response.stop_reason === "refusal") {
      throw new LlmRequestError(
        `model declined the request: ${response.stop_details?.explanation ?? "no explanation given"}`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (text === "") throw new LlmRequestError("model returned no text content");

    return {
      text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        costUsd: null,
      },
    };
  }
}
