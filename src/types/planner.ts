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

  // ── Hierarchical planning (Phase B evolution) ──────────────────
  /** Model for Graph Builder (B.2) LLM calls. Defaults to pathReasoningModel or motorCortex. */
  graphBuilderModel?: string;
  /** Minimum shana count to trigger B.2 pipeline during per-shael JIT planning. Default 5. */
  jitWiringThreshold?: number;
  /** NE level above which B.2 always runs regardless of shana count. Default 0.5. */
  jitWiringNEThreshold?: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  maxTasks: 30,
  maxPhaseDepth: 1,
  maxTokens: 8192,
  jitWiringThreshold: 5,
  jitWiringNEThreshold: 0.5,
};

// ─── Phase A: Manifestation ─────────────────────────────────────

/**
 * The concrete future Cortex is building toward.
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

// ─── Hierarchical Planning — Graph Builder (Phase B.2) ───────────

/**
 * A capability that a shael/shana provides or consumes.
 * Token consistency is critical — if one node provides "auth-boundary",
 * consumers must use "auth-boundary", not "authentication" or "access-control".
 */
export interface CapabilityToken {
  /** Short, consistent token (e.g. "clinical-data-model", "auth-boundary"). */
  capability: string;
  /** What this capability means in context. */
  description: string;
}

/**
 * Semantic map entry for a single node in the shael tree.
 * Produced by Graph Builder Step 1 (LLM semantic mapping).
 */
export interface SemanticMapEntry {
  /** Matches shael/shana id from B.1 decomposition. */
  id: string;
  /** Capabilities this node produces when completed. */
  provides: CapabilityToken[];
  /** Capabilities this node requires before it can be lived. */
  consumes: CapabilityToken[];
}

/**
 * A co-design cluster — nodes that share a boundary and create mutual
 * constraints even without hard dependencies. Produced by Graph Builder
 * Step 3 (LLM affinity analysis).
 *
 * Affinity groups must come from the LLM, not from algorithmic token overlap.
 * Algorithmic affinity produces groups so broad they're meaningless.
 * Real affinity requires understanding what specifically breaks.
 */
export interface AffinityGroup {
  /** Human-readable group name. */
  name: string;
  /** Node IDs in this group. */
  nodeIds: string[];
  /** What boundary they share. */
  sharedBoundary: string;
  /** Concrete co-design risk: what breaks if built without mutual awareness. */
  coDesignRisk: string;
}

/**
 * A dependency correction proposed by Graph Builder Step 3.
 * The algorithm (Step 2) is correct given the tokens — corrections mean
 * the tokens were misleading or the relationship isn't expressible
 * in provides/consumes (e.g. parent→child composition).
 */
export interface DepCorrection {
  /** Whether to add or remove an edge. */
  action: "add" | "remove";
  /** Node that depends (the consumer). */
  from: string;
  /** Node depended on (the provider). */
  to: string;
  /** Why this correction is needed. */
  reason: string;
}

/**
 * Complete output of the Graph Builder (Phase B.2).
 * Combines semantic mapping, algorithmic derivation, LLM correction,
 * and topological sorting into a single result with full provenance.
 */
export interface DependencyWiringResult {
  /** From Step 1: capability tokens per node. */
  semanticMap: SemanticMapEntry[];

  /** From Step 2 + Step 3 corrections: dependency edges with provenance. */
  dependencies: Array<{
    /** Node that depends (the consumer). */
    from: string;
    /** Node depended on (the provider). */
    to: string;
    /** How this edge was derived — algorithmic (Step 2) or correction (Step 3). */
    source: "algorithmic" | "correction";
    /** Present for corrections — why the LLM changed or added this edge. */
    reason?: string;
  }>;

  /** From Step 3: co-design clusters with concrete risks. */
  affinityGroups: AffinityGroup[];
  /** From Step 3: what the LLM changed and why (transparency). */
  corrections: DepCorrection[];

  /** Post-Step 3: valid execution order after corrections applied. */
  topologicalOrder: string[];
}

// ─── Hierarchical Planning — Shael Tree ──────────────────────────

/**
 * A node in the hierarchical plan tree.
 *
 * Shaels are questions to be lived. At the project level, the planner
 * produces shaels (high-level questions). Each shael is planned
 * just-in-time into shana (leaf tasks) when it's about to execute.
 *
 * The same fields as ProposedTask (necessity gates apply identically)
 * but with hierarchy: level, parentId, gateCondition.
 */
export interface DecompositionNode {
  /** Temporary ID for references within the plan. */
  id: string;
  /** What this node represents — question, milestone, commitment, etc. */
  description: string;
  /** Whether this is a high-level or leaf-level node. Value comes from the worldview vocabulary (e.g. "shael"/"shana", "block"/"cut", "set"/"riff"). */
  level: string;
  /** Phase group for integration checks. */
  phaseGroup: string;
  /** Parent node ID, or null for root-level nodes. */
  parentId: string | null;
  /** What must be true when this node completes. */
  gateCondition: string;
  /** Why this node needs to exist — necessity gate 1. */
  necessity: string;
  /** Why this specific form, not simpler — necessity gate 2. */
  formJustification: string;
  /** Why this scope, not smaller — necessity gate 3. */
  scopeJustification: string;
}

/** @deprecated Use DecompositionNode. */
export type ShaelNode = DecompositionNode;

/**
 * Result of assessing whether the hierarchy depth is appropriate.
 *
 * Evaluates coherence pressure: if a shael produced too many shana,
 * it should have been decomposed into sub-shaels first. Necessity
 * gates apply to the hierarchy structure itself.
 */
