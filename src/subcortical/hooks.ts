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
import type { BasalGanglia } from "../kernel/basal-ganglia.js";
import type { Amygdala } from "./amygdala.js";
import type { ExteroceptionSystem } from "./exteroception.js";
import type { HomeostasisMonitor } from "../brainstem/homeostasis.js";
import type { BuildCycleContext, BuildCycleResult } from "../types/brainstem.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { Consultation } from "../types/consultation.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { CerebellumPrediction, SpeedOfLight, ScoredEpisode } from "../types/cerebellum.js";
import type { Sense } from "../types/sense.js";
import type { SensoryCortex } from "../senses/cortex.js";
import type { WorkingMemory } from "../kernel/working-memory.js";
import type { DopamineProjections } from "../types/dopamine.js";
import type { ResolutionOutcome } from "../types/tension.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import type { SimulatedScenario, SimulationTrigger } from "../types/hippocampal-simulation.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { ExteroceptiveBatch, BatchAction } from "../types/exteroception.js";
import { TonicTracker } from "./tonic.js";
import { computeProjections } from "./projections.js";
import { createLogger } from "../util/logger.js";
import { emit, emitInfo } from "../events.js";

const log = createLogger("subcortical-hooks");

export interface CompositeHooksSources {
  cerebellum: Cerebellum;
  hippocampus: Hippocampus;
  homeostasis: HomeostasisMonitor;
  /** Current project ID — needed for episode recording + tonic tracking. */
  projectId: string;
  plasticity?: PlasticityStoreImpl;
  tonic?: TonicTracker;
  basalGanglia?: BasalGanglia;
  amygdala?: Amygdala;
  exteroception?: ExteroceptionSystem;
  wm?: WorkingMemory;
}

export class CompositeSubcorticalHooks implements SubcorticalHooks {
  private cerebellum: Cerebellum;
  private hippocampus: Hippocampus;
  private homeostasis: HomeostasisMonitor;
  private projectId: string;
  private plasticity?: PlasticityStoreImpl;
  private basalGanglia?: BasalGanglia;
  private amygdala?: Amygdala;
  private exteroception?: ExteroceptionSystem;
  private wm?: WorkingMemory;
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
    this.basalGanglia = sources.basalGanglia;
    this.amygdala = sources.amygdala;
    this.exteroception = sources.exteroception;
    this.wm = sources.wm;
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

