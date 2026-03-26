/**
 * Task Gestalt — the Thalamus's canonical per-task snapshot.
 *
 * Three-layer architecture:
 *   World Model (PFC, rebuilt at rhythm boundaries)
 *     → Task Gestalt (Thalamus, assembled once per task)
 *       → Consumer Briefings (Thalamus, extracted per-component)
 *
 * The gestalt is the "cortical representation" — pre-processed,
 * structured, consistent. Subcortical systems (BG, Cerebellum,
 * Inhibitor) read from it. Consumer briefings derive from it.
 *
 * Assembled when a task arrives at task-dispatch. Predictions and
 * speed-of-light attach during the task lifecycle (after consultation).
 * Cleared when the task completes.
 *
 * Why this exists:
 *   Before the gestalt, each briefing method re-read all sources
 *   independently. This meant (a) inconsistency if WM mutated between
 *   briefing calls, (b) redundant work re-reading the same data,
 *   (c) no canonical place for task-graph-position or full weltanschauung
 *   context to live. The gestalt is the single snapshot all consumers
 *   derive from within a task.
 */

import type { Task } from "./task.js";
import type { ProjectIntent, TasteProfile, DecisionRecord } from "./intent.js";
import type { Maxim, RebuildTrigger, WorldModelSourcesSummary } from "./world-model.js";
import type {
  EstablishedPattern,
  ScoreTrend,
  InhibitedSense,
  OpenQuestion,
  TaskSummary,
} from "./working-memory.js";
import type { PrincipleSummary } from "./thalamus.js";
import type { Capability } from "./pns.js";
import type { CerebellumPrediction, SpeedOfLight } from "./cerebellum.js";
import type { EfferenceCopy } from "./efference-copy.js";
import type { ExplorePath } from "./explore.js";
import type { TaskGraphNode } from "./brainstem.js";
import type { ForwardBriefing } from "./forward-briefing.js";

// ─── Task Gestalt ────────────────────────────────────────────

export interface TaskGestalt {
  /** The task this gestalt was assembled for. */
  task: Task;
  /** When this gestalt was assembled. */
  assembledAt: Date;

  // ── Core Identity ─────────────────────────────────────────
  intent: ProjectIntent;
  taste: TasteProfile;

  // ── World Model Layer ─────────────────────────────────────
  /**
   * The system's Weltanschauung at gestalt assembly time.
   * Null on cold start (no world model yet) — consumers degrade
   * gracefully, just like they do today with optional maxims.
   */
  weltanschauung: GestaltWeltanschauung | null;

  // ── Accumulated Context (WM snapshot at assembly time) ────
  /**
   * Working memory frozen at gestalt assembly. All consumers within
   * a task see the same accumulated context — no drift between
   * consultation and motor briefing.
   */
  accumulated: GestaltAccumulated;

  // ── Episodic Memory ───────────────────────────────────────
  /**
   * Hippocampus-derived principles and episodes. Null if the
   * hippocampus isn't wired yet. Pre-indexed by sense for
   * efficient per-consumer extraction.
   */
  episodic: GestaltEpisodic | null;

  // ── Capabilities ──────────────────────────────────────────
  /** PNS capabilities snapshot. */
  capabilities: GestaltCapabilities;

  // ── Task Graph Position ───────────────────────────────────
  /**
   * Where this task sits in the project graph. Null if no graph
   * context was provided (e.g., single-task runs without a planner).
   *
   * This is new context that no consumer had before the gestalt —
   * dependency relationships, phase gate proximity, completion
   * progress. The Thalamus can now route graph-position-aware
   * context to any consumer that benefits from it.
   */
  graphPosition: GestaltGraphPosition | null;

  // ── Modulation Signals ────────────────────────────────────
  /** Norepinephrine level from Attention Scheduler. */
  neLevel?: number;
  /** Explore/exploit mode from Attention Scheduler. */
  mode?: "explore" | "exploit";
  /** Budget pressure from CostTracker (0–1). Drives briefing depth. */
  budgetPressure?: number;
  /** Allocated budget for this task in dollars. */
  taskBudget?: number;

  // ── Forward Briefing (produced between tasks) ────────────
  /**
   * PFC's prospective preparation for this task. Produced during the
   * previous between-tasks phase and stored on the Thalamus. Included
   * in the gestalt at assembly time, then dissolved into consumer
   * briefings.
   */
  forwardBriefing?: ForwardBriefing;

  // ── Prospective Memory (fired triggers for this task) ──────
  /** Directives from PM triggers that matched this task. */
  prospectiveDirectives?: string[];

  // ── Efference Copy (attached before consultation) ────────
  /**
   * Motor Cortex's pre-build feasibility signal. Attached before
   * consultation so senses can calibrate ambitions against what's
   * actually buildable. Null if efference copy was skipped (e.g.,
   * no motor cortex available, or cold start with no context).
   */
  efferenceCopy?: EfferenceCopy;

  // ── Predictive Layer (attached during task lifecycle) ─────
  /**
   * Cerebellum's predicted scores. Attached after consultation
   * (the cerebellum needs the consultation to know which senses/
   * receptors are active). Null before prediction or on cold start.
   */
  prediction?: CerebellumPrediction;
  /**
   * Theoretical performance ceiling per sense + composite.
   * Attached alongside prediction. Available even on cold start
   * (sense ceilings don't require historical episodes).
   */
  speedOfLight?: SpeedOfLight;

