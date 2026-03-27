/**
 * Conviction Loop — PFC reasoning protocol types.
 *
 * The conviction loop fires at every gate decision point across all
 * rhythm levels. It tests:
 *   1. Necessity — does this action need to happen?
 *   2. Conviction — can we still manifest the outcome?
 *   3. Speed of light — how close to the ceiling are we?
 *   4. Shape downstream — what should consumers know?
 *
 * Procedural (no LLM calls). Reads from existing data structures.
 * Produces structured decisions that feed into gate strategies,
 * NE modulation (Phase 4), and forward briefings (Phase 4).
 */

import type { WeightedComposite } from "../kernel/evaluation-weighter.js";
import type { OscillationSignal } from "./working-memory.js";
import type { SpeedOfLight } from "./cerebellum.js";
import type { VitalSigns, TaskGraphNode } from "./brainstem.js";
import type { ProjectIntent } from "./intent.js";

// ─── Context ────────────────────────────────────────────────────

/**
 * What the conviction loop reads from. A single interface with optional
 * fields — the calling rhythm populates what it has, each test step
 * reads what it needs.
 */
export interface ConvictionContext {
  /** Which rhythm level is calling. Determines which tests fire. */
  level: "build-cycle" | "task-dispatch" | "plan-modification";
  /** Current cycle number within this rhythm. */
  cycle: number;

  // ── Build-cycle signals ──────────────────────────────────────

  /** Current weighted composite from evaluation. */
  composite?: WeightedComposite;
  /** Oscillation signals from WM score tracking. */
  oscillations?: OscillationSignal[];
  /** Speed of light from cerebellum. */
  speedOfLight?: SpeedOfLight;
  /** World model maxims (statement strings). */
  worldModelMaxims?: string[];
  /** NE level from attention scheduler. */
  neLevel?: number;
  /** Previous conviction result (from prior cycle's accumulator). */
  previousConviction?: ConvictionResult;
  /** Count of evaluations produced by fallback/degraded paths rather than genuine assessment. */
  degradedEvaluationCount?: number;
  /** Whether approach classification failed for this build cycle (speed-of-light less informative). */
  approachClassificationFailed?: boolean;

  // ── Task-dispatch signals ────────────────────────────────────

  /** Vital signs from homeostasis. */
  vitals?: VitalSigns;
  /** Recent between-tasks dopamine signal. */
  recentDopamine?: number;
  /** Task graph (full node list). */
  taskGraph?: TaskGraphNode[];
  /** IDs of completed tasks. */
  completedTaskIds?: Set<string>;
  /** IDs of escalated tasks. */
  escalatedTaskIds?: Set<string>;
  /** Project intent. */
  intent?: ProjectIntent;

  // ── Scheduler escalation signal (for conviction gating) ────

  /** When present, the scheduler wants to escalate. Fed as undermining evidence. */
  schedulerEscalation?: {
    type: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
    reason: string;
    /** How severe the scheduler considers this (0–1). Scales the conviction penalty. */
    severity: number;
  };

  // ── Phase 4 stubs ────────────────────────────────────────────

  /**
   * Manifested future from Planner (Phase 4).
   * When the Planner is built, conviction tests against this concrete
   * destination. Until then, conviction tests against intent + world
   * model maxims — still meaningful, just less precise.
   */
  manifestedFuture?: string;
}

// ─── Result ─────────────────────────────────────────────────────

/** Output of the conviction loop at any gate. */
export interface ConvictionResult {
  /** Categorical decision. */
  verdict: "proceed" | "reshape" | "escalate";
  /**
   * Continuous conviction level (0–1). For NE modulation (Phase 4).
   * High = the system believes in what it's doing.
   * Low = the system's own reasoning isn't convincing itself.
   */
  level: number;
  /**
   * How much conviction changed from this gate's new information.
   * Positive = conviction strengthened, negative = conviction eroded.
   */
  delta: number;
  /** What drove the verdict — for transparency and downstream shaping. */
  evidence: ConvictionEvidence[];
  /** Tactical notes for downstream consumers. */
  shaping: ConvictionShaping;
  /** Which step in the pipeline produced the verdict. */
  decidingStep: "necessity" | "conviction" | "speed-of-light";
}

// ─── Evidence ───────────────────────────────────────────────────

/** A piece of evidence that influenced the conviction verdict. */
export interface ConvictionEvidence {
  /** Which signal produced this evidence. */
  source:
    | "oscillation"
    | "approach-bottleneck"
    | "score-trajectory"
    | "score-stagnation"
    | "speed-of-light-gap"
    | "speed-of-light-near"
    | "tonic-low"
    | "graph-progress"
    | "graph-exhausted"
    | "maxim-orientation"
    | "previous-conviction"
    | "escalation-rate"
    | "degraded-evaluation"
    | "approach-classification-missing"
    | "scheduler-escalation";
  /** Human-readable explanation. */
  description: string;
  /** Numeric magnitude (meaning depends on source). */
  magnitude: number;
  /** Whether this evidence supports or undermines conviction. */
  valence: "supports" | "undermines";
}

// ─── Shaping ────────────────────────────────────────────────────

/**
 * Tactical notes for downstream consumers.
 *
 * At build-cycle level: stored in accumulator, Thalamus picks up for
 * next cycle's briefing. At task-dispatch level: stored in accumulator,
 * seeds next task's consultation. Richer pipeline comes with
 * Prospective Preparation (#32).
 */
export interface ConvictionShaping {
  /** Concise notes describing what the conviction loop found. */
  notes: string[];
  /** If reshape: what specifically should change. */
  reshapeGuidance?: string;
  /** If escalate: what the human needs to know. */
  escalationReason?: string;
}

// ─── Internal step results (not re-exported from index) ─────────

/** Step 1: Does this action need to happen? */
export interface NecessityResult {
  necessary: boolean;
  evidence: ConvictionEvidence[];
  /** If not necessary, what should change. */
  reshapeGuidance?: string;
  /** Override verdict when necessity fails. */
  verdict?: "reshape" | "escalate";
}

/** Step 2: Can we still manifest the outcome? */
export interface ConvictionTestResult {
  /** Continuous conviction level (0–1). */
  level: number;
  /** Change from previous conviction. */
  delta: number;
  evidence: ConvictionEvidence[];
  /** True when conviction is critically low. */
  shouldEscalate: boolean;
}

/** Step 3: How close to the ceiling are we? */
export interface SpeedOfLightTestResult {
  /** True when score is within 20% of ceiling. */
  nearCeiling: boolean;
  /** True when approach can't reach the ceiling. */
  shouldRearchitect: boolean;
  /** Normalized gap from ceiling (0–1). */
  gapRatio: number;
  evidence: ConvictionEvidence[];
}
