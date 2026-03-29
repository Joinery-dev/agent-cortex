import { z } from "zod";
import { callWithFallback } from "./client.js";
import type { Purpose } from "./client.js";
import { createLogger } from "../util/logger.js";
import { emitInfo, emitWarn, emitError } from "../events.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

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
  signal?: AbortSignal,
  fallbackModel?: string,
): Promise<T> {
  const systemWithFormat = `${system}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no explanation, no text before or after. Just the JSON object or array.`;

  const result = await callWithFallback(purpose, model, systemWithFormat, userMessage, maxTokens, signal, fallbackModel);

  try {
    const parsed = JSON.parse(result.text);
    const validated = schema.parse(parsed);

    // Record the parsed structured output for trace
    const jsonText = JSON.stringify(validated, null, 2);
    getContentStore().record({
      eventSeq: null,
      kind: "structured-parse",
      timestamp: new Date().toISOString(),
      component: purpose,
      taskId: null,
      inputs: [],
      outputs: [
        contentBlock(`Parsed ${purpose} result`, jsonText),
      ],
      purpose,
      model,
    });

    return validated;
  } catch (firstError) {
    log.warn("Structured parse failed, retrying with correction prompt", {
      error: String(firstError),
      responsePreview: result.text.slice(0, 200),
    });

    emitWarn("llm:schema-mismatch", { purpose, model }, {
      component: "llm-structured",
      prompt: userMessage.slice(0, 500),
      rawResponse: result.text.slice(0, 1000),
      validationError: String(firstError),
      retryCount: 0,
    });

    // Extract JSON if it's wrapped in markdown fences or has surrounding text
    const jsonMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      result.text.match(/(\[[\s\S]*\])/) ||
      result.text.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const validated = schema.parse(parsed);
        emitInfo("llm:retry-success", { purpose, model, attempt: 1, method: "fence-extraction" });

        // Record the parsed structured output for trace
        const jsonText = JSON.stringify(validated, null, 2);
        getContentStore().record({
          eventSeq: null,
          kind: "structured-parse",
          timestamp: new Date().toISOString(),
          component: purpose,
          taskId: null,
          inputs: [],
          outputs: [
            contentBlock(`Parsed ${purpose} result`, jsonText),
          ],
          purpose,
          model,
        });

        return validated;
      } catch {
        // Fall through to retry
      }
    }

    // Retry with error correction
    const correctionMessage = `Your previous response was not valid JSON. The error was: ${String(firstError)}\n\nPlease respond with ONLY the valid JSON. No other text.\n\nOriginal request:\n${userMessage}`;

    const retry = await callWithFallback(purpose, model, systemWithFormat, correctionMessage, maxTokens, signal, fallbackModel);

    try {
      const parsed = JSON.parse(retry.text);
      const validated = schema.parse(parsed);
      emitInfo("llm:retry-success", { purpose, model, attempt: 2, method: "correction-prompt" });

      // Record the parsed structured output for trace
      const jsonText = JSON.stringify(validated, null, 2);
      getContentStore().record({
        eventSeq: null,
        kind: "structured-parse",
        timestamp: new Date().toISOString(),
        component: purpose,
        taskId: null,
        inputs: [],
        outputs: [
          contentBlock(`Parsed ${purpose} result`, jsonText),
        ],
        purpose,
        model,
      });

      return validated;
    } catch (secondError) {
      log.error("Structured parse failed on retry", {
        error: String(secondError),
        responsePreview: retry.text.slice(0, 200),
      });

      emitError("llm:schema-mismatch-fatal", { purpose, model, retries: 2 }, {
        component: "llm-structured",
        prompt: userMessage.slice(0, 500),
        rawResponse: retry.text.slice(0, 1000),
        validationError: String(secondError),
        retryCount: 2,
      });

      throw new Error(
        `Failed to get structured response after retry: ${String(secondError)}`
      );
    }
  }
}
