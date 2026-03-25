/**
 * CompositeSubcorticalHooks — delegates to each subcortical system.
 *
 * Replaces the old CerebellumSubcorticalHooks with a compositor
 * that routes each hook method to the right subsystem:
 *   - Cerebellum: prediction, dopamine, recalibration
 *   - Dopamine relay: tonic tracking, per-consumer projections
 *   - Hippocampus: episode recording, potentiation, memory pruning
 *   - Plasticity: connection decay, weight settling, dopamine-driven updates
 *   - Basal Ganglia: routine updates (future — reads striatal projection)
 *
 * Each subsystem is optional — missing systems fall through to
 * no-op behavior. This lets the system grow incrementally.
 */

import type { SubcorticalHooks } from "../brainstem/stubs.js";
import type { Cerebellum } from "./cerebellum.js";
import type { Hippocampus } from "./hippocampus.js";
import type { PlasticityStoreImpl } from "./plasticity-store.js";
import type { HomeostasisMonitor } from "../brainstem/homeostasis.js";
import type { BuildCycleContext, BuildCycleResult } from "../types/brainstem.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { Consultation } from "../types/consultation.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { CerebellumPrediction } from "../types/cerebellum.js";
import type { DopamineProjections } from "../types/dopamine.js";
import { TonicTracker } from "./tonic.js";
import { computeProjections } from "./projections.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("subcortical-hooks");

export interface CompositeHooksSources {
  cerebellum: Cerebellum;
  hippocampus: Hippocampus;
  homeostasis: HomeostasisMonitor;
  /** Current project ID — needed for episode recording + tonic tracking. */
  projectId: string;
  plasticity?: PlasticityStoreImpl;
  tonic?: TonicTracker;
  // Future:
  // basalGanglia?: BasalGanglia;
}

export class CompositeSubcorticalHooks implements SubcorticalHooks {
  private cerebellum: Cerebellum;
  private hippocampus: Hippocampus;
  private homeostasis: HomeostasisMonitor;
  private projectId: string;
  private plasticity?: PlasticityStoreImpl;
  private tonic: TonicTracker;

  /**
   * The most recent dopamine projections, computed in computeDopamineSignal().
   * Read by recordEpisode() to pass hippocampal encodingStrength as significance.
   */
  private lastProjections: DopamineProjections | null = null;

  constructor(sources: CompositeHooksSources) {
    this.cerebellum = sources.cerebellum;
    this.hippocampus = sources.hippocampus;
    this.homeostasis = sources.homeostasis;
    this.projectId = sources.projectId;
    this.plasticity = sources.plasticity;
    this.tonic = sources.tonic ?? new TonicTracker();
  }

  /** Update project ID when a new project starts. */
  setProjectId(projectId: string): void {
    this.projectId = projectId;
  }

  /** Get the tonic tracker (for persistence/dashboard). */
  getTonicTracker(): TonicTracker {
    return this.tonic;
  }

  /** Get the most recent dopamine projections (for consumers outside the hook chain). */
  getLastProjections(): DopamineProjections | null {
    return this.lastProjections;
  }

  // ── Cerebellum ──────────────────────────────────────────────

  async predictScores(
    taskId: string,
    consultation: Consultation,
  ): Promise<CerebellumPrediction | null> {
    return this.cerebellum.predict(taskId, consultation);
  }

  /**
   * Compute dopamine signal, update tonic, compute projections,
   * apply plasticity updates, feed vitals to homeostasis.
   *
   * Returns the phasic aggregate (number) for the rhythm layer.
   * Stores full projections internally for recordEpisode() to read.
   */
  async computeDopamineSignal(
    taskId: string,
    evaluations: SenseEvaluation[],
  ): Promise<number> {
    const signal = this.cerebellum.recordOutcome(taskId, evaluations);

    // Feed prediction accuracy to homeostasis
    this.homeostasis.update(
      "predictionAccuracy",
      this.cerebellum.getAccuracy(),
    );

    if (!signal) {
      this.lastProjections = null;
      return 0;
    }

    // ── Dopamine distribution protocol ──────────────────────

    // 1. Update tonic level
    const tonicState = this.tonic.update(this.projectId, signal.aggregate);

    // 2. Compute all per-consumer projections
    const projections = computeProjections(signal, tonicState);
    this.lastProjections = projections;

    // 3. Feed tonic to homeostasis (map unbounded level to 0–1 for vital sign)
    //    tonic -3 → 0, tonic 0 → 0.5, tonic +3 → 1
    const tonicVital = Math.max(0, Math.min(1, 0.5 + tonicState.level / 6));
    this.homeostasis.update("tonicDopamine", tonicVital);

    // 4. Apply plasticity projection
    if (this.plasticity) {
      this.applyPlasticityProjection(projections);
    }

    log.debug("Dopamine distributed", {
      taskId: signal.taskId,
      phasicAggregate: signal.aggregate.toFixed(3),
      tonicLevel: tonicState.level.toFixed(3),
      tonicTrend: tonicState.trend,
      encodingStrength: projections.hippocampal.encodingStrength.toFixed(3),
      reinforcement: projections.striatal.reinforcement.toFixed(3),
      explorationBias: projections.striatal.explorationBias.toFixed(3),
      learningRate: projections.plasticity.learningRate.toFixed(3),
      wmGateStrength: projections.prefrontal.wmGateStrength.toFixed(3),
    });

    emit("dopamine:distributed", {
      taskId: signal.taskId,
      phasicAggregate: signal.aggregate,
      tonicLevel: tonicState.level,
      tonicTrend: tonicState.trend,
      encodingStrength: projections.hippocampal.encodingStrength,
      reinforcement: projections.striatal.reinforcement,
      explorationBias: projections.striatal.explorationBias,
      learningRate: projections.plasticity.learningRate,
      wmGateStrength: projections.prefrontal.wmGateStrength,
    });

    return signal.aggregate;
  }

