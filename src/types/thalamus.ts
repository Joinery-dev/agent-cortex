/**
 * Thalamus — central context relay types.
 *
 * The Thalamus assembles per-consumer briefings from all context sources.
 * Dual-layer API:
 *   Layer 1: Categorical getters — stable API, any consumer composes from these
 *   Layer 2: Convenience composers — encode selection intelligence for known consumers
 *
 * Briefings have three parts:
 *   core       — task + intent + taste (what Cortex always had)
 *   enrichment — WM data, PNS capabilities (what the Thalamus adds)
 *   meta       — transparency: what was included and why
 */

import type { ProjectIntent, TasteProfile, DecisionRecord } from "./intent.js";
import type { Task } from "./task.js";
import type { Consultation } from "./consultation.js";
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
import type { TerritoryObservation, ObservationStatus } from "./territory-observation.js";
import type { InhibitionBriefing, InhibitionEnrichment } from "./basal-ganglia.js";
import type { Episode, Principle } from "./hippocampus.js";
import type { Maxim, Weltanschauung } from "./world-model.js";
import type { CerebellumPrediction, ReceptorPrediction, SpeedOfLight, SenseCeiling } from "./cerebellum.js";
import type { PredictedTension } from "./forward-briefing.js";

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
  /**
   * Specification artistry: how prescriptive vs invitational the briefing should be.
   * 0 = fully invitational (low NE/conviction — under-specify, let the builder exceed).
   * 1 = fully prescriptive (high NE/conviction — specify exactly, minimize variance).
   * Consumers can use this to modulate prompt tone when ready.
   */
  toneDirectiveness?: number;
  /** Estimated token count for this briefing. From token estimation utility. */
  estimatedTokens?: number;
  /** Which breathing depth was applied during assembly. */
  depth?: import("./cost.js").BriefingDepth;
  /** Sections dropped due to breathing depth constraints. */
  droppedSections?: string[];
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
  /** Taste dissolved into consumer-specific natural language guidance. */
  dissolvedTaste?: string;
  /** What Cortex has established across prior tasks. */
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
  /** What Cortex can physically do — grounding for sense recommendations. */
  capabilitySummary?: string;
  /** Relevant principles from hippocampus (cross-project learning). */
  principles?: PrincipleSummary[];
  /** Weltanschauung maxims — Cortex's integrated understanding. The frame. */
  worldModelMaxims?: string[];
  /** Stream of awareness — what Claus has noticed across the project. */
  awareness?: string[];
  /** Sense pairs predicted to conflict — from prospective preparation. */
  predictedTensions?: PredictedTension[];
  /** Tactical notes from the completed task's conviction loop. */
  convictionNotes?: string[];
  /** Explore/leverage mode from Attention Scheduler. Shapes consultation framing. */
  mode?: "explore" | "leverage";
  /** Directives from Prospective Memory triggers fired for this task. */
  prospectiveDirectives?: string[];
  /** Motor Cortex's per-sense feasibility assessment — calibrate ambitions against buildability. */
  efferenceCopy?: import("./efference-copy.js").EfferenceSenseFeasibility[];
  /** Trade-off costs between sense dimensions identified by the Motor Cortex. */
  efferenceTensionCosts?: import("./efference-copy.js").TensionCost[];
  /** Hard constraints the builder cannot overcome regardless of approach. */
  efferenceHardConstraints?: string[];
  /** Predicted failure mode preemption — guidance to prevent predicted failure before it happens. */
  failurePreemption?: {
    category: import("./motor-cortex.js").FailureCategory;
    confidence: number;
    consultationGuidance: string;
  };
}

/** Simplified principle for inclusion in briefings. */
export interface PrincipleSummary {
  statement: string;
  confidence: number;
  relevantSenses: string[];
}

// ─── Awareness ──────────────────────────────────────────────

/**
 * A single insight from the Stream of Awareness.
 *
 * The Thalamus passively listens to the event bus and accumulates
 * significant findings from existing detector systems (cognitive
 * flexibility, drift monitor, homeostasis, conviction, hippocampus,
 * motor proprioception, gate failure classification).
 *
 * Each insight is a digested, natural-language summary of what
 * happened and why it matters. Consumers receive these as string
 * arrays in briefings — same shape as worldModelMaxims.
 */
export interface AwarenessInsight {
  /** Unique ID for deduplication. */
  id: string;
  /** When this insight was captured. */
  timestamp: Date;
  /** Which detector system produced the source event. */
  source: AwarenessSource;
  /** Task ID, if the event was task-scoped. Null for system-level events. */
  taskId: string | null;
  /** Human-readable summary — what happened and why it matters. */
  summary: string;
  /** Severity from the source event. Drives pruning priority. */
  severity: "info" | "warn" | "critical";
}

