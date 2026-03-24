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
import { createLogger } from "../util/logger.js";

const log = createLogger("subcortical-hooks");

export interface SubcorticalHooks {
  /** Called during build-cycle integrate. */
  recordBuildOutcome(
    context: BuildCycleContext,
    result: BuildCycleResult,
  ): Promise<void>;

  /** Cerebellum predicted vs. actual eval scores → dopamine signal. */
  computeDopamineSignal(
    predicted: number[],
    actual: number[],
  ): Promise<number>;

  /** Hippocampus: record a full task episode. */
  recordEpisode(
    taskId: string,
    result: OrchestratorResult,
  ): Promise<void>;

  /** Basal ganglia: strengthen/weaken routine based on dopamine. */
  updateRoutines(taskId: string, dopamine: number): Promise<void>;

  /** Hippocampus crystallization: cluster episodes → principles. */
  crystallize(): Promise<{ principlesExtracted: number }>;

  /** Working memory: promote to hippocampus or drop. */
  pruneMemory(): Promise<{ pruned: number; promoted: number }>;

  /** Plasticity: weaken unused/unstable connections. */
  decayConnections(): Promise<{ decayed: number }>;

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

  async computeDopamineSignal(
    predicted: number[],
    actual: number[],
  ): Promise<number> {
    // No cerebellum yet — no prediction error
    log.debug("[stub] computeDopamineSignal", {
      predicted: predicted.length,
      actual: actual.length,
    });
    return 0;
  }

  async recordEpisode(
    taskId: string,
    _result: OrchestratorResult,
  ): Promise<void> {
    log.debug("[stub] recordEpisode", { taskId });
  }

  async updateRoutines(taskId: string, dopamine: number): Promise<void> {
    log.debug("[stub] updateRoutines", { taskId, dopamine });
  }

  async crystallize(): Promise<{ principlesExtracted: number }> {
    log.debug("[stub] crystallize");
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

  async recalibrate(): Promise<{ recalibrated: boolean }> {
    log.debug("[stub] recalibrate");
    return { recalibrated: false };
  }
}
