/**
 * Brainstem — the vital rhythm engine.
 *
 * Ties together the three brainstem responsibilities:
 *   1. Rhythm — the recursive runner that drives all loops
 *   2. Homeostasis — vital signs monitoring with reflex responses
 *   3. Rest — load-triggered consolidation cycles
 *
 * Provides the main API for running tasks and projects through
 * the rhythm system.
 */

import type { Interrupt } from "../types/rhythm.js";
import type {
  ProjectContext,
  ProjectResult,
  SensoryCortexContext,
  SensoryCortexResult,
  VitalSigns,
  TaskGraphNode,
} from "../types/brainstem.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { createTask } from "../types/task.js";
import { newId } from "../util/ids.js";
import { RhythmRunnerImpl } from "./runner.js";
import { HomeostasisMonitor } from "./homeostasis.js";
import { NoOpSubcorticalHooks } from "./stubs.js";
import type { SubcorticalHooks } from "./stubs.js";
import { Cerebellum } from "../subcortical/cerebellum.js";
import { Hippocampus } from "../subcortical/hippocampus.js";
import { CompositeSubcorticalHooks } from "../subcortical/hooks.js";
import { TonicTracker } from "../subcortical/tonic.js";
import { createSensoryCortexDefinition } from "./rhythms/sensory-cortex.js";
import { createProjectDefinition } from "./rhythms/project.js";
import { WorkingMemory } from "../kernel/working-memory.js";
import { Thalamus } from "../kernel/thalamus.js";
import { AttentionScheduler } from "../kernel/attention-scheduler.js";
import type { SchedulerConfig } from "../types/attention-scheduler.js";
import { MotorCortex } from "../kernel/motor-cortex.js";
import { BasalGanglia } from "../kernel/basal-ganglia.js";
import type { BasalGangliaConfig } from "../types/basal-ganglia.js";
import type { Gate } from "../types/gate.js";
import type { StakeAdjuster } from "../kernel/evaluation-weighter.js";
import { createGate } from "../kernel/gate.js";
import { PlasticityStoreImpl } from "../subcortical/plasticity-store.js";
import type { PlasticityStoreConfig } from "../subcortical/plasticity-store.js";

export class Brainstem {
  private runner: RhythmRunnerImpl;
  private homeostasis: HomeostasisMonitor;
  private hooks: SubcorticalHooks;
  private config: CortexConfig;
  private library: SensoryCortex;
  private wm: WorkingMemory;
  private thalamus: Thalamus;
  private scheduler: AttentionScheduler;
  private motorCortex: MotorCortex;
  private basalGanglia: BasalGanglia;
  private gate: Gate;
  private stakeAdjuster: StakeAdjuster;
  private cerebellum: Cerebellum;
  private hippocampus: Hippocampus;
  private plasticityStore: PlasticityStoreImpl;
  private tonicTracker: TonicTracker;

  constructor(
    config: CortexConfig,
    library: SensoryCortex,
    hooks?: SubcorticalHooks,
    wm?: WorkingMemory,
    schedulerConfig?: Partial<SchedulerConfig>,
    basalGangliaConfig?: Partial<BasalGangliaConfig>,
    gate?: Gate,
    stakeAdjuster?: StakeAdjuster,
    plasticityConfig?: Partial<PlasticityStoreConfig>,
  ) {
    this.config = config;
    this.library = library;
    this.runner = new RhythmRunnerImpl();
    this.homeostasis = new HomeostasisMonitor();

    // Subcortical systems: prediction + episodic memory + plasticity.
    this.cerebellum = new Cerebellum();
    this.hippocampus = new Hippocampus({
      potentiationModel: config.models.consultation,
    });
    this.plasticityStore = new PlasticityStoreImpl(plasticityConfig);
    this.tonicTracker = new TonicTracker();

    // Register all built-in connections. Expand per-sense template
    // using the sense IDs from the library.
    const senseIds = library.getSenses().map((s) => s.id);
    this.plasticityStore.registerAll(
      new Map([["evaluator.sense-weight", senseIds]]),
    );

    // Core kernel — thalamus gets hippocampus as a source
    this.wm = wm ?? new WorkingMemory("default");
    this.thalamus = new Thalamus({ wm: this.wm, hippocampus: this.hippocampus });
    this.scheduler = new AttentionScheduler(schedulerConfig);
    this.motorCortex = new MotorCortex(config);
    this.basalGanglia = new BasalGanglia(basalGangliaConfig);
    this.gate = gate ?? createGate();

    // StakeAdjuster: if caller provides one, use it. Otherwise build
    // one that reads evaluation-influence weights from the store.
    this.stakeAdjuster = stakeAdjuster ?? this.createStakeAdjuster();

    // Compose hooks — when no hooks are provided, wire all systems
    this.hooks = hooks ?? new CompositeSubcorticalHooks({
      cerebellum: this.cerebellum,
      hippocampus: this.hippocampus,
      homeostasis: this.homeostasis,
      plasticity: this.plasticityStore,
      tonic: this.tonicTracker,
      projectId: "default",
    });
  }

