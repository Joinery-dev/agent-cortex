/**
 * Brainstem — the vital rhythm.
 *
 * The brainstem does three things:
 *
 * 1. RHYTHM — defines the nested loop levels that drive all work.
 *    Known levels (inner to outer):
 *      build-cycle       → premotor plan → primary produce → proprioception → accept/revise
 *      sensory-cortex    → consult → explore? → build-cycle → evaluate → resolve
 *      task-dispatch     → pick task → sensory-cortex → between-tasks → next/done
 *      project           → intake → planning → task-dispatch → completion
 *
 * 2. HOMEOSTASIS — monitors vital signs and takes corrective action below
 *    the level of executive function. Working memory pressure, prediction
 *    accuracy, learning signal health, context capacity. If any vital sign
 *    falls out of range, the brainstem acts before the PFC even knows.
 *
 * 3. REST — inserts consolidation cycles when the system has accumulated
 *    enough unprocessed load. Like sleep: not a timer, but load-triggered.
 *    Norepinephrine at zero. No task execution. The system turns inward:
 *    potentiate episodes, prune working memory, decay weak connections,
 *    recalibrate prediction models.
 *
 * New rhythm levels can be added without changing this file — any component
 * can define a RhythmDefinition and hand it to the runner.
 */

import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { Task } from "./task.js";
import type { OrchestratorResult } from "./orchestrator.js";
import type { Consultation } from "./consultation.js";
import type { SenseEvaluation } from "./sense.js";
import type { Tension, TensionResolution } from "./tension.js";
import type { MotorPlan, SelfAssessment } from "./motor-cortex.js";
import type { Intention } from "./pns.js";

// ─── Project state ──────────────────────────────────────────────

/**
 * The project-level state machine. These are the states the
 * brainstem's outermost rhythm moves through.
 *
 * intake      → brief + intent + taste received, not yet decomposed
 * planning    → planner (or human) is decomposing into task graph
 * executing   → task-dispatch rhythm is running
 * paused      → interrupted (escalation, hard interrupt, awaiting human)
 * completing  → final integration check, retrospective
 * delivered   → done, results handed off
 */
export type ProjectState =
  | "intake"
  | "planning"
  | "executing"
  | "paused"
  | "completing"
  | "delivered";

// ─── Rhythm-level context types ─────────────────────────────────

/** What the project rhythm needs to start. */
export interface ProjectContext {
  intent: ProjectIntent;
  taste: TasteProfile;
  /** Task graph — provided by Planner or directly by human. */
  tasks: TaskGraphNode[];
}

/** A node in the task dependency graph. */
export interface TaskGraphNode {
  task: Task;
  /** IDs of tasks that must complete before this one can start. */
  dependsOn: string[];
  /** Which phase gate group this belongs to (for integration checks). */
  phaseGroup?: string;
}

/** What the task-dispatch rhythm needs to start. */
export interface TaskDispatchContext {
  intent: ProjectIntent;
  taste: TasteProfile;
  graph: TaskGraphNode[];
}

/** What the sensory-cortex rhythm needs to start. */
export interface SensoryCortexContext {
  task: Task;
  intent: ProjectIntent;
  taste: TasteProfile;
  /** NE level from Attention Scheduler, for inhibition + consultation conditions. */
  neLevel?: number;
  /** Explore/exploit mode from Attention Scheduler. */
  mode?: "explore" | "exploit";
}

/** What the build-cycle rhythm needs to start. */
export interface BuildCycleContext {
  task: Task;
  consultation: Consultation;
  intent: ProjectIntent;
  taste: TasteProfile;
  /** The prompt assembled from consultation. */
  basePrompt: string;
  /** Previous work, if this is a revision cycle. */
  previousWork?: string;
  /** Norepinephrine level from Attention Scheduler, for gate strategy selection. */
  neLevel?: number;
}

// ─── Rhythm-level result types ──────────────────────────────────

/** What the project rhythm produces. */
export interface ProjectResult {
  state: "delivered" | "paused";
  taskResults: Map<string, OrchestratorResult>;
  retrospective?: string;
}

