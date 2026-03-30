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
  /** Whether this task requires agentic execution (real tools, multi-turn).
   *  When false, the text-only single-turn path is sufficient.
   *  Decided by the premotor based on task complexity and tool requirements. */
  requiresAgentic: boolean;
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

// ── Failure Classification ───────────────────────────────────

/**
 * What kind of failure caused rejection.
 *
 * Different failure types need different revision strategies:
 *   local-logic         → targeted surgical fix (default)
 *   integration         → senses conflict, resolution failed
 *   specification-gap   → motor thought it did fine, senses disagree on "done"
 *   approach-bottleneck → the approach itself is the ceiling
 */
export type FailureCategory =
  | "local-logic"
  | "integration"
  | "specification-gap"
  | "approach-bottleneck";

/** Result of classifying a gate rejection. */
export interface FailureClassification {
  category: FailureCategory;
  /** How confident the classifier is in this category (0–1). */
  confidence: number;
  /** Sense IDs that drove the rejection. */
  objectingSenseIds: string[];
  /** Diagnostic signals that led to this classification. */
  signals: string[];
  /** Human-readable explanation. */
  rationale: string;
}

// ── Revision Premotor ────────────────────────────────────────

/** Context passed to premotor on revision cycles. */
export interface RevisionContext {
  previousPlan: MotorPlan;
  evaluations: SenseEvaluation[];
  resolutions: TensionResolution[];
  /** Sense IDs that drove rejection — focus revision here. */
  objectingSenseIds?: string[];
  /** Weighted evaluations that drove rejection (sorted by impact). */
  rejectionDrivers?: import("../kernel/evaluation-weighter.js").WeightedEvaluation[];
  /** How the failure was classified — guides revision strategy. */
  failureClassification?: FailureClassification;
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

// ── Mid-Build Sense Consultation ─────────────────────────────

/**
 * Mid-build question from Motor Cortex when it hits ambiguity in the specification.
 * The builder pauses, asks a specific question, and the Thalamus routes it
 * to the right sense — or escalates to the Parsifal if no sense can answer.
 *
 * Parallels AskUserQuestion but the audience is internal: a sense, not the Parsifal.
 * The builder treats senses as domain experts it can consult mid-implementation,
 * the same way a developer asks a subject-matter expert on the team.
 */
export interface BuildQuestion {
  id: string;
  taskId: string;
  /** The specific, answerable question. Not open-ended — "should X or Y?" not "what should I do?" */
  question: string;
  /** What the builder was doing when it hit the ambiguity. */
  buildContext: string;
  /** Which dimension this relates to — helps Thalamus route to the right sense. */
  targetDimension?: string;
  /** If the builder has identified possible answers. */
  options?: string[];
}

/**
 * Answer to a BuildQuestion, from either a sense or the Parsifal.
 * When the Thalamus can route to a sense, the source is that sense.
 * When no sense can answer, the question escalates to the Parsifal.
 */
export interface BuildAnswer {
  questionId: string;
  source: { type: "sense"; senseId: string } | { type: "parsifal" };
  answer: string;
  /** How confident the source is in this answer [0-1]. */
  confidence: number;
  /** Why this answer — the reasoning from the source's perspective. */
  rationale: string;
}

/**
 * Callback the Motor Cortex invokes when it needs a mid-build answer.
 * Wired up by the build-cycle rhythm, which routes through the Thalamus.
 * The Motor Cortex stays decoupled from routing — it just asks and gets an answer.
 */
export type QuestionHandler = (question: BuildQuestion) => Promise<BuildAnswer>;

// ── Agentic Motor Result ─────────────────────────────────────

/** Trace of a single tool call during an agentic motor session. */
export interface ToolUseTrace {
  toolName: string;
  summary: string;
  timestamp: Date;
}

/** Full result from an agentic Motor Cortex session (real tool execution). */
export interface AgenticMotorResult {
  /** Natural language summary of what was done. */
  summary: string;
  /** Complete trace of every tool call the agentic session made. */
  toolTrace: ToolUseTrace[];
  /** Number of agentic turns consumed. */
  turns: number;
  /** Token usage for the agentic session. */
  usage: { inputTokens: number; outputTokens: number };
  /** Dollar cost of the agentic session. */
  costDollars?: number;
  /** Duration of the agentic session in milliseconds. */
  durationMs: number;
}

// ── Combined Motor Cortex Result ──────────────────────────────

/** The full output of a motor cortex execution cycle. */
export interface MotorCortexResult {
  /** Summary of what was built. In agentic mode, this is a trace summary; artifacts are on disk. */
  work: string;
  /** Full agentic result when Motor Cortex ran with real tools. */
  agenticResult?: AgenticMotorResult;
  /** The premotor plan that guided the build. */
  plan: MotorPlan;
  /** Proprioception self-check (absent if skipped). */
  selfAssessment?: SelfAssessment;
  /** Structured record of what the build intended to do. */
  intentions: Intention[];
}
