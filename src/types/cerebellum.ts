/**
 * Cerebellum Types — prediction engine data shapes.
 *
 * The Cerebellum predicts evaluation scores before building, then
 * compares predictions to reality. The delta is the dopamine signal.
 *
 * All prediction is case-based: store episodes, find similar tasks
 * by sense activation fingerprint, weight by recency and similarity.
 * No LLM calls — fast, procedural, debuggable.
 */

// ─── Fingerprinting ─────────────────────────────────────────────

/**
 * A task's signature extracted from its Consultation.
 * Two tasks are similar if their fingerprints are similar.
 */
export interface TaskFingerprint {
  /** Which senses activated with what stakes. senseName → stake (0–1). */
  senseStakes: Map<string, number>;
  /** Which receptors will evaluate the work. */
  activeReceptors: Set<string>;
}

// ─── Episodes ───────────────────────────────────────────────────

/**
 * One completed task's outcome, stored for future similarity lookup.
 * The Cerebellum's memory of what happened.
 */
export interface CerebellumEpisode {
  taskId: string;
  /** The task's fingerprint at consultation time. */
  fingerprint: TaskFingerprint;
  /** Actual scores per receptor after evaluation. receptorId → score (1–10). */
  receptorScores: Map<string, number>;
  /** Actual scores per sense (mean of receptor scores). senseName → score. */
  senseScores: Map<string, number>;
  /** Predicted scores per receptor, if a prediction was made. receptorId → score. */
  predictedScores: Map<string, number> | null;
  /** Approach archetype tags from V2 classification (absent for pre-V2 episodes). */
  approachTags?: string[];
  /** Monotonically increasing, for recency weighting. */
  sequenceNumber: number;
  recordedAt: Date;

  // ── Cost metadata (for cost prediction learning) ────────────
  /** Total dollar cost of this task execution. */
  cost?: number;
  /** Number of LLM calls made during this task. */
  callCount?: number;
  /** Cost breakdown by purpose (consultation, motor, evaluation, etc). */
  costByPurpose?: Partial<Record<import("../llm/client.js").Purpose, number>>;
  /** Which model tier was used for each purpose. */
  modelsByPurpose?: Partial<Record<import("../llm/client.js").Purpose, string>>;
  /** Thalamus briefing depth used during this task. */
  briefingDepth?: import("./cost.js").BriefingDepth;

  // ── Attention budget metadata (for cycle prediction learning) ──
  /** Actual outer cycles used by the sensory cortex loop. */
  outerCycles?: number;
  /** The attention budget that was active during this task. */
  attentionBudget?: { floor: number; expected: number; ceiling: number };

  // ── Failure classification metadata (for failure mode prediction) ──
  /** How the gate classified the failure (absent for first-try accepts). */
  failureCategory?: import("./motor-cortex.js").FailureCategory;
  /** Classifier confidence in the failure category. */
  failureConfidence?: number;
  /** Sense IDs that drove the rejection. */
  failureObjectingSenseIds?: string[];
}

// ─── Predictions ────────────────────────────────────────────────

/** A single receptor's predicted score. */
export interface ReceptorPrediction {
  receptorId: string;
  activationPath: string[];
  /** Predicted score (1–10 scale). */
  predicted: number;
  /** How confident the prediction is (0–1). */
  confidence: number;
  /** How many episodes contributed to this prediction. */
  basedOnEpisodes: number;
  /** Whether this came from direct receptor data or parent sense fallback. */
  source: "receptor" | "sense-fallback";
}

/** Full prediction for a task, produced before building. */
export interface CerebellumPrediction {
  taskId: string;
  receptorPredictions: ReceptorPrediction[];
  /** Mean of per-receptor confidences. */
  overallConfidence: number;
  /** How many similar episodes contributed. */
  episodeCount: number;
  /** Similarity of the best-matching episode (0–1). */
  bestSimilarity: number;
  predictedAt: Date;
}

// ─── Dopamine ───────────────────────────────────────────────────

/** Per-receptor component of the dopamine signal. */
export interface ReceptorDopamine {
  receptorId: string;
  predicted: number;
  actual: number;
  /** actual - predicted. Positive = pleasant surprise, negative = disappointment. */
  delta: number;
  /** From the prediction's confidence for this receptor. */
  confidence: number;
}

/**
 * The dopamine signal — reward prediction error.
 * The most information-rich signal in Cortex.
 */
export interface DopamineSignal {
  taskId: string;
  perReceptor: ReceptorDopamine[];
  /** Stake-weighted mean of per-receptor deltas, modulated by confidence. */
  aggregate: number;
  /** Unmodulated stake-weighted mean (for transparency). */
  rawAggregate: number;
  /** The prediction's overall confidence when it was made. */
  predictionConfidence: number;
}

// ─── Configuration ──────────────────────────────────────────────

/** Similarity function weights. Learnable by Plasticity in the future. */
export interface SimilarityWeights {
  senseJaccard: number;
  stakeDifference: number;
  receptorJaccard: number;
}

export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  senseJaccard: 0.33,
  stakeDifference: 0.33,
  receptorJaccard: 0.34,
};

