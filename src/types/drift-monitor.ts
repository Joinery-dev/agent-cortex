/**
 * Drift Monitor — PFC Feature #6.
 *
 * Compares cumulative project trajectory against original intent.
 * Catches slow divergence that no single task reveals. Also compares
 * stated preferences (taste profile) against demonstrated preferences
 * (what actually scores well). Proposes taste updates when they diverge.
 *
 * Two modes:
 *
 *   Quick check (procedural, after every task):
 *     Computes three signals — score profile shift, tension escalation,
 *     convergence difficulty — and combines them into a single driftLevel
 *     (0–1). No LLM calls. Minimum 3 completed tasks before producing
 *     non-zero drift (cold start guard).
 *
 *   Deep analysis (LLM-assisted, at phase gates):
 *     Full trajectory assessment against intent, taste, and conventions.
 *     Runs when a phaseGroup completes (BetweenTasksSlowPath).
 *     Produces structured assessment with intent alignment, taste
 *     divergence, and convention health.
 *
 * The drift monitor is a detector, not an actor. It produces signals
 * that other components consume:
 *   - Scheduler reads driftLevel → decides replan vs. escalate
 *   - Taste Feedback Loop (#24) reads taste divergences → proposes updates
 *   - Escalation Pathways (#23) routes drift alerts → reaches the Parsifal
 *   - BetweenTasksSlowPath populates drift fields → feeds the rhythm
 */

import type { ProjectIntent, TasteProfile, DecisionRecord } from "./intent.js";
import type {
  ScoreTrend,
  TaskSummary,
  EstablishedPattern,
  ScoreSnapshot,
} from "./working-memory.js";
import type { WorldModelSource, HippocampusSource } from "./thalamus.js";
import type { PlasticitySource } from "./world-model.js";

// ─── Config ─────────────────────────────────────────────────────

export interface DriftMonitorConfig {
  /**
   * Minimum completed tasks before quick check produces non-zero drift.
   * Cold start guard — not enough trajectory data to detect drift.
   * Split-halves comparison needs meaningful halves; linear regression
   * needs ≥3 data points.
   */
  minTasksForQuickCheck: number;
  /**
   * Minimum completed tasks before deep analysis runs at phase gates.
   * Even at phase gates, skip deep analysis if insufficient history.
   */
  minTasksForDeepAnalysis: number;
  /**
   * LLM model for deep analysis calls.
   * Quick check is procedural — no model needed.
   */
  deepAnalysisModel: string;
  /**
   * Weight of score profile shift in the composite driftLevel.
   * The three signal weights should sum to 1.0.
   */
  profileShiftWeight: number;
  /** Weight of tension escalation in the composite driftLevel. */
  tensionEscalationWeight: number;
  /** Weight of convergence difficulty in the composite driftLevel. */
  convergenceDifficultyWeight: number;
}

export const DEFAULT_DRIFT_MONITOR_CONFIG: DriftMonitorConfig = {
  minTasksForQuickCheck: 3,
  minTasksForDeepAnalysis: 3,
  deepAnalysisModel: "claude-sonnet-4-6-20250514",
  // Profile shift gets the highest weight — the most direct measure of
  // trajectory divergence. Tension escalation is second (coherence signal).
  // Convergence difficulty is lowest (process signal, not direction signal).
  profileShiftWeight: 0.4,
  tensionEscalationWeight: 0.35,
  convergenceDifficultyWeight: 0.25,
};

// ─── Sources ────────────────────────────────────────────────────

/**
 * What the Drift Monitor reads from. Typed as interfaces (not class refs)
 * so the monitor depends on shapes, not implementations.
 *
 * Required sources provide the minimum for quick check. Optional sources
 * enrich deep analysis — the monitor degrades gracefully without them.
 *
 * Intent and taste are required (unlike WorldModelSources where they're
 * optional) because without them the drift monitor has nothing to compare
 * trajectory against.
 */
