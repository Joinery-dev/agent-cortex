/**
 * World Model (Weltanschauung) — PFC's integrated understanding of reality.
 *
 * Not a data aggregation dashboard. Cortex's Weltanschauung — an
 * integrated orientation toward reality that fuses cognition (what kind
 * of terrain is this), valuation (what matters here), and volition
 * (how to orient) into a coherent gestalt.
 *
 * Expressed as 3-7 maxims — compressed wisdom that each carry all three
 * layers interpenetrating. Produced by LLM synthesis from all system
 * sources, not by procedural aggregation.
 *
 * Two scopes:
 *   cross-project — Cortex's general identity. Changes slowly across
 *     projects. Persists to disk. Portable.
 *   per-project — formed through experience in a specific project. Starts
 *     from cross-project + intent/taste, evolves at rhythm boundaries.
 *     Lives in memory, dies with the project (but may update cross-project
 *     at project completion).
 *
 * Rebuilt at rhythm boundaries: project-start, between-tasks, phase-gate,
 * rest-cycle, project-complete. The conviction loop runs against this.
 */

import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { TaskGraphNode, VitalSigns } from "./brainstem.js";
import type { HippocampusSource } from "./thalamus.js";
import type { TonicDopamine } from "./dopamine.js";
import type {
  EstablishedPattern,
  ScoreTrend,
  InhibitedSense,
  OpenQuestion,
  TaskSummary,
} from "./working-memory.js";
import type { DecisionRecord } from "./intent.js";
import type { ConnectionSnapshot, PlasticWeight, ConnectionCategory } from "./plasticity.js";
import type { SenseCeiling } from "./cerebellum.js";

// ─── Maxim ──────────────────────────────────────────────────────

/**
 * A single crystallized understanding — "wise words that speak volumes."
 *
 * Not analysis, not summary. Compressed wisdom that carries cognitive,
 * axiological, and volitional meaning as an interpenetrating gestalt.
 *
 * The statement is the maxim itself. The cognitive/axiological/volitional
 * fields are the LLM's self-annotation — facets of the same understanding,
 * not separate items. They exist for the Thalamus to route relevance
 * and for the conviction loop to trace reasoning.
 */
export interface Maxim {
  id: string;
  /** The maxim itself — compressed wisdom. */
  statement: string;
  /** What kind of terrain this speaks to (the Weltbild layer). */
  cognitive: string;
  /** What matters in that terrain (the axiological layer). */
  axiological: string;
  /** How to orient given what matters (the volitional layer). */
  volitional: string;
  /**
   * How deeply established this insight is (0–1).
   * New maxims start at 0.3–0.7 from LLM assessment.
   * Cross-project maxims gain confidence through confirming projects.
   * Per-project maxims gain confidence through confirming tasks.
   */
  confidence: number;
  /** When this maxim was first synthesized. */
  synthesizedAt: Date;
}

// ─── Weltanschauung snapshot ────────────────────────────────────

/** The full worldview at a point in time. */
export interface Weltanschauung {
  /** Cortex's general identity — what it has become across all projects. */
  crossProject: Maxim[];
  /** What this specific project has taught Cortex. */
  perProject: Maxim[];
  /** When this snapshot was computed. */
  synthesizedAt: Date;
  /** What triggered this rebuild. */
  trigger: RebuildTrigger;
  /** Transparency: what went into the synthesis. */
  sourcesSummary: WorldModelSourcesSummary;
}

/** What triggered a worldview rebuild. */
export type RebuildTrigger =
  | "project-start"
  | "between-tasks"
  | "phase-gate"
  | "rest-cycle"
  | "project-complete"
  | "replan";

/** Transparency: counts of what contributed to the synthesis (not the data itself). */
export interface WorldModelSourcesSummary {
  principleCount: number;
  sensePrincipleCount: number;
  episodeCount: number;
  patternCount: number;
  decisionCount: number;
  cerebellumAccuracy: number;
  cerebellumEpisodes: number;
  tonicLevel: number | null;
  tonicTrend: "rising" | "falling" | "stable" | null;
  wmLoad: number;
  completedTaskCount: number;
  hasPlasticity: boolean;
  hasVitals: boolean;
  hasTaskGraph: boolean;
  hasPNS: boolean;
  capabilityCount: number;
}

// ─── Sources ────────────────────────────────────────────────────

