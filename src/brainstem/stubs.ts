/**
 * Subcortical Hooks — the interface between rhythms and learning systems.
 *
 * The rhythm's integrate phase calls these hooks. The default implementation
 * is a no-op that logs what would happen. When hippocampus, cerebellum,
 * basal ganglia, and dopamine are built (Phase 3), they implement this
 * interface. The brainstem never needs to change.
 */

import type { BuildCycleContext, BuildCycleResult, TaskGraphNode } from "../types/brainstem.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { Consultation } from "../types/consultation.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { CerebellumPrediction, SpeedOfLight, ScoredEpisode } from "../types/cerebellum.js";
import type { Sense } from "../types/sense.js";
import type { SensoryCortex } from "../senses/cortex.js";
import type { ResolutionOutcome } from "../types/tension.js";
import type { SimulatedScenario, SimulationTrigger } from "../types/hippocampal-simulation.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { ExteroceptiveBatch, BatchAction } from "../types/exteroception.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("subcortical-hooks");

export interface SubcorticalHooks {
  /** Called during build-cycle integrate. */
  recordBuildOutcome(
    context: BuildCycleContext,
    result: BuildCycleResult,
  ): Promise<void>;

  /**
   * Cerebellum: predict evaluation scores before building.
   * Called after consultation, before the Explore/Build phase.
   * Returns null on cold start (insufficient episodes).
   */
  predictScores(
    taskId: string,
    consultation: Consultation,
  ): Promise<CerebellumPrediction | null>;

  /**
   * Cerebellum: retrieve the speed of light computed during predictScores().
   * Always available after predictScores() — sense ceilings don't require history.
   */
  getSpeedOfLight(taskId: string): Promise<SpeedOfLight | null>;

  /**
   * V2: classify a premotor plan's approach into archetype tags and
   * compute approach-specific ceiling. Called from build-cycle.execute
   * after the Motor Cortex plans. Returns tags, or null on failure.
   */
  classifyApproach(
    taskId: string,
    taskDescription: string,
    approach: string,
    model: string,
  ): Promise<string[] | null>;

  /**
   * Cerebellum: compare predicted to actual → dopamine signal.
   * Called after evaluation, in between-tasks processing.
   * The Cerebellum looks up its stored prediction by taskId.
   */
  computeDopamineSignal(
    taskId: string,
    evaluations: SenseEvaluation[],
    cycleData?: {
      outerCycles: number;
      attentionBudget?: { floor: number; expected: number; ceiling: number };
    },
    costData?: {
      cost: number;
      callCount: number;
      costByPurpose: Partial<Record<import("../llm/client.js").Purpose, number>>;
      modelsByPurpose?: Partial<Record<import("../llm/client.js").Purpose, string>>;
      briefingDepth?: import("../types/cost.js").BriefingDepth;
    },
  ): Promise<number>;

  /** Hippocampus: record a full task episode with its dopamine signal. */
  recordEpisode(
    taskId: string,
    result: OrchestratorResult,
    dopamineSignal: number,
  ): Promise<void>;

  /** Basal ganglia: strengthen/weaken routine based on dopamine. */
  updateRoutines(taskId: string, dopamine: number): Promise<void>;

  /** Resolution Rework: apply resolution quality signal to sense weights via plasticity. */
  applyResolutionLearning(
    taskId: string,
    outcomes: ResolutionOutcome[],
  ): Promise<void>;

  /** Hippocampus potentiation: cluster episodes → extract living principles. */
  potentiate(): Promise<{ principlesExtracted: number }>;

  /** Working memory: promote to hippocampus or drop. */
  pruneMemory(): Promise<{ pruned: number; promoted: number }>;

  /** Plasticity: weaken unused/unstable connections. */
  decayConnections(): Promise<{ decayed: number }>;

  /** Plasticity: let volatile weights converge toward defaults. */
  settleWeights(): Promise<{ settled: number }>;

  /** Cerebellum: holistic prediction model recalibration. */
  recalibrate(): Promise<{ recalibrated: boolean }>;

  /** Basal Ganglia: decay unused routines, prune low-confidence ones. */
  decayRoutines(): Promise<{ decayed: number; pruned: number }>;

  /**
   * Cerebellum: find similar episodes using a preliminary fingerprint,
   * before consultation. Used by the efference copy so the Motor Cortex
   * can assess feasibility before senses deliberate.
   * Synchronous — pure computation, no LLM call.
   */
  findPreliminaryMatches(
    activeSenses: Sense[],
    library: SensoryCortex,
  ): ScoredEpisode[];

  /**
   * Cerebellum: rolling prediction accuracy (0–1).
   * Used by the NE signal to compute system maturity.
   * Returns 0.5 (conservative unknown) when no cerebellum is available.
   */
  getCerebellumAccuracy(): number;

  /**
   * Cerebellum: predict outer cycle distribution from similar episodes.
   * Requires a TaskFingerprint (available after consultation).
   * Returns null on cold start (insufficient episodes with cycle data).
   * Called during sensory-cortex prepare to refine the attention budget.
   */
  predictCycleDistribution(
    fingerprint: import("../types/cerebellum.js").TaskFingerprint,
  ): import("../types/attention-budget.js").CyclePercentiles | null;

  /**
   * Hippocampus: constructive episodic simulation.
   * Recombines principles + episodes + world model to imagine
   * future failure scenarios. Called at phase gates, after
   * crystallization, and on high-relevance observations.
   */
  simulate(
    trigger: SimulationTrigger,
    remainingTasks: TaskGraphNode[],
    worldModelMaxims: string[],
    observations: TerritoryObservation[],
  ): Promise<SimulatedScenario[]>;