/** What task-dispatch produces — all tasks done or escalated. */
export interface TaskDispatchResult {
  completedTasks: string[];
  escalatedTasks: string[];
  taskResults: Map<string, OrchestratorResult>;
}

/**
 * What the sensory-cortex rhythm produces. Aliased to OrchestratorResult
 * because the sensory-cortex IS the task-level orchestrator — same inputs,
 * same outputs. The alias exists so rhythm code reads in brain-metaphor
 * terms while the external API stays stable.
 */
export type SensoryCortexResult = OrchestratorResult;

/** What the build-cycle rhythm produces. */
export interface BuildCycleResult {
  work: string;
  /** The premotor plan that guided the build. */
  plan: MotorPlan;
  /** Proprioception self-check (absent if skipped). */
  selfAssessment?: SelfAssessment;
  /** Structured record of what the build intended to do. */
  intentions: Intention[];
  evaluations: SenseEvaluation[];
  tensions: Tension[];
  resolutions: TensionResolution[];
  cycles: number;
  accepted: boolean;
  /** Weighted composite confidence (0–1). From evaluation weighter. */
  confidence: number;
}

// ─── Between-tasks processing ───────────────────────────────────

/**
 * What happens between tasks. Two paths:
 *
 * Fast path (runs after every task):
 *   - Dopamine signal: cerebellum predicted vs. actual eval scores
 *   - Hippocampus: record episode
 *   - Working memory: update patterns, score trends
 *   - Basal ganglia: strengthen/weaken routine match
 *
 * Slow path (runs at phase gates — when a phaseGroup completes):
 *   - Integration check across all artifacts in the phase
 *   - Deeper drift analysis (trajectory vs. original intent)
 *   - Crystallization opportunity (enough episodes accumulated?)
 *   - Potential re-planning if drift is significant
 */
export interface BetweenTasksFastPath {
  taskId: string;
  /** Prediction error: cerebellum.predicted - sensory.actual */
  dopamineSignal?: number;
  episodeRecorded: boolean;
  workingMemoryUpdated: boolean;
  routineUpdated: boolean;
}

export interface BetweenTasksSlowPath {
  phaseGroup: string;
  integrationCheckPassed: boolean;
  integrationIssues: string[];
  driftDetected: boolean;
  driftSeverity?: "low" | "medium" | "high";
  crystallizationTriggered: boolean;
  replanRequired: boolean;
}

export type BetweenTasksResult =
  | { path: "fast"; data: BetweenTasksFastPath }
  | { path: "slow"; data: BetweenTasksFastPath & BetweenTasksSlowPath };

// ─── Escalation ─────────────────────────────────────────────────

/**
 * The four escalation routes to the human.
 * Each source maps to a brain region, each has different urgency semantics.
 */
export type EscalationSource =
  | "drift-monitor"        // PFC — trajectory divergence
  | "attention-scheduler"  // PFC — proposals, prospective questions
  | "cognitive-flexibility" // PFC — strategy failure, perseveration
  | "amygdala";            // Subcortical — urgent override

export interface Escalation {
  id: string;
  source: EscalationSource;
  /** Which rhythm was interrupted. */
  rhythmId: string;
  /** Severity determines soft vs hard interrupt. */
  severity: "advisory" | "blocking" | "urgent" | "emergency";
  summary: string;
  detail: string;
  /** What the system needs from the human to continue. */
  question?: string;
  /** Options the system has identified, if any. */
  proposedActions?: string[];
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
}

/**
 * Maps escalation severity to interrupt mode.
 * advisory + blocking = soft (wait for gate)
 * urgent + emergency = hard (freeze immediately)
 */
export function escalationToInterruptMode(
  severity: Escalation["severity"],
): "soft" | "hard" {
  switch (severity) {
    case "advisory":
    case "blocking":
      return "soft";
    case "urgent":
    case "emergency":
      return "hard";
  }
}

// ─── Vital signs (homeostasis) ──────────────────────────────────