  async recalibrate(): Promise<{ recalibrated: boolean }> {
    const result = this.cerebellum.recalibrate();
    this.homeostasis.update(
      "predictionAccuracy",
      this.cerebellum.getAccuracy(),
    );
    return { recalibrated: result.recalibrated };
  }

  // ── Hippocampus ─────────────────────────────────────────────

  async recordEpisode(
    taskId: string,
    result: OrchestratorResult,
    dopamineSignal: number,
  ): Promise<void> {
    // Use hippocampal projection's encodingStrength as significance
    // when available (computed in computeDopamineSignal). Falls back
    // to undefined, which lets the episode-builder use its legacy formula.
    const significance = this.lastProjections?.hippocampal.encodingStrength;

    this.hippocampus.recordEpisode(
      this.projectId,
      taskId,
      taskId, // taskDescription — enriched when Thalamus provides it
      result,
      dopamineSignal,
      significance,
    );

    // Feed episode density to homeostasis
    this.homeostasis.setEpisodeDensity(
      this.hippocampus.getEpisodeDensity(),
    );
  }

  async potentiate(): Promise<{ principlesExtracted: number }> {
    return this.hippocampus.potentiate();
  }

  async pruneMemory(): Promise<{ pruned: number; promoted: number }> {
    log.debug("pruneMemory called — promotion logic pending");
    return { pruned: 0, promoted: 0 };
  }

  // ── Plasticity ─────────────────────────────────────────────

  async decayConnections(): Promise<{ decayed: number }> {
    if (!this.plasticity) return { decayed: 0 };

    const decayed = this.plasticity.decay();

    this.homeostasis.update(
      "weightVolatility",
      this.plasticity.getVolatility(),
    );

    return { decayed };
  }

  async settleWeights(): Promise<{ settled: number }> {
    if (!this.plasticity) return { settled: 0 };

    const settled = this.plasticity.settle();

    this.homeostasis.update(
      "weightVolatility",
      this.plasticity.getVolatility(),
    );

    return { settled };
  }

  // ── Not yet wired (future subsystems) ───────────────────────

  async recordBuildOutcome(
    _context: BuildCycleContext,
    _result: BuildCycleResult,
  ): Promise<void> {
    // No-op until build-level tracking is needed
  }

  async updateRoutines(_taskId: string, _dopamine: number): Promise<void> {
    // No-op until basal ganglia is built.
    // When it is, it will read this.lastProjections.striatal
    // for reinforcement + explorationBias.
  }

  // ── Private: plasticity projection application ──────────────

  /**
   * Apply the plasticity projection to connection weights.
   *
   * Replaces the old hardcoded applyDopamineToWeights — same effect,
   * but learning rate and per-receptor deltas come from the projection
   * (pure function in projections.ts) instead of being computed inline.
   */
  private applyPlasticityProjection(projections: DopamineProjections): void {
    if (!this.plasticity) return;

    const { learningRate, perReceptor } = projections.plasticity;

    for (const rd of perReceptor) {
      const senseWeightId = `evaluator.sense-weight.${rd.receptorId}`;
      const weight = this.plasticity.get(senseWeightId);
      if (weight) {
        const delta = rd.delta * learningRate;
        this.plasticity.update(
          senseWeightId,
          delta,
          "dopamine",
          projections.taskId,
        );
      }
    }

    // Feed updated volatility to homeostasis
    this.homeostasis.update(
      "weightVolatility",
      this.plasticity.getVolatility(),
    );

    log.debug("Plasticity projection applied", {
      taskId: projections.taskId,
      learningRate: learningRate.toFixed(4),
      receptorsUpdated: perReceptor.length,
    });
  }
}

/**
 * @deprecated Use CompositeSubcorticalHooks instead.
 * Kept as an alias for backwards compatibility.
 */
export { CompositeSubcorticalHooks as CerebellumSubcorticalHooks };
