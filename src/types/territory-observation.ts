/**
 * Territory Observation — an objective fact discovered during execution.
 *
 * 12 sources across the entire system emit observations during the rhythm:
 *
 *   During task:     cerebellum, builder, evaluator, proprioception, efference-copy
 *   Between tasks:   dopamine, hippocampus, basal-ganglia, world-model,
 *                    drift-monitor (quick check), working-memory
 *   At phase gates:  integration-check, drift-monitor (deep analysis),
 *                    cognitive-flexibility
 *
 * Stored in WM's observations section. NOT counted toward WM load or
 * homeostasis pressure — observations have their own pressure metric.
 *
 * NE modulates the relevance threshold for task-relative observations:
 *   high NE (≥0.7): threshold 0.2 (notice more)
 *   low NE (≤0.3): threshold 0.6 (only notice important)
 *
 * System health observations bypass NE entirely — Cortex must notice
 * its own malfunction regardless of arousal level.
 */

// ─── Core Types ─────────────────────────────────────────────────

/**
 * All components that can emit territory observations.
 *
 * Named for the architectural component, not the brain region,
 * matching the existing convention (e.g. "builder" not "primary-motor").
 */
export type ObservationComponent =
  // ── Existing (Phase 3) ──
  | "builder"               // Primary Motor during build
  | "evaluator"             // Sensory Cortex during evaluation
  | "proprioception"        // Motor Cortex self-assessment after build
  | "integration-check"     // Integration Checker at phase gates
  // ── Prediction ──
  | "cerebellum"            // Prediction errors, accuracy, approach bottlenecks
  // ── Reward ──
  | "dopamine"              // Phasic prediction errors, tonic trend reversals
  // ── Learning ──
  | "hippocampus"           // Episode contradictions, potentiation triggers
  | "basal-ganglia"         // Collapse dominance, routine override friction
  // ── Governance ──
  | "drift-monitor"         // Drift threshold crossings, intent alignment, convention health
  | "cognitive-flexibility" // Perseveration diagnosis (only fires when triggered)
  // ── Infrastructure ──
  | "thalamus"              // Capability gaps, context routing failures
  | "world-model"           // Maxim supersedure, confidence shifts
  | "working-memory"        // Oscillation, stale open questions
  | "efference-copy";       // Achievable ceiling surprises, plan feasibility

export interface TerritoryObservation {
  id: string;
  /** The objective fact. Descriptive, not prescriptive. */
  fact: string;
  /** Where this observation came from. */
  source: ObservationSource;
  /** How relevant this observation is to the project (0-1). Emitter's estimate. */
  relevance: number;
  /** When this was observed. */
  observedAt: Date;
  /** Processing status. */
  status: ObservationStatus;
  /** ID of the triage/synthesis that consumed this observation. */
  consumedBy?: string;
  /**
   * System health signal — bypassed NE threshold on entry, routes directly
   * to deep synthesis in quick triage (never keyword-matched to tasks).
   *
   * Examples: prediction accuracy degraded, tonic trend reversed,
   * collapse dominance detected, cognitive flexibility diagnosis.
   */
  systemHealth?: boolean;
}

export type ObservationStatus = "new" | "triaged" | "synthesized" | "dismissed";

export interface ObservationSource {
  /** Which task was being executed when this was observed. */
  taskId: string;
  /** Which component produced the observation. */
  component: ObservationComponent;
  /** For evaluator observations: which sense produced it. */
  senseId?: string;
}

// ─── Observation Proposals ──────────────────────────────────────

/**
 * Lightweight observation emitted by a component.
 *
 * Components return ObservationProposal[] alongside their existing results.
 * The orchestrator (task-dispatch) wraps each proposal with source metadata
 * (taskId, component), stamps id/observedAt/status, applies NE filtering,
 * and stores in WM. Components never touch WM directly.
 */
export interface ObservationProposal {
  /** The objective fact. Descriptive, not prescriptive. */
  fact: string;
  /** How relevant to the project (0-1). Emitter's estimate. */
  relevance: number;
  /**
   * System health signal — bypass NE relevance threshold.
   * Set true for observations about system malfunction, not task content:
   * prediction accuracy failure, tonic reversal, collapse dominance,
   * intent alignment category change, oscillation instability, diagnosis.
   */
  systemHealth?: boolean;
}

// ─── Pure Functions ─────────────────────────────────────────────

/**
 * Relevance threshold as a function of NE level.
 * Linear interpolation: NE 0 → 0.6, NE 1 → 0.2.
 * Task-relative observations below the threshold are filtered before storage.
 * System health observations bypass this entirely.
 */
export function relevanceThreshold(neLevel: number): number {
  const clamped = Math.min(1, Math.max(0, neLevel));
  return 0.6 - 0.4 * clamped;
}

/**
 * Relevance threshold for triggering hippocampal simulation.
 * Higher bar than storage (simulation is expensive), but still NE-modulated:
 *   NE 0 → 0.85 (routine: only simulate the most important)
 *   NE 1 → 0.55 (novel: simulate more to learn)
 * Always above relevanceThreshold() at the same NE level.
 */
export function simulationRelevanceThreshold(neLevel: number): number {
  const clamped = Math.min(1, Math.max(0, neLevel));
  return 0.85 - 0.3 * clamped;
}

/**
 * Whether a proposed observation should be stored in WM.
 *
 * System health proposals always pass — Cortex must notice its own
 * malfunction regardless of arousal level. Task-relative proposals are
 * gated by the NE-modulated relevance threshold.
 */
export function shouldStoreObservation(
  proposal: ObservationProposal,
  neLevel: number,
): boolean {
  if (proposal.systemHealth) return true;
  return proposal.relevance >= relevanceThreshold(neLevel);
}

/**
 * Observation pressure metric (0-1).
 * Ramps from 0 to 1 over 20 untriaged observations.
 * High pressure signals that synthesis should run sooner.
 */
export function observationPressure(observations: TerritoryObservation[]): number {
  const untriaged = observations.filter((o) => o.status === "new").length;
  return Math.min(1, untriaged / 20);
}
