import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../util/logger.js";
import { emitInfo, emitWarn, emitError } from "../events.js";
import { computeCallCost } from "../types/cost.js";
import type { CostRecord } from "../types/cost.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";
import { getStepBarrier } from "../trace/step-barrier.js";
import { checkReplayInterceptor } from "./replay-interceptor.js";
import { Semaphore } from "../util/semaphore.js";

const log = createLogger("llm-client");

// ─── Global concurrency gate ─────────────────────────────────────
// Limits concurrent LLM API calls across the entire system.
// Prevents rate-limit thundering herds regardless of which component
// (evaluator, consul, motor cortex, etc.) is making the calls.

const DEFAULT_LLM_CONCURRENCY = 8;
let llmSemaphore = new Semaphore(DEFAULT_LLM_CONCURRENCY);

/** Set the max concurrent LLM API calls. Replaces the active semaphore. */
export function setLlmConcurrency(max: number): void {
  llmSemaphore = new Semaphore(max);
  log.info(`LLM concurrency set to ${max}`);
}

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
  | "taste-verification"
  | "nursery-consultation"
  | "nursery-observation"
  | "graph-builder"
  | "inquiry";

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

// ─── Model selector callback ───────────────────────────────────
// Registered by the Brainstem at task dispatch. Picks the cheapest
// model tier whose predicted quality meets the NE-modulated threshold.
// When null, call() uses the model passed by the caller (cold start).

type ModelSelectorFn = (purpose: Purpose, configuredModel: string) => { model: string; source: string };
let activeModelSelector: ModelSelectorFn | null = null;

/** Set (or clear) the active model selector for subsequent LLM calls. */
export function setModelSelector(fn: ModelSelectorFn | null): void {
  activeModelSelector = fn;
}

// ─── Models-used tracking (per task) ────────────────────────────
// Records which model tier was actually used for each purpose during
// a task. Read by the Brainstem at task completion to populate
// episode.modelsByPurpose for Cerebellum learning.

const taskModelsUsed = new Map<string, Partial<Record<Purpose, string>>>();

/** Get the models used for each purpose during a task. */
export function getModelsUsed(taskId: string): Partial<Record<Purpose, string>> {
  return taskModelsUsed.get(taskId) ?? {};
}

