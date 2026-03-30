/**
 * Working Memory — active scratchpad, not long-term storage.
 *
 * Holds what's "in mind right now" across tasks within a project:
 * established patterns, score trends, key decisions, inhibited senses,
 * open questions. Persists across tasks but not across projects.
 *
 * The primary consumers are the Thalamus (reads everything to assemble
 * briefings) and the Attention Scheduler (reads task status + trends to
 * decide what happens next). See diagrams/working-memory-connections.mmd
 * for the full connection map across all 28 features.
 *
 * Score data is stored at the receptor level (ground truth for actionable
 * signals) and aggregated to the sense level on demand (meta-interpretation).
 * Each ScoreEntry carries its own activationPath so WM never depends on
 * SensoryCortex — the data is self-describing.
 *
 * Task dependencies are NOT tracked here — brainstem.ts defines
 * TaskGraphNode with dependsOn. WM tracks task status and summaries;
 * the Scheduler reads both WM and the brainstem's task graph.
 *
 * The brainstem monitors WM load as a vital sign. When load is high,
 * items get promoted to Hippocampus or pruned during rest cycles.
 */

import type { DecisionRecord } from "./intent.js";
import type { TerritoryObservation } from "./territory-observation.js";

// ─── Score tracking ─────────────────────────────────────────────

/**
 * A single receptor's score from one evaluation.
 * The activationPath carries the full ancestry so consumers can
 * group by any level without needing the sense tree.
 */
export interface ScoreEntry {
  /** The receptor that produced this score (SenseEvaluation.senseId). */
  receptorId: string;
  /**
   * Self-describing ancestry from root sense to receptor.
   * e.g. ["DESIGN", "Visual Identity", "Color Harmony"]
   * Index 0 is always the top-level sense name.
   */
  activationPath: string[];
  /** 1–10 score from the receptor's evaluation. */
  score: number;
  /** Stake inherited from the parent sense's consultation (0–1). */
  stake: number;
}

/**
 * All receptor scores from one completed task.
 * One snapshot per task, appended chronologically.
 */
export interface ScoreSnapshot {
  taskId: string;
  scores: ScoreEntry[];
  recordedAt: Date;
}

/** Direction a score is trending across tasks. */
export type TrendDirection = "up" | "stable" | "down";

/**
 * Computed trend for a single receptor or sense across tasks.
 * Not stored — computed on demand from scoreHistory.
 *
 * The split-halves algorithm compares the mean of the earlier half
 * of data points against the more recent half, with a 0.5-point
 * threshold on the 10-point scale.
 */
export interface ScoreTrend {
  /** Receptor ID (for receptor trends) or sense name (for sense trends). */
  id: string;
  /** Human-readable label — receptor name or sense name. */
  label: string;
  /** Whether this trend is per-receptor (ground truth) or per-sense (aggregated). */
  level: "receptor" | "sense";
  direction: TrendDirection;
  /** Mean of the more recent half of data points. */
  currentMean: number;
  /** Mean of the earlier half of data points. */
  previousMean: number;
  /** How many tasks contributed scores for this receptor/sense. */
  dataPoints: number;
}

// ─── Oscillation detection ───────────────────────────────────────

/**
 * A receptor whose score swung significantly between build cycles
 * within a single task. Indicates possible thrashing or collateral
 * damage from revisions targeting other dimensions.
 */
export interface OscillationSignal {
  receptorId: string;
  activationPath: string[];
  /** Scores across consecutive snapshots showing the swing. */
  recentScores: number[];
  /** Max absolute difference between consecutive scores. */
  swingMagnitude: number;
}

// ─── Conviction ledger ──────────────────────────────────────────

/** A conviction result recorded in WM's ledger. */
export interface ConvictionEntry {
  /** Categorical verdict from the conviction loop. */
  verdict: "proceed" | "reshape" | "escalate";
  /** Continuous conviction level (0–1). */
  level: number;
  /** Change from previous conviction. */
  delta: number;
  /** Which step in the pipeline produced the verdict. */
  decidingStep: "necessity" | "conviction" | "speed-of-light";
  /** Which task triggered this conviction check (null for dispatch-level). */
  taskId: string | null;
  /** Which replan generation (0 = original plan, 1 = first replan, etc). */
  replanGeneration: number;
  recordedAt: Date;
}