export interface DriftMonitorSources {
  /** Working memory — always available. Required for quick check signals. */
  wm: DriftMonitorWMSource;
  /** Project intent — the baseline for trajectory comparison. */
  intent: ProjectIntent;
  /** Taste profile — stated preferences for taste divergence detection. */
  taste: TasteProfile;

  /** World model — maxims and weltanschauung for deep analysis context. */
  worldModel?: WorldModelSource;
  /** Plasticity — reads drift-monitor.threshold.sensitivity weight. */
  plasticity?: PlasticitySource;
  /** Hippocampus — episodes and principles for deep analysis context. */
  hippocampus?: HippocampusSource;
  /**
   * Manifested future from Planner (Phase 4).
   * When available, deep analysis compares trajectory against this
   * concrete destination rather than just intent summary.
   */
  manifestedFuture?: string;
}

/**
 * What the Drift Monitor reads from Working Memory.
 * Subset of WM's full interface — only what drift detection needs.
 *
 * Separate from WorldModelSources.WorkingMemorySource because the two
 * consumers need different slices: the drift monitor needs getScoreHistory()
 * (which the world model doesn't), and doesn't need getLoad(),
 * getInhibitedSenses(), etc.
 */
export interface DriftMonitorWMSource {
  /** Per-sense score trends across tasks (for profile shift signal). */
  getSenseTrends(): ScoreTrend[];
  /** Completed task summaries (for tension + convergence signals). */
  getCompletedSummaries(): TaskSummary[];
  /** Raw score history — per-task, per-receptor (for deep analysis context). */
  getScoreHistory(): ScoreSnapshot[];
  /** Established patterns (for convention health in deep analysis). */
  getPatterns(): EstablishedPattern[];
  /** Key decisions made (for deep analysis context). */
  getDecisions(): DecisionRecord[];
}

// ─── Quick Check ─────────────────────────────────────────────────

/**
 * The three procedural signals computed by the quick check.
 * Each is 0–1 where 0 = no drift detected, 1 = maximum drift.
 *
 * These are the raw signals before weighting and sensitivity modulation.
 * The composite driftLevel is the weighted combination.
 */
export interface QuickCheckSignals {
  /**
   * Score profile shift — how much the shape of quality across senses
   * has changed between the first half and second half of completed tasks.
   *
   * A project that started with balanced 7s across all senses and now
   * shows 9 on Performance but 4 on Design has a high profile shift —
   * even if the overall mean hasn't changed.
   *
   * Catches: "the project is drifting toward one dimension at the expense
   * of others." Uniform improvement or decline is NOT profile shift.
   *
   * Computed from per-sense deltas (currentMean - previousMean from
   * ScoreTrends). High std across sense deltas = high shift.
   */
  profileShift: number;

  /**
   * Tension escalation — whether unresolved high-severity tensions are
   * accumulating across tasks.
   *
   * Rising highTensionCount across recent tasks indicates Cortex is
   * producing work that generates more disagreement between senses —
   * a symptom of divergence from a coherent intent.
   *
   * Computed from linear regression on TaskSummary.highTensionCount.
   * Positive slope = tensions escalating. Negative/zero clamped to 0.
   */
  tensionEscalation: number;

  /**
   * Convergence difficulty — whether it's getting harder to reach
   * acceptance across tasks.
   *
   * If early tasks converge in 1–2 cycles but recent tasks take 4+,
   * Cortex is struggling to satisfy its own standards — possibly
   * because the work is in uncharted territory where established
   * patterns don't fit.
   *
   * Computed from linear regression on TaskSummary.cycles.
   * Positive slope = getting harder. Negative/zero clamped to 0.
   */
  convergenceDifficulty: number;
}

/**
 * Output of the quick check — produced after every completed task
 * (once minTasksForQuickCheck is met).
 */
