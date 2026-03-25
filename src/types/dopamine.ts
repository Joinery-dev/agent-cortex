/**
 * Dopamine Signal Types — distribution protocol + tonic tracking.
 *
 * Dopamine is reward prediction error. The Cerebellum computes the raw
 * signal (Feature #18). This module defines how that signal gets
 * transformed for each consumer — the "receptor types" that convert
 * one broadcast signal into region-specific modulation.
 *
 * Phasic = per-task burst (what just happened).
 * Tonic = running average (how is this project going overall).
 * Projections = per-consumer transforms (what this means for you).
 */

// Re-export the phasic signal type from cerebellum
export type {
  DopamineSignal,
  ReceptorDopamine,
} from "./cerebellum.js";

// ─── Tonic Dopamine ──────────────────────────────────────────────

/**
 * Running average of phasic dopamine signals for a project.
 * Reflects the overall reward environment — "how is this going?"
 *
 * Positive = outcomes consistently exceeding expectations.
 * Negative = outcomes consistently disappointing.
 * Near-zero = mixed bag or insufficient data.
 */
export interface TonicDopamine {
  /** Exponential moving average of phasic aggregates. Unbounded but typically [-3, +3]. */
  level: number;
  /** Recent trajectory of the tonic level. */
  trend: "rising" | "falling" | "stable";
  /** How many phasic signals have contributed. Low = uncertain. */
  sampleCount: number;
  /** Which project this tonic state belongs to. */
  projectId: string;
  lastUpdated: Date;
}

/** Configuration for the tonic EMA tracker. */
export interface TonicConfig {
  /**
   * EMA smoothing factor (0–1). Higher = more responsive to recent signals.
   * α = 0.3 means the last ~3-4 tasks dominate the tonic level.
   */
  alpha: number;
  /**
   * How many recent levels to compare for trend detection.
   * Trend = compare current level to level N signals ago.
   */
  trendWindow: number;
  /**
   * Minimum absolute change over trendWindow to register as rising/falling.
   * Below this threshold → "stable".
   */
  trendThreshold: number;
}

export const DEFAULT_TONIC_CONFIG: TonicConfig = {
  alpha: 0.3,
  trendWindow: 4,
  trendThreshold: 0.15,
};

// ─── Per-Consumer Projections ────────────────────────────────────

/**
 * Hippocampal projection — modulates episodic memory encoding.
 *
 * In the brain: surprising events (large |dopamine|) get encoded more
 * strongly. Negative tonic increases consolidation urgency — when things
 * are going badly, the system needs to extract lessons faster.
 */
export interface HippocampalProjection {
  /**
   * How strongly to encode this episode (0–1).
   * Derived from |phasic aggregate|. Large surprises → stronger encoding.
   * Replaces the ad-hoc computeSignificance() in episode-builder.
   */
  encodingStrength: number;
  /**
   * How urgently should consolidation (potentiation) run (0–1).
   * Higher when tonic is negative — the project is struggling,
   * so extracting principles from recent failures is more urgent.
   */
  consolidationUrgency: number;
}

/**
 * Striatal projection — modulates habit formation in basal ganglia.
 *
 * In the brain: D1 receptors (direct pathway) strengthen the action
 * that led to reward. D2 receptors (indirect pathway) suppress
 * alternatives. This is how routines form and dissolve.
 */
export interface StriatalProjection {
  /**
   * How much to reinforce the current sense-activation pattern (-1 to +1).
   * Positive = strengthen this routine (outcome was good).
   * Negative = weaken this routine (outcome disappointed).
   */
  reinforcement: number;
  /**
   * Bias toward exploration vs exploitation (0–1).
   * 0 = pure exploitation (keep doing what works).
   * 1 = pure exploration (try something different).
   * Derived from tonic: negative tonic → explore more.
   */
  explorationBias: number;
}

/**
 * Per-receptor weight delta for plasticity.
 * Tells the plasticity system which connection to adjust and how.
 */
export interface ReceptorWeightDelta {
  receptorId: string;
  /**
   * Direction and magnitude of the weight change.
   * Positive = sense was undervalued (actual > predicted), strengthen.
   * Negative = sense was overvalued (actual < predicted), weaken.
   * Normalized to roughly [-1, +1] range.
   */
  delta: number;
  /**
   * How confident the prediction was for this receptor (0–1).
   * High-confidence wrong predictions → larger corrections.
   */
  predictionConfidence: number;
}

/**
 * Plasticity projection — modulates connection weight adjustment.
 *
 * The dopamine signal determines WHEN to learn (large surprise → learn more)
 * and WHAT to learn (per-receptor deltas → which connections to adjust).
 */
export interface PlasticityProjection {
  /**
   * How aggressively to adjust weights this cycle (0–1).
   * Derived from |phasic aggregate| × prediction confidence.
   * Replaces the hardcoded learningRate = 0.05 in applyDopamineToWeights.
   */
  learningRate: number;
  /**
   * Per-receptor direction signals.
   * Each entry tells plasticity which sense's weight to adjust and how.
   */
  perReceptor: ReceptorWeightDelta[];
}

/**
 * Prefrontal projection — modulates working memory gating.
 *
 * In the brain: dopamine in the PFC controls what gets into working
 * memory. High dopamine = "update with new info." Low = "maintain
 * current contents." Large surprises mean new info is important.
 */
export interface PrefrontalProjection {
  /**
   * How aggressively to gate new information into working memory (0–1).
   * Large |phasic| → higher gate strength → more WM updates.
   * Small |phasic| → lower gate strength → maintain current focus.
   */
  wmGateStrength: number;
}

// ─── Composite ───────────────────────────────────────────────────

/**
 * The full dopamine distribution — phasic signal + tonic state +
 * all per-consumer projections. Computed once per task by the
 * dopamine relay, then distributed to each consumer.
 */
export interface DopamineProjections {
  /** The raw phasic signal from the Cerebellum. */
  taskId: string;
  /** Aggregate phasic dopamine (for logging/display). */
  phasicAggregate: number;
  /** Current tonic state for this project. */
  tonic: TonicDopamine;
  /** For hippocampus: encoding strength + consolidation urgency. */
  hippocampal: HippocampalProjection;
  /** For basal ganglia: reinforcement + exploration bias. */
  striatal: StriatalProjection;
  /** For plasticity system: learning rate + per-receptor deltas. */
  plasticity: PlasticityProjection;
  /** For prefrontal cortex: working memory gating strength. */
  prefrontal: PrefrontalProjection;
}

// ─── Tonic Snapshot (for persistence/dashboard) ──────────────────

/** Serializable tonic state for a single project. */
export interface TonicSnapshot {
  projectId: string;
  level: number;
  trend: "rising" | "falling" | "stable";
  sampleCount: number;
  lastUpdated: string; // ISO date
}

/** Full tonic tracker state for persistence. */
export interface TonicTrackerSnapshot {
  projects: TonicSnapshot[];
  config: TonicConfig;
}