/** Computed trajectory over the conviction ledger. */
export interface ConvictionTrajectory {
  /** All recorded levels in chronological order. */
  levels: number[];
  /** Split-halves direction (up/stable/down) using conviction-scale threshold. */
  direction: TrendDirection;
  /** Most recent conviction level. */
  currentLevel: number;
  /** Number of distinct replan generations in the ledger. */
  generationCount: number;
  /** Per-generation mean conviction level. */
  generationMeans: Array<{ generation: number; meanLevel: number; entryCount: number }>;
}

// ─── Task tracking ──────────────────────────────────────────────

export type WMTaskStatus = "pending" | "active" | "complete" | "failed";

/**
 * Summary extracted from OrchestratorResult at task completion.
 * The full OrchestratorResult is not retained in WM — that's the
 * Hippocampus's job (Phase 3). WM keeps only what's needed for
 * trends, scheduling, and briefings.
 */
export interface TaskSummary {
  cycles: number;
  confidence: number;
  /** Weighted mean of evaluation scores (stake-weighted). */
  weightedMean: number;
  /** Count of tensions with severity "high". */
  highTensionCount: number;
  completedAt: Date;
}

/** A task known to Working Memory. */
export interface WMTask {
  taskId: string;
  description: string;
  status: WMTaskStatus;
  startedAt?: Date;
  /** Present only after the task completes successfully. */
  summary?: TaskSummary;
}

// ─── Patterns ───────────────────────────────────────────────────

/**
 * An observation about what Cortex has established.
 * Minimal by design — no categories, no structure. The description
 * is freeform natural language. Detection mechanism is left to
 * emerge from the implementation; callers invoke recordPattern()
 * when they notice something worth remembering.
 */
export interface EstablishedPattern {
  id: string;
  /** Freeform description, e.g. "Dark + bold visual language". */
  description: string;
  establishedAt: Date;
  /** How confident Cortex is that this pattern holds. 0–1. */
  confidence: number;
}

// ─── Open questions ─────────────────────────────────────────────

/**
 * A question that needs answering — for the Parsifal or for future tasks.
 * Created by escalation pathways, amygdala urgency, or any component
 * that surfaces an unresolved issue.
 */
export interface OpenQuestion {
  id: string;
  question: string;
  /** Why this question matters — what prompted it. */
  context: string;
  askedAt: Date;
  resolvedAt?: Date;
  answer?: string;
}

// ─── Inhibition ─────────────────────────────────────────────────

/**
 * A sense or receptor that has been suppressed.
 * Tracks who suppressed it and why so the Thalamus can explain
 * suppressions in briefings and the Basal Ganglia can distinguish
 * its own suppressions from Amygdala overrides.
 */
export interface InhibitedSense {
  senseId: string;
  /** Why this sense is suppressed, e.g. "scalability irrelevant for a 5-page site". */
  reason: string;
  /** Who requested the inhibition, e.g. "planner", "amygdala", "basal-ganglia". */
  source: string;
  /**
   * Scope level for hierarchical cleanup. When a scope boundary is crossed,
   * inhibitions at that scope + narrower are cleared and re-evaluated.
   * Undefined for non-inhibitor sources (e.g. amygdala overrides).
   */
  scope?: string;
  inhibitedAt: Date;
}

// ─── Full state ─────────────────────────────────────────────────

/**
 * The complete serializable state of Working Memory.
 *
 * Future additions (single fields, trivially addable):
 * - predictions: ScoreTrend[]  — cerebellum forward models (Phase 3)
 * - dopamineSignal: number     — last surprise magnitude (Phase 3)
 */
export interface WorkingMemoryState {
  projectId: string;
  /** All tasks WM knows about, in insertion order. */
  tasks: WMTask[];
  /** Which task is currently executing (null between tasks). */
  currentTaskId: string | null;
  /** Raw score history — one snapshot per completed task, chronological. */
  scoreHistory: ScoreSnapshot[];
  /** Key decisions made across tasks. Reuses DecisionRecord from intent.ts. */
  decisions: DecisionRecord[];
  /** Patterns Cortex has established. */
  patterns: EstablishedPattern[];
  /** Senses currently inhibited. */
  inhibitedSenses: InhibitedSense[];
  /** Questions awaiting resolution. */
  openQuestions: OpenQuestion[];
  /** Conviction results across tasks and replan generations. */
  convictionLedger: ConvictionEntry[];
  /** Territory observations from builder/evaluator. Separate from WM load. */
  observations: TerritoryObservation[];
  /** Timestamp of the most recent mutation. */
  lastUpdated: Date;
}
