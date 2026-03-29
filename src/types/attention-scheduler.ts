/**
 * Attention Scheduler — the PFC's decision function.
 *
 * The Scheduler is stateless. It reads a SchedulerSignals snapshot
 * and returns exactly one SchedulerAction. It doesn't hold state,
 * doesn't call the LLM, and doesn't drive loops. The brainstem's
 * task-dispatch rhythm calls it during its prepare phase; the rhythm
 * mechanically executes whatever the Scheduler decides.
 *
 * SchedulerSignals is the extensibility seam: future components
 * (Drift Monitor, Prospective Memory, Basal Ganglia) add optional
 * fields here without changing the decide() signature.
 */

import type { TaskGraphNode, VitalSigns, ConsolidationLoad } from "./brainstem.js";
import type {
  WMTask,
  ScoreTrend,
  OpenQuestion,
  EstablishedPattern,
  InhibitedSense,
} from "./working-memory.js";
import type { NEWeights, RiskFactors } from "./norepinephrine.js";

// ─── Scheduler Actions ──────────────────────────────────────────

/** The seven actions the Scheduler can return. Discriminated on `action`. */
export type SchedulerAction =
  | SchedulerDispatch
  | SchedulerEscalate
  | SchedulerRest
  | SchedulerReplan
  | SchedulerComplete
  | SchedulerGestate
  | SchedulerObserve;

export interface SchedulerDispatch {
  action: "dispatch-task";
  /** ID of the selected task from the graph. */
  taskId: string;
  /** Norepinephrine level for this task: 0–1. Higher = more thorough. */
  neLevel: number;
  /** Whether to leverage a known routine or explore divergent approaches. */
  mode: "explore" | "leverage";
  /** Why this task was selected over other ready tasks. */
  reasoning: string;
  /** Budget allocated for this task (dollars). Absent when no budget set. */
  taskBudget?: number;
  /** Frozen risk factors from dispatch — carried forward so enrichment sites don't re-derive from shifting sources. */
  riskSnapshot?: RiskFactors;
  /** Attention budget: task-specific cycle range. Replaces flat maxOuterCycles. */
  attentionBudget?: import("./attention-budget.js").AttentionBudget;
}

export interface SchedulerEscalate {
  action: "escalate";
  reason: string;
  source: "attention-scheduler";
  /** Specific questions for the human, if any. */
  questions: string[];
  /** What condition triggered this escalation. */
  escalationType: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
}

export interface SchedulerRest {
  action: "rest";
  reason: string;
}

export interface SchedulerReplan {
  action: "replan";
  reason: string;
  /** What specifically needs re-decomposition. */
  driftSummary: string;
}

export interface SchedulerComplete {
  action: "complete";
}

export interface SchedulerGestate {
  action: "dispatch-gestate";
  /** Which phase group needs nursery stress-testing. */
  phaseGroup: string;
  reason: string;
}

export interface SchedulerObserve {
  action: "observe";
  reason: string;
  /** Ambient NE level at decision time — modulates triage depth. */
  neLevel: number;
}

// ─── Scheduler Signals ──────────────────────────────────────────

/**
 * All signals the Scheduler considers. Assembled by task-dispatch.prepare()
 * each cycle and passed to decide() as a single snapshot.
 *
 * Required fields are available now. Optional fields are the seam
 * for future components — they add signal without changing the interface.
 */
export interface SchedulerSignals {
  // ── Available now ────────────────────────────────────────────

  /** The full task graph from the Planner (or human). */
  taskGraph: TaskGraphNode[];
  /** Tasks that have completed successfully. */
  completedTaskIds: Set<string>;
  /** Tasks that escalated (failed or deferred to human). */
  escalatedTaskIds: Set<string>;

  /** Snapshot of Working Memory state. */
  wmSnapshot: {
    tasks: WMTask[];
    senseTrends: ScoreTrend[];
    receptorTrends: ScoreTrend[];
    openQuestions: OpenQuestion[];
    patterns: EstablishedPattern[];
    inhibitedSenses: InhibitedSense[];
    /** WM load as a 0–1 vital sign. */
    load: number;
  };