export interface CerebellumConfig {
  /** Minimum similar episodes to produce a prediction. */
  minEpisodes: number;
  /** Maximum episodes to store before pruning oldest. */
  maxEpisodes: number;
  /** Top-k similar episodes to use for prediction. */
  topK: number;
  /** Minimum similarity threshold to consider an episode relevant. */
  similarityThreshold: number;
  /** Weights for the similarity function. */
  similarityWeights: SimilarityWeights;
  /** Recency weight decay: weight = 1 / (1 + rank * decayRate). */
  decayRate: number;
  /** Rolling window size for accuracy tracking. */
  accuracyWindowSize: number;

  // ── Revision prediction gating ─────────────────────────────
  /** Minimum predicted composite improvement to justify a revision cycle. */
  revisionDeltaThreshold: number;
  /** Minimum confidence to act on a revision-skip prediction. */
  revisionSkipConfidence: number;
}

export const DEFAULT_CEREBELLUM_CONFIG: CerebellumConfig = {
  minEpisodes: 2,
  maxEpisodes: 50,
  topK: 5,
  similarityThreshold: 0.2,
  similarityWeights: DEFAULT_SIMILARITY_WEIGHTS,
  decayRate: 0.1,
  accuracyWindowSize: 10,
  revisionDeltaThreshold: 0.5,
  revisionSkipConfidence: 0.6,
};

// ─── Failure mode prediction ──────────────────────────────────

/**
 * Predicted failure mode for a task, before building.
 * Produced by the Cerebellum from episode similarity matching.
 * Consumed by the Thalamus for preemptive briefing enrichment.
 */
export interface FailureModePrediction {
  /** Most likely failure category, or null if insufficient data / no clear winner. */
  predicted: import("./motor-cortex.js").FailureCategory | null;
  /** Probability per category (similarity-weighted votes, sums to ~1). */
  distribution: Record<string, number>;
  /** 0–1 confidence, based on episode count + vote share agreement. */
  confidence: number;
  /** How many episodes with failure data were considered. */
  episodesConsidered: number;
}

// ─── Accuracy tracking ─────────────────────────────────────────

/** One accuracy measurement, for the sliding window. */
export interface AccuracyRecord {
  taskId: string;
  /** Mean absolute error across matched receptors (0–9 scale, lower = better). */
  meanAbsoluteError: number;
  /** How many receptors were compared. */
  receptorCount: number;
  recordedAt: Date;
}

// ─── Speed of light ─────────────────────────────────────────────

/** Per-sense component of the speed of light. */
export interface SenseCeiling {
  senseName: string;
  senseId: string;
  stake: number;
  /** Theoretical max from the sense's domain expertise (1–10). */
  ceiling: number;
  /** Why — the physics. The inherent constraints. */
  ceilingRationale: string;
  /** Best score achieved on similar tasks (null if no history). */
  bestAchieved: number | null;
  /** ceiling - bestAchieved (null if no history). */
  gap: number | null;
}

/**
 * The speed of light — theoretical performance ceiling for a task.
 *
 * Computed from per-sense ceiling estimates (what physics allows)
 * enriched with historical best-achieved data (what we've actually done).
 * Flows into Thalamus briefings to calibrate planning and evaluation.
 */
export interface SpeedOfLight {
  taskId: string;
  /** Per-sense ceiling breakdown. */
  perSense: SenseCeiling[];
  /** Stake-weighted mean of per-sense ceilings. */
  compositeCeiling: number;
  /** Stake-weighted mean of per-sense best-achieved (null if insufficient history). */
  compositeBestAchieved: number | null;
  /** compositeCeiling - compositeBestAchieved (null if insufficient history). */
  compositeGap: number | null;
  /** Whether historical data exists for enrichment. */
  hasHistory: boolean;
  /** V2: approach-specific ceiling (present after approach classification). */
  approachSpecific?: ApproachCeiling;
  computedAt: Date;
}

/**
 * V2: approach-specific performance ceiling.
 *
 * After the premotor plans an approach, one LLM call classifies it
 * into archetype tags. Historical episodes with matching tags are
 * filtered to compute approach-specific best-achieved.
 *
 * If the approach class consistently underperforms the overall ceiling,
 * the approach is the bottleneck — rethink, don't optimize.
 */
export interface ApproachCeiling {
  approachTags: string[];
  /** Best scores achieved by this approach class on similar tasks. */
  perSense: Array<{ senseName: string; bestAchieved: number | null }>;
  /** Stake-weighted composite of approach-specific best-achieved. */
  compositeBestAchieved: number | null;
  /** How many approach-matched episodes contributed. */
  episodesConsidered: number;
  /** True when approach ceiling << overall ceiling. */
  approachIsBottleneck: boolean;
  /** Overall best-achieved - approach best-achieved. Positive = approach underperforms. */
  bottleneckGap: number | null;
}

// ─── Similarity match (internal but exported for testing) ───────

/** An episode scored by similarity and weighted by recency. */
export interface ScoredEpisode {
  episode: CerebellumEpisode;
  similarity: number;
  weight: number;
}
