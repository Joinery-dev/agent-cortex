/**
 * Inhibitor — PFC sense suppression + collapsed-tension detection.
 *
 * Two modes:
 *   1. Suppression — determines which senses are irrelevant for a given scope.
 *      Called by the planning layer at scope boundaries (phase, subphase, task).
 *   2. Collapsed-tension detection — judges whether a resolution is genuine
 *      synthesis or capitulation. Produces a gate signal for the build-cycle.
 *
 * The Inhibitor is passive — it runs when called, doesn't track boundaries.
 * No inhibition outlives its scope without re-evaluation.
 */

import type { BriefingMeta } from "./thalamus.js";
import type { Tension, TensionResolution } from "./tension.js";
import type { SenseEvaluation } from "./sense.js";
import type { InhibitedSense, ScoreTrend, EstablishedPattern } from "./working-memory.js";
import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { Task } from "./task.js";

// ─── Config ─────────────────────────────────────────────────────

export interface InhibitorConfig {
  /**
   * Minimum number of senses that must remain active after suppression.
   * Prevents the Inhibitor from being too aggressive. Default: 2.
   */
  minActiveSenses: number;

  /**
   * NE level above which the Inhibitor suppresses fewer senses.
   * High NE = novel/risky task = want more perspectives. Default: 0.7.
   */
  highNeThreshold: number;

  /**
   * In explore mode, scale down suppressions by this factor (0-1).
   * 0.5 means suppress half as many senses as you otherwise would. Default: 0.5.
   */
  exploreSuppressionScale: number;
}

export const DEFAULT_INHIBITOR_CONFIG: InhibitorConfig = {
  minActiveSenses: 2,
  highNeThreshold: 0.7,
  exploreSuppressionScale: 0.5,
};

// ─── Scope ──────────────────────────────────────────────────────

/**
 * Inhibition scope levels. Each level clears itself + all narrower
 * scopes when re-evaluated:
 *   project → clears phase, subphase, task
 *   phase   → clears subphase, task
 *   subphase → clears task
 *   task    → clears only task
 */
export type InhibitionScope = "project" | "phase" | "subphase" | "task";

/**
 * Ordered from broadest to narrowest. Used for hierarchical cleanup.
 */
export const SCOPE_HIERARCHY: InhibitionScope[] = [
  "project",
  "phase",
  "subphase",
  "task",
];

// ─── Suppression ────────────────────────────────────────────────

/** What the LLM returns from a suppression evaluation. */
export interface SuppressionDecision {
  /** Senses to suppress at this scope. */
  suppress: SuppressionEntry[];
  /** Senses to explicitly reactivate (previously suppressed but now relevant). */
  reactivate: ReactivationEntry[];
}

export interface SuppressionEntry {
  senseId: string;
  reason: string;
}

export interface ReactivationEntry {
  senseId: string;
  reason: string;
}

// ─── Collapsed-Tension Detection ────────────────────────────────

/** Input to collapsed-tension detection. */
export interface CollapseContext {
  /** The tensions that were flagged in this build cycle. */
  tensions: Tension[];
  /** The resolutions produced by the resolver. */
  resolutions: TensionResolution[];
  /** Current cycle's evaluations. */
  evaluations: SenseEvaluation[];
  /** Previous cycle's evaluations (if any — for detecting score shifts). */
  priorEvaluations?: SenseEvaluation[];
  /** The work that was produced. */
  work: string;
}

/** Output of collapsed-tension detection. */
export interface CollapseSignal {
  /** Whether any tensions collapsed (vs. genuine resolution). */
  collapsed: boolean;
  /** Per-tension details. */
  details: CollapseDetail[];
}

export interface CollapseDetail {
  /** Which tension this applies to. */
  tensionId: string;
  /** Whether this specific tension collapsed. */
  collapsed: boolean;
  /** Which sense capitulated (if any). */
  capitulatedSense?: string;
  /** Why we think this is capitulation vs. synthesis. */
  explanation: string;
  /** Guidance for the next build cycle to re-engage this tension. */
  reEngagementGuidance?: string;
}

// ─── Thalamus Briefing ──────────────────────────────────────────

/**
 * What the Inhibitor receives from the Thalamus.
 * Key difference from other briefings: includes the full sense library
 * so the LLM can reason about what's relevant.
 */
export interface InhibitionBriefing {
  intent: ProjectIntent;
  taste: TasteProfile;
  /** The task being evaluated (undefined for project/phase-level suppression). */
  task?: Task;
  enrichment: InhibitionEnrichment;
  meta: BriefingMeta;
}

export interface InhibitionEnrichment {
  /** All senses with their activation hints — the Inhibitor's primary input. */
  senses: SenseSummary[];
  /** Current inhibitions from WM — what's already suppressed. */
  currentInhibitions: InhibitedSense[];
  /** Sense-level score trends — signals for what's adding value. */
  senseTrends: ScoreTrend[];
  /** Established patterns — context for what matters. */
  patterns: EstablishedPattern[];
  /** NE level from Scheduler — modulates aggressiveness. */
  neLevel?: number;
  /** Explore/exploit mode from Scheduler. */
  mode?: "explore" | "exploit";
  /** Total number of senses in the library (before any filtering). */
  totalSenseCount: number;
}

/** Minimal sense info for the Inhibitor's LLM prompt. */
export interface SenseSummary {
  id: string;
  name: string;
  sensitivity: string;
  activationHint: string;
}
