import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../util/logger.js";
import { emitInfo, emitWarn, emitError } from "../events.js";
import { computeCallCost } from "../types/cost.js";
import type { CostRecord } from "../types/cost.js";

const log = createLogger("llm-client");

export type Purpose =
  | "consultation"
  | "motorCortex"
  | "premotor"
  | "proprioception"
  | "evaluation"
  | "resolution"
  | "inhibition"
  | "collapse-detection"
  | "potentiation"
  | "weltanschauung"
  | "approach-classification"
  | "cognitive-flexibility"
  | "drift-analysis"
  | "planner"
  | "prospective-matching"
  | "explore"
  | "project-diagnostics"
  | "efference-copy"
  | "taste-proposal"
  | "reconsultation"
  | "sense-question"
  | "agenticMotor"
  | "integration-check"
  | "simulation"
  | "principle-verification"
  | "escalation-assessment"
  | "taste-verification";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface CallResult {
  text: string;
  usage: TokenUsage;
  model: string;
  /** Dollar cost of this call, computed from token usage + model pricing. */
  costDollars: number;
}

// ─── Cost callback ──────────────────────────────────────────────
// Registered by the Brainstem's CostTracker. Avoids threading the
// tracker through every call site — the client just invokes the
// callback after each successful call.

let costCallback: ((record: CostRecord) => void) | null = null;
let currentTaskId: string | null = null;

/** Register a callback to receive cost records for every LLM call. */
export function registerCostCallback(cb: (record: CostRecord) => void): void {
  costCallback = cb;
}