export interface HierarchyAssessment {
  /** Overall assessment: is the current depth appropriate? */
  appropriate: boolean;
  /** Shaels whose shana count exceeds coherence thresholds. */
  overloadedShaels: Array<{
    shaelId: string;
    shanaCount: number;
    /** Recommended sub-shael count if decomposition is warranted. */
    recommendedSubShaels: number;
    reason: string;
  }>;
  /** Current max depth in the tree. */
  currentDepth: number;
  /** Maximum depth allowed by config. */
  maxAllowedDepth: number;
  /** Cerebellum speed-of-light coherence estimate, if available. */
  coherenceCeiling?: number;
}

/**
 * A phase (shael) ready for just-in-time planning.
 *
 * Represents a shael that's about to execute — it needs its own
 * planning cycle (A' → B.1' → B.2' → B.3') to produce shana.
 * Carries context from prior completed shaels.
 */
export interface PlannedPhase {
  /** The shael node being planned. */
  shael: ShaelNode;
  /** Context from previously completed shaels (descriptions + outcomes). */
  priorContext: Array<{ shaelId: string; description: string; outcome: string }>;
  /** The project-level manifested future this phase serves. */
  manifestedFuture: ManifestedFuture;
  /** Phase-level gate condition — what must be true when this phase completes. */
  gateCondition: string;
  /** Affinity group IDs this shael belongs to (from project-level wiring). */
  affinityGroupIds: string[];
}

/**
 * Output of just-in-time per-shael planning.
 *
 * Analogous to HierarchicalPlanResult but scoped to a single shael.
 * Contains the shana decomposition and wiring for one phase.
 */
export interface PhasePlanResult {
  /** The shael that was planned. */
  shaelId: string;
  /** Leaf tasks produced by B.1' decomposition. */
  shana: ShaelNode[];
  /** Dependency wiring from B.2' (if triggered — ≥5 shana or NE ≥ 0.5). */
  wiring: DependencyWiringResult | null;
  /** Nodes rejected by necessity gates. */
  rejected: RejectedTask[];
  /** The backward reasoning from B.1'. */
  reasoning: string;
}

/**
 * What the hierarchical planner produces.
 * Analog of PlannerResult for the new planning pipeline.
 */
export interface HierarchicalPlanResult {
  /** The manifested future from Phase A. */
  manifestedFuture: ManifestedFuture;
  /** The shael tree from Phase B.1 (after necessity gates). */
  shaels: ShaelNode[];
  /** Dependency wiring from Phase B.2 (semantic map + deps + affinity). */
  wiring: DependencyWiringResult;
  /** Nodes that were proposed but failed necessity gates. */
  rejected: RejectedTask[];
  /** The raw backward reasoning from B.1 (for transparency). */
  reasoning: string;
  /** Phase definitions for integration checks. */
  phases: ProposedPhase[];
}

// ─── PFC Review (Phase B.3) ──────────────────────────────────────

/**
 * A structural warning from PFC Review.
 *
 * Four kinds matching the design doc's four tests:
 *   gap         — manifested future requires something no shael provides
 *   redundancy  — two shaels are semantically the same question
 *   affinity    — co-design risk doesn't hold up under scrutiny
 *   correction  — dependency correction from B.2 Step 3 wasn't justified
 */
export interface PlanWarning {
  kind: "gap" | "redundancy" | "affinity" | "correction";
  severity: "info" | "warning" | "critical";
  description: string;
  /** Node IDs affected by this warning. */
  affectedNodeIds: string[];
}

/**
 * A dependency patch suggested by PFC Review.
 * Applied to the wiring before dispatch.
 */
export interface DependencyPatch {
  action: "add" | "remove";
  from: string;
  to: string;
  reason: string;
}

/**
 * Output of PFC Review (Phase B.3).
 *
 * Contains the validated (possibly patched) plan. The project rhythm
 * uses reviewed shaels + wiring for dispatch instead of the raw B.2 output.
 */
export interface PfcReviewResult {
  /** Structural warnings found during review. */
  warnings: PlanWarning[];
  /** Dependency patches applied. */
  patches: DependencyPatch[];
  /** Shaels after review (unchanged unless redundancy was detected). */
  shaels: ShaelNode[];
  /** Wiring after patches applied + re-sorted. */
  wiring: DependencyWiringResult;
  /** Whether the LLM review ran (true) vs. mechanical-only (false). */
  thoroughReview: boolean;
}

// ─── Generative Completion ───────────────────────────────────────

/**
 * A question that couldn't have been asked before the shalem existed.
 *
 * After completion, Cortex's understanding has changed enough to
 * see questions it couldn't see before. These surface to the
 * question-asker as proposals — Cortex signals, it doesn't chase
 * its own curiosity without permission.
 */
export interface GenerativeQuestion {
  /** The question itself — framed as a shaela (a question to be lived). */
  question: string;
  /** Extension = go deeper in the same direction. Revision = the shalem itself should change. */
  kind: "extension" | "revision";
  /** Why this question couldn't have been asked before the shalem existed. */
  emergenceReason: string;
  /** Enough context for the question-asker to decide whether to pursue it. */
  context: string;
}

/**
 * What generative completion produces. Attached to ProjectResult
 * so the question-asker can decide what to pursue next.
 */
export interface GenerativeCompletionResult {
  /** Questions that emerged from the shalem. */
  questions: GenerativeQuestion[];
  /** The reasoning trace — how Cortex arrived at these questions. */
  reasoning: string;
}
