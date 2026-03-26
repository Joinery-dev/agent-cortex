/**
 * Planner — project-level planning through two phases.
 *
 * Phase A: Manifestation — runs through sensory cortex.
 *   Senses consult on what the finished outcome must look like.
 *   Motor Cortex synthesizes a concrete manifested future.
 *   Senses evaluate whether the vision satisfies the intent.
 *
 * Phase B: Path Reasoning — structured LLM backward decomposition.
 *   Given the manifested future, reason backward to minimum task graph.
 *   Every proposed step passes Jensen's three necessity gates:
 *     1. Does it need to exist?
 *     2. Does it need to be this?
 *     3. Does it need to take this long?
 *
 * The Planner is a kernel component. The project rhythm orchestrates:
 * it creates the manifestation task, runs it through sensory cortex,
 * feeds the result to the Planner for path reasoning, and hands the
 * resulting graph to task-dispatch.
 */

import type { TaskGraphNode } from "./brainstem.js";

// ─── Configuration ──────────────────────────────────────────────

export interface PlannerConfig {
  /** Model for Phase B path reasoning. Defaults to CortexConfig.models.motorCortex. */
  pathReasoningModel?: string;
  /** Maximum tasks the planner can produce in a single graph. Safety valve. */
  maxTasks: number;
  /** Maximum depth of phase groups. v1 = 1 (flat phases, no recursive nesting). */
  maxPhaseDepth: number;
  /** Max tokens for path reasoning LLM call. */
  maxTokens: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  maxTasks: 30,
  maxPhaseDepth: 1,
  maxTokens: 8192,
};

// ─── Phase A: Manifestation ─────────────────────────────────────

/**
 * The concrete future the system is building toward.
 *
 * Extracted from sensory cortex output after Phase A. The manifested
 * future is the anchor for everything downstream:
 *   - Evaluation asks "how close to the manifested future?" not "how good?"
 *   - Speed of light has a concrete ceiling
 *   - Conviction tests against a destination, not a direction
 *   - Drift measures distance from a known target
 */
export interface ManifestedFuture {
  /** The concrete vision — what the completed outcome looks like. */
  vision: string;
  /**
   * Per-sense contributions to the vision, extracted from consultation.
   * Each sense describes what the finished artifact must satisfy from
   * its perspective. Keyed by sense name.
   */
  senseContributions: Record<string, string>;
  /** Confidence from the sensory cortex evaluation (0–1). */
  confidence: number;
  /** How many build cycles the manifestation task took. */
  cycles: number;
}

// ─── Phase B: Path Reasoning ────────────────────────────────────

/**
 * A proposed task from the LLM's backward reasoning,
 * before necessity gates are applied.
 */
export interface ProposedTask {
  /** Human-readable task description. */
  description: string;
  /** IDs of tasks this depends on (references other proposed tasks). */
  dependsOn: string[];
  /** Phase group for integration checks at phase gates. */
  phaseGroup: string;
  /** Why this task needs to exist — tested by necessity gate 1. */
  necessity: string;
  /** Why it needs to be THIS (not simpler) — tested by necessity gate 2. */
  formJustification: string;
  /** Why it takes this scope (not less) — tested by necessity gate 3. */
  scopeJustification: string;
  /** Temporary ID for dependency references within the proposed graph. */
  id: string;
}

/**
 * The LLM's raw backward reasoning output before filtering.
 */
export interface PathReasoningRaw {
  /** The reasoning trace — how the LLM worked backward from the future. */
  reasoning: string;
  /** Proposed phase groups and their purpose. */
  phases: ProposedPhase[];
  /** Proposed tasks, organized within phases. */
  tasks: ProposedTask[];
}

export interface ProposedPhase {
  /** Phase group name (matches ProposedTask.phaseGroup). */
  name: string;
  /** What this phase achieves toward the manifested future. */
  purpose: string;
  /** Integration check: what must be true when this phase completes. */
  gateCondition: string;
}

/**
 * A task that failed a necessity gate, with the reason.
 */
export interface RejectedTask {
  task: ProposedTask;
  gate: "existence" | "form" | "scope";
  reason: string;
}

// ─── Combined Result ────────────────────────────────────────────

/**
 * What the Planner produces. Fed into ProjectContext.tasks
 * and stored on the Thalamus for downstream consumers.
 */
export interface PlannerResult {
  /** The manifested future from Phase A. */
  manifestedFuture: ManifestedFuture;
  /** The task graph from Phase B (after necessity gates). */
  graph: TaskGraphNode[];
  /** Tasks that were proposed but failed necessity gates. */
  rejected: RejectedTask[];
  /** The raw reasoning from Phase B (for transparency/debugging). */
  reasoning: string;
  /** Phase definitions for integration checks. */
  phases: ProposedPhase[];
}

// ─── Replan ──────────────────────────────────────────────────────

/**
 * Context for replanning mid-project. Passed to Planner.replan()
 * when the Attention Scheduler triggers a replan due to drift.
 *
 * Contains what's already been done, what failed, and why we're
 * replanning — so the Planner can reason backward from the manifested
 * future to the minimum REMAINING path.
 */
export interface ReplanContext {
  /** Completed tasks — descriptions + real IDs. */
  completedTasks: Array<{ id: string; description: string }>;
  /** Task IDs that escalated (failed or deferred). */
  escalatedTasks: string[];
  /** Why replanning was triggered — from Drift Monitor. */
  driftSummary: string;
  /** Deep drift analysis, if available. */
  driftAnalysis: import("./drift-monitor.js").DeepAnalysis | null;
  /** The original task graph before replanning. */
  originalGraph: TaskGraphNode[];
  /** The manifested future from Phase A. */
  manifestedFuture: string;
  /** IDs of completed tasks — used by buildGraph() to preserve deps. */
  completedIds: Set<string>;
  /** Injected by ProjectDiagnostics when self-heal type is replan-with-directive. */
  diagnosticDirective?: string;
}

/**
 * What Planner.replan() produces. Same shape as PlannerResult but
 * without the manifested future (kept from the original plan or
 * re-manifested separately by the project rhythm).
 */
export interface ReplanResult {
  /** The new task graph (after necessity gates). */
  graph: TaskGraphNode[];
  /** Tasks rejected by necessity gates. */
  rejected: RejectedTask[];
  /** The raw reasoning from the replan LLM call. */
  reasoning: string;
  /** Phase definitions for integration checks. */
  phases: ProposedPhase[];
}
