/**
 * Hippocampus — episodic memory + potentiation types.
 *
 * The hippocampus transforms experience into understanding through two
 * operations:
 *
 *   Feature 14 (Episodic Memory): Record the story of each task — not
 *   just scores, but what approaches were tried, how tensions were
 *   resolved, what decisions were made, and how surprising the outcome
 *   was. Per-sense queryable. Significance-weighted by dopamine.
 *
 *   Feature 15 (Potentiation): Extract living, revisable principles
 *   from clusters of episodes. Principles strengthen through confirming
 *   evidence (potentiation), weaken through contradictions
 *   (depotentiation), and can be refined or superseded.
 *
 * Episodes are project-scoped (they happened in a specific context).
 * Principles are cross-project (they transfer to new situations).
 * The hippocampus feeds the Thalamus, never consumers directly.
 */

// ─── Episode (Feature 14) ──────────────────────────────────────

/**
 * The narrative-structured record of one completed task.
 * Not a raw data dump — structured extraction at recording time
 * that makes the story legible for potentiation and Thalamus queries.
 */
export interface Episode {
  id: string;
  taskId: string;
  projectId: string;

  /** The structured story of what happened. */
  narrative: EpisodeNarrative;

  /** Per-sense view of this episode. */
  senseParticipation: SenseParticipationRecord[];

  /**
   * Aggregate dopamine signal from the cerebellum.
   * Positive = pleasant surprise, negative = disappointment.
   * Zero = outcome matched prediction exactly.
   */
  dopamineSignal: number;

  /**
   * Derived from |dopamineSignal|, normalized to 0–1.
   * Higher = more important episode. Zero = expected, boring outcome.
   */
  significance: number;

  /** Principle IDs that were extracted using this episode. */
  potentiatedBy: string[];

  /**
   * True if narrative details have been pruned after potentiation.
   * Faded episodes keep metadata + sense participation but lose
   * detailed narrative content. The principle carries the weight.
   *
   * Episodes contradicting existing principles must NOT fade.
   */
  faded: boolean;
  fadedAt?: Date;

  /**
   * IDs of principles this episode contradicts. Non-empty means
   * this episode is evidence against an existing theory.
   * Contradiction-tagged episodes are protected from fading.
   */
  contradicts: string[];

  recordedAt: Date;

  /** Monotonically increasing for ordering. */
  sequenceNumber: number;
}

/** The structured story of what happened during a task. */
export interface EpisodeNarrative {
  /** What the task was about. */
  taskDescription: string;

  /** How many build-evaluate cycles ran. */
  cycles: number;

  /** Final status. */
  outcome: "complete" | "needs_revision" | "needs_parsifal";

  /** Final composite confidence (0–1). */
  confidence: number;

  /**
   * Score snapshots across cycles. Currently only final cycle
   * is captured (OrchestratorResult doesn't carry per-cycle history).
   * The array structure anticipates future multi-cycle tracking.
   */
  scoreProgression: ScoreProgressionEntry[];

  /** Key decisions made during the task. */
  decisions: DecisionSnapshot[];

  /** Tensions that emerged and how they were resolved. */
  tensionSnapshots: TensionSnapshot[];

  /**
   * High-level description of approaches tried, derived from
   * the decision log. Captures strategy shifts between cycles.
   * e.g. ["card grid layout", "switched to accordion after low scores"]
   */
  approachesTried: string[];
}

/** One cycle's evaluation snapshot for score progression tracking. */
export interface ScoreProgressionEntry {
  cycle: number;
  scores: ScoreProgressionScore[];
  /** Composite confidence at this cycle. */
  overallConfidence: number;
}

export interface ScoreProgressionScore {
  senseId: string;
  senseName: string;
  score: number;
  acceptable: boolean;
}

/**
 * Simplified decision record for episode storage.
 * Stripped from the full DecisionRecord — keeps what matters
 * for understanding the story, drops what's only useful live.
 */
export interface DecisionSnapshot {
  description: string;
  reasoning: string;
  confidence: number;
}

/** How a tension was handled during the task. */
export interface TensionSnapshot {
  senseA: string; // sense name, not ID
  senseB: string;
  description: string;
  severity: "low" | "medium" | "high";
  resolution?: {
    strategy: string;
    satisfiesBoth: boolean;
  };
  /** Measured outcome: did the resolution actually work? Added by Resolution Rework (#13). */
  outcome?: {
    quality: number;
    gapShrinkage: number;
    scoresMaintained: boolean;
    collapsed: boolean;
  };
}

