/**
 * Motor Cortex types — premotor planning, proprioception self-assessment,
 * and the combined result of a motor cortex execution cycle.
 *
 * Three sub-components:
 *   Premotor        — plans the approach before building
 *   Primary Motor   — produces the artifact (uses existing LLM call)
 *   Proprioception  — self-checks plan adherence after building
 */

import type { IntentionCategory } from "./pns.js";
import type { SenseEvaluation } from "./sense.js";
import type { TensionResolution } from "./tension.js";
import type { Intention } from "./pns.js";

// ── Premotor Output ───────────────────────────────────────────

/** What the premotor produces before the builder runs. */
export interface MotorPlan {
  /** Natural language approach — how we're going to build this. */
  approach: string;
  /** Ordered steps the builder should follow. */
  steps: PlanStep[];
  /** How we're handling tensions surfaced by senses. */
  tensionStrategy: TensionStrategy[];
  /** Areas where this plan might fail or underperform. */
  risks: PlanRisk[];
  /** Overall confidence in this plan [0-1]. */
  confidence: number;
  /** Planned intentions — what operations the build will perform. */
  plannedIntentions: PlannedIntention[];
}

export interface PlanStep {
  /** What to do. */
  description: string;
  /** Why this step matters for the overall approach. */
  rationale: string;
  /** Which sense concerns this step addresses (sense names). */
  addressesConcerns: string[];
}

export interface TensionStrategy {
  /** Which senses are in tension. */
  senses: [string, string];
  /** How we plan to resolve it in the artifact — synthesis, not compromise. */
  synthesis: string;
}

export interface PlanRisk {
  /** What could go wrong. */
  area: string;
  /** How likely. */
  likelihood: "low" | "medium" | "high";
  /** How we'll mitigate it. */
  mitigation: string;
}

export interface PlannedIntention {
  /** What this operation will accomplish. */
  description: string;
  /** build | observe | communicate | control */
  category: IntentionCategory;
  /** Motor cortex self-assessed confidence [0-1]. */
  confidence: number;
  /** How novel this operation is [0-1]. 0 = routine reuse, 1 = unprecedented. */
  novelty: number;
}

// ── Revision Premotor ────────────────────────────────────────

/** Context passed to premotor on revision cycles. */
export interface RevisionContext {
  previousPlan: MotorPlan;
  evaluations: SenseEvaluation[];
  resolutions: TensionResolution[];
}

/** Premotor's judgment on what went wrong. */
export type RevisionStrategy =
  | { kind: "execution-error"; amendments: string[] }
  | { kind: "plan-error"; newApproach: string };

/** What premotor produces on revision — a plan with revision metadata. */
export interface RevisionPlan extends MotorPlan {
  revisionStrategy: RevisionStrategy;
  /** What changed from the previous plan. */
  delta: string;
}

// ── Proprioception Output ────────────────────────────────────

/** Self-assessment: did the artifact follow the plan? */
export interface SelfAssessment {
  /** How closely the artifact followed the plan [0-1]. */
  planAdherence: number;
  /** Specific areas where the output diverged from the plan. */
  driftAreas: DriftArea[];
  /** Things the motor cortex is unsure about in the artifact. */
  uncertainties: string[];
  /** Overall confidence in the produced artifact [0-1]. */
  confidence: number;
  /** Where evaluators should focus their scrutiny. */
  suggestedFocus: string[];
}

export interface DriftArea {
  /** Which plan step was deviated from. */
  planStep: string;
  /** What actually happened instead. */
  actualBehavior: string;
  /** How much this matters. */
  severity: "minor" | "significant";
}

// ── Combined Motor Cortex Result ──────────────────────────────

/** The full output of a motor cortex execution cycle. */
export interface MotorCortexResult {
  /** The produced artifact (code, copy, design, etc.). */
  work: string;
  /** The premotor plan that guided the build. */
  plan: MotorPlan;
  /** Proprioception self-check (absent if skipped). */
  selfAssessment?: SelfAssessment;
  /** Structured record of what the build intended to do. */
  intentions: Intention[];
}
