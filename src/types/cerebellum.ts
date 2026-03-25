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
  /** Monotonically increasing, for recency weighting. */
  sequenceNumber: number;
  recordedAt: Date;
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
 * The most information-rich signal in the system.
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
}

export const DEFAULT_CEREBELLUM_CONFIG: CerebellumConfig = {
  minEpisodes: 2,
  maxEpisodes: 50,
  topK: 5,
  similarityThreshold: 0.2,
  similarityWeights: DEFAULT_SIMILARITY_WEIGHTS,
  decayRate: 0.1,
  accuracyWindowSize: 10,
};

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

// ─── Similarity match (internal but exported for testing) ───────

/** An episode scored by similarity and weighted by recency. */
export interface ScoredEpisode {
  episode: CerebellumEpisode;
  similarity: number;
  weight: number;
}
