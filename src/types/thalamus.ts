/**
 * Thalamus — central context relay types.
 *
 * The Thalamus assembles per-consumer briefings from all context sources.
 * Dual-layer API:
 *   Layer 1: Categorical getters — stable API, any consumer composes from these
 *   Layer 2: Convenience composers — encode selection intelligence for known consumers
 *
 * Briefings have three parts:
 *   core       — task + intent + taste (what the system always had)
 *   enrichment — WM data, PNS capabilities (what the Thalamus adds)
 *   meta       — transparency: what was included and why
 */

import type { ProjectIntent, TasteProfile, DecisionRecord } from "./intent.js";
import type { Task } from "./task.js";
import type { Council } from "./council.js";
import type { Sense } from "./sense.js";
import type {
  EstablishedPattern,
  ScoreTrend,
  InhibitedSense,
  OpenQuestion,
  TaskSummary,
  WMTask,
} from "./working-memory.js";
import type { Capability } from "./pns.js";
import type { InhibitionBriefing, InhibitionEnrichment } from "./inhibitor.js";

// ─── Briefing Meta ───────────────────────────────────────────

/** Transparency: what context was included in a briefing and why. */
export interface BriefingMeta {
  consumer: string;
  taskId?: string;
  assembledAt: Date;
  /** Which sources contributed context to this briefing. */
  sources: string[];
  /** Count of enrichment items per category. */
  enrichmentCounts: Record<string, number>;
}

// ─── Consultation Briefing ───────────────────────────────────

/**
 * What senses receive when consulted.
 * Full project context + WM enrichment so senses know
 * what's been established, what's trending, what's suppressed.
 */
export interface ConsultationBriefing {
  task: Task;
  intent: ProjectIntent;
  taste: TasteProfile;
  enrichment: ConsultationEnrichment;
  meta: BriefingMeta;
}

export interface ConsultationEnrichment {
  /** What the system has established across prior tasks. */
  patterns: EstablishedPattern[];
  /** Key decisions made so far. */
  decisions: DecisionRecord[];
  /** Per-sense score trends — landscape awareness. */
  senseTrends: ScoreTrend[];
  /** Which senses are suppressed and why. */
  inhibitedSenses: InhibitedSense[];
  /** Unresolved questions. */
  openQuestions: OpenQuestion[];
  /** How many tasks have completed so far. */
  completedTaskCount: number;
}

// ─── Motor Briefing ──────────────────────────────────────────

/**
 * What the motor cortex receives when building.
 * Richest briefing — the builder makes the most consequential decisions.
 */
export interface MotorBriefing {
  task: Task;
  intent: ProjectIntent;
  taste: TasteProfile;
  council: Council;
  enrichment: MotorEnrichment;
  meta: BriefingMeta;
}

export interface MotorEnrichment {
  /** Established patterns — builder MUST maintain these. */
  patterns: EstablishedPattern[];
  /** All decisions made so far. */
  decisions: DecisionRecord[];
  /** Score trends across all receptors. */
  scoreTrends: ScoreTrend[];
  /** Unresolved questions that might affect the build. */
  openQuestions: OpenQuestion[];
  /** Natural language description of available tools. */
  capabilities: string;
}

// ─── Evaluation Briefing ─────────────────────────────────────

/**
 * What each evaluator receives.
 * Intentionally minimal — evaluators should focus on the work,
 * not get overwhelmed with system state.
 */
export interface EvaluationBriefing {
  /** This receptor's score trend across tasks. */
  receptorTrends: ScoreTrend[];
  /** Patterns relevant to this evaluation dimension. */
  relevantPatterns: EstablishedPattern[];
  meta: BriefingMeta;
}

// ─── Scheduling Briefing ─────────────────────────────────────

/**
 * What the task selector / attention scheduler receives.
 * For now task-dispatch is simple graph traversal, but this
 * context is available when the Attention Scheduler is built.
 */
export interface SchedulingBriefing {
  /** Current task statuses from WM. */
  tasks: WMTask[];
  /** High-level sense trends. */
  senseTrends: ScoreTrend[];
  /** Completed task summaries. */
  completedSummaries: TaskSummary[];
  /** Working memory load (0-1). */
  load: number;
  /** Unresolved questions. */
  openQuestions: OpenQuestion[];
  meta: BriefingMeta;
}

// ─── Categorical getter return types ─────────────────────────

export interface ProjectContext {
  intent: ProjectIntent;
  taste: TasteProfile;
}

export interface AccumulatedContext {
  patterns: EstablishedPattern[];
  decisions: DecisionRecord[];
  receptorTrends: ScoreTrend[];
  senseTrends: ScoreTrend[];
  inhibitedSenses: InhibitedSense[];
  openQuestions: OpenQuestion[];
  completedSummaries: TaskSummary[];
  load: number;
}

export interface CapabilityContext {
  description: string;
  capabilities: Capability[];
}

/** Options for filtering accumulated context. */
export interface AccumulatedContextOpts {
  /** Filter receptor trends to this specific receptor. */
  forReceptor?: string;
  /** Filter patterns to those containing this sense name. */
  forSense?: string;
}

// ─── Sources ─────────────────────────────────────────────────

/**
 * What the Thalamus reads from. Required sources are available
 * from Phase 1. Optional sources plug in as the system grows.
 *
 * When an optional source isn't provided, the Thalamus omits
 * that context from briefings. No registration ceremony —
 * just typed fields.
 */
export interface ThalamusSources {
  // Phase 1 (available now)
  wm: import("../kernel/working-memory.js").WorkingMemory;
  pns?: import("../kernel/pns.js").PeripheralNervousSystem;

  // Phase 3 (added when built)
  // hippocampus?: { ... }
  // cerebellum?: { ... }
  // basalGanglia?: { ... }

  // Phase 4
  // getArousal?: () => number;
}
