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
import type { RiskFactors } from "./norepinephrine.js";
import type { TasteProposal } from "./taste-feedback.js";
import type { Consultation } from "./consultation.js";
import type { SenseEvaluation } from "./sense.js";
import type { Tension, TensionResolution, ResolutionOutcome } from "./tension.js";
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
  /** Affinity group from Graph Builder — co-design cluster metadata. */
  affinityGroupId?: string;
}

/** What the task-dispatch rhythm needs to start. */
export interface TaskDispatchContext {
  intent: ProjectIntent;
  taste: TasteProfile;
  graph: TaskGraphNode[];
  /** Phase definitions from planner — needed for gate condition checking. */
  phases?: import("./planner.js").ProposedPhase[];
  // ── Replan carry-over (populated when restarting after replan) ──
  /** Tasks completed in prior dispatch rounds (before replan). */
  priorCompleted?: Set<string>;
  /** Tasks escalated in prior dispatch rounds. */
  priorEscalated?: Set<string>;
  /** Results from prior dispatch rounds. */
  priorResults?: Map<string, import("./orchestrator.js").OrchestratorResult>;
  /** Which replan generation this dispatch is running under (0 = original plan). */
  replanGeneration?: number;
  /** When executing within a shael (hierarchical planning), the shael ID. */
  shaelId?: string;
}

/** What the sensory-cortex rhythm needs to start. */
export interface SensoryCortexContext {
  task: Task;
  intent: ProjectIntent;
  taste: TasteProfile;
  /** NE level from Attention Scheduler, for inhibition + consultation conditions. */
  neLevel?: number;
  /** Frozen risk factors from dispatch — enrichment sites reuse instead of re-deriving. */
  riskSnapshot?: RiskFactors;
  /** Explore/leverage mode from Attention Scheduler. */
  mode?: "explore" | "leverage";
  /** Budget allocated for this task (dollars). From Scheduler dispatch. */
  taskBudget?: number;
  /** Project-level budget utilization (0–1). From CostTracker. */
  projectBudgetUtilization?: number;
  /** Attention budget for this task. From Attention Scheduler at dispatch. */
  attentionBudget?: import("./attention-budget.js").AttentionBudget;
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
  /** Frozen risk factors from dispatch — gate reuses instead of re-deriving. */
  riskSnapshot?: RiskFactors;
  /** Which outer cycle we're in (1-indexed). Present when sensory cortex loops. */
  outerCycle?: number;
  /** Remaining task budget in dollars. For gate economic signals. */
  taskBudgetRemaining?: number;
  /** Project-level budget utilization (0–1). For gate economic signals. */
  projectBudgetUtilization?: number;
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
  /** Measured outcomes of resolution attempts (pre/post score comparison). */
  resolutionOutcomes?: ResolutionOutcome[];
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
  /** Number of exteroceptive signals processed in this batch (0 if none). */
  exteroceptiveSignalsProcessed?: number;
}

export interface BetweenTasksSlowPath {
  phaseGroup: string;
  integrationCheckPassed: boolean;
  integrationIssues: string[];
  driftDetected: boolean;
  driftSeverity?: "low" | "medium" | "high";
  crystallizationTriggered: boolean;
  replanRequired: boolean;
  /** Taste divergence proposals generated during this phase gate (Feature #24). */
  tasteProposals?: TasteProposal[];
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
 * What the human provides when resolving an escalation.
 * Structured enough for the system to act on, flexible enough
 * for any kind of response.
 */
export interface EscalationResolution {
  /** Free-form answer to the escalation's question(s). */
  answer: string;
  /** If the human wants to redirect strategy, they say how. */
  directive?: string;
  /** Which specific open question IDs this resolves (if any). */
  resolvedQuestionIds?: string[];
  /** Timestamp of the resolution. */
  resolvedAt: Date;
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

// ─── Escalation delivery ────────────────────────────────────────

/**
 * Delivery adapter for escalations. Transports the escalation to the human
 * and returns their resolution. The EscalationHandler is decoupled from
 * the transport — it just calls deliver() and awaits the response.
 *
 * Implementations:
 *   EventBusDeliveryAdapter  — no-op, waits for external resolve() call (default)
 *   AgentSdkDeliveryAdapter  — uses an askUser callback (e.g. AskUserQuestion tool)
 */
export interface EscalationDeliveryAdapter {
  /**
   * Deliver an escalation to the human and return their resolution.
   * Returns null if delivery is passive (resolution comes via external resolve()).
   */
  deliver(
    escalation: Escalation,
    briefing: import("./thalamus.js").EscalationBriefing,
  ): Promise<EscalationResolution | null>;
}

// ─── Vital signs (homeostasis) ──────────────────────────────────

/**
 * The brainstem continuously monitors these. They're not metrics for
 * the PFC to deliberate over — they're reflexes. When a vital sign
 * leaves its range, the brainstem acts automatically:
 *
 * - workingMemoryLoad high   → trigger rest cycle (prune/promote)
 * - predictionAccuracy low   → trigger rest cycle (recalibrate cerebellum)
 * - contextCapacity critical → compress briefings (breathing reflex)
 * - budgetUtilization high   → tighten budget (model downgrade + briefing compression)
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
   * How large assembled briefings are relative to quality-optimal size. 0–1.
   * Measured by the Thalamus after each assembly: totalTokens / optimalBudget.
   * High = briefings are bloated, attention dilution degrades output quality.
   * The brainstem compresses briefings without asking the PFC.
   */
  contextCapacity: number;

