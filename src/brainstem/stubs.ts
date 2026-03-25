/**
 * Subcortical Hooks — the interface between rhythms and learning systems.
 *
 * The rhythm's integrate phase calls these hooks. The default implementation
 * is a no-op that logs what would happen. When hippocampus, cerebellum,
 * basal ganglia, and dopamine are built (Phase 3), they implement this
 * interface. The brainstem never needs to change.
 */

import type { BuildCycleContext, BuildCycleResult } from "../types/brainstem.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { Consultation } from "../types/consultation.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { CerebellumPrediction } from "../types/cerebellum.js";
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
   * Cerebellum: compare predicted to actual → dopamine signal.
   * Called after evaluation, in between-tasks processing.
   * The Cerebellum looks up its stored prediction by taskId.
   */
  computeDopamineSignal(
    taskId: string,
    evaluations: SenseEvaluation[],
  ): Promise<number>;

  /** Hippocampus: record a full task episode with its dopamine signal. */
  recordEpisode(
    taskId: string,
    result: OrchestratorResult,
    dopamineSignal: number,
  ): Promise<void>;

  /** Basal ganglia: strengthen/weaken routine based on dopamine. */
  updateRoutines(taskId: string, dopamine: number): Promise<void>;

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

  async computeDopamineSignal(
    taskId: string,
    _evaluations: SenseEvaluation[],
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
}