/**
 * The brainstem continuously monitors these. They're not metrics for
 * the PFC to deliberate over — they're reflexes. When a vital sign
 * leaves its range, the brainstem acts automatically:
 *
 * - workingMemoryLoad high   → trigger rest cycle (prune/promote)
 * - predictionAccuracy low   → trigger rest cycle (recalibrate cerebellum)
 * - contextCapacity critical → evict lowest-relevance context (breathing)
 * - learningSignalHealth low → flag for PFC (something is wrong, not fixable by reflex)
 */
export interface VitalSigns {
  /**
   * How full working memory is. 0–1.
   * High = too many patterns/decisions/conventions accumulated without
   * promotion to hippocampus or pruning. The scratchpad is noisy.
   */
  workingMemoryLoad: number;

  /**
   * How accurate the cerebellum's predictions have been recently. 0–1.
   * Rolling accuracy over the last N tasks. Low = the forward models
   * are stale and need holistic recalibration, not just per-error correction.
   */
  predictionAccuracy: number;

  /**
   * How much of the available context window is consumed. 0–1.
   * This is the breathing reflex — when it gets too high, the brainstem
   * evicts low-relevance context without asking the PFC. Survival function.
   */
  contextCapacity: number;

  /**
   * Are learning signals flowing and producing convergent updates? 0–1.
   * Low = dopamine is firing but weights aren't stabilizing, or
   * crystallization keeps contradicting itself. The system is churning
   * without learning. Brainstem flags this for PFC because it can't
   * fix a broken learning loop by reflex.
   */
  learningSignalHealth: number;

  /**
   * How volatile plastic connection weights have been recently. 0–1.
   * High = weights are oscillating instead of converging. The system
   * hasn't stabilized what it's learning. Triggers rest for decay/settling.
   */
  weightVolatility: number;

  /**
   * Tonic dopamine level for the current project. Mapped to 0–1 for
   * homeostasis (raw tonic is unbounded). Reflects overall reward
   * environment: 0.5 = neutral, < 0.5 = project disappointing,
   * > 0.5 = project exceeding expectations.
   *
   * Persistently low → flag PFC (something systematic is wrong).
   */
  tonicDopamine: number;
}

export interface VitalSignThresholds {
  /** Above this → brainstem considers rest. */
  workingMemoryLoad: number;
  /** Below this → brainstem considers rest. */
  predictionAccuracy: number;
  /** Above this → brainstem evicts context (reflex, not rest). */
  contextCapacity: number;
  /** Below this → brainstem flags for PFC attention. */
  learningSignalHealth: number;
  /** Above this → brainstem considers rest. */
  weightVolatility: number;
  /** Below this → brainstem flags for PFC (project persistently disappointing). */
  tonicDopamine: number;
}

export const DEFAULT_VITAL_THRESHOLDS: VitalSignThresholds = {
  workingMemoryLoad: 0.8,
  predictionAccuracy: 0.4,
  contextCapacity: 0.9,
  learningSignalHealth: 0.3,
  weightVolatility: 0.7,
  tonicDopamine: 0.25,
};

// ─── Consolidation load (rest trigger) ──────────────────────────

/**
 * The pressure signals that determine whether the brainstem inserts
 * a rest cycle instead of dispatching the next task. Rest happens
 * when the system NEEDS it, not on a schedule.
 *
 * Each signal is 0–1. The brainstem combines them (weighted sum,
 * max, or threshold count — TBD during implementation) and compares
 * against restThreshold.
 */
export interface ConsolidationLoad {
  /**
   * Uncrystallized episodes. How many raw task stories sit in the
   * hippocampus without principles extracted. High = the system has
   * lots of experience but hasn't made sense of it yet.
   */
  episodeDensity: number;

  /**
   * Working memory overflow pressure. Same signal as the vital sign,
   * but interpreted differently: vital sign triggers reflex eviction,
   * consolidation load triggers deliberate promotion/pruning during rest.
   */
  memoryPressure: number;

  /**
   * Cerebellum prediction drift. Not just "inaccurate on the last task"
   * but "systematically miscalibrated across recent tasks." Needs
   * holistic recalibration, not per-error adjustment.
   */
  predictionDrift: number;