  /**
   * How much of the project's dollar budget has been consumed. 0–1.
   * Measured by the CostTracker: spent / budget.total.
   * High = budget pressure rising. Brainstem tightens budget: model
   * downgrades + briefing compression + economic gate stopping.
   * 0 when no budget is set (unconstrained mode).
   */
  budgetUtilization: number;

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
  /** Above this → brainstem compresses briefings (breathing reflex). */
  contextCapacity: number;
  /** Above this → brainstem tightens budget (model downgrade + briefing compression). */
  budgetUtilization: number;
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
  budgetUtilization: 0.85,
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

  /**
   * Cumulative NE exposure normalized to 0–1.
   * High = system has been running at high alertness for many tasks
   * without rest. Needs cooldown to prevent cognitive fatigue.
   */
  neFatigue: number;
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
  | "decay-routines"    // basal ganglia: decay unused routines, prune low-confidence
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

// ─── Breathing reflex (budget-driven context management) ────────

/**
 * The breathing reflex is NOT an eviction engine. Anthropic's
 * server-side compaction handles conversation-time context management.
 * The breathing reflex is the system breathing differently based on
 * the economics of the work — driven by a real dollar budget.
 *
 * Three mechanisms:
 *   1. Assembly-time budget — Thalamus constrains what goes into
 *      each briefing based on BriefingDepth (driven by NE + budget).
 *   2. Compaction configuration — Thalamus generates custom
 *      instructions for the API's compaction summarizer.
 *   3. Post-compaction rehydration — Thalamus re-injects from
 *      external stores (WM, Hippocampus, World Model) after compaction.
 *
 * See types/cost.ts for BriefingDepth and budget types.
 */

/**
 * A section of a Thalamus-assembled briefing.
 * This is an assembly receipt — what the Thalamus included in a
 * briefing, what it cost, and how important it was. Not a slot
 * registry; computed after each assembly for observability and
 * capacity monitoring.
 */
export interface BriefingSlot {
  id: string;
  /** Human-readable label for this section. */
  label: string;
  /** Which data source this came from. */
  source:
    | "patterns"
    | "decisions"
    | "principles"
    | "episodes"
    | "graph-position"
    | "taste"
    | "intent"
    | "forward-briefing"
    | "efference-copy"
    | "world-model"
    | "capabilities"
    | "predictions"
    | "previous-work";
  /** Priority level — essential sections are never dropped. */
  priority: "essential" | "high" | "medium" | "low";
  /** Estimated token count for this section. */
  tokenCost: number;
  /** Thalamus-assessed relevance to current task. 0–1. */
  relevance: number;
  /** Number of items in this section (patterns, principles, etc). */
  itemCount: number;
}

/**
 * Receipt emitted after the Thalamus assembles a briefing.
 * Feeds the contextCapacity vital sign and provides observability
 * into what each consumer received.
 */
export interface BriefingReceipt {
  /** Which consumer this briefing was assembled for. */
  consumer: "consultation" | "motor" | "evaluation" | "scheduling" | "gestalt";
  taskId: string;
  sections: BriefingSlot[];
  /** Total estimated tokens across all sections. */
  totalTokens: number;
  /** NE level at time of assembly. */
  neLevel: number;
  /** Budget pressure at time of assembly (0–1). */
  budgetPressure: number;
  /** Which breathing depth was applied. */
  depth: import("./cost.js").BriefingDepth;
  /** Sections that were dropped due to breathing. */
  droppedSections: string[];
  assembledAt: Date;
}

/**
 * Configuration for the API's server-side compaction.
 * Generated by the Thalamus based on current system state.
 * Passed to the LLM client for agentic (multi-turn) sessions.
 */
export interface CompactionConfig {
  /** Token threshold to trigger compaction. Min 50_000. */
  triggerThreshold: number;
  /** Always true — we need to inject context post-compaction. */
  pauseAfterCompaction: true;
  /**
   * Custom summarization instructions generated by the Thalamus.
   * Tells the compactor what this system needs to remember:
   * patterns, conviction state, active tensions, manifested future.
   * Replaces the API's default summarization prompt entirely.
   */
  instructions: string;
}

/**
 * What the system does when compaction fires.
 * The Thalamus reassembles a gestalt from external stores
 * (WM, Hippocampus, World Model) and injects it post-compaction.
 */
export interface CompactionResponse {
  /** The reassembled context to inject after compaction. */
  rehydrationContext: string;
  /** Estimated tokens of the rehydration payload. */
  rehydrationTokens: number;
  /** Updated compaction instructions for the next compaction event. */
  updatedInstructions: string;
}
