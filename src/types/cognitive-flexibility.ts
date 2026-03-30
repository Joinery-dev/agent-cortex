/**
 * Cognitive Flexibility — PFC Feature #5.
 *
 * Detects perseveration and diagnoses WHY Cortex is stuck.
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
 * full strategy reset, re-engagement, or escalation to the Parsifal.
 */

import type { ConvictionResult } from "./conviction.js";
import type { WeightedComposite } from "../kernel/evaluation-weighter.js";
import type { Tension } from "./tension.js";
import type { OscillationSignal, ScoreTrend } from "./working-memory.js";
import type { SpeedOfLight } from "./cerebellum.js";
import type { Task } from "./task.js";
import type { TaskGraphNode, VitalSigns } from "./brainstem.js";
import type { OrchestratorResult } from "./orchestrator.js";
import type { ProjectIntent } from "./intent.js";

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
  /** Human-readable explanation of why Cortex is stuck. */
  reasoning: string;
  /** True → force re-plan (not revision). False → more targeted revision. */
  shouldReset: boolean;
  /** Present when shouldReset is true. */
  resetDirective?: ResetDirective;
  /** True → escalate to the Parsifal. Overrides shouldReset. */
  shouldEscalate: boolean;
  /** Present when shouldEscalate is true. */
  escalationContext?: string;
}

// ─── Dispatch-Level Context ─────────────────────────────────────

/** What dispatch-level Cognitive Flexibility reads. Aggregate signals, not per-build. */
export interface DispatchFlexibilityContext {
  /** The conviction loop's verdict that triggered flexibility. */
  conviction: ConvictionResult;
  /** Task graph (full node list). */
  taskGraph: TaskGraphNode[];
  /** IDs of completed tasks. */
  completedTaskIds: Set<string>;
  /** IDs of escalated tasks. */
  escalatedTaskIds: Set<string>;
  /** Task results so far (scores, confidence, cycles). */
  taskResults: Map<string, OrchestratorResult>;
  /** Per-sense score trends from WM. */
  senseTrends: ScoreTrend[];
  /** Scheduler escalation that triggered this (if any). */
  schedulerEscalation?: {
    type: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
    reason: string;
  };
  /** Vital signs from homeostasis. */
  vitals: VitalSigns;
  /** Project intent. */
  intent: ProjectIntent;
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
