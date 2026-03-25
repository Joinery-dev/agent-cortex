/**
 * Project Rhythm — the outermost loop.
 *
 *   prepare:   validate context, wrap single task as graph if needed
 *   execute:   spawn task-dispatch
 *   integrate: retrospective (stub)
 *   gate:      always complete after one pass
 */

import type { RhythmDefinition } from "../../types/rhythm.js";
import type {
  ProjectContext,
  ProjectResult,
  TaskDispatchResult,
  TaskGraphNode,
} from "../../types/brainstem.js";
import type { CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import { createLogger } from "../../util/logger.js";
import { emit } from "../../events.js";
import { createTaskDispatchDefinition } from "./task-dispatch.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { HomeostasisMonitor } from "../homeostasis.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { AttentionScheduler } from "../../kernel/attention-scheduler.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { BasalGanglia } from "../../kernel/basal-ganglia.js";
import type { Gate } from "../../types/gate.js";
import type { StakeAdjuster } from "../../kernel/evaluation-weighter.js";

const log = createLogger("project-rhythm");

interface PreparedProject {
  graph: TaskGraphNode[];
}

export function createProjectDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  homeostasis: HomeostasisMonitor,
  wm: WorkingMemory,
  thalamus: Thalamus,
  scheduler: AttentionScheduler,
  motorCortex: MotorCortex,
  basalGanglia: BasalGanglia,
  gate: Gate,
  stakeAdjuster?: StakeAdjuster,
): RhythmDefinition<ProjectContext, ProjectResult, PreparedProject, TaskDispatchResult, ProjectResult> {
  const taskDispatchDef = createTaskDispatchDefinition(config, library, hooks, homeostasis, wm, thalamus, scheduler, motorCortex, basalGanglia, gate, stakeAdjuster);

  return {
    name: "project",
    maxCycles: 1, // Projects don't loop — looping happens inside task-dispatch

    async prepare(context, _state) {
      log.info("Project starting", {
        tasks: context.tasks.length,
        intent: context.intent.summary,
      });

      emit("project:start", {
        intentId: context.intent.id,
        taskCount: context.tasks.length,
      });

      return { graph: context.tasks };
    },

    async execute(prepared, state, runner) {
      const result = await runner.run(
        taskDispatchDef,
        {
          intent: state.initialContext.intent,
          taste: state.initialContext.taste,
          graph: prepared.graph,
        },
        state.id,
      );

      return result;
    },

    async integrate(executed, _state) {
      // Retrospective — stub for now
      // In the real system, this would do a final crystallization sweep
      // and produce a retrospective summary

      log.info("Project retrospective", {
        completed: executed.completedTasks.length,
        escalated: executed.escalatedTasks.length,
      });

      const state: ProjectResult["state"] =
        executed.escalatedTasks.length > 0 ? "paused" : "delivered";

      return {
        state,
        taskResults: executed.taskResults,
        retrospective: undefined,
      };
    },

    async gate(integrated, _state) {
      emit("project:complete", {
        state: integrated.state,
        completedTasks: integrated.taskResults.size,
      });

      return {
        action: "complete",
        result: integrated,
      };
    },
  };
}