export interface QuickCheckResult {
  /** The three raw signals. */
  signals: QuickCheckSignals;
  /**
   * Composite drift level (0–1). Weighted combination of the three
   * signals, modulated by the plasticity sensitivity weight.
   * This value populates SchedulerSignals.driftLevel.
   */
  driftLevel: number;
  /**
   * Human-readable summary of what the drift signals indicate.
   * Identifies which signals are contributing and by how much.
   * Populates SchedulerSignals.driftSummary.
   */
  driftSummary: string;
  /** How many completed tasks contributed to the computation. */
  taskCount: number;
  /** When this check ran. */
  computedAt: Date;
}

// ─── Deep Analysis ───────────────────────────────────────────────

/**
 * A piece of evidence supporting an alignment or divergence claim.
 * Follows the ConvictionEvidence pattern: structured transparency
 * with source attribution and magnitude.
 */
export interface DriftEvidence {
  /** What was observed in the trajectory data. */
  observation: string;
  /** What it was compared against (from intent, taste, or conventions). */
  reference: string;
  /** How significant this evidence is (0–1). */
  magnitude: number;
  /** Whether this evidence indicates drift or alignment. */
  valence: "drift" | "alignment";
}

// ─── Intent Alignment ────────────────────────────────────────────

/** Categorical assessment of intent alignment. */
export type IntentAlignmentLevel = "aligned" | "drifting" | "diverged";

/** Whether alignment is getting better or worse. */
export type AlignmentTrajectory = "improving" | "stable" | "worsening";

/**
 * How well the project trajectory aligns with intent.
 * The core question the deep analysis answers.
 */
export interface IntentAlignment {
  /**
   * Categorical assessment.
   *   aligned  — trajectory serves the intent
   *   drifting — trajectory is shifting away from intent
   *   diverged — trajectory has lost connection to intent
   */
  level: IntentAlignmentLevel;
  /** Is alignment improving or worsening over recent tasks? */
  trajectory: AlignmentTrajectory;
  /** Natural language description of the alignment state. */
  description: string;
  /** Evidence supporting the assessment. */
  evidence: DriftEvidence[];
}

// ─── Taste Divergence ────────────────────────────────────────────

/**
 * A single detected taste divergence — where demonstrated preference
 * (what actually scores well) differs from stated preference (taste profile).
 *
 * This is the primary output that Feature #24 (Taste Feedback Loop)
 * will consume to propose taste profile updates.
 */
export interface TasteDivergenceItem {
  /** Which taste dimension diverged (e.g. "visual", "decisionStyle", "patterns"). */
  dimension: string;
  /** What the taste profile says. */
  stated: string;
  /** What the score data demonstrates. */
  demonstrated: string;
  /** How strong the divergence signal is (0–1). */
  strength: number;
}

/** Taste divergence section of the deep analysis. */
export interface TasteDivergence {
  /** Whether any taste divergence was detected. */
  detected: boolean;
  /** Individual divergences. Empty array when detected is false. */
  divergences: TasteDivergenceItem[];
}

// ─── Convention Health ───────────────────────────────────────────

/**
 * A convention (established pattern) whose health is changing.
 * Used for both eroding and emerging conventions.
 */
export interface ConventionSignal {
  /** Description of the convention (from EstablishedPattern or newly observed). */
  convention: string;
  /** Evidence for the erosion or emergence. */
  evidence: string;
  /** Confidence in this signal (0–1). */
  confidence: number;
}

/**
 * Convention health section of the deep analysis.
 * Two-directional: patterns fading + new patterns forming.
 */
export interface ConventionHealth {
  /** Established conventions that are weakening across recent tasks. */
  eroding: ConventionSignal[];
  /**
   * New conventions emerging that weren't in the original patterns.
   * Emergence isn't inherently bad — but conventions that form without
   * explicit decisions may be accidental drift.
   */
  emerging: ConventionSignal[];
}

// ─── Full Deep Analysis ──────────────────────────────────────────

