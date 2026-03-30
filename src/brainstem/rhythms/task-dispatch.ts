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
import type { RiskFactors } from "../../types/norepinephrine.js";
import { mapUrgencyToNE } from "../../kernel/norepinephrine.js";
import { createLogger } from "../../util/logger.js";
import { emit, emitInfo, emitWarn } from "../../events.js";
import { createSensoryCortexDefinition } from "./sensory-cortex.js";
import { createRestCycleDefinition } from "./rest.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { HomeostasisMonitor } from "../homeostasis.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { AttentionScheduler } from "../../kernel/attention-scheduler.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { BasalGanglia } from "../../kernel/basal-ganglia.js";
import type { Gate } from "../../types/gate.js";
import type { CognitiveFlexibility } from "../../kernel/cognitive-flexibility.js";
import type { StakeAdjuster } from "../../kernel/evaluation-weighter.js";
import type { WorldModel } from "../../kernel/world-model.js";
import type { PeripheralNervousSystem } from "../../kernel/pns.js";
import type { ConvictionResult } from "../../types/conviction.js";
import { runConvictionLoop, modulateThresholds, DEFAULT_CONVICTION_THRESHOLDS } from "../../kernel/conviction.js";
import { prepareForward } from "../../kernel/prospective-preparation.js";
import type { DriftMonitor } from "../../kernel/drift-monitor.js";
import type { TasteFeedbackLoop } from "../../kernel/taste-feedback.js";
import type { ProspectiveMemory } from "../../kernel/prospective-memory.js";
import type { IntegrationChecker } from "../../kernel/integration-check.js";
import type { PhaseGateResult } from "../../types/integration-check.js";
import type { SurgeryProposal, SurgeryResult } from "../../types/graph-surgery.js";
import { quickTriage } from "../../kernel/quick-triage.js";
import { applySurgery, validateProposal } from "../../kernel/graph-surgery.js";
import { deepSynthesis } from "../../kernel/deep-synthesis.js";
import { newId } from "../../util/ids.js";
import { setCostTaskId, setModelSelector, clearModelsUsed } from "../../llm/client.js";
import type { CostTracker } from "../cost-tracker.js";
import { selectModel } from "../../kernel/model-selector.js";
import type { ModelQualityPredictor } from "../../kernel/model-selector.js";
import { reallocateBudget } from "../../kernel/budget-allocator.js";
import { computeAttentionBudget } from "../../kernel/attention-budget.js";
import { simulationRelevanceThreshold } from "../../types/territory-observation.js";

const log = createLogger("task-dispatch");

// ─── Intermediate types ─────────────────────────────────────────

interface PreparedDispatch {
  action: "run-task" | "run-rest" | "run-nursery" | "run-observe" | "done" | "escalate" | "replan";
  task?: TaskGraphNode;
  restContext?: RestCycleContext;
  /** NE level from Scheduler — passed through to sensory-cortex context. */
  neLevel?: number;
  /** Frozen risk factors from dispatch — carried through to enrichment sites. */
  riskSnapshot?: RiskFactors;
  /** Explore/leverage mode from Scheduler. */
  mode?: "explore" | "leverage";
  /** Escalation details when action is "escalate". */
  escalation?: { reason: string; questions: string[]; escalationType?: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift" };
  /** Replan details when action is "replan". */
  replanReason?: string;
  /** Task budget from Scheduler dispatch (dollars). */
  taskBudget?: number;
  /** Project-level budget utilization (0–1). */
  projectBudgetUtilization?: number;
  /** Phase group for nursery dispatch. */
  nurseryPhaseGroup?: string;
}

interface ExecutedDispatch {
  action: "task-completed" | "task-escalated" | "rested" | "done" | "scheduler-escalated" | "replan-requested" | "nursery-completed" | "observed";
  taskId?: string;
  taskResult?: SensoryCortexResult;
  restResult?: RestCycleResult;
  escalationReason?: string;
  escalationQuestions?: string[];
  escalationType?: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
  replanReason?: string;
  /** Nursery result when action is "nursery-completed". */
  nurseryResult?: import("../../types/nursery.js").NurseryResult;
  /** Phase group that was nursed. */
  nurseryPhaseGroup?: string;
  /** Quick triage result from observe action. */
  observeTriageResult?: import("../../kernel/quick-triage.js").QuickTriageResult;
  /** Deep synthesis result from observe (only when NE high or pressure critical). */
  observeSynthesisResult?: import("../../kernel/deep-synthesis.js").DeepSynthesisResult;
}

interface IntegratedDispatch {
  betweenTasks?: BetweenTasksFastPath;
  allComplete: boolean;
  completedTasks: string[];
  escalatedTasks: string[];
  /** Non-null when the Scheduler wants to escalate to the Parsifal. */
  schedulerEscalation?: { reason: string; questions: string[]; escalationType: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift" };
  /** Non-null when the Scheduler wants to replan. */
  replanRequest?: string;
  /** PFC intervention flags from homeostasis, for gate-level processing. */
  pfcFlags?: Array<{ type: "learning-signal-degraded" | "tonic-dopamine-crashed" | "weight-displacement-high"; reason: string }>;
  /** Present when a phase gate fired during this integration. */
  phaseGateResult?: PhaseGateResult;
  /** Quick triage flagged deep synthesis should run early. */
  flagForDeepSynthesis?: boolean;
  /** Surgery applied during phase gate deep synthesis. */
  appliedSurgery?: SurgeryResult;
  /** Deep synthesis determined blast radius too high → replan instead. */
  synthesisReplanRequired?: boolean;
  /** Non-null when nursery fix cycles exceeded the max — escalate to Parsifal. */
  nurseryStuck?: { phaseGroup: string; cycle: number; findingCount: number };
}

// ─── Accumulator ────────────────────────────────────────────────

interface DispatchAccumulator {
  completedTasks: Set<string>;
  escalatedTasks: Set<string>;
  taskResults: Map<string, OrchestratorResult>;
  /** When PFC flags request a rest cycle with learning signal recovery priorities. */
  __pfcRestRequested: boolean;
  /** Previous conviction result — for delta tracking across tasks. */
  previousConviction: ConvictionResult | null;
  /** Most recent NE level from dispatch — used by integration check. */
  lastNELevel: number;
  /** Working copy of the graph, updated by graph surgery. */
  liveGraph: TaskGraphNode[];
  /** Counter for discovery task ID generation. */
  discoveryCounter: number;
  /** Last completed task's aggregate dopamine — for NE recency-of-failure. */
  lastDopamine?: number;
  /** Last dispatched attention budget — for episode recording. */
  lastAttentionBudget?: import("../../types/attention-budget.js").AttentionBudget;