  /**
   * Plastic connection instability. Weights changing rapidly without
   * converging. The system needs time to settle — decay weak connections,
   * let strong ones stabilize.
   */
  weightInstability: number;

  /**
   * Unprocessed between-tasks backlog. If slow-path processing (phase
   * gate checks, deep drift analysis) has been deferred, it accumulates
   * here. Rest is when it gets handled.
   */
  deferredProcessing: number;
}

// ─── Rest cycle ─────────────────────────────────────────────────

/**
 * Rest is a rhythm like any other — same four phases:
 *   prepare:   thalamus assembles what needs consolidating
 *   execute:   run consolidation processes
 *   integrate: update stores with consolidated results
 *   gate:      is the load resolved, or do we need more rest?
 *
 * Norepinephrine drops to zero during rest. No task execution.
 * The system turns inward.
 */

/** What the rest rhythm needs to start. */
export interface RestCycleContext {
  /** The load snapshot that triggered rest. */
  load: ConsolidationLoad;
  /** Current vital signs at rest entry. */
  vitals: VitalSigns;
  /** Which consolidation processes to prioritize. */
  priorities: ConsolidationPriority[];
}

export type ConsolidationPriority =
  | "potentiate"        // hippocampus: cluster episodes → extract living principles
  | "prune-memory"      // working memory: promote to hippocampus or drop
  | "decay-connections"  // plasticity: weaken unused/unstable connections
  | "recalibrate"       // cerebellum: holistic prediction model update
  | "settle-weights"    // plasticity: let volatile weights converge
  | "deferred-checks";  // phase gate integration checks, deep drift analysis

/** What the rest rhythm produces. */
export interface RestCycleResult {
  /** Which processes actually ran. */
  completed: ConsolidationPriority[];
  /** What changed. */
  principlesExtracted: number;
  memoryItemsPruned: number;
  memoryItemsPromoted: number;
  connectionsDecayed: number;
  predictionsRecalibrated: boolean;
  /** Post-rest vital signs — should be healthier. */
  vitalsAfter: VitalSigns;
  /** Post-rest load — should be lower. */
  loadAfter: ConsolidationLoad;
}

// ─── Context management (breathing) ─────────────────────────────

/**
 * Context management is the brainstem's breathing reflex.
 * It runs continuously, not as a rhythm. When contextCapacity
 * exceeds the threshold, the brainstem evicts without asking.
 *
 * Eviction is by relevance scoring — the thalamus already knows
 * what's relevant to the current consumer. The brainstem inverts
 * that: what's LEAST relevant to ANY active rhythm gets evicted first.
 *
 * Evicted context isn't deleted — it's pushed to hippocampus
 * (episodic) or working memory's cold store. It can be recalled
 * if the thalamus needs it later, but it costs a retrieval.
 */
export interface ContextSlot {
  id: string;
  /** What this context is about. */
  label: string;
  /** Which rhythm loaded it. */
  ownerRhythmId: string;
  /** Last time any rhythm referenced this. */
  lastAccessed: Date;
  /** Thalamus-assigned relevance to current work. 0–1. */
  relevance: number;
  /** Approximate token cost of keeping this in context. */
  tokenCost: number;
  /** Where to store if evicted. */
  evictionTarget: "hippocampus" | "working-memory-cold" | "discard";
}

/**
 * Warmup: when a rhythm starts or resumes, the brainstem loads
 * context slots it predicts will be needed. This is the thalamus
 * working proactively — not waiting for a consumer to ask.
 *
 * Cooldown: when a rhythm completes, the brainstem flushes its
 * context slots — either evicting or persisting depending on
 * whether parent rhythms still need them.
 */
export interface ContextTransition {
  type: "warmup" | "cooldown";
  rhythmId: string;
  /** Slots to load (warmup) or flush (cooldown). */
  slots: string[];
  /** For cooldown: where each flushed slot goes. */
  destinations?: Map<string, ContextSlot["evictionTarget"]>;
}
