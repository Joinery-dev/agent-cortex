/**
 * Basal Ganglia — action selection through tonic inhibition + learned routines.
 *
 * The BG's default state is tonic inhibition of all senses. Selection happens
 * by selectively disinhibiting the relevant ones (direct pathway) while
 * strengthening suppression of competitors (indirect pathway).
 *
 * Two capabilities:
 *   1. Suppression — determines which senses are irrelevant for a given scope.
 *      Called by the planning layer at scope boundaries (phase, subphase, task).
 *      When learned routines exist, this can shortcut the LLM call entirely.
 *   2. Collapsed-tension detection — judges whether a resolution is genuine
 *      synthesis or capitulation. Produces a gate signal for the build-cycle.
 *      (PFC-delegated: this is executive function, not action selection.
 *       Lives here for convenience until a dedicated CollapseDetector exists.)
 *
 * No inhibition outlives its scope without re-evaluation.
 */

import type { BriefingMeta } from "./thalamus.js";
import type { Tension, TensionResolution } from "./tension.js";
import type { SenseEvaluation } from "./sense.js";
import type { InhibitedSense, ScoreTrend, EstablishedPattern } from "./working-memory.js";
import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { Task } from "./task.js";

// ─── Config ─────────────────────────────────────────────────────

export interface BasalGangliaConfig {
  // ── Tonic inhibition settings (from original Inhibitor) ────────

  /**
   * Minimum number of senses that must remain active after suppression.
   * Prevents the BG from being too aggressive. Default: 2.
   */
  minActiveSenses: number;

  /**
   * NE level above which the BG suppresses fewer senses.
   * High NE = novel/risky task = want more perspectives. Default: 0.7.
   */
  highNeThreshold: number;

  /**
   * In explore mode, scale down suppressions by this factor (0-1).
   * 0.5 means suppress half as many senses as you otherwise would. Default: 0.5.
   */
  exploreSuppressionScale: number;

  // ── Routine learning settings ──────────────────────────────────

  /**
   * Minimum effective confidence (routine.confidence × similarity)
   * to use a routine shortcut instead of LLM deliberation. Default: 0.6.
   */
  routineConfidenceThreshold: number;

  /**
   * Minimum fingerprint similarity for a routine to be considered
   * a match at all. Default: 0.5.
   */
  similarityThreshold: number;

  /**
   * Confidence lost per rest cycle for unused routines. Default: 0.05.
   */
  routineDecayRate: number;

  /**
   * How many observations of the same fingerprint pattern before
   * creating a new routine. Default: 5.
   */
  stableObservationCount: number;

  /**
   * Maximum number of routines stored. Lowest-confidence evicted
   * when exceeded. Default: 100.
   */
  maxRoutines: number;
}

export const DEFAULT_BASAL_GANGLIA_CONFIG: BasalGangliaConfig = {
  minActiveSenses: 2,
  highNeThreshold: 0.7,
  exploreSuppressionScale: 0.5,
  routineConfidenceThreshold: 0.6,
  similarityThreshold: 0.5,
  routineDecayRate: 0.05,
  stableObservationCount: 5,
  maxRoutines: 100,
};

// ─── Scope ──────────────────────────────────────────────────────

/**
 * Inhibition scope levels. Each level clears itself + all narrower
 * scopes when re-evaluated:
 *   project → clears phase, subphase, task
 *   phase   → clears subphase, task
 *   subphase → clears task
 *   task    → clears only task
 *
 * String union (not enum) because these are serialized into WM state
 * and LLM prompts. If converting to enum, update SCOPE_HIERARCHY,
 * WM.clearInhibitionsByScope(), and all BasalGanglia callers.
 */
export type InhibitionScope = "project" | "phase" | "subphase" | "task";

/**
 * Ordered from broadest to narrowest. Used for hierarchical cleanup.
 * Must stay in sync with InhibitionScope — validates scope strings
 * at runtime via indexOf().
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

// ─── Collapsed-Tension Detection (PFC-delegated) ────────────────

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
 * What the Basal Ganglia receives from the Thalamus.
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
  /** All senses with their activation hints — the BG's primary input. */
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

/** Minimal sense info for the BG's deliberative LLM prompt. */
export interface SenseSummary {
  id: string;
  name: string;
  sensitivity: string;
  activationHint: string;
}

// ─── Routine Store (learned procedural memory) ──────────────────

/**
 * A learned sense-activation pattern. The BG's procedural memory.
 *
 * Each routine encodes: "for tasks matching this fingerprint,
 * activate these senses and suppress those." Formed from repeated
 * observations, reinforced by dopamine, decays without use.
 */
export interface Routine {
  id: string;
  /** Structured features this routine matches against. */
  fingerprint: RoutineFingerprint;
  /** D1 direct pathway: senses to release from tonic inhibition. */
  activateSenses: string[];
  /** D2 indirect pathway: senses to keep suppressed. */
  suppressSenses: string[];
  /** Confidence 0–1. Decays without reinforcement. */
  confidence: number;
  /** How many times this routine has been observed/reinforced. */
  observationCount: number;
  /** How often the LLM deliberation disagreed with this routine. */
  overrideCount: number;
  createdAt: Date;
  lastReinforcedAt: Date;
}

/**
 * Features extracted from InhibitionBriefing for routine matching.
 *
 * These are the "cortical inputs" to the striatum — pre-processed
 * structured data, not raw task text. The thalamus has already done
 * the perceptual work; the BG fires on the structured output.
 */
export interface RoutineFingerprint {
  /** Keywords from intent (project domain). Lowercased, stop-words removed. */
  domainKeywords: string[];
  /** Keywords from task description. Lowercased, stop-words removed. */
  taskKeywords: string[];
  /** NE level bucket: "low" (<0.3), "mid" (0.3-0.7), "high" (>0.7). */
  neBucket: "low" | "mid" | "high";
  /** Explore/exploit mode from Scheduler. */
  mode?: "explore" | "exploit";
  /** Number of senses available at briefing time. */
  senseCount: number;
}

/** Result of matching a task against the routine store. */
export interface RoutineMatch {
  routine: Routine;
  /** How well the fingerprint matched (0–1). */
  similarity: number;
  /** routine.confidence × similarity — must exceed threshold to fire. */
  effectiveConfidence: number;
}

/**
 * The BG's pathway decision.
 *
 * Direct: a learned routine fires, shortcutting LLM deliberation.
 * Hyperdirect: no confident match, fall back to LLM.
 */
export type PathwayDecision =
  | { pathway: "direct"; match: RoutineMatch }
  | { pathway: "hyperdirect"; reason: string };