  /** Current vital signs from HomeostasisMonitor. */
  vitals: VitalSigns;
  /** Whether the brainstem thinks a rest cycle is needed. */
  needsRest: boolean;
  /** Consolidation load breakdown. */
  consolidationLoad: ConsolidationLoad;

  // ── Wired later (all optional) ──────────────────────────────

  /** Cerebellum prediction accuracy (0–1). For NE maturity signal. */
  cerebellumAccuracy?: number;
  /** Drift Monitor (Phase 4): trajectory divergence 0–1. */
  driftLevel?: number;
  /** Drift Monitor: textual explanation when drift is high. */
  driftSummary?: string;
  /** Cognitive Flexibility (Phase 4): is the system perseverating? */
  perseverating?: boolean;
  /** Prospective Memory: triggered conditions per ready task. Keyed by taskId. */
  prospectiveTriggers?: Map<string, Array<{ id: string; description: string }>>;
  /** Basal Ganglia (Phase 3): routine match per ready task. */
  routineMatches?: Map<string, { confidence: number; routineId: string }>;

  // ── Cost budget signals ─────────────────────────────────────
  /** Project-level budget utilization (0–1). From CostTracker. */
  budgetUtilization?: number;
  /** Per-task budget context. Keyed by taskId. */
  taskBudgets?: Map<string, { allocated: number; spent: number; remaining: number }>;
  /** Whether the project budget is exhausted (depends on enforcement mode). */
  budgetExhausted?: boolean;

  // ── Proactive Discovery signals ───────────────────────────────
  /** Territory observation pressure (0–1). From WM.getObservationPressure(). */
  observationPressure?: number;

  // ── Exteroception signals ──────────────────────────────────────
  /** Exteroceptive signal pressure (0–1). From ExteroceptionSystem.getSignalPressure(). */
  exteroceptivePressure?: number;

  // ── NE recency-of-failure signal ────────────────────────────
  /** Last completed task's aggregate dopamine. Negative = recent failure → heightened NE. */
  lastTaskDopamine?: number;
  /** Most recent NE level from the last dispatched task. For observe threshold computation. */
  lastNELevel?: number;

  // ── NE human urgency signal ────────────────────────────────
  /** Mapped human urgency (0–1). From ProjectIntent.urgency via mapUrgencyToNE(). */
  humanUrgency?: number;

  // ── Homeostasis PFC flags ───────────────────────────────────
  /** PFC intervention flags from homeostasis (learning signal degraded, tonic dopamine crashed, identity drift). */
  pfcFlags?: Array<{
    type: "learning-signal-degraded" | "tonic-dopamine-crashed" | "weight-displacement-high";
    reason: string;
  }>;

  // ── Nursery signals ───────────────────────────────────────────
  /** Phase groups awaiting nursery graduation (detected runtime surface, not yet graduated). */
  nurseryPendingPhases?: Set<string>;
  /** Phase groups that have graduated from the nursery. */
  nurseryGraduatedPhases?: Set<string>;
}

// ─── Scheduler Config ───────────────────────────────────────────

/** Tuning knobs for the Scheduler's decision logic. */
export interface SchedulerConfig {
  /** Below this mean score across recent tasks, escalate. */
  scoreFloorThreshold: number;
  /** If more than this fraction of sense trends are "down", escalate. */
  crateringThreshold: number;
  /** Drift level at or above this triggers replan. */
  driftReplanThreshold: number;
  /** Drift level at or above this triggers escalation. */
  driftEscalateThreshold: number;
  /** Maximum unresolved open questions before escalation. */
  maxOpenQuestions: number;
  /** Override NE signal weights (partial — missing keys use defaults). */
  neWeights?: Partial<NEWeights>;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  scoreFloorThreshold: 4.0,
  crateringThreshold: 0.5,
  driftReplanThreshold: 0.8,
  driftEscalateThreshold: 0.5,
  maxOpenQuestions: 3,
};