  // ── Explore Phase (attached after explore runs) ─────
  /**
   * Selected path from explore phase. Attached after explore runs,
   * before the build cycle. Null if explore was skipped or no path
   * cleared the quality floor. Read by forMotorFromGestalt.
   */
  explorePath?: ExplorePath;
}

// ─── Sub-structures ──────────────────────────────────────────

/**
 * World model context shaped for gestalt consumers.
 *
 * Carries more than just maxim strings — the full maxims (with
 * cognitive/axiological/volitional layers) plus the synthesis
 * metadata. This lets the Thalamus route different facets to
 * different consumers: statement strings for consultation briefings,
 * full maxims for the conviction loop, freshness metadata for
 * the attention scheduler.
 */
export interface GestaltWeltanschauung {
  /** Maxim statement strings — lightweight, for briefing inclusion. */
  maxims: string[];
  /** Full maxims with all three layers. For consumers that need depth. */
  fullMaxims: Maxim[];
  /** Transparency: what went into the worldview synthesis. */
  sourcesSummary: WorldModelSourcesSummary;
  /** What triggered the most recent rebuild. */
  trigger: RebuildTrigger;
  /** When the worldview was last synthesized. */
  synthesizedAt: Date;
}

/**
 * WM state frozen at gestalt assembly time.
 *
 * Same data as AccumulatedContext but explicitly a snapshot — the
 * gestalt owns this copy, WM can continue evolving. This is the
 * consistency guarantee: every consumer within a task sees the
 * same accumulated state.
 */
export interface GestaltAccumulated {
  patterns: EstablishedPattern[];
  decisions: DecisionRecord[];
  senseTrends: ScoreTrend[];
  receptorTrends: ScoreTrend[];
  inhibitedSenses: InhibitedSense[];
  openQuestions: OpenQuestion[];
  completedSummaries: TaskSummary[];
  completedTaskCount: number;
  load: number;
}

/**
 * Hippocampus-derived context, pre-indexed for efficient extraction.
 *
 * The key improvement: principlesBySense is computed once at gestalt
 * assembly, not re-queried per evaluation briefing. With 8 senses
 * and 5 receptors each, that's 40 hippocampus queries saved per task.
 */
export interface GestaltEpisodic {
  /** All active principles (cross-project + per-project). */
  principles: PrincipleSummary[];
  /**
   * Principles indexed by sense ID. O(1) lookup when assembling
   * per-sense evaluation briefings. Keyed by sense name (lowercased)
   * to match the Thalamus's existing convention.
   */
  principlesBySense: Record<string, PrincipleSummary[]>;
}

/**
 * PNS capabilities snapshot.
 *
 * Includes both the natural-language description (for motor briefings)
 * and the structured list (for anything that needs to reason about
 * specific capabilities).
 */
export interface GestaltCapabilities {
  /** Natural language description of available tools. */
  description: string;
  /** Structured capability list. */
  capabilities: Capability[];
}

/**
 * Where this task sits in the project graph.
 *
 * This is genuinely new context — no consumer had it before.
 * The motor cortex can now know "this is 1 of 3 remaining tasks
 * before a phase gate" without the Thalamus having to re-derive it
 * per briefing.
 */
export interface GestaltGraphPosition {
  /** Total tasks in the graph. */
  totalTasks: number;
  /** IDs of tasks already completed. */
  completedTaskIds: string[];
  /** IDs of tasks that escalated. */
  escalatedTaskIds: string[];
  /** IDs of tasks this task depends on. */
  dependsOn: string[];
  /** IDs of tasks that depend on this one. */
  dependedOnBy: string[];
  /**
   * Which phase gate group this task belongs to, if any.
   * From TaskGraphNode.phaseGroup.
   */
  phaseGroup?: string;
  /**
   * How many tasks in this phase group are already complete.
   * Null if no phase group. Consumers can derive proximity:
   * completedInPhase / totalInPhase → how close to the gate.
   */
  completedInPhase?: number;
  /** Total tasks in this phase group. */
  totalInPhase?: number;
}

// ─── Assembly Context ────────────────────────────────────────

/**
 * What the caller provides when asking the Thalamus to assemble
 * a gestalt. The Thalamus already holds its persistent sources
 * (WM, PNS, hippocampus, world model, intent, taste). This
 * carries the task-specific and dispatch-layer context.
 */
export interface GestaltAssemblyContext {
  task: Task;
  /** NE level from Attention Scheduler. */
  neLevel?: number;
  /** Explore/exploit mode from Attention Scheduler. */
  mode?: "explore" | "exploit";
  /**
   * Task graph context from task-dispatch. Optional — single-task
   * runs or test harnesses may not have a graph.
   */
  graph?: {
    nodes: TaskGraphNode[];
    completedTaskIds: Set<string>;
    escalatedTaskIds: Set<string>;
  };
  /** Prospective Memory directives fired for this task. */
  prospectiveDirectives?: string[];
  /**
   * Budget pressure from CostTracker (0–1). Drives briefing depth
   * and model selection. 0 when no budget is set.
   */
  budgetPressure?: number;
  /** Allocated budget for this task in dollars. */
  taskBudget?: number;
}
