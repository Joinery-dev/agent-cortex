import { z } from "zod";
import { call } from "./client.js";
import type { Purpose } from "./client.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("llm-structured");

/**
 * Make an LLM call and parse the response as structured JSON validated by a Zod schema.
 * Retries once with an error correction prompt if parsing fails.
 */
export async function callStructured<T>(
  purpose: Purpose,
  model: string,
  system: string,
  userMessage: string,
  schema: z.ZodType<T>,
  maxTokens: number = 4096,
  signal?: AbortSignal
): Promise<T> {
  const systemWithFormat = `${system}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no explanation, no text before or after. Just the JSON object or array.`;

  const result = await call(purpose, model, systemWithFormat, userMessage, maxTokens, signal);

  try {
    const parsed = JSON.parse(result.text);
    return schema.parse(parsed);
  } catch (firstError) {
    log.warn("Structured parse failed, retrying with correction prompt", {
      error: String(firstError),
      responsePreview: result.text.slice(0, 200),
    });

    // Extract JSON if it's wrapped in markdown fences or has surrounding text
    const jsonMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      result.text.match(/(\[[\s\S]*\])/) ||
      result.text.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return schema.parse(parsed);
      } catch {
        // Fall through to retry
      }
    }

    // Retry with error correction
    const correctionMessage = `Your previous response was not valid JSON. The error was: ${String(firstError)}\n\nPlease respond with ONLY the valid JSON. No other text.\n\nOriginal request:\n${userMessage}`;

    const retry = await call(purpose, model, systemWithFormat, correctionMessage, maxTokens, signal);

    try {
      const parsed = JSON.parse(retry.text);
      return schema.parse(parsed);
    } catch (secondError) {
      log.error("Structured parse failed on retry", {
        error: String(secondError),
        responsePreview: retry.text.slice(0, 200),
      });
      throw new Error(
        `Failed to get structured response after retry: ${String(secondError)}`
      );
    }
  }
}