/**
 * Full deep analysis output. Produced by the LLM at phase gates.
 *
 * This is the structure that callStructured<DeepAnalysis>() will validate
 * against. A corresponding Zod schema exists in the implementation file.
 */
export interface DeepAnalysis {
  /** How well the trajectory aligns with intent. */
  intentAlignment: IntentAlignment;
  /** Stated vs. demonstrated taste preferences. */
  tasteDivergence: TasteDivergence;
  /** Are established conventions holding or eroding? */
  conventionHealth: ConventionHealth;
  /**
   * Overall drift level from the LLM's holistic assessment (0–1).
   * This may differ from the quick check's procedural driftLevel —
   * the LLM sees semantic patterns the signals miss.
   */
  overallLevel: number;
  /** High-level summary of the trajectory state. 2–3 sentences. */
  summary: string;
  /**
   * Actionable recommendations. Each is a concrete suggestion,
   * not a vague observation. Consumers: Parsifal (via escalation),
   * Planner (via replan action).
   */
  recommendations: string[];
}

// ─── Unified Assessment ──────────────────────────────────────────

/**
 * The Drift Monitor's current assessment — unified view of quick check
 * and deep analysis results.
 *
 * The quick check runs after every task (fast path).
 * Deep analysis runs at phase gates (slow path).
 * This assessment always reflects the latest information; deep analysis
 * is included when it exists.
 *
 * assembleSignals() in task-dispatch reads driftLevel and driftSummary
 * to populate SchedulerSignals.
 */
export interface DriftAssessment {
  /**
   * Current drift level (0–1). From the most recent check
   * (quick or deep, whichever ran last).
   * Populates SchedulerSignals.driftLevel.
   */
  driftLevel: number;
  /**
   * Current drift summary. From the most recent check.
   * Populates SchedulerSignals.driftSummary.
   */
  driftSummary: string;
  /** The most recent quick check result. Null before minTasksForQuickCheck is met. */
  quickCheck: QuickCheckResult | null;
  /** The most recent deep analysis. Null until the first phase gate. */
  deepAnalysis: DeepAnalysis | null;
  /** When the deep analysis was last performed. */
  deepAnalysisAt: Date | null;
  /** The phase group that triggered the most recent deep analysis. */
  deepAnalysisPhaseGroup: string | null;
  /**
   * Sensitivity weight from plasticity (drift-monitor.threshold.sensitivity).
   * Applied as a multiplier to the raw driftLevel. Higher sensitivity
   * means the same raw signals produce a higher reported driftLevel.
   * Null when plasticity store is not wired.
   */
  sensitivityWeight: number | null;
}

// ─── State snapshot (for dashboard/debugging) ────────────────────

/** Serializable snapshot of the Drift Monitor's state. */
export interface DriftMonitorState {
  /** Current composite drift level (0–1). */
  driftLevel: number;
  /** Current drift summary. */
  driftSummary: string;
  /** Number of completed tasks contributing to the assessment. */
  completedTaskCount: number;
  /** Whether quick check is producing non-zero signals (past cold start). */
  quickCheckActive: boolean;
  /** Current raw signal values. Null before cold start. */
  signals: QuickCheckSignals | null;
  /** Whether a deep analysis has been performed. */
  hasDeepAnalysis: boolean;
  /** Phase group of the most recent deep analysis. */
  lastDeepAnalysisPhaseGroup: string | null;
  /** When the last deep analysis ran. */
  lastDeepAnalysisAt: Date | null;
  /** Overall level from deep analysis (if performed). */
  deepAnalysisLevel: number | null;
  /** Current plasticity sensitivity weight. */
  sensitivityWeight: number | null;
  /** Taste divergences detected (count, not full details). */
  tasteDivergenceCount: number;
  /** Eroding convention count from last deep analysis. */
  erodingConventionCount: number;
  /** Emerging convention count from last deep analysis. */
  emergingConventionCount: number;
}