/** Clean up models-used tracking for a completed task. */
export function clearModelsUsed(taskId: string): void {
  taskModelsUsed.delete(taskId);
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
  "nursery-consultation": { inputTokens: 0, outputTokens: 0 },
  "nursery-observation": { inputTokens: 0, outputTokens: 0 },
  "graph-builder": { inputTokens: 0, outputTokens: 0 },
  inquiry: { inputTokens: 0, outputTokens: 0 },
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
  return llmSemaphore.run(async () => {
  // Step barrier — blocks if step-by-step mode is active
  await getStepBarrier().checkpoint(`llm:${purpose}`);

  // Replay interceptor — return cached response if available
  const cached = checkReplayInterceptor(purpose, system, userMessage);
  if (cached) {
    const usage: TokenUsage = { inputTokens: cached.tokens.input, outputTokens: cached.tokens.output };
    totalUsage[purpose].inputTokens += usage.inputTokens;
    totalUsage[purpose].outputTokens += usage.outputTokens;
    // Record to content store even during replay (for trace continuity)
    getContentStore().record({
      eventSeq: null,
      kind: "llm-call",
      timestamp: new Date().toISOString(),
      component: purpose,
      taskId: currentTaskId,
      inputs: [contentBlock("System prompt", system), contentBlock("User message", userMessage)],
      outputs: [contentBlock("LLM response", cached.text)],
      purpose,
      model: cached.model,
      tokens: { input: usage.inputTokens, output: usage.outputTokens },
      costDollars: 0, // replay is free
    });
    return { text: cached.text, usage, model: cached.model, costDollars: 0 };
  }

  // Model selection — transparent to callers
  const effectiveModel = activeModelSelector
    ? activeModelSelector(purpose, model).model
    : model;
  const sdkModel = resolveModel(effectiveModel);

  // Track which model was used for this purpose (for episode learning)
  if (currentTaskId) {
    const used = taskModelsUsed.get(currentTaskId) ?? {};
    used[purpose] = sdkModel;
    taskModelsUsed.set(currentTaskId, used);
  }

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

      // Record full prompt/response content for trace
      getContentStore().record({
        eventSeq: null,
        kind: "llm-call",
        timestamp: new Date().toISOString(),
        component: purpose,
        taskId: currentTaskId,
        inputs: [
          contentBlock("System prompt", system),
          contentBlock("User message", userMessage),
        ],
        outputs: [
          contentBlock("LLM response", resultText),
        ],
        purpose,
        model: sdkModel,
        tokens: { input: usage.inputTokens, output: usage.outputTokens },
        costDollars,
      });

      return { text: resultText, usage, model: sdkModel, costDollars };
    } catch (err: unknown) {
      // Propagate abort errors immediately — don't retry
      if (err instanceof AbortError || signal?.aborted) {
        throw err instanceof AbortError ? err : new AbortError(`${purpose} call aborted`);
      }

      const errStr = String(err);
      const isRetryable =
        errStr.includes("rate") || errStr.includes("500") || errStr.includes("overloaded") || errStr.includes("SDK error");

      if (isRetryable && attempt < maxRetries) {
        // Jittered exponential backoff to avoid synchronized retry herds
        const baseDelay = Math.pow(2, attempt) * 1000;
        const jitter = Math.random() * 1000;
        const delay = baseDelay + jitter;
        log.warn(`${purpose} call failed (attempt ${attempt}), retrying in ${Math.round(delay)}ms`, {
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
  }); // llmSemaphore.run
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
  return llmSemaphore.run(async () => {
  // Step barrier — blocks if step-by-step mode is active
  await getStepBarrier().checkpoint(`llm:${purpose} (agentic)`);

  // Replay interceptor — return cached response if available
  const cached = checkReplayInterceptor(purpose, system, userMessage);
  if (cached) {
    const usage: TokenUsage = { inputTokens: cached.tokens.input, outputTokens: cached.tokens.output };
    totalUsage[purpose].inputTokens += usage.inputTokens;
    totalUsage[purpose].outputTokens += usage.outputTokens;
    getContentStore().record({
      eventSeq: null,
      kind: "llm-call",
      timestamp: new Date().toISOString(),
      component: purpose,
      taskId: currentTaskId,
      inputs: [contentBlock("System prompt", system), contentBlock("User message", userMessage)],
      outputs: [
        contentBlock("LLM response", cached.text),
        ...(cached.toolTraceText ? [contentBlock("Tool trace", cached.toolTraceText)] : []),
      ],
      purpose,
      model: cached.model,
      tokens: { input: usage.inputTokens, output: usage.outputTokens },
      costDollars: 0,
    });
    return {
      summary: cached.text,
      toolTrace: [], // tools don't re-execute during replay
      turns: 1,
      usage,
      costDollars: 0,
      durationMs: 0,
    };
  }

  // Model selection — transparent to callers
  const effectiveModel = activeModelSelector
    ? activeModelSelector(purpose, model).model
    : model;
  const sdkModel = resolveModel(effectiveModel);

  // Track which model was used for this purpose (for episode learning)
  if (currentTaskId) {
    const used = taskModelsUsed.get(currentTaskId) ?? {};
    used[purpose] = sdkModel;
    taskModelsUsed.set(currentTaskId, used);
  }

  const maxTurns = opts?.maxTurns ?? 15;
  const startTime = Date.now();

  log.debug(`${purpose} agentic call via Agent SDK (${sdkModel})`, {
    systemLength: system.length,
    userLength: userMessage.length,
    tools: toolSet.tools,
    maxTurns,
  });

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (opts?.signal?.aborted) {
      throw new AbortError(`${purpose} agentic call aborted before attempt ${attempt}`);
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

      // Emit retry-success if this wasn't the first attempt
      if (attempt > 1) {
        emitInfo("llm:retry-success", { purpose, model: sdkModel, attempt });
      }

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

      // Record full agentic call content for trace
      const toolTraceText = toolTrace
        .map((t) => `[${t.toolName}] ${t.summary}`)
        .join("\n");
      getContentStore().record({
        eventSeq: null,
        kind: "llm-call",
        timestamp: new Date().toISOString(),
        component: purpose,
        taskId: currentTaskId,
        inputs: [
          contentBlock("System prompt", system),
          contentBlock("User message", userMessage),
        ],
        outputs: [
          contentBlock("LLM response", resultText),
          ...(toolTraceText ? [contentBlock("Tool trace", toolTraceText)] : []),
        ],
        purpose,
        model: sdkModel,
        tokens: { input: usage.inputTokens, output: usage.outputTokens },
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
      // Propagate abort errors immediately — don't retry
      if (err instanceof AbortError || opts?.signal?.aborted) {
        throw err instanceof AbortError ? err : new AbortError(`${purpose} agentic call aborted`);
      }

      const errStr = String(err);
      const isRetryable =
        errStr.includes("rate") || errStr.includes("500") || errStr.includes("overloaded") || errStr.includes("SDK error");

      if (isRetryable && attempt < maxRetries) {
        // Jittered exponential backoff to avoid synchronized retry herds
        const baseDelay = Math.pow(2, attempt) * 1000;
        const jitter = Math.random() * 1000;
        const delay = baseDelay + jitter;
        log.warn(`${purpose} agentic call failed (attempt ${attempt}), retrying in ${Math.round(delay)}ms`, {
          error: errStr,
        });
        // Race retry delay against abort signal
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new AbortError(`${purpose} agentic call aborted during retry delay`));
          }, { once: true });
        });
        continue;
      }

      // Max retries exhausted
      emitError("llm:agentic-failed", { purpose, model: sdkModel, retries: maxRetries }, {
        component: "llm-client",
        prompt: userMessage.slice(0, 500),
        retryCount: attempt,
        snapshot: { error: errStr, isRetryable },
      });

      log.error(`${purpose} agentic call failed permanently`, { error: errStr });
      throw err;
    }
  }

  // Unreachable — loop always returns or throws — but TypeScript needs it
  throw new Error(`${purpose} agentic call: retry loop exited unexpectedly`);
  }); // llmSemaphore.run
}