/**
 * What each sense experienced during this episode.
 * Per-sense queryable — the Thalamus can ask "what has Design
 * experienced across this project?" and get these records.
 */
export interface SenseParticipationRecord {
  senseId: string;
  senseName: string;
  /** Self-assessed relevance to the task (0–1). */
  stake: number;
  /** Mean of receptor scores for this sense. */
  finalScore: number;
  /** Whether this sense considered the work adequate. */
  acceptable: boolean;
  /** Per-receptor detail. */
  receptorScores: { receptorId: string; score: number }[];
  /** The sense's assessment text. */
  assessment: string;
}

// ─── Principle (Feature 15) ─────────────────────────────────────

/**
 * A living theory extracted from episode clusters.
 *
 * Principles are DESCRIPTIVE, not prescriptive:
 *   "Fragmented layouts underperform for scope-heavy content
 *    because users need to see full scope before committing."
 *   NOT: "You should prefer consolidated layouts."
 *
 * Principles strengthen through confirming evidence (potentiation),
 * weaken through contradictions (depotentiation), and can be
 * refined or superseded. They are working theories, not facts.
 */
export interface Principle {
  id: string;

  /** Human-readable statement of the principle. */
  statement: string;

  /** Which sense(s) this principle is most relevant to. */
  relevantSenses: string[];

  /**
   * The kind of pattern this principle describes.
   * e.g., "layout-strategy", "evaluation-dynamics", "tension-resolution"
   */
  domain: string;

  /**
   * Distinguishes transferable insights from project-local understanding.
   *
   * - "cross-project": Extracted from episode clusters, transfers to new
   *   situations. e.g. "fragmented layouts underperform for scope-heavy content"
   * - "project-sense": What a specific sense has learned about a specific
   *   project. e.g. "dark/bold palette established, image-heavy pages are risky
   *   for this client". Scoped to extractionContext.projectId + senseId.
   */
  scope: "cross-project" | "project-sense";

  /**
   * Confidence in this principle (0–1).
   * Strengthens with supporting evidence, weakens with contradictions.
   */
  confidence: number;

  /** Episodes that confirmed this principle. */
  supportingEvidence: EvidenceRef[];

  /** Episodes that contradicted this principle. */
  contradictingEvidence: EvidenceRef[];

  /** If this principle replaced an older, less nuanced one. */
  supersedes?: string;

  /** If a newer principle replaced this one. */
  supersededBy?: string;

  extractedAt: Date;

  /** Last time evidence was added (supporting or contradicting). */
  lastUpdated: Date;

  /** Context of the potentiation cycle that produced this. */
  extractionContext: ExtractionContext;

  /**
   * Sense verification results — populated when relevant senses
   * review a principle before storage. Consensus modulates confidence.
   */
  senseVerification?: {
    results: Array<{ senseId: string; senseName: string; agreement: number; assessment: string }>;
    consensus: number;
    verifiedAt: Date;
  };
}

/** Reference to an episode that serves as evidence for a principle. */
export interface EvidenceRef {
  episodeId: string;
  projectId: string;
  taskId: string;
  /** Brief note on how this episode relates to the principle. */
  relevance: string;
  addedAt: Date;
}

/** Context of the potentiation cycle that produced a principle. */
export interface ExtractionContext {
  /** Episode IDs that were clustered for extraction. */
  episodeIds: string[];
  /** What triggered potentiation. */
  trigger: PotentiationTrigger;
  /** Which project the potentiation ran in. */
  projectId: string;
  /**
   * For project-sense scoped principles: which sense's perspective
   * this principle captures. Undefined for cross-project principles.
   */
  senseId?: string;
}

// ─── Potentiation triggers ──────────────────────────────────────

/**
 * What triggered a potentiation cycle. Three possible causes:
 *
 * - pattern-density: enough similar episodes accumulated
 * - surprise: a large dopamine signal demands explanation
 * - contradiction: evidence against an existing principle
 */
export type PotentiationTrigger =
  | PatternDensityTrigger
  | SurpriseTrigger
  | ContradictionTrigger;

export interface PatternDensityTrigger {
  type: "pattern-density";
  /** How many episodes are in the cluster. */
  episodeCount: number;
  /** What the episodes have in common. */
  similarity: string;
}

export interface SurpriseTrigger {
  type: "surprise";
  /** The dopamine signal that triggered this. */
  dopamineSignal: number;
  /** Which task produced the surprise. */
  taskId: string;
}

