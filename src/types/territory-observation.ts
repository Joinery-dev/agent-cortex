/**
 * Territory Observation — an objective fact discovered during execution.
 *
 * Emitted by builder (Motor Cortex), evaluator, proprioception, and
 * integration checker during task execution. Stored in WM's observations
 * section. NOT counted toward WM load or homeostasis pressure —
 * observations have their own pressure metric (observationPressure).
 *
 * NE modulates the relevance threshold:
 *   high NE (≥0.7): threshold 0.2 (notice more)
 *   low NE (≤0.3): threshold 0.6 (only notice important)
 *   default: linear interpolation
 */

// ─── Core Types ─────────────────────────────────────────────────

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
}

export type ObservationStatus = "new" | "triaged" | "synthesized" | "dismissed";

export interface ObservationSource {
  /** Which task was being executed when this was observed. */
  taskId: string;
  /** Which component produced the observation. */
  component: "builder" | "evaluator" | "proprioception" | "integration-check";
  /** For evaluator observations: which sense produced it. */
  senseId?: string;
}

// ─── Pure Functions ─────────────────────────────────────────────

/**
 * Relevance threshold as a function of NE level.
 * Linear interpolation: NE 0 → 0.6, NE 1 → 0.2.
 * Observations below the threshold are filtered out before storage.
 */
export function relevanceThreshold(neLevel: number): number {
  const clamped = Math.min(1, Math.max(0, neLevel));
  return 0.6 - 0.4 * clamped;
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
