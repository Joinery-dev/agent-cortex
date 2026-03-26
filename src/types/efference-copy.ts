/**
 * Efference Copy — the Motor Cortex's pre-build feasibility signal.
 *
 * Before the senses deliberate, the Motor Cortex predicts what it
 * can actually deliver. This lets senses calibrate their ambitions
 * against reality — the hardware engineer briefing the architects.
 *
 * Counterpart to proprioception:
 *   Proprioception  = feedback AFTER building  (did the artifact follow the plan?)
 *   Efference copy   = feedforward BEFORE building (what can the builder achieve?)
 *
 * Produced by MotorCortex.predictFeasibility(), attached to the
 * TaskGestalt by the Thalamus, dissolved into consultation briefings.
 */

import type { Task } from "./task.js";
import type { EstablishedPattern } from "./working-memory.js";

// ─── Core Output ────────────────────────────────────────────

/** The Motor Cortex's feasibility assessment for a task. */
export interface EfferenceCopy {
  taskId: string;
  /** Per-sense buildability assessment. */
  perSense: EfferenceSenseFeasibility[];
  /** Trade-off relationships between senses. */
  tensionCosts: TensionCost[];
  /** Things that can't be achieved regardless of approach. */
  hardConstraints: string[];
  /** Predicted build cycles to acceptable quality. */
  convergenceEstimate: number;
  /** Why the convergence estimate is what it is. */
  convergenceRationale: string;
  /** Overall feasibility 0–1. */
  overallFeasibility: number;
  computedAt: Date;
}

/** What the builder thinks is achievable for one sense dimension. */
export interface EfferenceSenseFeasibility {
  senseName: string;
  /** Practical maximum score (1–10) given current tools, codebase, and history. */
  achievableCeiling: number;
  /** Why this ceiling — the ground truth reasoning. */
  ceilingRationale: string;
  /** Specific factors that limit this sense's achievability. */
  constrainingFactors: string[];
}

/** A trade-off relationship between two sense dimensions. */
export interface TensionCost {
  senseA: string;
  senseB: string;
  /** Natural language: "Pushing Design above 8 requires animation that drops Performance below 6" */
  costDescription: string;
  /** How severe the trade-off is (0–1). */
  severity: number;
}

// ─── Input Context ──────────────────────────────────────────

/** What the Motor Cortex receives to assess feasibility. */
export interface EfferenceCopyContext {
  task: Task;
  /** Active senses — name + sensitivity for LLM reasoning. */
  activeSenses: { name: string; sensitivity: string }[];
  /** PNS capability description — what tools/frameworks are available. */
  capabilities: string;
  /** Similar episodes from Cerebellum, pre-serialized for prompt. */
  similarEpisodes: SerializedEpisode[];
  /** Established patterns from working memory. */
  patterns: EstablishedPattern[];
}

/**
 * Lightweight episode shape for the LLM prompt.
 * Maps/Sets from CerebellumEpisode are converted to plain objects.
 */
export interface SerializedEpisode {
  taskId: string;
  /** senseName → score (1–10). */
  senseScores: Record<string, number>;
  /** How similar this episode is to the current task (0–1). */
  similarity: number;
}
