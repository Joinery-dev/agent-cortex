import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../util/logger.js";

const log = createLogger("llm-client");

export type Purpose =
  | "consultation"
  | "motorCortex"
  | "premotor"
  | "proprioception"
  | "evaluation"
  | "resolution"
  | "inhibition"
  | "collapse-detection";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface CallResult {
  text: string;
  usage: TokenUsage;
  model: string;
}

// Running totals for observability
const totalUsage: Record<Purpose, TokenUsage> = {
  consultation: { inputTokens: 0, outputTokens: 0 },
  motorCortex: { inputTokens: 0, outputTokens: 0 },
  premotor: { inputTokens: 0, outputTokens: 0 },
  proprioception: { inputTokens: 0, outputTokens: 0 },
  evaluation: { inputTokens: 0, outputTokens: 0 },
  resolution: { inputTokens: 0, outputTokens: 0 },
  inhibition: { inputTokens: 0, outputTokens: 0 },
  "collapse-detection": { inputTokens: 0, outputTokens: 0 },
};

// Map our model IDs to Agent SDK model aliases
function resolveModel(model: string): string {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  return "sonnet";
}

export async function call(
  purpose: Purpose,
  model: string,
  system: string,
  userMessage: string,
  _maxTokens: number = 4096,
  signal?: AbortSignal
): Promise<CallResult> {
  const sdkModel = resolveModel(model);

  log.debug(`${purpose} call via Agent SDK (${sdkModel})`, {
    systemLength: system.length,
    userLength: userMessage.length,
  });

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check abort before starting attempt
    if (signal?.aborted) {
      throw new AbortError(`${purpose} call aborted before attempt ${attempt}`);
    }

    try {
      const conversation = query({
        prompt: userMessage,
        options: {
          model: sdkModel,
          maxTurns: 1,
          tools: [],
          systemPrompt: system,
          persistSession: false,
        },
      });

      // Consume the async generator to get all messages
      let resultText = "";
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const message of conversation) {
        // Check abort between messages from the generator
        if (signal?.aborted) {
          throw new AbortError(`${purpose} call aborted mid-stream`);
        }

        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
            inputTokens = message.usage?.input_tokens ?? 0;
            outputTokens = message.usage?.output_tokens ?? 0;
          } else {
            const errMsg = "errors" in message ? (message.errors as string[]).join("; ") : "Unknown SDK error";
            throw new Error(`SDK error: ${errMsg}`);
          }
        }
      }

      const usage: TokenUsage = { inputTokens, outputTokens };
      totalUsage[purpose].inputTokens += usage.inputTokens;
      totalUsage[purpose].outputTokens += usage.outputTokens;

      log.debug(`${purpose} response`, {
        tokens: usage,
        textLength: resultText.length,
      });

      return { text: resultText, usage, model: sdkModel };
    } catch (err: unknown) {
      // Propagate abort errors immediately — don't retry
      if (err instanceof AbortError || signal?.aborted) {
        throw err instanceof AbortError ? err : new AbortError(`${purpose} call aborted`);
      }

      const errStr = String(err);
      const isRetryable =
        errStr.includes("rate") || errStr.includes("500") || errStr.includes("overloaded");

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        log.warn(`${purpose} call failed (attempt ${attempt}), retrying in ${delay}ms`, {
          error: errStr,
        });
        // Race retry delay against abort signal
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new AbortError(`${purpose} call aborted during retry delay`));
          }, { once: true });
        });
        continue;
      }

      log.error(`${purpose} call failed permanently`, { error: errStr });
      throw err;
    }
  }

  throw new Error("Unreachable");
}

/** Distinguishes abort from other errors so callers can handle gracefully. */
export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(err: unknown): err is AbortError {
  return err instanceof AbortError;
}

export function getUsage(): Record<Purpose, TokenUsage> {
  return structuredClone(totalUsage);
}

export function resetUsage(): void {
  for (const purpose of Object.keys(totalUsage) as Purpose[]) {
    totalUsage[purpose] = { inputTokens: 0, outputTokens: 0 };
  }
}