/** Set the current task context for cost attribution. */
export function setCostTaskId(taskId: string | null): void {
  currentTaskId = taskId;
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
  potentiation: { inputTokens: 0, outputTokens: 0 },
  weltanschauung: { inputTokens: 0, outputTokens: 0 },
  "approach-classification": { inputTokens: 0, outputTokens: 0 },
  "cognitive-flexibility": { inputTokens: 0, outputTokens: 0 },
  "drift-analysis": { inputTokens: 0, outputTokens: 0 },
  planner: { inputTokens: 0, outputTokens: 0 },
  "prospective-matching": { inputTokens: 0, outputTokens: 0 },
  explore: { inputTokens: 0, outputTokens: 0 },
  "project-diagnostics": { inputTokens: 0, outputTokens: 0 },
  "efference-copy": { inputTokens: 0, outputTokens: 0 },
  "taste-proposal": { inputTokens: 0, outputTokens: 0 },
  reconsultation: { inputTokens: 0, outputTokens: 0 },
  "sense-question": { inputTokens: 0, outputTokens: 0 },
  agenticMotor: { inputTokens: 0, outputTokens: 0 },
  "integration-check": { inputTokens: 0, outputTokens: 0 },
  simulation: { inputTokens: 0, outputTokens: 0 },
  "principle-verification": { inputTokens: 0, outputTokens: 0 },
  "escalation-assessment": { inputTokens: 0, outputTokens: 0 },
  "taste-verification": { inputTokens: 0, outputTokens: 0 },
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
  // Token budgets are managed by the Agent SDK internally — this parameter
  // is retained for call-site compatibility but not passed to the SDK.
  _maxTokens?: number,
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

      // Emit retry-success if this wasn't the first attempt
      if (attempt > 1) {
        emitInfo("llm:retry-success", { purpose, model: sdkModel, attempt });
      }

      // Compute cost and notify tracker
      const costDollars = computeCallCost(sdkModel, usage.inputTokens, usage.outputTokens);
      if (costCallback) {
        costCallback({
          purpose,
          model: sdkModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: costDollars,
          taskId: currentTaskId,
          timestamp: new Date(),
        });
      }

      return { text: resultText, usage, model: sdkModel, costDollars };
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

      // Max retries exhausted
      emitError("llm:max-retries", { purpose, model: sdkModel, retries: maxRetries }, {
        component: "llm-client",
        prompt: userMessage.slice(0, 500),
        retryCount: attempt,
        snapshot: { error: errStr, isRetryable },
      });

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

/**
 * Call with one fallback model attempt. If the primary model exhausts its
 * retries, try once with the fallback model before giving up. The caller
 * provides the fallback model — typically one tier down (opus→sonnet, sonnet→haiku).
 */
export async function callWithFallback(
  purpose: Purpose,
  primaryModel: string,
  system: string,
  userMessage: string,
  maxTokens?: number,
  signal?: AbortSignal,
  fallbackModel?: string,
): Promise<CallResult> {
  try {
    return await call(purpose, primaryModel, system, userMessage, maxTokens, signal);
  } catch (err) {
    if (err instanceof AbortError) throw err;
    if (!fallbackModel || fallbackModel === primaryModel) throw err;

    emitWarn(
      "llm:model-fallback",
      { purpose, from: primaryModel, to: fallbackModel },
      {
        component: "llm-client",
        expected: `response from ${primaryModel}`,
        received: String(err),
      },
    );

    return await call(purpose, fallbackModel, system, userMessage, maxTokens, signal);
  }
}

export function getUsage(): Record<Purpose, TokenUsage> {
  return structuredClone(totalUsage);
}

export function resetUsage(): void {
  for (const purpose of Object.keys(totalUsage) as Purpose[]) {
    totalUsage[purpose] = { inputTokens: 0, outputTokens: 0 };
  }
}

// ── Agentic Call ──────────────────────────────────────────────────
// Multi-turn LLM call with real tools. Used by the Motor Cortex
// when the PNS provides an activated tool set.

import type { ActivatedToolSet } from "../types/pns.js";
import type { ToolUseTrace, AgenticMotorResult } from "../types/motor-cortex.js";

export interface AgenticCallOpts {
  /** Max agentic turns before stopping. Default: 15. */
  maxTurns?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export async function agenticCall(
  purpose: Purpose,
  model: string,
  system: string,
  userMessage: string,
  toolSet: ActivatedToolSet,
  opts?: AgenticCallOpts,
): Promise<AgenticMotorResult> {
  const sdkModel = resolveModel(model);
  const maxTurns = opts?.maxTurns ?? 15;
  const startTime = Date.now();

  log.debug(`${purpose} agentic call via Agent SDK (${sdkModel})`, {
    systemLength: system.length,
    userLength: userMessage.length,
    tools: toolSet.tools,
    maxTurns,
  });

  if (opts?.signal?.aborted) {
    throw new AbortError(`${purpose} agentic call aborted before start`);
  }

  try {
    const conversation = query({
      prompt: userMessage,
      options: {
        model: sdkModel,
        maxTurns,
        tools: toolSet.tools,
        allowedTools: toolSet.allowedTools,
        systemPrompt: system,
        persistSession: false,
      },
    });

    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    const toolTrace: ToolUseTrace[] = [];

    for await (const message of conversation) {
      if (opts?.signal?.aborted) {
        throw new AbortError(`${purpose} agentic call aborted mid-stream`);
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
          turns = (message as Record<string, unknown>).num_turns as number ?? 1;
        } else {
          const errMsg = "errors" in message
            ? (message.errors as string[]).join("; ")
            : "Unknown SDK error";
          throw new Error(`SDK error: ${errMsg}`);
        }
      }

      // Capture tool use summaries for the trace
      if (message.type === "tool_use_summary") {
        const msg = message as Record<string, unknown>;
        toolTrace.push({
          toolName: (msg.tool_name as string) ?? "unknown",
          summary: (msg.summary as string) ?? "",
          timestamp: new Date(),
        });
      }
    }

    const usage: TokenUsage = { inputTokens, outputTokens };
    totalUsage[purpose].inputTokens += usage.inputTokens;
    totalUsage[purpose].outputTokens += usage.outputTokens;

    const durationMs = Date.now() - startTime;

    log.info(`${purpose} agentic call complete`, {
      turns,
      toolCalls: toolTrace.length,
      durationMs,
      tokens: usage,
    });

    // Compute cost and notify tracker
    const costDollars = computeCallCost(sdkModel, usage.inputTokens, usage.outputTokens);
    if (costCallback) {
      costCallback({
        purpose,
        model: sdkModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: costDollars,
        taskId: currentTaskId,
        timestamp: new Date(),
      });
    }

    emitInfo("llm:agentic-complete", {
      purpose,
      model: sdkModel,
      turns,
      toolCalls: toolTrace.length,
      durationMs,
      costDollars,
    });

    return {
      summary: resultText,
      toolTrace,
      turns,
      usage,
      costDollars,
      durationMs,
    };
  } catch (err: unknown) {
    if (err instanceof AbortError || opts?.signal?.aborted) {
      throw err instanceof AbortError ? err : new AbortError(`${purpose} agentic call aborted`);
    }

    emitError("llm:agentic-failed", { purpose, model: sdkModel }, {
      component: "llm-client",
      prompt: userMessage.slice(0, 500),
      snapshot: { error: String(err) },
    });

    log.error(`${purpose} agentic call failed`, { error: String(err) });
    throw err;
  }
}
