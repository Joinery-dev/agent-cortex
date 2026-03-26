/**
 * Cognitive Flexibility — PFC Feature #5.
 *
 * Detects perseveration and diagnoses WHY the system is stuck.
 * Fires when the conviction loop returns "reshape" — the signal
 * that something is wrong. Cognitive Flexibility determines WHAT
 * is wrong and WHAT to do about it.
 *
 * Four diagnoses:
 *   execution-problem  → approach is sound, execution is poor
 *   strategy-limited   → approach is fundamentally capped
 *   tension-evasion    → suppressing rather than synthesizing
 *   irreconcilable     → task constraints make goals impossible
 *
 * Each diagnosis leads to a different action: targeted revision,
 * full strategy reset, re-engagement, or escalation to human.
 */

import type { ConvictionResult } from "./conviction.js";
import type { WeightedComposite } from "../kernel/evaluation-weighter.js";
import type { Tension } from "./tension.js";
import type { OscillationSignal } from "./working-memory.js";
import type { SpeedOfLight } from "./cerebellum.js";
import type { Task } from "./task.js";

// ─── Diagnosis ──────────────────────────────────────────────────

export type FlexibilityDiagnosis =
  | "execution-problem"
  | "strategy-limited"
  | "tension-evasion"
  | "irreconcilable";

// ─── Context (input) ────────────────────────────────────────────

/** What Cognitive Flexibility reads to make its assessment. */
export interface FlexibilityContext {
  /** The conviction loop's verdict that triggered flexibility. */
  conviction: ConvictionResult;
  /** Previous cycle's conviction (for trajectory). */
  previousConviction: ConvictionResult | null;

  // Build state
  composite: WeightedComposite;
  tensions: Tension[];
  oscillations: OscillationSignal[];
  cycle: number;

  /** Approaches tried so far within this task, with their best scores. */
  approachHistory: ApproachHistoryEntry[];

  // Speed of light
  speedOfLight: SpeedOfLight | null;

  // World model
  worldModelMaxims: string[];

  // Task
  task: Task;
}

export interface ApproachHistoryEntry {
  approach: string;
  bestComposite: number;
}

// ─── Assessment (output) ────────────────────────────────────────

/** What Cognitive Flexibility produces. */
export interface FlexibilityAssessment {
  diagnosis: FlexibilityDiagnosis;
  /** Human-readable explanation of why the system is stuck. */
  reasoning: string;
  /** True → force re-plan (not revision). False → more targeted revision. */
  shouldReset: boolean;
  /** Present when shouldReset is true. */
  resetDirective?: ResetDirective;
  /** True → escalate to human. Overrides shouldReset. */
  shouldEscalate: boolean;
  /** Present when shouldEscalate is true. */
  escalationContext?: string;
}

/** Instructions for the premotor when re-planning from scratch. */
export interface ResetDirective {
  /** Approach archetypes to avoid (from V2 vocabulary). */
  avoidApproaches: string[];
  /** Natural language: what direction to try instead. */
  suggestedDirection: string;
  /** What to keep from the current approach (don't throw everything away). */
  retainFromCurrent: string[];
}