  // ── Nursery tracking ──
  /** Phases that had runtime surface detected — awaiting nursery graduation. */
  nurseryPendingPhases: Set<string>;
  /** Phases that graduated from the nursery (or had no runtime surface). */
  nurseryGraduatedPhases: Set<string>;
  /** Task IDs inserted by nursery fix proposals, keyed by phase group. */
  nurseryFixTasks: Map<string, Set<string>>;
  /** How many nursery cycles have run per phase group. */
  nurseryCycles: Map<string, number>;
}

function getAcc(
  state: RhythmState<TaskDispatchContext, TaskDispatchResult>,
): DispatchAccumulator {
  return (state.accumulator as unknown as { __td: DispatchAccumulator }).__td ??= {
    completedTasks: new Set(),
    escalatedTasks: new Set(),
    taskResults: new Map(),
    previousConviction: null,
    lastNELevel: 0.5,
    liveGraph: [], // Populated on first cycle from context.graph
    discoveryCounter: 0,
    __pfcRestRequested: false,
    nurseryPendingPhases: new Set(),
    nurseryGraduatedPhases: new Set(),
    nurseryFixTasks: new Map(),
    nurseryCycles: new Map(),
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
  graph: TaskGraphNode[],
  context: TaskDispatchContext,
  acc: DispatchAccumulator,
  wm: WorkingMemory,
  homeostasis: HomeostasisMonitor,
  hooks: SubcorticalHooks,
  config: CortexConfig,
  basalGanglia?: BasalGanglia,
  driftMonitor?: DriftMonitor,
  prospectiveMemory?: ProspectiveMemory,
  costTracker?: CostTracker,
): SchedulerSignals {
  // Drift Monitor signals (Phase 4)
  const driftAssessment = driftMonitor?.getAssessment();
  const driftLevel = driftAssessment?.driftLevel;
  const driftSummary = driftAssessment?.driftSummary;

  // Perseveration detection (Phase 4): if the last 2 completed tasks
  // both exhausted their cycle budget with low confidence, Cortex
  // is struggling across tasks — not just within one.
  let perseverating: boolean | undefined;
  if (acc.completedTasks.size >= 2) {
    const recentIds = [...acc.completedTasks].slice(-2);
    const recentResults = recentIds
      .map((id) => acc.taskResults.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null);

    if (recentResults.length === 2) {
      const allExhausted = recentResults.every((r) => r.cycles >= config.maxCycles);
      const allLowConfidence = recentResults.every((r) => r.confidence < 0.5);
      if (allExhausted && allLowConfidence) {
        perseverating = true;
      }
    }
  }

  return {
    taskGraph: graph,
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
    cerebellumAccuracy: hooks.getCerebellumAccuracy(),
    // Drift Monitor (Phase 4)
    driftLevel: driftLevel && driftLevel > 0 ? driftLevel : undefined,
    driftSummary: driftSummary && driftSummary.length > 0 ? driftSummary : undefined,
    // Cognitive Flexibility (Phase 4)
    perseverating,
    // Prospective Memory: fast-path check per ready task
    prospectiveTriggers: prospectiveMemory ? (() => {
      const readyTaskIds = graph
        .filter((n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id))
        .map((n) => n.task.id);
      const triggerMap = new Map<string, Array<{ id: string; description: string }>>();
      for (const taskId of readyTaskIds) {
        const fired = prospectiveMemory.checkFastPath(taskId);
        if (fired.length > 0) {
          triggerMap.set(taskId, fired.map((f) => ({
            id: f.trigger.id,
            description: f.trigger.condition.description,
          })));
        }
      }
      return triggerMap.size > 0 ? triggerMap : undefined;
    })() : undefined,
    // Basal ganglia routine matches for explore/leverage gating
    routineMatches: basalGanglia?.getRoutineCount()
      ? basalGanglia.getRoutineMatches(
          new Map(
            graph
              .filter((n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id))
              .map((n) => [n.task.id, {
                intent: context.intent,
                taste: context.taste,
                task: n.task,
                enrichment: {
                  senses: [],
                  currentInhibitions: wm.getInhibitedSenses(),
                  senseTrends: wm.getSenseTrends(),
                  patterns: wm.getPatterns(),
                  neLevel: undefined,
                  mode: undefined,
                  totalSenseCount: 0,
                },
                meta: { consumer: "routine-match", assembledAt: new Date(), sources: [], enrichmentCounts: {} },
              }]),
          ),
        )
      : undefined,
    // Proactive Discovery: territory observation pressure
    observationPressure: wm.getObservationPressure() > 0 ? wm.getObservationPressure() : undefined,
    // Exteroception: signal pressure for NE risk computation
    exteroceptivePressure: hooks.getExteroceptivePressure() > 0 ? hooks.getExteroceptivePressure() : undefined,
    // Homeostasis PFC flags — cognitive-level problems that rest can't fix
    pfcFlags: (() => {
      const flags = homeostasis.needsPfcIntervention();
      return flags.length > 0 ? flags : undefined;
    })(),
    // Cost budget signals — from CostTracker when a budget is set
    budgetUtilization: costTracker?.getUtilization(),
    budgetExhausted: costTracker?.isExhausted() || undefined,
    // NE recency-of-failure: last task's aggregate dopamine
    lastTaskDopamine: acc.lastDopamine,
    // NE ambient level: last dispatched task's NE (for observe threshold)
    lastNELevel: acc.lastNELevel,
    // NE Parsifal urgency: mapped from ProjectIntent.urgency
    parsifalUrgency: mapUrgencyToNE(context.intent.urgency),
    taskBudgets: costTracker ? (() => {
      const budgets = new Map<string, { allocated: number; spent: number; remaining: number }>();
      for (const node of graph) {
        const summary = costTracker.getTaskBudget(node.task.id);
        if (summary.allocated > 0) {
          budgets.set(node.task.id, {
            allocated: summary.allocated,
            spent: summary.spent,
            remaining: summary.remaining,
          });
        }
      }
      return budgets.size > 0 ? budgets : undefined;
    })() : undefined,
    // Nursery signals — which phases need graduation
    nurseryPendingPhases: acc.nurseryPendingPhases.size > 0 ? acc.nurseryPendingPhases : undefined,
    nurseryGraduatedPhases: acc.nurseryGraduatedPhases.size > 0 ? acc.nurseryGraduatedPhases : undefined,
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
  basalGanglia: BasalGanglia,
  gate: Gate,
  cognitiveFlexibility: CognitiveFlexibility,
  stakeAdjuster?: StakeAdjuster,
  worldModel?: WorldModel,
  pns?: PeripheralNervousSystem,
  driftMonitor?: DriftMonitor,
  tasteFeedbackLoop?: TasteFeedbackLoop,
  prospectiveMemory?: ProspectiveMemory,
  integrationChecker?: IntegrationChecker,
  costTracker?: CostTracker,
  qualityPredictor?: ModelQualityPredictor,
): RhythmDefinition<TaskDispatchContext, TaskDispatchResult, PreparedDispatch, ExecutedDispatch, IntegratedDispatch> {
  const sensoryCortexDef = createSensoryCortexDefinition(config, library, hooks, wm, thalamus, motorCortex, basalGanglia, gate, cognitiveFlexibility, stakeAdjuster, pns);
  const restDef = createRestCycleDefinition(
    hooks,
    () => homeostasis.getVitals(),
    () => homeostasis.getConsolidationLoad(),
    3,
    () => homeostasis.resetCumulativeNE(),
  );

  return {
    name: "task-dispatch",
    maxCycles: 0, // Unlimited — runs until graph is exhausted

    async prepare(context, state) {
      const acc = getAcc(state);

      // Seed accumulator from carry-over if this is a replanned dispatch
      if (acc.completedTasks.size === 0 && context.priorCompleted) {
        for (const id of context.priorCompleted) acc.completedTasks.add(id);
        for (const id of context.priorEscalated ?? []) acc.escalatedTasks.add(id);
        if (context.priorResults) {
          for (const [id, result] of context.priorResults) {
            acc.taskResults.set(id, result);
          }
        }
      }

      // First cycle: initialize live graph and register tasks in WM
      if (state.completedCycles === 0) {
        acc.liveGraph = [...context.graph];
        for (const node of acc.liveGraph) {
          if (!acc.completedTasks.has(node.task.id) && !acc.escalatedTasks.has(node.task.id)) {
            try {
              wm.addTask(node.task.id, node.task.description);
            } catch {
              // Already added (e.g., re-entered after rest cycle)
            }
          }
        }
      }

      // PFC rest override: gate flagged learning-signal-degraded → inject rest
      if (acc.__pfcRestRequested) {
        acc.__pfcRestRequested = false;
        log.info("PFC rest override: injecting rest for learning signal recovery");
        const load = homeostasis.getConsolidationLoad();
        return {
          action: "run-rest" as const,
          restContext: {
            load,
            vitals: homeostasis.getVitals(),
            priorities: ["recalibrate", "settle-weights"] as ConsolidationPriority[],
          },
        };
      }

      // Attention Scheduler makes the decision
      const signals = assembleSignals(acc.liveGraph, context, acc, wm, homeostasis, hooks, config, basalGanglia, driftMonitor, prospectiveMemory, costTracker);
      const decision = scheduler.decide(signals);

      switch (decision.action) {
        case "complete":
          return { action: "done" };

        case "dispatch-gestate":
          log.info("Nursery dispatch requested", { phaseGroup: decision.phaseGroup });
          return {
            action: "run-nursery" as const,
            nurseryPhaseGroup: decision.phaseGroup,
            neLevel: acc.lastNELevel,
          };

        case "dispatch-task": {
          const taskNode = acc.liveGraph.find((n) => n.task.id === decision.taskId);
          if (!taskNode) {
            log.error("Scheduler selected unknown task", { taskId: decision.taskId });
            return { action: "done" };
          }

          // Prospective Memory: full LLM check before gestalt assembly
          let pmDirectives: string[] | undefined;
          if (prospectiveMemory) {
            const pmModel = config.models.prospectiveMemory ?? config.models.consultation;
            const firedTriggers = await prospectiveMemory.check(
              taskNode.task, context.intent, pmModel,
            );

            if (firedTriggers.length > 0) {
              const directives = firedTriggers.map((f) => f.trigger.action.directive);
              const questions = firedTriggers
                .filter((f) => f.trigger.action.question)
                .map((f) => f.trigger.action.question!);

              if (directives.length > 0) pmDirectives = directives;

              // Questions trigger escalation before the task runs
              if (questions.length > 0) {
                emit("dispatch:pm-escalation", {
                  taskId: taskNode.task.id,
                  questionCount: questions.length,
                  triggerIds: firedTriggers.filter((f) => f.trigger.action.question).map((f) => f.trigger.id),
                });

                return {
                  action: "escalate",
                  escalation: {
                    reason: `Prospective Memory triggered ${questions.length} question(s) for task "${taskNode.task.description}"`,
                    questions,
                  },
                };
              }

              emit("dispatch:pm-fired", {
                taskId: taskNode.task.id,
                directiveCount: directives.length,
                triggerIds: firedTriggers.map((f) => f.trigger.id),
              });
            }
          }

          // Assemble per-task gestalt — the canonical snapshot all consumers derive from
          thalamus.assembleGestalt({
            task: taskNode.task,
            neLevel: decision.neLevel,
            mode: decision.mode,
            graph: {
              nodes: acc.liveGraph,
              completedTaskIds: acc.completedTasks,
              escalatedTaskIds: acc.escalatedTasks,
            },
            prospectiveDirectives: pmDirectives,
            budgetPressure: costTracker?.getBudgetPressure(),
            taskBudget: decision.taskBudget,
          });

          // Basal Ganglia: evaluate sense relevance for this task (from gestalt)
          const inhibitionBriefing = thalamus.forInhibitionFromGestalt(
            taskNode.task.id,
            library,
          );
          await basalGanglia.selectAction(inhibitionBriefing, "task", wm, config);

          emit("dispatch:task-selected", {
            taskId: taskNode.task.id,
            description: taskNode.task.description,
            completedSoFar: acc.completedTasks.size,
            totalTasks: acc.liveGraph.length,
            neLevel: decision.neLevel,
            mode: decision.mode,
            reasoning: decision.reasoning,
          });

          return {
            action: "run-task",
            task: taskNode,
            neLevel: decision.neLevel,
            riskSnapshot: decision.riskSnapshot,
            mode: decision.mode,
            taskBudget: decision.taskBudget,
            projectBudgetUtilization: signals.budgetUtilization,
          };
        }

        case "rest": {
          log.info("Scheduler requested rest", { reason: decision.reason });
          const load = homeostasis.getConsolidationLoad();
          const priorities: ConsolidationPriority[] = [];

          if (load.memoryPressure > 0.7) priorities.push("prune-memory");
          if (load.predictionDrift > 0.5) priorities.push("recalibrate");
          if (load.weightInstability > 0.6) priorities.push("settle-weights", "decay-connections");
          if (load.episodeDensity > 0.7) priorities.push("potentiate");
          if (priorities.length === 0) priorities.push("potentiate");

          return {
            action: "run-rest",
            restContext: {
              load,
              vitals: homeostasis.getVitals(),
              priorities,
            },
          };
        }

        case "observe":
          log.info("Scheduler requested observe", {
            reason: decision.reason,
            neLevel: decision.neLevel,
          });
          return { action: "run-observe", neLevel: decision.neLevel };

        case "escalate":
          log.info("Scheduler escalating", { reason: decision.reason, escalationType: decision.escalationType });
          return {
            action: "escalate",
            escalation: {
              reason: decision.reason,
              questions: decision.questions,
              escalationType: decision.escalationType,
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
          escalationType: prepared.escalation?.escalationType,
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

      if (prepared.action === "run-observe") {
        const acc = getAcc(state);
        const neLevel = prepared.neLevel ?? acc.lastNELevel;

        // 1. Quick triage — focused session on accumulated observations
        const triageResult = quickTriage(
          wm, acc.liveGraph, acc.completedTasks, acc.escalatedTasks, neLevel,
        );

        // Apply amend proposals from triage (same pattern as between-tasks)
        for (const proposal of triageResult.proposals) {
          const validation = validateProposal(
            proposal, acc.liveGraph, acc.completedTasks, wm.getCurrentTaskId(),
          );
          if (validation.valid) {
            const result = applySurgery(proposal.id, proposal.operations, acc.liveGraph, acc.completedTasks);
            acc.liveGraph = result.graph;
            for (const insertedId of result.insertedTaskIds) {
              const node = acc.liveGraph.find((n) => n.task.id === insertedId);
              if (node) {
                try { wm.addTask(insertedId, node.task.description); } catch { /* already added */ }
              }
            }
          } else {
            emitWarn("observe:triage-proposal-dropped", {
              proposalId: proposal.id,
              issues: validation.issues,
            }, {
              component: "observe",
              expected: "valid proposal",
              received: `invalid: ${validation.issues.join("; ")}`,
            });
            for (const obsId of proposal.grounding) {
              wm.unmarkObservationTriaged(obsId);
            }
          }
        }

        // 2. Check if deep synthesis should run
        const postTriagePressure = wm.getObservationPressure();
        const shouldDeepSynthesize = neLevel > 0.7 || postTriagePressure > 0.85;

        // 3. Anti-loop guard: if triage produced nothing and no deep synthesis will run,
        //    mark remaining "new" observations as "triaged" to prevent re-triggering.
        //    They remain available for deep synthesis at the next phase gate.
        if (triageResult.proposals.length === 0 && !shouldDeepSynthesize) {
          for (const obs of wm.getNewObservations()) {
            wm.markObservationTriaged(obs.id);
          }
        }

        // 4. Conditional deep synthesis: NE high or pressure critical
        let synthesisResult: import("../../kernel/deep-synthesis.js").DeepSynthesisResult | undefined;
        if (shouldDeepSynthesize) {
          const harvest = thalamus.harvestObservations({ neLevel });
          const allObs = harvest.observations;
          const remainingTasks = acc.liveGraph.filter(
            (n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id),
          );

          if (allObs.length > 0 && remainingTasks.length > 0) {
            const recentCompletedId = [...acc.completedTasks].slice(-1)[0];
            const recentNode = acc.liveGraph.find((n) => n.task.id === recentCompletedId);
            const phaseGroup = recentNode?.phaseGroup ?? "observe";

            synthesisResult = await deepSynthesis(
              {
                observations: allObs,
                simulations: [], // Observe processes what exists; simulation is phase-gate's job
                maxims: worldModel?.getMaximsForBriefing() ?? [],
                drift: driftMonitor?.getAssessment() ?? null,
                remainingTasks,
                completedTaskIds: acc.completedTasks,
                manifestedFuture: thalamus.getManifestedFuture() ?? "",
                phaseGroup,
              },
              config.models.consultation,
              acc.discoveryCounter,
            );

            // Mark observations as synthesized
            for (const obs of allObs) {
              wm.markObservationSynthesized(obs.id, "observe-synthesis");
            }

            // 5. Apply valid surgery proposals (no conviction — observe is the pressure valve)
            if (!synthesisResult.shouldReplan) {
              for (const proposal of synthesisResult.proposals) {
                const validation = validateProposal(
                  proposal, acc.liveGraph, acc.completedTasks, null,
                );
                if (validation.valid) {
                  const result = applySurgery(
                    proposal.id, proposal.operations, acc.liveGraph, acc.completedTasks,
                  );
                  acc.liveGraph = result.graph;
                  acc.discoveryCounter += result.insertedTaskIds.length;

                  for (const insertedId of result.insertedTaskIds) {
                    const node = acc.liveGraph.find((n) => n.task.id === insertedId);
                    if (node) {
                      try { wm.addTask(insertedId, node.task.description); } catch { /* already added */ }
                    }
                  }
                  for (const reopenedId of result.reopenedTaskIds) {
                    try {
                      wm.reopenTask(reopenedId, `Rework via observe synthesis ${proposal.id}`);
                    } catch {
                      log.warn("Could not reopen task in WM", { taskId: reopenedId });
                    }
                  }
                } else {
                  log.warn("Observe surgery proposal validation failed", {
                    proposalId: proposal.id,
                    issues: validation.issues,
                  });
                }
              }
            }
          }
        }

        emit("observe:complete", {
          triaged: triageResult.observationsTriaged,
          proposals: triageResult.proposals.length,
          deepSynthesis: !!synthesisResult,
          shouldReplan: synthesisResult?.shouldReplan,
          surgeryProposals: synthesisResult?.proposals.length ?? 0,
          neLevel,
          pressure: postTriagePressure,
        });

        return {
          action: "observed",
          observeTriageResult: triageResult,
          observeSynthesisResult: synthesisResult,
        };
      }

      if (prepared.action === "run-nursery" && prepared.nurseryPhaseGroup) {
        const acc = getAcc(state);
        const phaseGroup = prepared.nurseryPhaseGroup;

        // Surface scan — detect what was built that runs
        const { scanPhaseArtifacts } = await import("../../kernel/nursery-scanner.js");
        const surfaceScan = scanPhaseArtifacts(
          phaseGroup, acc.liveGraph, acc.taskResults, acc.completedTasks,
        );

        emit("nursery:scan-complete", {
          phaseGroup,
          hasRuntimeSurface: surfaceScan.hasRuntimeSurface,
          surfaceAreaCount: surfaceScan.surfaceAreas.length,
        });

        if (!surfaceScan.hasRuntimeSurface) {
          // No runtime surface — auto-graduate
          acc.nurseryGraduatedPhases.add(phaseGroup);
          log.info("Phase auto-graduated (no runtime surface)", { phaseGroup });
          return {
            action: "nursery-completed",
            nurseryPhaseGroup: phaseGroup,
            nurseryResult: {
              graduated: true,
              findings: [],
              exercisedScenarios: [],
              surgeryProposals: [],
              durationMs: 0,
            },
          };
        }

        const cycle = acc.nurseryCycles.get(phaseGroup) ?? 0;
        acc.nurseryCycles.set(phaseGroup, cycle + 1);

        emit("nursery:enter", {
          phaseGroup,
          surfaceAreaCount: surfaceScan.surfaceAreas.length,
          cycle,
        });

        // Spawn the nursery rhythm
        const { createNurseryDefinition } = await import("./nursery.js");
        const nurseryDef = createNurseryDefinition(config, library, pns!);

        const nurseryResult = await runner.run(
          nurseryDef,
          {
            phaseGroup,
            surfaceScan,
            taskResults: acc.taskResults,
            graph: acc.liveGraph,
            completedTaskIds: acc.completedTasks,
            neLevel: prepared.neLevel ?? acc.lastNELevel,
            cycle,
          },
          state.id,
        );

        return {
          action: "nursery-completed",
          nurseryPhaseGroup: phaseGroup,
          nurseryResult,
        };
      }

      // Run the task through sensory-cortex
      const taskNode = prepared.task!;
      const acc = getAcc(state);
      if (prepared.neLevel !== undefined) acc.lastNELevel = prepared.neLevel;
      wm.startTask(taskNode.task.id);
      // Attribute LLM call costs to this task
      setCostTaskId(taskNode.task.id);

      // Wire model selector — NE captured at dispatch, budget pressure read live
      const taskNE = prepared.neLevel ?? 0.5;
      if (qualityPredictor) {
        setModelSelector((purpose, configuredModel) =>
          selectModel(
            { purpose, neLevel: taskNE, budgetPressure: costTracker?.getBudgetPressure() ?? 0, configuredModel },
            qualityPredictor,
          )
        );
      }

      // Compute coarse attention budget from NE + importance (Phase 1).
      // Cerebellum refinement happens in sensory-cortex prepare (Phase 2)
      // after consultation produces a fingerprint.
      const dependentsCount = acc.liveGraph.filter(
        (n) => n.dependsOn.includes(taskNode.task.id)
          && !acc.completedTasks.has(n.task.id),
      ).length;
      const taskImportance = Math.min(1, dependentsCount * 0.2
        + (taskNode.phaseGroup ? 0.3 : 0));

      const attentionBudget = computeAttentionBudget({
        neLevel: prepared.neLevel ?? 0.5,
        maxOuterCycles: config.maxOuterCycles,
        taskImportance,
      });

      acc.lastAttentionBudget = attentionBudget;

      emit("attention-budget:computed", {
        taskId: taskNode.task.id,
        cycleRange: attentionBudget.cycleRange,
        source: attentionBudget.basis.source,
        neLevel: attentionBudget.basis.neLevel,
        importance: taskImportance,
      });

      const ctx: SensoryCortexContext = {
        task: taskNode.task,
        intent: state.initialContext.intent,
        taste: state.initialContext.taste,
        neLevel: prepared.neLevel,
        riskSnapshot: prepared.riskSnapshot,
        mode: prepared.mode,
        taskBudget: prepared.taskBudget,
        projectBudgetUtilization: prepared.projectBudgetUtilization,
        attentionBudget,
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

      // Pass-through for done
      if (executed.action === "done") {
        return {
          allComplete: allTasksDone(
            acc.liveGraph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      // Rest completed — fire crystallization simulation trigger if potentiation produced principles
      if (executed.action === "rested") {
        if (executed.restResult && executed.restResult.principlesExtracted > 0) {
          const remainingTasks = acc.liveGraph.filter(
            (n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id),
          );
          if (remainingTasks.length > 0) {
            await hooks.simulate(
              { type: "crystallization", principleId: "post-rest-batch" },
              remainingTasks,
              worldModel?.getMaximsForBriefing() ?? [],
              wm.getNewObservations(),
            );
          }
        }
        return {
          allComplete: allTasksDone(
            acc.liveGraph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      // Observe completed — re-evaluate from scratch
      if (executed.action === "observed") {
        emit("dispatch:observed", {
          triaged: executed.observeTriageResult?.observationsTriaged ?? 0,
          deepSynthesis: !!executed.observeSynthesisResult,
          shouldReplan: executed.observeSynthesisResult?.shouldReplan,
        });
        return {
          allComplete: allTasksDone(acc.liveGraph, acc.completedTasks, acc.escalatedTasks),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
          synthesisReplanRequired: executed.observeSynthesisResult?.shouldReplan,
        };
      }

      if (executed.action === "nursery-completed") {
        const phaseGroup = executed.nurseryPhaseGroup!;
        const nurseryResult = executed.nurseryResult!;

        if (nurseryResult.graduated) {
          acc.nurseryGraduatedPhases.add(phaseGroup);
          acc.nurseryPendingPhases.delete(phaseGroup);
          emit("nursery:graduate", {
            phaseGroup,
            scenariosExercised: nurseryResult.exercisedScenarios.length,
            durationMs: nurseryResult.durationMs,
            cycle: acc.nurseryCycles.get(phaseGroup) ?? 0,
          });
          log.info("Phase graduated from nursery", { phaseGroup });
        } else {
          // Nursery cycle cap: if fixes keep failing, escalate instead of looping forever.
          const nurseryCycle = acc.nurseryCycles.get(phaseGroup) ?? 0;
          const maxNurseryCycles = 3;
          if (nurseryCycle >= maxNurseryCycles) {
            log.warn("Nursery cycle cap reached — escalating", {
              phaseGroup,
              cycle: nurseryCycle,
              findingCount: nurseryResult.findings.length,
            });

            emitWarn("nursery:stuck", {
              phaseGroup,
              cycle: nurseryCycle,
              findingCount: nurseryResult.findings.length,
              findings: nurseryResult.findings.map((f) => f.description).slice(0, 5),
            }, {
              component: "nursery",
              expected: `graduation within ${maxNurseryCycles} cycles`,
              received: `${nurseryCycle} cycles with ${nurseryResult.findings.length} remaining finding(s)`,
            });

            return {
              allComplete: false,
              completedTasks: [...acc.completedTasks],
              escalatedTasks: [...acc.escalatedTasks],
              nurseryStuck: {
                phaseGroup,
                cycle: nurseryCycle,
                findingCount: nurseryResult.findings.length,
              },
            };
          }

          // Findings exist — apply surgery proposals to insert fix tasks
          for (const proposal of nurseryResult.surgeryProposals) {
            const validation = validateProposal(proposal, acc.liveGraph, acc.completedTasks, null);
            if (!validation.valid) {
              log.warn("Nursery surgery proposal invalid", {
                proposalId: proposal.id,
                issues: validation.issues,
              });
              continue;
            }

            const surgeryResult = applySurgery(
              proposal.id,
              proposal.operations,
              acc.liveGraph,
              acc.completedTasks,
            );

            acc.liveGraph = surgeryResult.graph;

            // Track fix tasks so we can re-trigger nursery when they complete
            const fixTaskSet = acc.nurseryFixTasks.get(phaseGroup) ?? new Set<string>();
            for (const insertedId of surgeryResult.insertedTaskIds) {
              fixTaskSet.add(insertedId);
              // Register in WM so task-dispatch can dispatch them
              try { wm.addTask(insertedId, `[Nursery fix] ${phaseGroup}`); } catch { /* already added */ }

              emit("nursery:fix-task-inserted", {
                phaseGroup,
                taskId: insertedId,
              });
            }
            for (const reopenedId of surgeryResult.reopenedTaskIds) {
              fixTaskSet.add(reopenedId);

              emit("nursery:fix-task-inserted", {
                phaseGroup,
                taskId: reopenedId,
              });
            }
            acc.nurseryFixTasks.set(phaseGroup, fixTaskSet);

            log.info("Nursery surgery applied", {
              phaseGroup,
              inserted: surgeryResult.insertedTaskIds.length,
              reopened: surgeryResult.reopenedTaskIds.length,
            });
          }
        }

        return {
          allComplete: allTasksDone(
            acc.liveGraph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      if (executed.action === "scheduler-escalated") {
        const pfcFlags = homeostasis.needsPfcIntervention();
        return {
          allComplete: false,
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
          schedulerEscalation: {
            reason: executed.escalationReason ?? "Unknown reason",
            questions: executed.escalationQuestions ?? [],
            escalationType: executed.escalationType ?? "drift",
          },
          pfcFlags: pfcFlags.length > 0 ? pfcFlags : undefined,
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

        // Dynamic budget reallocation — return unspent budget to remaining tasks
        if (costTracker) {
          const unspent = costTracker.returnUnspent(taskId);
          if (unspent > 0) {
            const remainingIds = acc.liveGraph
              .filter((n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id))
              .map((n) => n.task.id);
            if (remainingIds.length > 0) {
              const realloc = reallocateBudget(remainingIds, unspent);
              for (const [tid, amount] of realloc) {
                const existing = costTracker.getTaskBudget(tid);
                costTracker.allocateTaskBudget(tid, existing.allocated + amount);
              }
            }
          }
        }

        // ── Nursery fix task tracking ──
        // If this task was a nursery fix, track completion. When all fix
        // tasks for a phase are done, the scheduler will re-dispatch gestate
        // (nurseryPendingPhases still has the phase, so it re-enters nursery).
        for (const [fixPhaseGroup, fixTasks] of acc.nurseryFixTasks) {
          if (fixTasks.has(taskId)) {
            fixTasks.delete(taskId);
            if (fixTasks.size === 0) {
              // All fix tasks done — nursery will re-exercise on next dispatch cycle
              emit("nursery:re-exercise", {
                phaseGroup: fixPhaseGroup,
                cycle: acc.nurseryCycles.get(fixPhaseGroup) ?? 0,
              });
              log.info("All nursery fix tasks complete, re-exercise pending", { phaseGroup: fixPhaseGroup });
            }
            break;
          }
        }

        // Prospective preparation — read gestalt before clearing
        const completedGestalt = thalamus.getGestalt(taskId);
        const forwardBriefing = prepareForward({
          senseTrends: wm.getSenseTrends(),
          speedOfLight: completedGestalt?.speedOfLight ?? null,
          recentEpisodes: thalamus.getRecentEpisodeSummaries(10),
          convictionShaping: acc.previousConviction?.shaping ?? { notes: [] },
          cerebellumPredictions: null, // not available between tasks
          manifestedFuture: thalamus.getManifestedFuture() ?? undefined,
        });
        thalamus.setForwardBriefing(forwardBriefing);

        // Clear this task's gestalt — it's done, consumers have extracted what they need
        thalamus.clearGestalt(taskId);

        // Clear model selector — between-tasks processing uses configured defaults
        setModelSelector(null);

        // Between-tasks fast path
        // Pipeline boundary: dopamine computation requires evaluations
        if (executed.taskResult.evaluations.length === 0) {
          emitWarn("pipeline:dopamine-missing-input", { taskId }, {
            component: "task-dispatch",
            expected: "evaluations",
            received: "empty array — dopamine signal will be zero",
          });
        }
        const budgetSnapshot = acc.lastAttentionBudget?.cycleRange;

        // Gather cost data for episode learning (model selection + cost metadata)
        const taskCostSummary = costTracker?.getTaskBudget(taskId);
        const costData = taskCostSummary ? {
          cost: taskCostSummary.spent,
          callCount: taskCostSummary.callCount,
          costByPurpose: taskCostSummary.byPurpose as Partial<Record<import("../../llm/client.js").Purpose, number>>,
          modelsByPurpose: costTracker!.getTaskModelsByPurpose(taskId),
        } : undefined;

        const dopamine = await hooks.computeDopamineSignal(taskId, executed.taskResult.evaluations, {
          outerCycles: executed.taskResult.outerCycles ?? executed.taskResult.cycles,
          attentionBudget: budgetSnapshot
            ? { floor: budgetSnapshot.floor, expected: budgetSnapshot.expected, ceiling: budgetSnapshot.ceiling }
            : undefined,
        }, costData);
        acc.lastDopamine = dopamine;
        await hooks.recordEpisode(taskId, executed.taskResult, dopamine);
        await hooks.updateRoutines(taskId, dopamine);

        // Clean up models-used tracking for this task
        clearModelsUsed(taskId);

        // Resolution Rework (#13): feed resolution quality into plasticity
        if (executed.taskResult.resolutionOutcomes?.length) {
          await hooks.applyResolutionLearning(taskId, executed.taskResult.resolutionOutcomes);
        }

        // Feed WM load to homeostasis (drives rest cycle triggers)
        homeostasis.update("workingMemoryLoad", wm.getLoad());

        // Record NE exposure for rest sensitivity (cumulative fatigue)
        homeostasis.recordTaskNE(acc.lastNELevel);

        // Rebuild Weltanschauung at rhythm boundary
        if (worldModel) {
          await worldModel.rebuild("between-tasks", {
            wm,
            intent: state.initialContext.intent,
            taste: state.initialContext.taste,
            projectId: state.initialContext.intent.id,
            taskGraph: acc.liveGraph,
            completedTaskIds: acc.completedTasks,
            escalatedTaskIds: acc.escalatedTasks,
            vitals: homeostasis.getVitals(),
            pns,
          });
        }

        // Drift Monitor quick check — runs after world model rebuild
        // so it can read the updated Weltanschauung
        if (driftMonitor) {
          driftMonitor.quickCheck(
            {
              wm,
              intent: state.initialContext.intent,
              taste: state.initialContext.taste,
              worldModel,
              plasticity: undefined, // Wired when Brainstem threads plasticity
              manifestedFuture: thalamus.getManifestedFuture() ?? undefined,
            },
            taskId,
          );
        }

        // ── Quick triage — scan observations against ready tasks ──
        let flagForDeepSynthesis = false;
        if (wm.getNewObservations().length > 0) {
          const triageResult = quickTriage(
            wm, acc.liveGraph, acc.completedTasks, acc.escalatedTasks, acc.lastNELevel,
          );
          // Apply amend proposals directly (low blast radius, no conviction needed)
          for (const proposal of triageResult.proposals) {
            const validation = validateProposal(
              proposal, acc.liveGraph, acc.completedTasks, wm.getCurrentTaskId(),
            );
            if (validation.valid) {
              const result = applySurgery(proposal.id, proposal.operations, acc.liveGraph, acc.completedTasks);
              acc.liveGraph = result.graph;
              // Register any inserted tasks in WM
              for (const insertedId of result.insertedTaskIds) {
                const node = acc.liveGraph.find((n) => n.task.id === insertedId);
                if (node) {
                  try { wm.addTask(insertedId, node.task.description); } catch { /* already added */ }
                }
              }
            } else {
              // Proposal dropped — make the failure visible and restore consumed observations.
              // Without this, the observation is marked "triaged" but never applied — the
              // signal is consumed but nothing happened. Restoring it lets deep synthesis pick it up.
              emitWarn(
                "triage:proposal-dropped",
                {
                  proposalId: proposal.id,
                  issues: validation.issues,
                  grounding: proposal.grounding,
                  operationCount: proposal.operations.length,
                },
                {
                  component: "quick-triage",
                  expected: "valid proposal",
                  received: `invalid: ${validation.issues.join("; ")}`,
                },
              );
              for (const obsId of proposal.grounding) {
                wm.unmarkObservationTriaged(obsId);
              }
            }
          }
          flagForDeepSynthesis = triageResult.flagForDeepSynthesis;

          // High-relevance observation → fire hippocampal simulation
          if (triageResult.flagForDeepSynthesis && triageResult.flagReason?.startsWith("High-relevance")) {
            const remainingForSim = acc.liveGraph.filter(
              (n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id),
            );
            if (remainingForSim.length > 0) {
              // Find the observation that triggered the flag (NE-modulated threshold)
              const simThreshold = simulationRelevanceThreshold(acc.lastNELevel);
              const highRelObs = wm.getNewObservations().find((o) => o.relevance > simThreshold);
              await hooks.simulate(
                { type: "high-relevance-observation", observationId: highRelObs?.id ?? "unknown" },
                remainingForSim,
                worldModel?.getMaximsForBriefing() ?? [],
                wm.getNewObservations(),
              );
            }
          }
        }

        // ── Simulation calibration hook point ──
        // Hippocampal simulation accuracy is tracked via
        // hippocampus.recordSimulationOutcome() — called by the Brainstem
        // when it has direct access to the hippocampus instance.
        emit("dispatch:calibration-check", { taskId, confidence: executed.taskResult?.confidence ?? 0 });

        // ── Exteroception batch processing ──────────────────────
        let exteroceptiveSignalsProcessed = 0;
        let exteroceptiveHighUrgencyCount = 0;
        const exBatch = hooks.assembleExteroceptiveBatch();
        if (exBatch && exBatch.signals.length > 0) {
          // Differentiate high-urgency signals from low:
          // High → alert (feeds diagnostic load via emitWarn), Low → noted.
          // Future: PFC processes all via Thalamus briefing.
          const batchActions: import("../../types/exteroception.js").BatchAction[] =
            exBatch.signals.map((s) => {
              if (s.urgency === "high") {
                exteroceptiveHighUrgencyCount++;
                return { kind: "alert" as const, signalId: s.id, message: s.summary };
              }
              return { kind: "noted" as const, signalId: s.id };
            });
          hooks.recordExteroceptiveBatchOutcome(batchActions);
          exteroceptiveSignalsProcessed = exBatch.signals.length;

          if (exteroceptiveHighUrgencyCount > 0) {
            const highSignals = exBatch.signals.filter((s) => s.urgency === "high");
            emitWarn("exteroception:high-urgency-batch", {
              taskId,
              highUrgencyCount: exteroceptiveHighUrgencyCount,
              summaries: highSignals.map((s) => s.summary).slice(0, 5),
              monitorIds: [...new Set(highSignals.map((s) => s.monitorId))],
            }, {
              component: "exteroception",
              expected: "signals acted upon or dismissed with reason",
              received: `${exteroceptiveHighUrgencyCount} high-urgency signal(s) surfaced as alerts`,
            });
          }

          emitInfo("exteroception:batch-processed-at-boundary", {
            taskId,
            signalCount: exteroceptiveSignalsProcessed,
            highUrgencyCount: exteroceptiveHighUrgencyCount,
          });
        }

        const betweenTasks: BetweenTasksFastPath = {
          taskId,
          dopamineSignal: dopamine,
          episodeRecorded: true,
          workingMemoryUpdated: true,
          routineUpdated: true,
          exteroceptiveSignalsProcessed,
        };

        // ── Phase gate integration check ──────────────────────
        let phaseGateResult: PhaseGateResult | undefined;
        const completedNode = acc.liveGraph.find(
          (n) => n.task.id === taskId,
        );
        const phaseGroup = completedNode?.phaseGroup;

        if (phaseGroup && integrationChecker) {
          const isPhaseComplete = integrationChecker.detectPhaseGate(
            phaseGroup,
            acc.liveGraph,
            acc.completedTasks,
            acc.escalatedTasks,
          );

          if (isPhaseComplete) {
            const phases = state.initialContext.phases ?? [];
            const phase = phases.find((p) => p.name === phaseGroup);
            const gateCondition = phase?.gateCondition
              ?? `All tasks in phase "${phaseGroup}" complete coherently`;

            const currentDrift = driftMonitor?.getAssessment()?.driftLevel ?? 0;

            phaseGateResult = await integrationChecker.check(
              phaseGroup,
              gateCondition,
              acc.liveGraph,
              acc.taskResults,
              acc.lastNELevel,
              currentDrift,
            );

            emit("dispatch:phase-gate-check", {
              phaseGroup,
              passed: phaseGateResult.passed,
              preCheckVerdict: phaseGateResult.preCheck.verdict,
              skippedLLM: phaseGateResult.evaluations === null,
              compositeScore: phaseGateResult.compositeScore,
              issueCount: phaseGateResult.integrationIssues.length,
              discoveredProblemCount: phaseGateResult.discoveredProblems.length,
              durationMs: phaseGateResult.durationMs,
            });

            // ── Drift deep analysis + taste feedback (every phase gate) ──
            if (driftMonitor) {
              await driftMonitor.deepAnalysis(
                {
                  wm,
                  intent: state.initialContext.intent,
                  taste: state.initialContext.taste,
                  worldModel,
                  manifestedFuture: thalamus.getManifestedFuture() ?? undefined,
                },
                phaseGroup,
              );

              // Taste feedback reads deep analysis results from drift monitor
              if (tasteFeedbackLoop) {
                const proposals = await tasteFeedbackLoop.evaluate(
                  {
                    driftMonitor,
                    taste: state.initialContext.taste,
                    intent: state.initialContext.intent,
                    neLevel: acc.lastNELevel,
                    cerebellumAccuracy: hooks.getCerebellumAccuracy(),
                  },
                  phaseGroup,
                );

                for (const proposal of proposals) {
                  emit("dispatch:taste-proposal", {
                    proposalId: proposal.id,
                    dimensions: proposal.dimensions,
                    interpretation: proposal.interpretation,
                    proposalStrength: proposal.proposalStrength,
                    persistence: proposal.persistence,
                    phaseGroup,
                  });
                }
              }
            }

            // ── Nursery: register phase as pending graduation ──
            if (phaseGateResult.passed && !acc.nurseryGraduatedPhases.has(phaseGroup)) {
              acc.nurseryPendingPhases.add(phaseGroup);
            }

            // ── Proactive: simulation + deep synthesis (on pass) ──
            if (phaseGateResult.passed) {
              // 1. Feed discovered problems as territory observations
              for (const problem of phaseGateResult.discoveredProblems) {
                wm.addObservation({
                  id: newId(),
                  fact: problem,
                  source: { taskId, component: "integration-check" },
                  relevance: 0.7,
                  observedAt: new Date(),
                  status: "new",
                });
              }

              // 2. Hippocampal simulation
              const remainingTasks = acc.liveGraph.filter(
                (n) => !acc.completedTasks.has(n.task.id) && !acc.escalatedTasks.has(n.task.id),
              );

              if (remainingTasks.length > 0) {
                const simulations = await hooks.simulate(
                  { type: "phase-gate", phaseGroup },
                  remainingTasks,
                  worldModel?.getMaximsForBriefing() ?? [],
                  wm.getNewObservations(),
                );

                // 3. Deep synthesis
                const phaseHarvest = thalamus.harvestObservations({ neLevel: acc.lastNELevel });
                const allObs = phaseHarvest.observations;
                if (allObs.length > 0 || simulations.length > 0) {
                  const synthesisResult = await deepSynthesis(
                    {
                      observations: allObs,
                      simulations,
                      maxims: worldModel?.getMaximsForBriefing() ?? [],
                      drift: driftMonitor?.getAssessment() ?? null,
                      remainingTasks,
                      completedTaskIds: acc.completedTasks,
                      manifestedFuture: thalamus.getManifestedFuture() ?? "",
                      phaseGroup,
                    },
                    config.models.consultation,
                    acc.discoveryCounter,
                  );

                  // Mark observations + simulations as consumed
                  for (const obs of allObs) wm.markObservationSynthesized(obs.id, "deep-synthesis");
                  for (const sim of simulations) {
                    hooks.dismissSimulation?.(sim.id, false);
                  }

                  // 4. Apply or flag for replan
                  if (synthesisResult.shouldReplan) {
                    emit("dispatch:between-tasks", {
                      path: "slow",
                      taskId,
                      dopamineSignal: dopamine,
                      phaseGroup,
                    });

                    return {
                      betweenTasks,
                      phaseGateResult,
                      allComplete: false,
                      completedTasks: [...acc.completedTasks],
                      escalatedTasks: [...acc.escalatedTasks],
                      synthesisReplanRequired: true,
                    };
                  }

                  // 5. Conviction check on each proposal before applying
                  let appliedSurgery: SurgeryResult | undefined;
                  for (const proposal of synthesisResult.proposals) {
                    const convictionCtx = {
                      level: "plan-modification" as const,
                      cycle: state.completedCycles + 1,
                      taskGraph: acc.liveGraph,
                      completedTaskIds: acc.completedTasks,
                      escalatedTaskIds: acc.escalatedTasks,
                      intent: state.initialContext.intent,
                      worldModelMaxims: worldModel?.getMaximsForBriefing(),
                      previousConviction: acc.previousConviction ?? undefined,
                      manifestedFuture: thalamus.getManifestedFuture() ?? undefined,
                    };

                    const proposalConviction = runConvictionLoop(
                      convictionCtx,
                      modulateThresholds(DEFAULT_CONVICTION_THRESHOLDS, acc.lastNELevel),
                    );

                    emit("conviction:plan-modification", {
                      proposalId: proposal.id,
                      verdict: proposalConviction.verdict,
                      level: proposalConviction.level,
                      blastRadius: proposal.blastRadius,
                    });

                    if (proposalConviction.verdict === "escalate") {
                      log.info("Surgery proposal dismissed — conviction too low", {
                        proposalId: proposal.id,
                        conviction: proposalConviction.level,
                      });
                      continue;
                    }

                    // Apply approved proposals via graph surgery
                    const validation = validateProposal(
                      proposal, acc.liveGraph, acc.completedTasks, null,
                    );
                    if (validation.valid) {
                      const result = applySurgery(
                        proposal.id, proposal.operations, acc.liveGraph, acc.completedTasks,
                      );
                      acc.liveGraph = result.graph;
                      acc.discoveryCounter += result.insertedTaskIds.length;
                      appliedSurgery = result;

                      // Register inserted tasks in WM
                      for (const insertedId of result.insertedTaskIds) {
                        const node = acc.liveGraph.find((n) => n.task.id === insertedId);
                        if (node) {
                          try { wm.addTask(insertedId, node.task.description); } catch { /* already added */ }
                        }
                      }
                      // Reopen reworked tasks in WM
                      for (const reopenedId of result.reopenedTaskIds) {
                        try {
                          wm.reopenTask(reopenedId, `Rework via surgery proposal ${proposal.id}`);
                        } catch {
                          log.warn("Could not reopen task in WM", { taskId: reopenedId });
                        }
                      }
                    } else {
                      log.warn("Surgery proposal validation failed", {
                        proposalId: proposal.id,
                        issues: validation.issues,
                      });
                    }
                  }

                  if (appliedSurgery) {
                    emit("dispatch:between-tasks", {
                      path: "slow",
                      taskId,
                      dopamineSignal: dopamine,
                      phaseGroup,
                    });

                    return {
                      betweenTasks,
                      phaseGateResult,
                      appliedSurgery,
                      allComplete: allTasksDone(acc.liveGraph, acc.completedTasks, acc.escalatedTasks),
                      completedTasks: [...acc.completedTasks],
                      escalatedTasks: [...acc.escalatedTasks],
                    };
                  }
                }
              }
            }
          }
        }

        emit("dispatch:between-tasks", {
          path: phaseGateResult ? "slow" : "fast",
          taskId,
          dopamineSignal: dopamine,
          phaseGroup: phaseGateResult?.phaseGroup,
        });

        return {
          betweenTasks,
          phaseGateResult,
          flagForDeepSynthesis,
          allComplete: allTasksDone(
            acc.liveGraph,
            acc.completedTasks,
            acc.escalatedTasks,
          ),
          completedTasks: [...acc.completedTasks],
          escalatedTasks: [...acc.escalatedTasks],
        };
      }

      // Task escalated
      thalamus.clearGestalt(taskId);
      acc.escalatedTasks.add(taskId);
      wm.failTask(taskId, "Task escalated");

      return {
        allComplete: allTasksDone(
          acc.liveGraph,
          acc.completedTasks,
          acc.escalatedTasks,
        ),
        completedTasks: [...acc.completedTasks],
        escalatedTasks: [...acc.escalatedTasks],
      };
    },

    async gate(integrated, state) {
      const acc = getAcc(state);

      // ── Map scheduler/PFC signals for conviction ──────────────
      // Scheduler escalation and PFC flags are fed as undermining evidence
      // into the conviction loop. Conviction gates all escalation decisions.
      const severityMap: Record<string, number> = {
        deadlock: 1.0,
        cratering: 0.9,
        perseveration: 0.8,
        drift: 0.7,
        "open-questions": 0.6,
      };

      let schedulerEscalationSignal: {
        type: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
        reason: string;
        severity: number;
      } | undefined;

      if (integrated.schedulerEscalation) {
        const escType = integrated.schedulerEscalation.escalationType;
        schedulerEscalationSignal = {
          type: escType,
          reason: integrated.schedulerEscalation.reason,
          severity: severityMap[escType] ?? 0.7,
        };
      }

      // PFC flags also feed as scheduler escalation signals (lower severity — background)
      const pfcFlags = integrated.pfcFlags ?? (homeostasis.needsPfcIntervention().length > 0 ? homeostasis.needsPfcIntervention() : undefined);
      if (!schedulerEscalationSignal && pfcFlags?.length) {
        schedulerEscalationSignal = {
          type: pfcFlags[0].type === "tonic-dopamine-crashed" ? "cratering" : "drift",
          reason: pfcFlags.map((f) => f.reason).join("; "),
          severity: 0.5,
        };
      }

      // Nursery stuck: fix cycles exhausted, runtime issues persist — high severity
      if (!schedulerEscalationSignal && integrated.nurseryStuck) {
        schedulerEscalationSignal = {
          type: "perseveration",
          reason: `Nursery stuck on phase "${integrated.nurseryStuck.phaseGroup}": ${integrated.nurseryStuck.findingCount} finding(s) persist after ${integrated.nurseryStuck.cycle} fix cycles`,
          severity: 0.85,
        };
      }

      // ── Conviction loop (now includes scheduler pressure) ─────
      const convictionCtx = {
        level: "task-dispatch" as const,
        cycle: state.completedCycles + 1,
        vitals: homeostasis.getVitals(),
        recentDopamine: integrated.betweenTasks?.dopamineSignal,
        taskGraph: acc.liveGraph,
        completedTaskIds: acc.completedTasks,
        escalatedTaskIds: acc.escalatedTasks,
        intent: state.initialContext.intent,
        worldModelMaxims: worldModel?.getMaximsForBriefing(),
        previousConviction: acc.previousConviction ?? undefined,
        manifestedFuture: thalamus.getManifestedFuture() ?? undefined,
        schedulerEscalation: schedulerEscalationSignal,
      };

      const conviction = runConvictionLoop(
        convictionCtx,
        modulateThresholds(DEFAULT_CONVICTION_THRESHOLDS, acc.lastNELevel),
      );
      acc.previousConviction = conviction;

      // Record to WM conviction ledger for triage/diagnostics trajectory
      wm.recordConviction(
        conviction,
        null, // dispatch-level, not per-task
        state.initialContext.replanGeneration ?? 0,
      );

      emit("conviction:result", {
        level: "task-dispatch",
        cycle: state.completedCycles + 1,
        verdict: conviction.verdict,
        convictionLevel: conviction.level,
        delta: conviction.delta,
        decidingStep: conviction.decidingStep,
        evidenceCount: conviction.evidence.length,
        schedulerOverridden: schedulerEscalationSignal != null && conviction.verdict !== "escalate",
      });

      // Conviction escalate → bubble up (system agrees with scheduler, or conviction independently low)
      if (conviction.verdict === "escalate") {
        return {
          action: "escalate",
          severity: "high" as const,
          reason: conviction.shaping.escalationReason ?? "Project conviction too low to continue",
          context: {
            type: schedulerEscalationSignal ? "scheduler-escalation" : "conviction-escalation",
            conviction,
            schedulerEscalation: integrated.schedulerEscalation,
            schedulerEscalationType: schedulerEscalationSignal?.type,
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            previousConviction: acc.previousConviction,
          },
        };
      }

      // ── Cognitive Flexibility at dispatch level (runs on reshape) ──
      if (conviction.verdict === "reshape") {
        const flexAssessment = cognitiveFlexibility.assessDispatch({
          conviction,
          taskGraph: acc.liveGraph,
          completedTaskIds: acc.completedTasks,
          escalatedTaskIds: acc.escalatedTasks,
          taskResults: acc.taskResults,
          senseTrends: wm.getSenseTrends(),
          schedulerEscalation: schedulerEscalationSignal
            ? { type: schedulerEscalationSignal.type, reason: schedulerEscalationSignal.reason }
            : undefined,
          vitals: homeostasis.getVitals(),
          intent: state.initialContext.intent,
        }, acc.lastNELevel);

        emit("flexibility:dispatch-assessment", {
          cycle: state.completedCycles + 1,
          diagnosis: flexAssessment.diagnosis,
          shouldReset: flexAssessment.shouldReset,
          shouldEscalate: flexAssessment.shouldEscalate,
          schedulerEscalationType: schedulerEscalationSignal?.type,
        });

        if (flexAssessment.shouldEscalate) {
          return {
            action: "escalate",
            severity: "high" as const,
            reason: flexAssessment.escalationContext ?? flexAssessment.reasoning,
            context: {
              type: "scheduler-escalation",
              conviction,
              flexibility: flexAssessment,
              schedulerEscalationType: schedulerEscalationSignal?.type,
              questions: integrated.schedulerEscalation?.questions ?? [],
              completedTasks: [...acc.completedTasks],
              escalatedTasks: [...acc.escalatedTasks],
              taskResults: acc.taskResults,
              driftAssessment: driftMonitor?.getAssessment() ?? null,
              previousConviction: acc.previousConviction,
            },
          };
        }

        if (flexAssessment.shouldReset) {
          // Strategy reset at dispatch level = request replan with directive
          return {
            action: "escalate",
            severity: "high" as const,
            reason: flexAssessment.reasoning,
            context: {
              type: "replan-request",
              completedTasks: [...acc.completedTasks],
              escalatedTasks: [...acc.escalatedTasks],
              taskResults: acc.taskResults,
              driftAssessment: driftMonitor?.getAssessment() ?? null,
              previousConviction: acc.previousConviction,
              resetDirective: flexAssessment.resetDirective,
            },
          };
        }

        // execution-problem or tension-evasion without reset → continue
        // Conviction shaping notes will seed the next task's consultation
        log.info("Dispatch CogFlex: continuing after reshape", {
          diagnosis: flexAssessment.diagnosis,
          schedulerOverridden: !!schedulerEscalationSignal,
        });
      } else if (schedulerEscalationSignal) {
        // Conviction said "proceed" despite scheduler wanting to escalate.
        // Cortex overrode the scheduler — log for observability.
        log.info("Conviction overrode scheduler escalation", {
          schedulerType: schedulerEscalationSignal.type,
          convictionLevel: conviction.level.toFixed(3),
        });
      }

      // ── PFC learning-signal-degraded + conviction proceed → request rest ──
      if (pfcFlags?.some((f) => f.type === "learning-signal-degraded") && conviction.verdict === "proceed") {
        log.info("PFC flag: requesting rest for learning signal recovery");
        // Don't escalate — override next cycle's scheduler to produce a rest
        // by marking the accumulator. The prepare phase will check this.
        acc.__pfcRestRequested = true;
      }

      // Replan request (from graph surgery / deep synthesis) → bubble up
      if (integrated.replanRequest) {
        return {
          action: "escalate",
          severity: "high" as const,
          reason: integrated.replanRequest,
          context: {
            type: "replan-request",
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            previousConviction: acc.previousConviction,
          },
        };
      }

      // Phase gate integration failure → trigger replan
      if (integrated.phaseGateResult && !integrated.phaseGateResult.passed) {
        return {
          action: "escalate",
          severity: "high" as const,
          reason: `Phase gate "${integrated.phaseGateResult.phaseGroup}" failed integration check: ${integrated.phaseGateResult.integrationIssues.slice(0, 3).join("; ")}`,
          context: {
            type: "replan-request",
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            previousConviction: acc.previousConviction,
            phaseGateResult: integrated.phaseGateResult,
          },
        };
      }

      // Deep synthesis determined blast radius too high → trigger replan
      if (integrated.synthesisReplanRequired) {
        return {
          action: "escalate",
          severity: "high" as const,
          reason: "Deep synthesis proposals exceed blast radius threshold — full replan needed",
          context: {
            type: "replan-request",
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            previousConviction: acc.previousConviction,
          },
        };
      }

      if (integrated.allComplete) {
        emitInfo("gate:decision", {
          level: "task-dispatch",
          action: "complete",
          cycle: state.completedCycles + 1,
          completedTasks: acc.completedTasks.size,
          escalatedTasks: acc.escalatedTasks.size,
          convictionVerdict: conviction.verdict,
          convictionLevel: conviction.level,
        });

        return {
          action: "complete",
          result: {
            completedTasks: [...acc.completedTasks],
            escalatedTasks: [...acc.escalatedTasks],
            taskResults: acc.taskResults,
          },
        };
      }

      emitInfo("gate:decision", {
        level: "task-dispatch",
        action: "continue",
        cycle: state.completedCycles + 1,
        completedTasks: acc.completedTasks.size,
        escalatedTasks: acc.escalatedTasks.size,
        totalTasks: acc.liveGraph.length,
        convictionVerdict: conviction.verdict,
        convictionLevel: conviction.level,
        hasPhaseGate: !!integrated.phaseGateResult,
        phaseGatePassed: integrated.phaseGateResult?.passed,
        hasSurgery: !!integrated.appliedSurgery,
      });

      return {
        action: "continue",
        reason: `${acc.completedTasks.size} completed, ${acc.escalatedTasks.size} escalated, more tasks remaining`,
      };
    },
  };
}
