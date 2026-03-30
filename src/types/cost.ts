/**
 * Cost Budget — the metabolic constraint.
 *
 * Like the brain's metabolic budget forcing efficient neural representations,
 * a dollar budget forces Cortex to prioritize cognitive spending. A
 * "box house" project (tight budget, constrained scope) breathes shallowly.
 * A "custom home" project (generous budget, open scope) breathes deeply.
 * Same architecture, different depth, determined by the economics of the work.
 *
 * The budget flows through every component:
 *   Planner       → cost estimation, scope/budget negotiation
 *   Scheduler     → per-task budget allocation
 *   NE            → budget pressure as risk factor
 *   Thalamus      → breathing depth (briefing richness)
 *   ModelSelector → dynamic model downgrading
 *   Gate          → economic stopping criterion
 *   Cerebellum    → cost prediction from episode history
 *   Homeostasis   → budgetUtilization vital sign
 */

import type { Purpose } from "../llm/client.js";

// ─── Model Pricing ──────────────────────────────────────────────

/**
 * Pricing per model tier. The `modelPattern` matches the normalized
 * model alias from resolveModel() in client.ts ("haiku"/"sonnet"/"opus").
 */
export interface ModelPricing {
  modelPattern: string;
  /** Dollars per 1 million input tokens. */
  inputPer1M: number;
  /** Dollars per 1 million output tokens. */
  outputPer1M: number;
}

/**
 * Current Anthropic pricing (March 2026).
 * Updated manually when pricing changes — this is a data constant,
 * not a service call.
 */
export const MODEL_PRICING: ModelPricing[] = [
  { modelPattern: "haiku",  inputPer1M: 1.00,  outputPer1M: 5.00 },
  { modelPattern: "sonnet", inputPer1M: 3.00,  outputPer1M: 15.00 },
  { modelPattern: "opus",   inputPer1M: 5.00,  outputPer1M: 25.00 },
];

/**
 * Compute the dollar cost of a single LLM call.
 * Model should be the resolved alias ("haiku"/"sonnet"/"opus").
 *
 * When cache metrics are provided, cost is computed accurately:
 *   - Cache read tokens: 10% of input price (90% discount)
 *   - Cache creation tokens: 125% of input price (25% surcharge)
 *   - Remaining tokens: standard input price
 */
export function computeCallCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
): number {
  const pricing = MODEL_PRICING.find((p) => model.includes(p.modelPattern));
  if (!pricing) return 0;

  const cacheRead = cacheReadTokens ?? 0;
  const cacheCreate = cacheCreationTokens ?? 0;
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreate);

  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPer1M;
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.inputPer1M * 0.1;
  const cacheCreateCost = (cacheCreate / 1_000_000) * pricing.inputPer1M * 1.25;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return inputCost + cacheReadCost + cacheCreateCost + outputCost;
}

/**
 * Estimate the cost of a call before making it.
 * Uses approximate token counts — good enough for budget decisions.
 */
export function estimateCallCost(
  model: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number {
  return computeCallCost(model, estimatedInputTokens, estimatedOutputTokens);
}

// ─── Cost Budget ────────────────────────────────────────────────

/**
 * The project's dollar budget. Provided by the Parsifal at project start.
 * Optional on ProjectIntent — unconstrained when absent.
 */
export interface CostBudget {
  /** Total dollar budget for the project. */
  total: number;
  /**
   * How strict the budget is:
   *   hard → stop at exhaustion, deliver what's done
   *   soft → warn + slow down (model downgrade, briefing compression)
   */
  enforcement: "hard" | "soft";
  /**
   * Fraction of budget reserved for replanning, phase gates, rest cycles.
   * Not allocated to individual tasks. Default 0.15.
   */
  reserveFraction: number;
  /** Currency code. Always USD for now. */
  currency: "USD";
}

export const DEFAULT_COST_BUDGET: CostBudget = {
  total: 10.0,
  enforcement: "soft",
  reserveFraction: 0.15,
  currency: "USD",
};

// ─── Cost Records ───────────────────────────────────────────────

/** A single LLM call's cost record. Written by the CostTracker. */
export interface CostRecord {
  purpose: Purpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from Anthropic's prompt cache (90% discount). */
  cacheReadInputTokens?: number;
  /** Input tokens used to create a new cache entry (25% surcharge). */
  cacheCreationInputTokens?: number;
  /** Computed dollar cost. */
  cost: number;
  /** Which task this call was made for (null during planning). */
  taskId: string | null;
  timestamp: Date;
}

/** Cost summary for a single task. */
export interface TaskCostSummary {
  taskId: string;
  allocated: number;
  spent: number;
  remaining: number;
  callCount: number;
  byPurpose: Partial<Record<Purpose, number>>;
}

/** Cost summary for the entire project. */
export interface ProjectCostSummary {
  budget: CostBudget;
  spent: number;
  remaining: number;
  /** spent / budget.total, 0–1. */
  utilization: number;
  /** Budget held back for replanning/gates. */
  reserveRemaining: number;
  /** Cost of the planning phase (already spent). */
  planningCost: number;
  taskSummaries: Map<string, TaskCostSummary>;
  totalCalls: number;
}

/** Cost estimate for a project, produced after planning. */
export interface ProjectCostEstimate {
  totalEstimate: number;
  perTaskEstimates: Map<string, number>;
  /** Description of estimation assumptions. */
  assumptions: string;
  /** Planning phase cost (already spent). */
  planningCostActual: number;
  /** Confidence in the estimate 0–1. */
  confidence: number;
}

// ─── Briefing Depth ─────────────────────────────────────────────

/**
 * How rich the Thalamus's assembled briefings are.
 *
 *   full       — all enrichment: patterns, principles, decisions, trends,
 *                maxims, capabilities, predictions, forward briefing, efference
 *   standard   — core enrichment: top-N patterns, recent decisions,
 *                relevant principles, prediction summary
 *   compressed — essentials: task + intent + top-2 patterns + active maxims
 *   minimal    — task + intent only, no enrichment
 *
 * Depth is NOT determined by hardcoded thresholds. It is learned:
 *
 *   1. The Cerebellum predicts the context fidelity ceiling at each depth
 *      level — "at this briefing size, quality starts to degrade."
 *   2. The Thalamus picks the shallowest depth whose predicted quality
 *      meets the NE-modulated quality threshold.
 *   3. Budget pressure biases toward shallower depths (cheaper calls).
 *
 * On cold start (no Cerebellum data), the Thalamus defaults to "standard."
 * As episodes accumulate with depth metadata, the Cerebellum discovers
 * Cortex's actual optimal briefing size empirically. The training
 * wheels come off as predictions improve.
 */
export type BriefingDepth = "full" | "standard" | "compressed" | "minimal";

/**
 * Cold-start default: "standard" depth. Used when the Cerebellum has
 * no context fidelity data yet. Deliberately conservative — include
 * enough context to produce good results, let Cortex learn to
 * compress over time.
 */
export const COLD_START_DEPTH: BriefingDepth = "standard";
