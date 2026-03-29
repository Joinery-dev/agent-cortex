import type { ProjectIntent, TasteProfile } from "./types/intent.js";
import type { OrchestratorResult, CortexConfig } from "./types/orchestrator.js";
import type { ProjectContext, ProjectResult, VitalSigns } from "./types/brainstem.js";
import type { Worldview } from "./types/worldview.js";
import { DEFAULT_WORLDVIEW } from "./types/worldview.js";
import { runWithWorldview } from "./util/worldview-context.js";
import { DEFAULT_CONFIG } from "./types/orchestrator.js";
import { SensoryCortex } from "./senses/cortex.js";
import { WorkingMemory } from "./kernel/working-memory.js";
import { createTask } from "./types/task.js";
import { newId } from "./util/ids.js";
import { buildConfig } from "./util/config.js";
import { setLogLevel } from "./util/logger.js";
import type { LogLevel } from "./util/logger.js";
import { getUsage, resetUsage } from "./llm/client.js";
import { Brainstem } from "./brainstem/index.js";

export interface CortexOptions {
  intent: ProjectIntent;
  taste: TasteProfile;
  config?: Partial<CortexConfig>;
  logLevel?: LogLevel;
  dashboard?: boolean | number; // true = port 3000, number = custom port
  /** Ontological frame that shapes how the system thinks. Defaults to shaela. */
  worldview?: Worldview;
}

export class Cortex {
  private intent: ProjectIntent;
  private taste: TasteProfile;
  private config: CortexConfig;
  private library: SensoryCortex;
  private wm: WorkingMemory;
  private brainstem: Brainstem;
  private dashboardUrl: string | null = null;
  private worldview: Worldview;

  constructor(options: CortexOptions) {
    this.intent = options.intent;
    this.taste = options.taste;
    this.worldview = options.worldview ?? DEFAULT_WORLDVIEW;
    this.config = buildConfig(options.config);
    this.library = SensoryCortex.withDefaults();
    this.wm = new WorkingMemory(options.intent.id);
    this.brainstem = new Brainstem(this.config, this.library, undefined, this.wm, undefined, undefined, undefined, undefined, undefined, options.worldview);

    // Initialize cost tracking if the intent has a budget
    if (this.intent.budget) {
      this.brainstem.initCostTracking(this.intent.budget);
    }

    if (options.logLevel) {
      setLogLevel(options.logLevel);
    }
  }

  async startDashboard(port?: number): Promise<string> {
    const { startDashboard } = await import("./dashboard/server.js");
    const p = port ?? 3000;
    this.dashboardUrl = await startDashboard(p);
    return this.dashboardUrl;
  }

  /**
   * Run a single task through the brainstem's rhythm system.
   *
   * WM lifecycle: addTask + startTask here (single-task path skips task-dispatch),
   * completeTask called inside sensory-cortex.integrate.
   */
  async run(description: string, context?: Record<string, unknown>): Promise<OrchestratorResult> {
    const task = createTask(newId(), description, context);
    this.wm.addTask(task.id, description);
    this.wm.startTask(task.id);
    return runWithWorldview(this.worldview, () =>
      this.brainstem.runTask({
        task,
        intent: this.intent,
        taste: this.taste,
      }),
    );
  }

  /**
   * Run a multi-task project through the full rhythm hierarchy:
   * project → task-dispatch → sensory-cortex → build-cycle.
   */
  async runProject(projectContext: Omit<ProjectContext, "intent" | "taste">): Promise<ProjectResult> {
    return runWithWorldview(this.worldview, () =>
      this.brainstem.runProject({
        intent: this.intent,
        taste: this.taste,
        ...projectContext,
      }),
    );
  }

  /** Get current vital signs from the homeostasis monitor. */
  getVitals(): VitalSigns {
    return this.brainstem.getVitals();
  }

  /** Get the working memory instance. */
  getWorkingMemory(): WorkingMemory {
    return this.wm;
  }

  /** Get the brainstem for advanced use (interrupts, hooks, etc). */
  getBrainstem(): Brainstem {
    return this.brainstem;
  }

  getLibrary(): SensoryCortex {
    return this.library;
  }

  getConfig(): CortexConfig {
    return { ...this.config };
  }

  /** Get project cost summary. Returns null when no budget is set. */
  getCostSummary(): import("./types/cost.js").ProjectCostSummary | null {
    return this.brainstem.getCostSummary();
  }

  getTokenUsage() {
    return getUsage();
  }

  resetTokenUsage() {
    resetUsage();
  }
}

// Re-export types for consumers
export type {
  ProjectIntent,
  TasteProfile,
  DecisionRecord,
  DriftEntry,
} from "./types/intent.js";
export type {
  Sense,
  SensePerspective,
  SenseEvaluation,
} from "./types/sense.js";
export type { Task } from "./types/task.js";
export type { Consultation } from "./types/consultation.js";
export type { Tension, TensionResolution } from "./types/tension.js";
export type { OrchestratorResult, CortexConfig } from "./types/orchestrator.js";
export { DEFAULT_CONFIG } from "./types/orchestrator.js";
export { SensoryCortex } from "./senses/cortex.js";
export { WorkingMemory } from "./kernel/working-memory.js";
export { Brainstem } from "./brainstem/index.js";
export type { SubcorticalHooks } from "./brainstem/index.js";
export type { Worldview, Term, WorldviewFrames } from "./types/worldview.js";
export {
  SHAELA_WORLDVIEW,
  PROJECT_WORLDVIEW,
  HYBRID_WORLDVIEW,
  DEFAULT_WORLDVIEW,
} from "./types/worldview.js";
export { loadWorldview } from "./util/worldview-loader.js";
