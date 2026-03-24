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
import { createSensoryCortexDefinition } from "./rhythms/sensory-cortex.js";
import { createProjectDefinition } from "./rhythms/project.js";
import { WorkingMemory } from "../kernel/working-memory.js";
import { Thalamus } from "../kernel/thalamus.js";
import { AttentionScheduler } from "../kernel/attention-scheduler.js";
import type { SchedulerConfig } from "../types/attention-scheduler.js";
import { MotorCortex } from "../kernel/motor-cortex.js";
import { Inhibitor } from "../kernel/inhibitor.js";
import type { InhibitorConfig } from "../types/inhibitor.js";

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
  private inhibitor: Inhibitor;

  constructor(
    config: CortexConfig,
    library: SensoryCortex,
    hooks?: SubcorticalHooks,
    wm?: WorkingMemory,
    schedulerConfig?: Partial<SchedulerConfig>,
    inhibitorConfig?: Partial<InhibitorConfig>,
  ) {
    this.config = config;
    this.library = library;
    this.hooks = hooks ?? new NoOpSubcorticalHooks();
    this.wm = wm ?? new WorkingMemory("default");
    this.thalamus = new Thalamus({ wm: this.wm });
    this.scheduler = new AttentionScheduler(schedulerConfig);
    this.motorCortex = new MotorCortex(config);
    this.inhibitor = new Inhibitor(inhibitorConfig);
    this.runner = new RhythmRunnerImpl();
    this.homeostasis = new HomeostasisMonitor();
  }

  /**
   * Run a single task through the sensory-cortex rhythm.
   * Drop-in replacement for the old orchestrator.runTask().
   * Same return type (OrchestratorResult via SensoryCortexResult).
   */
  async runTask(context: SensoryCortexContext): Promise<SensoryCortexResult> {
    this.thalamus.updateProject(context.intent, context.taste);

    const definition = createSensoryCortexDefinition(
      this.config,
      this.library,
      this.hooks,
      this.wm,
      this.thalamus,
      this.motorCortex,
      this.inhibitor,
    );

    return this.runner.run(definition, context);
  }

  /**
   * Run a full project — multiple tasks with dependencies.
   * Spawns the project rhythm → task-dispatch → sensory-cortex → build-cycle.
   */
  async runProject(context: ProjectContext): Promise<ProjectResult> {
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
      this.inhibitor,
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

  /** Get the inhibitor instance. */
  getInhibitor(): Inhibitor {
    return this.inhibitor;
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
export { Inhibitor } from "../kernel/inhibitor.js";