  /**
   * Build a StakeAdjuster that reads per-sense evaluation-influence
   * weights from the plasticity store.
   *
   * The raw stake (sense's self-assessed relevance) is multiplied by
   * the learned weight (how much the system has learned to trust that
   * sense's self-assessment). Returns raw stake if no weight is registered.
   */
  private createStakeAdjuster(): StakeAdjuster {
    const store = this.plasticityStore;
    return (senseId: string, rawStake: number): number => {
      const weight = store.get(`evaluator.sense-weight.${senseId}`);
      if (!weight) return rawStake;

      // Weight is normalized (sums to 1.0 across senses). Multiply into
      // the raw stake to modulate influence. Scale by number of senses
      // so the weight doesn't shrink stakes toward zero.
      const senseCount = store.getByCategory("evaluation-influence").length;
      return rawStake * weight.value * senseCount;
    };
  }

  /**
   * Run a single task through the sensory-cortex rhythm.
   * Drop-in replacement for the old orchestrator.runTask().
   * Same return type (OrchestratorResult via SensoryCortexResult).
   */
  async runTask(context: SensoryCortexContext): Promise<SensoryCortexResult> {
    await this.hippocampus.load();
    this.thalamus.updateProject(context.intent, context.taste);

    const definition = createSensoryCortexDefinition(
      this.config,
      this.library,
      this.hooks,
      this.wm,
      this.thalamus,
      this.motorCortex,
      this.basalGanglia,
      this.gate,
      this.stakeAdjuster,
    );

    return this.runner.run(definition, context);
  }

  /**
   * Run a full project — multiple tasks with dependencies.
   * Spawns the project rhythm → task-dispatch → sensory-cortex → build-cycle.
   */
  async runProject(context: ProjectContext): Promise<ProjectResult> {
    await this.hippocampus.load();
    if (this.hooks instanceof CompositeSubcorticalHooks) {
      this.hooks.setProjectId(context.intent.id);
    }
    this.thalamus.updateProject(context.intent, context.taste);

    const definition = createProjectDefinition(
      this.config,
      this.library,
      this.hooks,
      this.homeostasis,
      this.wm,
      this.thalamus,
      this.scheduler,
      this.motorCortex,
      this.basalGanglia,
      this.gate,
      this.stakeAdjuster,
    );

    return this.runner.run(definition, context);
  }

  /** Get the working memory instance. */
  getWorkingMemory(): WorkingMemory {
    return this.wm;
  }

  /** Get the thalamus for advanced use. */
  getThalamus(): Thalamus {
    return this.thalamus;
  }

  /** Get the attention scheduler. */
  getScheduler(): AttentionScheduler {
    return this.scheduler;
  }

  /** Get the motor cortex instance. */
  getMotorCortex(): MotorCortex {
    return this.motorCortex;
  }

  /** Get the basal ganglia instance. */
  getBasalGanglia(): BasalGanglia {
    return this.basalGanglia;
  }

  /** Get the gate instance. */
  getGate(): Gate {
    return this.gate;
  }

  /** Get the cerebellum (prediction engine). */
  getCerebellum(): Cerebellum {
    return this.cerebellum;
  }

  /** Get the hippocampus (episodic memory + potentiation). */
  getHippocampus(): Hippocampus {
    return this.hippocampus;
  }

  /** Get the plasticity store (connection weights). */
  getPlasticityStore(): PlasticityStoreImpl {
    return this.plasticityStore;
  }

  /** Get the tonic dopamine tracker. */
  getTonicTracker(): TonicTracker {
    return this.tonicTracker;
  }

  /** Interrupt a running rhythm. */
  interrupt(rhythmId: string, interrupt: Interrupt): void {
    this.runner.interrupt(rhythmId, interrupt);
  }

  /** Get current vital signs. */
  getVitals(): VitalSigns {
    return this.homeostasis.getVitals();
  }

  /** Get the homeostasis monitor (for components that need to report vitals). */
  getHomeostasis(): HomeostasisMonitor {
    return this.homeostasis;
  }

  /** Get the rhythm runner (for advanced use). */
  getRunner(): RhythmRunnerImpl {
    return this.runner;
  }
}

// Re-export key types for consumers
export { RhythmRunnerImpl } from "./runner.js";
export { HomeostasisMonitor } from "./homeostasis.js";
export { NoOpSubcorticalHooks } from "./stubs.js";
export type { SubcorticalHooks } from "./stubs.js";
export type { ReflexAction } from "./homeostasis.js";
export { EscalationError, RhythmAbortedError } from "./errors.js";
export { Thalamus } from "../kernel/thalamus.js";
export { AttentionScheduler } from "../kernel/attention-scheduler.js";
export { MotorCortex } from "../kernel/motor-cortex.js";
export { BasalGanglia } from "../kernel/basal-ganglia.js";
export { Cerebellum } from "../subcortical/cerebellum.js";
export { Hippocampus } from "../subcortical/hippocampus.js";
export { PlasticityStoreImpl } from "../subcortical/plasticity-store.js";
export { CompositeSubcorticalHooks, CerebellumSubcorticalHooks } from "../subcortical/hooks.js";
export { TonicTracker } from "../subcortical/tonic.js";