export type AwarenessSource =
  | "flexibility"      // cognitive flexibility assessment
  | "drift"            // drift monitor level change or deep analysis
  | "vitals"           // homeostasis reflex
  | "hippocampus"      // principle extracted or replaced
  | "proprioception"   // motor self-assessment
  | "conviction"       // reshape or escalate verdict
  | "gate"             // failure classified
  | "pacing"           // task taking 2x expected cycles
  | "lifecycle"        // task complete
  | "identity"         // world model maxim evolved or dropped
  | "phase-gate"       // phase boundary check
  | "escalation"       // system escalated to / resolved by Parsifal
  | "surgery";         // graph surgery (plan revision)

// ─── Motor Briefing ──────────────────────────────────────────

/**
 * What the motor cortex receives when building.
 * Richest briefing — the builder makes the most consequential decisions.
 */
export interface MotorBriefing {
  task: Task;
  intent: ProjectIntent;
  taste: TasteProfile;
  consultation: Consultation;
  enrichment: MotorEnrichment;
  meta: BriefingMeta;
}

export interface MotorEnrichment {
  /** Taste dissolved into builder-specific natural language guidance. */
  dissolvedTaste?: string;
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
  /** Principles relevant to this task's active senses. */
  principles?: PrincipleSummary[];
  /** Cerebellum's predicted scores before building. Present after cold start. */
  prediction?: CerebellumPrediction;
  /** Speed of light — theoretical performance ceiling. Always present when senses provide ceilings. */
  speedOfLight?: SpeedOfLight;
  /** Weltanschauung maxims — Cortex's integrated understanding. The frame. */
  worldModelMaxims?: string[];
  /** Stream of awareness — what Claus has noticed across the project. */
  awareness?: string[];
  /** Predicted build cycles based on similar past tasks. */
  predictedCycles?: number;
  /** Tactical approach notes from conviction shaping. */
  approachNotes?: string[];
  /** Senses identified as bottlenecks (below ceiling, trending poorly). */
  bottleneckSenses?: string[];
  /** Explore/leverage mode from Attention Scheduler. Shapes motor framing. */
  mode?: "explore" | "leverage";
  /** Directives from Prospective Memory triggers fired for this task. */
  prospectiveDirectives?: string[];
  /** Selected explore path — strong guidance for the premotor's approach. */
  selectedPath?: import("./explore.js").ExplorePath;
  /** Predicted failure mode preemption — specific guidance to prevent predicted failure. */
  failurePreemption?: {
    predictedCategory: import("./motor-cortex.js").FailureCategory;
    confidence: number;
    guidance: string;
    historicalPatterns: string[];
  };
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
  /** Principles relevant to this evaluator's sense. */
  relevantPrinciples?: PrincipleSummary[];
  /** Cerebellum's predicted score for this specific receptor. */
  prediction?: ReceptorPrediction;
  /** Theoretical ceiling for this evaluator's sense dimension. */
  senseCeiling?: SenseCeiling;
  /** True if this evaluator's sense has been identified as a bottleneck. */
  isBottleneck?: boolean;
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

// ─── Escalation Briefing ─────────────────────────────────────

/**
 * What the Parsifal receives when Cortex escalates.
 * Assembled by the Thalamus so escalation messages have full context,
 * not just a raw error string. Non-task-scoped (like forScheduling).
 */
export interface EscalationBriefing {
  /** The escalation record being surfaced. */
  escalation: import("./brainstem.js").Escalation;
  /** What Cortex was doing when it escalated. */
  rhythmContext: EscalationRhythmContext;
  /** Current project state relevant to the escalation. */
  projectSnapshot: EscalationProjectSnapshot;
  meta: BriefingMeta;
}

/** Rhythm state at the moment of escalation. */
export interface EscalationRhythmContext {
  rhythmId: string;
  rhythmType: string;
  phase: import("./rhythm.js").RhythmPhase;
  cycle: number;
  parentRhythmType?: string;
}

/** Project-level snapshot for escalation context. */
export interface EscalationProjectSnapshot {
  /** Intent summary — what the project is trying to achieve. */
  intentSummary: string;
  /** How many tasks completed vs total. */
  completedTasks: number;
  totalTasks: number;
  /** Unresolved open questions (the ones that may need answering). */
  openQuestions: OpenQuestion[];
  /** Current sense trends — which dimensions are improving/declining. */
  senseTrends: ScoreTrend[];
  /** Drift level if available. */
  driftLevel?: number;
  /** World model maxims if available — Cortex's current understanding. */
  worldModelMaxims?: string[];
  /** Stream of awareness — what Claus has noticed across the project. */
  awareness?: string[];
  /** Per-sense assessments of the escalation — domain expert perspectives. */
  senseAssessments?: Array<{
    senseId: string;
    senseName: string;
    assessment: string;
    recentTrend: ScoreTrend | null;
  }>;
}

// ─── Integration Check Briefing ─────────────────────────────

/**
 * What the integration checker's per-sense evaluators receive.
 * Assembled by Thalamus from phase task results + accumulated context.
 * The phaseWork array is the "collective artifact" being evaluated.
 */
export interface IntegrationCheckBriefing {
  phaseGroup: string;
  gateCondition: string;
  manifestedFuture: string | null;
  /** Work produced by each task in the phase. */
  phaseWork: Array<{ taskId: string; description: string; work: string; confidence: number }>;
  enrichment: IntegrationCheckEnrichment;
  meta: BriefingMeta;
}

export interface IntegrationCheckEnrichment {
  /** Patterns established during/before this phase. */
  patterns: EstablishedPattern[];
  /** Sense trends across the phase. */
  senseTrends: ScoreTrend[];
  /** Relevant principles from hippocampus. */
  principles: PrincipleSummary[];
}

// ─── Sense Question Briefing ─────────────────────────────────

/**
 * What a sense receives when the Motor Cortex asks it a mid-build question.
 * Lighter than a full consultation — targeted context for a specific question.
 * The sense answers from its dimension's perspective, not as a general Q&A.
 */
export interface SenseQuestionBriefing {
  /** The question from the builder. */
  question: import("./motor-cortex.js").BuildQuestion;
  /** The sense's original perspective from consultation — what it already said. */
  originalPerspective: string;
  /** The task being worked on. */
  task: Task;
  /** Build progress so far — what's been done, what remains. */
  buildProgress?: string;
  meta: BriefingMeta;
}

/**
 * Thalamus routing decision for a mid-build question.
 * Deterministic routing based on dimension matching and stake analysis.
 * Falls back to the Parsifal when no sense has sufficient expertise.
 */
export interface QuestionRouting {
  questionId: string;
  route: "sense" | "parsifal";
  /** Target sense when routed internally. */
  targetSenseId?: string;
  /** Why the Thalamus chose this route. */
  rationale: string;
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

// ─── Observation Harvest ────────────────────────────────────────

/** Options for harvesting observations through the Thalamus. */
export interface ObservationHarvestOpts {
  /** Current NE level — required for re-filtering at harvest time. */
  neLevel: number;
  /** Which statuses to include. Defaults to ["new", "triaged"]. */
  statuses?: ObservationStatus[];
}

/**
 * Shaped observation set from the Thalamus.
 * Parallel to AccumulatedContext — filtered, sorted, wrapped in meta.
 */
export interface ObservationHarvest {
  /** Observations surviving all filters, sorted by relevance descending. */
  observations: TerritoryObservation[];
  /** Transparency: what sources contributed, what was filtered. */
  meta: BriefingMeta;
}

// ─── Sources ─────────────────────────────────────────────────

/**
 * What the Thalamus reads from. Required sources are available
 * from Phase 1. Optional sources plug in as Cortex grows.
 *
 * When an optional source isn't provided, the Thalamus omits
 * that context from briefings. No registration ceremony —
 * just typed fields.
 */
export interface ThalamusSources {
  // Phase 1 (available now)
  wm: import("../kernel/working-memory.js").WorkingMemory;
  pns?: import("../kernel/pns.js").PeripheralNervousSystem;

