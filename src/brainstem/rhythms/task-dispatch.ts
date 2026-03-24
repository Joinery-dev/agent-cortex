/**
 * Task-Dispatch Rhythm — picks tasks from the graph and runs them.
 *
 *   prepare:   Attention Scheduler decides what to do next
 *   execute:   spawn sensory-cortex for a task, rest, or surface escalation
 *   integrate: between-tasks processing (fast path, slow path at phase gates)
 *   gate:      more tasks → continue; all done → complete; escalation → escalate
 */

import type { RhythmDefinition, RhythmState } from "../../types/rhythm.js";
import type {
  TaskDispatchContext,
  TaskDispatchResult,
  TaskGraphNode,
  SensoryCortexContext,
  SensoryCortexResult,
  BetweenTasksFastPath,
  RestCycleContext,
  RestCycleResult,
  ConsolidationPriority,
} from "../../types/brainstem.js";
import type { OrchestratorResult, CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { SchedulerSignals } from "../../types/attention-scheduler.js";
import { createLogger } from "../../util/logger.js";
import { emit } from "../../events.js";
import { createSensoryCortexDefinition } from "./sensory-cortex.js";
import { createRestCycleDefinition } from "./rest.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { HomeostasisMonitor } from "../homeostasis.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { AttentionScheduler } from "../../kernel/attention-scheduler.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { Inhibitor } from "../../kernel/inhibitor.js";

const log = createLogger("task-dispatch");

// ─── Intermediate types ─────────────────────────────────────────

interface PreparedDispatch {
  action: "run-task" | "run-rest" | "done" | "escalate" | "replan";
  task?: TaskGraphNode;
  restContext?: RestCycleContext;
  /** NE level from Scheduler — passed through to sensory-cortex context. */
  neLevel?: number;
  /** Explore/exploit mode from Scheduler. */
  mode?: "explore" | "exploit";
  /** Escalation details when action is "escalate". */
  escalation?: { reason: string; questions: string[] };
  /** Replan details when action is "replan". */
  replanReason?: string;
}

interface ExecutedDispatch {
  action: "task-completed" | "task-escalated" | "rested" | "done" | "scheduler-escalated" | "replan-requested";
  taskId?: string;
  taskResult?: SensoryCortexResult;
  restResult?: RestCycleResult;
  escalationReason?: string;
  escalationQuestions?: string[];
  replanReason?: string;
}

interface IntegratedDispatch {
  betweenTasks?: BetweenTasksFastPath;
  allComplete: boolean;
  completedTasks: string[];
  escalatedTasks: string[];
  /** Non-null when the Scheduler wants to escalate to the human. */
  schedulerEscalation?: { reason: string; questions: string[] };
  /** Non-null when the Scheduler wants to replan. */
  replanRequest?: string;
}

// ─── Accumulator ────────────────────────────────────────────────

interface DispatchAccumulator {
  completedTasks: Set<string>;
  escalatedTasks: Set<string>;
  taskResults: Map<string, OrchestratorResult>;
}

function getAcc(
  state: RhythmState<TaskDispatchContext, TaskDispatchResult>,
): DispatchAccumulator {
  return (state.accumulator as unknown as { __td: DispatchAccumulator }).__td ??= {
    completedTasks: new Set(),
    escalatedTasks: new Set(),
    taskResults: new Map(),
  };
}

// ─── Graph traversal (used by integrate phase) ──────────────────

function allTasksDone(
  graph: TaskGraphNode[],
  completed: Set<string>,
  escalated: Set<string>,
): boolean {
  const done = new Set([...completed, ...escalated]);
  return graph.every((node) => done.has(node.task.id));
}

// ─── Signal assembly ────────────────────────────────────────────

function assembleSignals(
  context: TaskDispatchContext,
  acc: DispatchAccumulator,
  wm: WorkingMemory,
  homeostasis: HomeostasisMonitor,
): SchedulerSignals {
  return {
    taskGraph: context.graph,
    completedTaskIds: acc.completedTasks,
    escalatedTaskIds: acc.escalatedTasks,
    wmSnapshot: {
      tasks: wm.getTasks(),
      senseTrends: wm.getSenseTrends(),
      receptorTrends: wm.getReceptorTrends(),
      openQuestions: wm.getOpenQuestions(),
      patterns: wm.getPatterns(),
      inhibitedSenses: wm.getInhibitedSenses(),
      load: wm.getLoad(),
    },
    vitals: homeostasis.getVitals(),
    needsRest: homeostasis.needsRest(),
    consolidationLoad: homeostasis.getConsolidationLoad(),
  };
}

// ─── Definition factory ─────────────────────────────────────────

export function createTaskDispatchDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  homeostasis: HomeostasisMonitor,
  wm: WorkingMemory,
  thalamus: Thalamus,
  scheduler: AttentionScheduler,
  motorCortex: MotorCortex,
  inhibitor: Inhibitor,
): RhythmDefinition<TaskDispatchContext, TaskDispatchResult, PreparedDispatch, ExecutedDispatch, IntegratedDispatch> {
  const sensoryCortexDef = createSensoryCortexDefinition(config, library, hooks, wm, thalamus, motorCortex, inhibitor);
  const restDef = createRestCycleDefinition(hooks);

  return {
    name: "task-dispatch",
    maxCycles: 0, // Unlimited — runs until graph is exhausted

    async prepare(context, state) {
      const acc = getAcc(state);

      // First cycle: register all graph tasks in WM
      if (acc.completedTasks.size === 0 && acc.escalatedTasks.size === 0) {
        for (const node of context.graph) {
          try {
            wm.addTask(node.task.id, node.task.description);
          } catch {
            // Already added (e.g., re-entered after rest cycle)
          }
        }
      }

      // Attention Scheduler makes the decision
      const signals = assembleSignals(context, acc, wm, homeostasis);
      const decision = scheduler.decide(signals);

      switch (decision.action) {
        case "complete":
          return { action: "done" };

        case "dispatch-task": {
          const taskNode = context.graph.find((n) => n.task.id === decision.taskId);
          if (!taskNode) {
            log.error("Scheduler selected unknown task", { taskId: decision.taskId });
            return { action: "done" };
          }

          // Inhibitor: evaluate sense relevance for this task
          const inhibitionBriefing = await thalamus.forInhibition(
            library,
            taskNode.task,
            decision.neLevel,
            decision.mode,
          );
          await inhibitor.suppress(inhibitionBriefing, "task", wm, config);

          emit("dispatch:task-selected", {
            taskId: taskNode.task.id,
            description: taskNode.task.description,
            completedSoFar: acc.completedTasks.size,
            totalTasks: context.graph.length,
            neLevel: decision.neLevel,
            mode: decision.mode,
            reasoning: decision.reasoning,
          });

          return {
            action: "run-task",
            task: taskNode,
            neLevel: decision.neLevel,
            mode: decision.mode,
          };
        }

        case "rest": {
          log.info("Scheduler requested rest", { reason: decision.reason });
          const load = homeostasis.getConsolidationLoad();
          const priorities: ConsolidationPriority[] = [];

          if (load.memoryPressure > 0.7) priorities.push("prune-memory");
          if (load.predictionDrift > 0.5) priorities.push("recalibrate");
          if (load.weightInstability > 0.6) priorities.push("settle-weights", "decay-connections");
          if (load.episodeDensity > 0.7) priorities.push("crystallize");
          if (priorities.length === 0) priorities.push("crystallize");

          return {
            action: "run-rest",
            restContext: {
              load,
              vitals: homeostasis.getVitals(),
              priorities,
            },
          };
        }

        case "escalate":
          log.info("Scheduler escalating", { reason: decision.reason });
          return {
            action: "escalate",
            escalation: {
              reason: decision.reason,
              questions: decision.questions,
            },
          };

        case "replan":
          log.info("Scheduler requesting replan", { reason: decision.reason });
          return {
            action: "replan",
            replanReason: decision.reason,
          };
      }
    },

    async execute(prepared, state, runner) {
      if (prepared.action === "done") {
        return { action: "done" };
      }

      if (prepared.action === "escalate") {
        return {
          action: "scheduler-escalated",
          escalationReason: prepared.escalation?.reason,
          escalationQuestions: prepared.escalation?.questions,
        };
      }

      if (prepared.action === "replan") {
        return {
          action: "replan-requested",
          replanReason: prepared.replanReason,
        };
      }

      if (prepared.action === "run-rest" && prepared.restContext) {
        const restResult = await runner.run(
          restDef,
          prepared.restContext,
          state.id,
        );
        return { action: "rested", restResult };
      }

      // Run the task through sensory-cortex
      const taskNode = prepared.task!;
      wm.startTask(taskNode.task.id);

      const ctx: SensoryCortexContext = {
        task: taskNode.task,
        intent: state.initialContext.intent,
        taste: state.initialContext.taste,
        briefing: {
          neLevel: prepared.neLevel,
          mode: prepared.mode,
        },
      };

      try {
        const taskResult = await runner.run(sensoryCortexDef, ctx, state.id);
        return {
          action: "task-completed",
          taskId: taskNode.task.id,
          taskResult,
        };
      } catch (err) {
        log.warn(`Task ${taskNode.task.id} escalated`, { error: String(err) });
        return {
          action: "task-escalated",
          taskId: taskNode.task.id,
        };
      }
    },

    async integrate(executed, state) {
      const acc = getAcc(state);

      // Pass-through for non-task actions
      if (executed.action === "done" || executed.action === "rested") {
        return {
          allComplete: allTasksDone(
            state.initialContext.graph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      if (executed.action === "scheduler-escalated") {
        return {
          allComplete: false,
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
          schedulerEscalation: {
            reason: executed.escalationReason ?? "Unknown reason",
            questions: executed.escalationQuestions ?? [],
          },
        };
      }

      if (executed.action === "replan-requested") {
        return {
          allComplete: false,
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
          replanRequest: executed.replanReason ?? "Unknown reason",
        };
      }

      const taskId = executed.taskId!;

      if (executed.action === "task-completed" && executed.taskResult) {
        acc.completedTasks.add(taskId);
        acc.taskResults.set(taskId, executed.taskResult);

        // Between-tasks fast path
        const dopamine = await hooks.computeDopamineSignal([], []);
        await hooks.recordEpisode(taskId, executed.taskResult);
        await hooks.updateRoutines(taskId, dopamine);

        // Feed WM load to homeostasis (drives rest cycle triggers)
        homeostasis.update("workingMemoryLoad", wm.getLoad());

        const betweenTasks: BetweenTasksFastPath = {
          taskId,
          dopamineSignal: dopamine,
          episodeRecorded: true,
          workingMemoryUpdated: true,
          routineUpdated: true,
        };

        emit("dispatch:between-tasks", {
          path: "fast",
          taskId,
          dopamineSignal: dopamine,
        });

        return {
          betweenTasks,
          allComplete: allTasksDone(
            state.initialContext.graph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      // Task escalated
      acc.escalatedTasks.add(taskId);
      wm.failTask(taskId, "Task escalated");

      return {
        allComplete: allTasksDone(
          state.initialContext.graph,
          acc.completedTasks,
          acc.escalatedTasks,
        ),
        completedTasks: [...acc.completedTasks],
        escalatedTasks: [...acc.escalatedTasks],
      };
    },

    async gate(integrated, state) {
      const acc = getAcc(state);

      // Scheduler escalation → bubble up to parent
      if (integrated.schedulerEscalation) {
        return {
          action: "escalate",
          severity: "medium" as const,
          reason: integrated.schedulerEscalation.reason,
          context: {
            type: "scheduler-escalation",
            questions: integrated.schedulerEscalation.questions,
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
          },
        };
      }

      // Replan request → bubble up as high-severity escalation
      if (integrated.replanRequest) {
        return {
          action: "escalate",
          severity: "high" as const,
          reason: integrated.replanRequest,
          context: {
            type: "replan-request",
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
          },
        };
      }

      if (integrated.allComplete) {
        return {
          action: "complete",
          result: {
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
          },
        };
      }

      return {
        action: "continue",
        reason: `${acc.completedTasks.size} completed, ${acc.escalatedTasks.size} escalated, more tasks remaining`,
      };
    },
  };
}