/**
 * What the WorldModel reads from during rebuild(). Typed as interfaces
 * (not class refs) so the WorldModel depends on shapes, not implementations.
 *
 * All sources are optional except working memory — Cortex degrades
 * gracefully when learning systems aren't yet wired. The synthesis
 * prompt omits empty sections.
 */
export interface WorldModelSources {
  /** Working memory — always available. */
  wm: WorkingMemorySource;

  /** Project identity — available after project binding. */
  intent?: ProjectIntent;
  taste?: TasteProfile;

  /** Task graph — available during project execution. */
  taskGraph?: TaskGraphNode[];
  completedTaskIds?: Set<string>;
  escalatedTaskIds?: Set<string>;

  /** Hippocampus — episodes and crystallized principles. */
  hippocampus?: HippocampusSource;

  /** Cerebellum — prediction accuracy and episode count. */
  cerebellum?: CerebellumSource;

  /** Tonic dopamine — overall project reward environment. */
  tonic?: TonicSource;

  /** Plasticity — learned connection weights. */
  plasticity?: PlasticitySource;

  /** Homeostasis — vital signs. */
  vitals?: VitalSigns;

  /** PNS — available capabilities. */
  pns?: PNSSource;

  /** Project profile — discovered at intake. What kind of project, how to run/test/build. */
  projectProfile?: import("./runtime.js").ProjectProfile;

  /** Current project ID — needed for tonic lookup and sense-project principles. */
  projectId?: string;
}

/** What the WorldModel reads from WM. */
export interface WorkingMemorySource {
  getPatterns(): EstablishedPattern[];
  getDecisions(): DecisionRecord[];
  getInhibitedSenses(): InhibitedSense[];
  getOpenQuestions(): OpenQuestion[];
  getSenseTrends(): ScoreTrend[];
  getReceptorTrends(): ScoreTrend[];
  getCompletedSummaries(): TaskSummary[];
  getLoad(): number;
}

/** What the WorldModel reads from the Cerebellum. */
export interface CerebellumSource {
  getAccuracy(): number;
  getEpisodeCount(): number;
  /** Composite ceiling from the most recent speed-of-light computation. */
  getCompositeCeiling(): number | null;
  /** Per-sense ceilings from the most recent speed-of-light computation. */
  getPerSenseCeilings(): SenseCeiling[];
  /** Approach bottleneck info, if approach-specific data exists. */
  getApproachBottleneckInfo(): { approachIsBottleneck: boolean; bottleneckGap: number | null } | null;
}

/** What the WorldModel reads from the Tonic tracker. */
export interface TonicSource {
  get(projectId: string): TonicDopamine;
}

/** What the WorldModel reads from the PNS. */
export interface PNSSource {
  describeCapabilities(): string;
  getCapabilities(): Array<{ direction: string; category: string; name: string }>;
}

/** What the WorldModel reads from the Plasticity store. */
export interface PlasticitySource {
  snapshot(): ConnectionSnapshot;
  getByCategory(category: ConnectionCategory): PlasticWeight[];
}

// ─── Config ─────────────────────────────────────────────────────

export interface WorldModelConfig {
  /** LLM model for synthesis. */
  synthesisModel: string;
  /**
   * Minimum completed tasks before per-project synthesis runs.
   * Cold start guard — not enough experience to form understanding.
   * Does NOT apply to project-start trigger (which synthesizes from
   * cross-project + intent/taste alone).
   */
  minTasksForProjectSynthesis: number;
  /** Maximum maxims per scope. */
  maxMaximsPerScope: number;
  /** Storage directory for cross-project persistence. */
  storageDir: string;
}

export const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig = {
  synthesisModel: "claude-sonnet-4-6-20250514",
  minTasksForProjectSynthesis: 2,
  maxMaximsPerScope: 7,
  storageDir: "", // Resolved at runtime to ~/.agent-cortex/world-model/
};

// ─── State snapshot (for dashboard/debugging) ───────────────────

export interface WorldModelState {
  crossProjectMaximCount: number;
  perProjectMaximCount: number;
  crossProjectMaxims: Array<{
    id: string;
    statement: string;
    confidence: number;
  }>;
  perProjectMaxims: Array<{
    id: string;
    statement: string;
    confidence: number;
  }>;
  projectId: string | null;
  lastSynthesisAt?: Date;
  lastTrigger?: RebuildTrigger;
}