  // Phase 3
  hippocampus?: HippocampusSource;
  worldModel?: WorldModelSource;
  // cerebellum?: { ... }
  // basalGanglia?: { ... }

  // Reflective evolution
  guidanceStore?: import("../kernel/guidance-store.js").GuidanceStore;

  // Phase 4
  // getArousal?: () => number;
}

/**
 * What the Thalamus reads from the World Model.
 * The maxims are Cortex's Weltanschauung — compressed wisdom
 * that frames all briefings.
 */
export interface WorldModelSource {
  /** Just the statement strings, for inclusion in briefings. */
  getMaximsForBriefing(): string[];
  /** Full maxims from both scopes. */
  getAllMaxims(): Maxim[];
  /** Full Weltanschauung snapshot — needed by gestalt assembly for metadata. */
  getWeltanschauung(): Weltanschauung | null;
  /** Self-model maxims — who I am. */
  getSelfMaxims(): import("./world-model.js").Maxim[];
  /** Self-model narratives — identity-shaping stories. */
  getSelfNarratives(): import("./world-model.js").SelfNarrative[];
}

/**
 * What the Thalamus reads from the hippocampus.
 * Typed as an interface (not class reference) so the Thalamus
 * depends on the shape, not the implementation.
 */
export interface HippocampusSource {
  getActivePrinciples(): Principle[];
  getPrinciplesForSense(senseId: string): Principle[];
  /**
   * Project-sense scoped principles — what a specific sense has
   * learned about a specific project. Feature 15 potentiation output.
   */
  getPrinciplesForSenseAndProject(senseId: string, projectId: string): Principle[];
  getEpisodesForSense(senseId: string, projectId?: string): Episode[];
  getRecentEpisodes(count: number): Episode[];
}