  /** Get the amygdala (for pre-action gate wiring in build-cycle). */
  getAmygdala(): Amygdala | undefined {
    return this.amygdala;
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

  async getSpeedOfLight(taskId: string): Promise<SpeedOfLight | null> {
    return this.cerebellum.getSpeedOfLight(taskId);
  }

  async classifyApproach(
    taskId: string,
    taskDescription: string,
    approach: string,
    model: string,
  ): Promise<string[] | null> {
    const result = await this.cerebellum.classifyAndEstimate(
      taskId,
      taskDescription,
      approach,
      model,
    );
    return result ? result.approachTags : null;
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
  ): Promise<number> {
    const signal = this.cerebellum.recordOutcome(taskId, evaluations, costData, cycleData);

    // Feed prediction efficiency (ceiling-relative) to homeostasis.
    // Recalibration triggers when efficiency is low — meaning room to
    // improve — not when raw accuracy is low due to inherently noisy data.
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
    const episodeDensity = this.hippocampus.getEpisodeDensity();
    this.homeostasis.setEpisodeDensity(episodeDensity);

    emitInfo("learning:episode-recorded", {
      taskId,
      projectId: this.projectId,
      dopamineSignal,
      encodingStrength: significance,
      episodeDensity,
      confidence: result.confidence,
      cycles: result.cycles,
    });
  }

  async potentiate(): Promise<{ principlesExtracted: number }> {
    const result = await this.hippocampus.potentiate();

    emitInfo("learning:potentiation", {
      principlesExtracted: result.principlesExtracted,
      projectId: this.projectId,
    });

    return result;
  }

  async pruneMemory(): Promise<{ pruned: number; promoted: number }> {
    if (!this.wm) return { pruned: 0, promoted: 0 };

    const result = this.wm.pruneStale();

    // Promote high-confidence patterns as lightweight episodes
    // so hippocampal potentiation can crystallize them into principles
    let promoted = 0;
    for (const description of result.promotable) {
      this.hippocampus.recordEpisode(
        this.projectId,
        `wm-promotion-${Date.now()}-${promoted}`,
        `Pattern promoted from working memory: ${description}`,
        {
          taskId: `wm-promotion-${Date.now()}-${promoted}`,
          status: "complete",
          confidence: 0.7,
          work: description,
          cycles: 0,
          evaluations: [],
          tensions: [],
          resolutions: [],
          decisionLog: [],
        } as import("../types/orchestrator.js").OrchestratorResult,
        0, // neutral dopamine — this is consolidation, not surprise
      );
      promoted++;
    }

    if (result.pruned > 0 || promoted > 0) {
      this.homeostasis.update("workingMemoryLoad", this.wm.getLoad());

      emitInfo("learning:wm-pruned", {
        pruned: result.pruned,
        promoted,
        wmLoadAfter: this.wm.getLoad(),
      });
    }

    return { pruned: result.pruned, promoted };
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

  async updateRoutines(taskId: string, _dopamine: number): Promise<void> {
    if (!this.basalGanglia) return;

    const striatal = this.lastProjections?.striatal;
    if (striatal) {
      this.basalGanglia.reinforceRoutine(taskId, striatal);

      emitInfo("learning:routine-update", {
        taskId,
        reinforcement: striatal.reinforcement,
        explorationBias: striatal.explorationBias,
        routineCount: this.basalGanglia.getRoutineCount(),
      });
    }
  }

  // ── Resolution Rework (#13): resolution quality → plasticity ──

  async applyResolutionLearning(
    taskId: string,
    outcomes: ResolutionOutcome[],
  ): Promise<void> {
    if (!this.plasticity || outcomes.length === 0) return;

    let applied = 0;

    for (const outcome of outcomes) {
      if (outcome.collapsed) {
        // Collapsed = capitulation. Boost the capitulated (lower-scored) sense
        // so it gets listened to more next time.
        const lowerSenseId =
          outcome.preScores.senseA <= outcome.preScores.senseB
            ? outcome.senseAId
            : outcome.senseBId;

        const weightId = `evaluator.sense-weight.${lowerSenseId}`;
        const weight = this.plasticity.get(weightId);
        if (weight) {
          this.plasticity.update(weightId, 0.03, "resolution", taskId);
          applied++;
        }
      } else if (outcome.quality > 0.5) {
        // Resolution worked — the lower-scored sense had legitimate concerns.
        // Modestly boost its weight so future tensions from it are taken seriously.
        const lowerSenseId =
          outcome.preScores.senseA <= outcome.preScores.senseB
            ? outcome.senseAId
            : outcome.senseBId;

        const weightId = `evaluator.sense-weight.${lowerSenseId}`;
        const weight = this.plasticity.get(weightId);
        if (weight) {
          const delta = 0.02 * outcome.quality;
          this.plasticity.update(weightId, delta, "resolution", taskId);
          applied++;
        }
      }
      // quality <= 0.5 and not collapsed: no weight change.
      // The resolution didn't work, but we can't attribute that to
      // the sense — it might be the resolver's strategy that failed.
    }

    if (applied > 0) {
      this.homeostasis.update("weightVolatility", this.plasticity.getVolatility());
      this.homeostasis.update("weightDisplacement", this.plasticity.getDisplacement());

      emit("resolution:learning-applied", {
        taskId,
        outcomesTotal: outcomes.length,
        weightsAdjusted: applied,
        meanQuality: outcomes.reduce((s, o) => s + o.quality, 0) / outcomes.length,
      });

      log.info("Resolution learning applied", {
        taskId,
        outcomes: outcomes.length,
        adjusted: applied,
      });
    }
  }

  // ── Cerebellum: preliminary matching (efference copy) ────────

  findPreliminaryMatches(
    activeSenses: Sense[],
    library: SensoryCortex,
  ): ScoredEpisode[] {
    return this.cerebellum.findPreliminaryMatches(activeSenses, library);
  }

  // ── Cerebellum: accuracy ─────────────────────────────────────

  getCerebellumAccuracy(): number {
    return this.cerebellum.getAccuracy();
  }

  predictCycleDistribution(
    fingerprint: import("../types/cerebellum.js").TaskFingerprint,
  ): import("../types/attention-budget.js").CyclePercentiles | null {
    return this.cerebellum.predictCycleDistribution(fingerprint);
  }

  // ── Basal Ganglia ────────────────────────────────────────────

  async decayRoutines(): Promise<{ decayed: number; pruned: number }> {
    if (!this.basalGanglia) return { decayed: 0, pruned: 0 };
    return this.basalGanglia.decayRoutines();
  }

  // ── Hippocampus: simulation ──────────────────────────────────

  async simulate(
    trigger: SimulationTrigger,
    remainingTasks: TaskGraphNode[],
    worldModelMaxims: string[],
    observations: TerritoryObservation[],
  ): Promise<SimulatedScenario[]> {
    return this.hippocampus.simulate(
      trigger,
      remainingTasks,
      worldModelMaxims,
      observations,
    );
  }

  dismissSimulation(scenarioId: string, materialized: boolean): void {
    this.hippocampus.recordSimulationOutcome(scenarioId, materialized, 0);
  }

  // ── Exteroception ──────────────────────────────────────────────

  assembleExteroceptiveBatch(): ExteroceptiveBatch | null {
    if (!this.exteroception) return null;
    return this.exteroception.assembleBatch();
  }

  recordExteroceptiveBatchOutcome(actions: BatchAction[]): void {
    if (!this.exteroception) return;
    this.exteroception.recordBatchOutcome(actions);
  }

  getExteroceptivePressure(): number {
    if (!this.exteroception) return 0;
    return this.exteroception.getSignalPressure();
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

    // Feed updated volatility + displacement to homeostasis
    const volatility = this.plasticity.getVolatility();
    const displacement = this.plasticity.getDisplacement();
    this.homeostasis.update("weightVolatility", volatility);
    this.homeostasis.update("weightDisplacement", displacement);

    emitInfo("learning:plasticity-applied", {
      taskId: projections.taskId,
      learningRate,
      receptorsUpdated: perReceptor.length,
      weightVolatility: volatility,
      weightDisplacement: displacement,
    });

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