  /**
   * Mark a simulation as consumed after deep synthesis processes it.
   * Optional — no-op when hippocampus isn't wired.
   */
  dismissSimulation?(scenarioId: string, materialized: boolean): void;

  /**
   * Exteroception: assemble batch of accumulated external signals for processing.
   * Returns null when no pending signals exist.
   */
  assembleExteroceptiveBatch(): ExteroceptiveBatch | null;

  /**
   * Exteroception: record the outcome of batch processing (closes feedback loop).
   * Per-signal action/no-action feeds back to the mini cerebellum for cadence learning.
   */
  recordExteroceptiveBatchOutcome(actions: BatchAction[]): void;

  /**
   * Exteroception: signal pressure for NE risk computation (0–1).
   * High = many unprocessed external signals piling up.
   * Returns 0 when no exteroception system is wired.
   */
  getExteroceptivePressure(): number;
}

/**
 * No-op implementation. Logs what would happen so the system is
 * observable during Phase 1/2 before learning systems exist.
 */
export class NoOpSubcorticalHooks implements SubcorticalHooks {
  async recordBuildOutcome(
    _context: BuildCycleContext,
    result: BuildCycleResult,
  ): Promise<void> {
    log.debug("[stub] recordBuildOutcome", {
      cycles: result.cycles,
      accepted: result.accepted,
    });
  }

  async predictScores(
    taskId: string,
    _consultation: Consultation,
  ): Promise<CerebellumPrediction | null> {
    log.debug("[stub] predictScores", { taskId });
    return null;
  }

  async getSpeedOfLight(taskId: string): Promise<SpeedOfLight | null> {
    log.debug("[stub] getSpeedOfLight", { taskId });
    return null;
  }

  async classifyApproach(
    taskId: string,
    _taskDescription: string,
    _approach: string,
    _model: string,
  ): Promise<string[] | null> {
    log.debug("[stub] classifyApproach", { taskId });
    return null;
  }

  async computeDopamineSignal(
    taskId: string,
    _evaluations: SenseEvaluation[],
    _cycleData?: {
      outerCycles: number;
      attentionBudget?: { floor: number; expected: number; ceiling: number };
    },
    _costData?: {
      cost: number;
      callCount: number;
      costByPurpose: Partial<Record<import("../llm/client.js").Purpose, number>>;
      modelsByPurpose?: Partial<Record<import("../llm/client.js").Purpose, string>>;
      briefingDepth?: import("../types/cost.js").BriefingDepth;
    },
  ): Promise<number> {
    log.debug("[stub] computeDopamineSignal", { taskId });
    return 0;
  }

  async recordEpisode(
    taskId: string,
    _result: OrchestratorResult,
    _dopamineSignal: number,
  ): Promise<void> {
    log.debug("[stub] recordEpisode", { taskId });
  }

  async updateRoutines(taskId: string, dopamine: number): Promise<void> {
    log.debug("[stub] updateRoutines", { taskId, dopamine });
  }

  async applyResolutionLearning(
    taskId: string,
    outcomes: ResolutionOutcome[],
  ): Promise<void> {
    log.debug("[stub] applyResolutionLearning", { taskId, count: outcomes.length });
  }

  async potentiate(): Promise<{ principlesExtracted: number }> {
    log.debug("[stub] potentiate");
    return { principlesExtracted: 0 };
  }

  async pruneMemory(): Promise<{ pruned: number; promoted: number }> {
    log.debug("[stub] pruneMemory");
    return { pruned: 0, promoted: 0 };
  }

  async decayConnections(): Promise<{ decayed: number }> {
    log.debug("[stub] decayConnections");
    return { decayed: 0 };
  }

  async settleWeights(): Promise<{ settled: number }> {
    log.debug("[stub] settleWeights");
    return { settled: 0 };
  }

  async recalibrate(): Promise<{ recalibrated: boolean }> {
    log.debug("[stub] recalibrate");
    return { recalibrated: false };
  }

  async decayRoutines(): Promise<{ decayed: number; pruned: number }> {
    log.debug("[stub] decayRoutines");
    return { decayed: 0, pruned: 0 };
  }

  findPreliminaryMatches(
    _activeSenses: Sense[],
    _library: SensoryCortex,
  ): ScoredEpisode[] {
    log.debug("[stub] findPreliminaryMatches");
    return [];
  }

  getCerebellumAccuracy(): number {
    log.debug("[stub] getCerebellumAccuracy");
    return 0.5; // Conservative unknown
  }

  predictCycleDistribution(
    _fingerprint: import("../types/cerebellum.js").TaskFingerprint,
  ): import("../types/attention-budget.js").CyclePercentiles | null {
    log.debug("[stub] predictCycleDistribution");
    return null;
  }

  async simulate(
    _trigger: SimulationTrigger,
    _remainingTasks: TaskGraphNode[],
    _worldModelMaxims: string[],
    _observations: TerritoryObservation[],
  ): Promise<SimulatedScenario[]> {
    log.debug("[stub] simulate");
    return [];
  }

  assembleExteroceptiveBatch(): ExteroceptiveBatch | null {
    log.debug("[stub] assembleExteroceptiveBatch");
    return null;
  }

  recordExteroceptiveBatchOutcome(actions: BatchAction[]): void {
    log.debug("[stub] recordExteroceptiveBatchOutcome", { count: actions.length });
  }

  getExteroceptivePressure(): number {
    return 0;
  }
}