export interface ContradictionTrigger {
  type: "contradiction";
  /** The principle being contradicted. */
  principleId: string;
  /** The episode that contradicts it. */
  contradictingEpisodeId: string;
}

// ─── Clustering (internal to potentiation) ──────────────────────

/** A group of similar episodes ready for principle extraction. */
export interface EpisodeCluster {
  /** Episode IDs in this cluster. */
  episodeIds: string[];
  /** The episodes themselves. */
  episodes: Episode[];
  /** What these episodes have in common (for the LLM prompt). */
  commonality: string;
  /** Sum of episode significance values. */
  totalSignificance: number;
}

/** A detected contradiction between an episode and a principle. */
export interface PrincipleContradiction {
  principle: Principle;
  contradictingEpisode: Episode;
  /** Which senses show divergence from the principle's claims. */
  divergentSenses: string[];
}

// ─── Configuration ──────────────────────────────────────────────

/**
 * Hippocampus configuration — mechanism parameters, NOT value
 * judgments. These control how fast potentiation runs and how
 * much is stored, not what Cortex should care about.
 * The Hole: build the mechanism, not the content.
 */
export interface HippocampusConfig {
  /** Maximum episodes stored per project before oldest faded get pruned. */
  maxEpisodesPerProject: number;
  /** Maximum total episodes across all projects. */
  maxTotalEpisodes: number;
  /** Minimum episodes in a cluster for pattern-density potentiation. */
  minClusterSize: number;
  /** |dopamine| above this triggers surprise-based potentiation. */
  surpriseThreshold: number;
  /** Minimum confidence for a principle to be included in briefings. */
  minPrincipleConfidence: number;
  /** How much confidence a principle gains per confirming episode. */
  confirmationIncrement: number;
  /** How much confidence a principle loses per contradicting episode. */
  contradictionDecrement: number;
  /** Below this confidence, a principle is considered dead (not deleted, just inactive). */
  principleDeathThreshold: number;
  /** Where to persist data. Defaults to ~/.agent-cortex/hippocampus/ */
  storageDir: string;
  /** Model to use for potentiation LLM calls. */
  potentiationModel: string;
}

export const DEFAULT_HIPPOCAMPUS_CONFIG: HippocampusConfig = {
  maxEpisodesPerProject: 100,
  maxTotalEpisodes: 500,
  minClusterSize: 3,
  surpriseThreshold: 2.0,
  minPrincipleConfidence: 0.3,
  confirmationIncrement: 0.1,
  contradictionDecrement: 0.15,
  principleDeathThreshold: 0.1,
  storageDir: "", // Set at runtime — resolved to ~/.agent-cortex/hippocampus/
  potentiationModel: "claude-sonnet-4-6-20250514",
};

// ─── Persistence metadata ───────────────────────────────────────

/** Metadata persisted alongside episodes and principles. */
export interface HippocampusMeta {
  sequenceCounter: number;
  lastPotentiationAt?: Date;
  lastSaveAt?: Date;
}

// ─── Snapshot (for dashboard/debugging) ─────────────────────────

export interface HippocampusState {
  totalEpisodes: number;
  episodesByProject: Record<string, number>;
  unpotentiatedEpisodes: number;
  fadedEpisodes: number;
  totalPrinciples: number;
  activePrinciples: number;
  deadPrinciples: number;
  supersededPrinciples: number;
  episodeDensity: number;
  lastPotentiationAt?: Date;
  recentEpisodes: Array<{
    id: string;
    taskId: string;
    projectId: string;
    significance: number;
    dopamineSignal: number;
    faded: boolean;
    senseCount: number;
    cycles: number;
    outcome: string;
  }>;
  recentPrinciples: Array<{
    id: string;
    statement: string;
    confidence: number;
    relevantSenses: string[];
    supportingCount: number;
    contradictingCount: number;
    active: boolean;
  }>;
}

// ─── LLM output schemas (for potentiation) ──────────────────────

/** What the LLM returns when extracting a principle from a cluster. */
export interface PrincipleExtractionResult {
  principle: {
    statement: string;
    relevantSenses: string[];
    domain: string;
    confidence: number;
    /** ID of principle this supersedes, or null. */
    supersedes: string | null;
  } | null;
  reasoning: string;
}

/** What the LLM returns when refining a contradicted principle. */
export interface PrincipleRefinementResult {
  action: "refine" | "replace" | "maintain";
  revisedStatement?: string;
  revisedConfidence: number;
  reasoning: string;
}
