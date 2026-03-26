/**
 * Project Rhythm — the outermost loop.
 *
 *   prepare:   validate context, build world model
 *   execute:   plan (if no tasks) → task-dispatch → triage-driven replan
 *   integrate: retrospective (stub)
 *   gate:      always complete after one pass
 *
 * When ProjectContext.tasks is empty, the Planner runs:
 *   Phase A: Manifestation — sensory cortex produces a concrete vision
 *   Phase B: Path Reasoning — LLM reasons backward to minimum task graph
 * When tasks are pre-provided (human-given), planning is skipped.
 *
 * Replan cascade (adaptive, triage-driven):
 *   On every drift trigger, ProjectDiagnostics.triage() reads conviction
 *   trajectory, sense trends, drift level, and cerebellum accuracy to
 *   decide the route: replan | re-manifest | full-diagnostic | escalate.
 *   The heavy LLM diagnostic call only runs when triage routes to
 *   full-diagnostic. A safety valve caps total replans regardless.
 */

import type { RhythmDefinition } from "../../types/rhythm.js";
import type {
  ProjectContext,
  ProjectResult,
  TaskDispatchContext,
  TaskDispatchResult,
  TaskGraphNode,
  SensoryCortexContext,
} from "../../types/brainstem.js";
import type { OrchestratorResult, CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { ReplanContext } from "../../types/planner.js";
import type { DiagnosticContext } from "../../types/project-diagnostics.js";
import type { DriftAssessment } from "../../types/drift-monitor.js";
import type { ConvictionResult } from "../../types/conviction.js";
import { createLogger } from "../../util/logger.js";
import { emit } from "../../events.js";
import { EscalationError, RhythmAbortedError } from "../errors.js";
import { createTaskDispatchDefinition } from "./task-dispatch.js";
import { createSensoryCortexDefinition } from "./sensory-cortex.js";
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
import type { ProjectProfile } from "../../types/runtime.js";
import { discoverProject } from "../../kernel/project-discovery.js";
import type { DriftMonitor } from "../../kernel/drift-monitor.js";
import type { Planner } from "../../kernel/planner.js";
import type { ProjectDiagnostics } from "../../kernel/project-diagnostics.js";
import type { ProspectiveMemory } from "../../kernel/prospective-memory.js";
import { IntegrationChecker } from "../../kernel/integration-check.js";

const log = createLogger("project-rhythm");

interface PreparedProject {
  graph: TaskGraphNode[];
}

// ─── Manifestation helper (reused for initial plan + re-manifestation) ──

import type { RhythmRunner } from "../../types/rhythm.js";
import type { RhythmDefinition as RD } from "../../types/rhythm.js";
import type { SensoryCortexResult } from "../../types/brainstem.js";
import type { ProjectIntent, TasteProfile } from "../../types/intent.js";

import type { ManifestedFuture, ProposedPhase } from "../../types/planner.js";
import { createTask } from "../../types/task.js";
import { newId } from "../../util/ids.js";
import { allocateBudget } from "../../kernel/budget-allocator.js";
import type { CostTracker } from "../cost-tracker.js";
import { setCostTaskId } from "../../llm/client.js";

async function runManifestation(
  planner: Planner,
  thalamus: Thalamus,
  sensoryCortexDef: RD<SensoryCortexContext, SensoryCortexResult, unknown, unknown, unknown>,
  runner: RhythmRunner,
  parentId: string,
  intent: ProjectIntent,
  taste: TasteProfile,
): Promise<ManifestedFuture> {
  const manifestationTask = planner.createManifestationTask(intent);
  thalamus.assembleGestalt({ task: manifestationTask });

  const manifestCtx: SensoryCortexContext = {
    task: manifestationTask,
    intent,
    taste,
  };

  emit("planner:phase-a-start", { taskId: manifestationTask.id });
  const manifestResult = await runner.run(sensoryCortexDef, manifestCtx, parentId);
  thalamus.clearGestalt(manifestationTask.id);

  const future = planner.extractManifestedFuture(manifestResult);
  emit("planner:phase-a-complete", {
    confidence: future.confidence,
    visionLength: future.vision.length,
  });

  thalamus.setManifestedFuture(future.vision);
  return future;
}

// ─── Definition factory ─────────────────────────────────────────

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
  cognitiveFlexibility: CognitiveFlexibility,
  stakeAdjuster?: StakeAdjuster,
  worldModel?: WorldModel,
  pns?: PeripheralNervousSystem,
  driftMonitor?: DriftMonitor,
  planner?: Planner,
  projectDiagnostics?: ProjectDiagnostics,
  prospectiveMemory?: ProspectiveMemory,
  costTracker?: CostTracker,
): RhythmDefinition<ProjectContext, ProjectResult, PreparedProject, TaskDispatchResult, ProjectResult> {
  const integrationChecker = new IntegrationChecker(undefined, library, wm, thalamus, config);
  const taskDispatchDef = createTaskDispatchDefinition(config, library, hooks, homeostasis, wm, thalamus, scheduler, motorCortex, basalGanglia, gate, cognitiveFlexibility, stakeAdjuster, worldModel, pns, driftMonitor, prospectiveMemory, integrationChecker, costTracker);

  // Sensory cortex definition for planning tasks — same machinery used for
  // regular tasks, now plugged into the project rhythm for Phase A manifestation.
  const sensoryCortexDef = createSensoryCortexDefinition(config, library, hooks, wm, thalamus, motorCortex, basalGanglia, gate, cognitiveFlexibility, stakeAdjuster, pns);

  return {
    name: "project",
    maxCycles: 1, // Projects don't loop — looping happens inside task-dispatch

    async prepare(context, _state) {
      log.info("Project starting", {
        tasks: context.tasks.length,
        intent: context.intent.summary,
        planningRequired: context.tasks.length === 0 && !!planner,
      });

      emit("project:start", {
        intentId: context.intent.id,
        taskCount: context.tasks.length,
        planningRequired: context.tasks.length === 0 && !!planner,
      });

      // ── Project Discovery: figure out what kind of project this is ──
      // Uses innate tools to read package.json, scan structure, identify frameworks.
      // Produces a ProjectProfile that tells the system how to run, test, and build.
      let projectProfile: ProjectProfile | undefined;
      if (pns) {
        try {
          const discoveryTools = pns.activateToolsForTask(
            "Discover project characteristics",
            0.5, // medium NE — thorough but not excessive
          );
          projectProfile = await discoverProject(
            process.cwd(),
            config.models.motorCortex,
            discoveryTools,
          );
        } catch (err) {
          log.warn("Project discovery failed — continuing without profile", {
            error: String(err),
          });
        }
      }

      // Hydrate intent.runtime from discovered profile if human didn't provide one.
      // This means everything downstream (build-cycle, evaluators) just reads
      // intent.runtime and gets the right config whether human-provided or discovered.
      if (projectProfile && projectProfile.runtimes.length > 0 && !context.intent.runtime) {
        context.intent.runtime = projectProfile.runtimes;
        log.info("Hydrated intent.runtime from discovered profile", {
          runtimes: projectProfile.runtimes.map((r) => r.name),
        });
      }

      // Bind and build initial Weltanschauung from cross-project + intent/taste
      if (worldModel) {
        worldModel.bindProject(context.intent.id);
        await worldModel.rebuild("project-start", {
          wm,
          intent: context.intent,
          taste: context.taste,
          projectId: context.intent.id,
          taskGraph: context.tasks,
          pns,
          projectProfile,
        });
      }

      return { graph: context.tasks };
    },

    async execute(prepared, state, runner) {
      const { intent, taste } = state.initialContext;
      let graph = prepared.graph;
      let phases: import("../../types/planner.js").ProposedPhase[] = [];
      const originalGraph = prepared.graph;

      // ── Planning: if no tasks provided and Planner available ──
      if (graph.length === 0 && planner) {
        log.info("No tasks provided — running Planner");

        // Phase A: Manifestation through sensory cortex
        const future = await runManifestation(planner, thalamus, sensoryCortexDef, runner, state.id, intent, taste);

        // Phase B: Path Reasoning — LLM backward decomposition
        emit("planner:phase-b-start", {});
        const maxims = worldModel?.getMaximsForBriefing();
        const capabilities = pns?.describeCapabilities();

        const planResult = await planner.reasonBackward(
          future,
          intent,
          taste,
          maxims,
          capabilities,
        );

        graph = planResult.graph;
        phases = planResult.phases;

        emit("planner:phase-b-complete", {
          taskCount: graph.length,
          rejectedCount: planResult.rejected.length,
          phaseCount: planResult.phases.length,
        });

        log.info("Planning complete", {
          tasks: graph.length,
          rejected: planResult.rejected.length,
          phases: planResult.phases.map((p) => p.name),
        });

        // Rebuild world model with the new task graph
        if (worldModel) {
          await worldModel.rebuild("project-start", {
            wm,
            intent,
            taste,
            projectId: intent.id,
            taskGraph: graph,
            pns,
          });
        }

        // ── Cost Estimation + Budget Allocation ──────────────────
        if (costTracker && intent.budget && planner) {
          const planningCost = costTracker.getSpent();
          const estimate = planner.estimateProjectCost(graph, config, planningCost);

          emit("cost:estimate-complete", {
            estimatedTotal: estimate.totalEstimate,
            budget: intent.budget.total,
            overagePercent: estimate.totalEstimate > intent.budget.total
              ? ((estimate.totalEstimate - intent.budget.total) / intent.budget.total * 100)
              : 0,
            assumptions: estimate.assumptions,
            confidence: estimate.confidence,
          });

          log.info("Project cost estimated", {
            estimated: estimate.totalEstimate.toFixed(2),
            budget: intent.budget.total.toFixed(2),
            tasks: graph.length,
          });

          // Allocate budget across tasks
          const allocations = allocateBudget(graph, intent.budget);
          for (const [taskId, amount] of allocations) {
            costTracker.allocateTaskBudget(taskId, amount);
          }
        }

        // ── Plan Evaluation: senses assess the task decomposition ──
        // Only when the system produced a plan (not human-provided) and
        // the plan is non-trivial (>= 3 tasks).
        if (graph.length >= 3) {
          const MAX_PLAN_EVAL_ITERATIONS = 2;
          const future = thalamus.getManifestedFuture() ?? undefined;

          for (let planEvalIter = 0; planEvalIter < MAX_PLAN_EVAL_ITERATIONS; planEvalIter++) {
            const planDescription = formatPlanForEvaluation(graph, phases, future);
            const planEvalTask = createTask(newId(), planDescription, {
              role: "plan-evaluation",
              phaseCount: phases.length,
              taskCount: graph.length,
            });

            thalamus.assembleGestalt({ task: planEvalTask });
            const planEvalCtx: SensoryCortexContext = {
              task: planEvalTask,
              intent,
              taste,
            };

            emit("project:plan-eval-start", {
              iteration: planEvalIter + 1,
              taskCount: graph.length,
              phaseCount: phases.length,
            });

            const evalResult = await runner.run(sensoryCortexDef, planEvalCtx, state.id);
            thalamus.clearGestalt(planEvalTask.id);

            emit("project:plan-eval-complete", {
              iteration: planEvalIter + 1,
              confidence: evalResult.confidence,
              accepted: evalResult.confidence >= 0.6,
            });

            if (evalResult.confidence >= 0.6) {
              log.info("Plan evaluation passed", {
                iteration: planEvalIter + 1,
                confidence: evalResult.confidence.toFixed(2),
              });
              break;
            }

            // Plan didn't pass — replan with evaluation feedback
            if (planEvalIter < MAX_PLAN_EVAL_ITERATIONS - 1) {
              log.info("Plan evaluation failed — replanning", {
                iteration: planEvalIter + 1,
                confidence: evalResult.confidence.toFixed(2),
              });

              const maxims = worldModel?.getMaximsForBriefing();
              const capabilities = pns?.describeCapabilities();
              const replanResult = await planner.replan(
                {
                  completedTasks: [],
                  escalatedTasks: [],
                  driftSummary: "Plan evaluation by senses found gaps",
                  driftAnalysis: null,
                  originalGraph: graph,
                  manifestedFuture: thalamus.getManifestedFuture() ?? "",
                  completedIds: new Set<string>(),
                  diagnosticDirective: evalResult.work,
                },
                intent,
                taste,
                maxims,
                capabilities,
              );

              graph = replanResult.graph;
              phases = replanResult.phases;

              emit("planner:replan-from-eval", {
                taskCount: graph.length,
                phaseCount: phases.length,
              });
            }
          }
        }
      }

      // ── Task dispatch with replan cascade ──────────────────────
      let replanCount = 0;
      let carryOver: {
        completed: Set<string>;
        escalated: Set<string>;
        results: Map<string, OrchestratorResult>;
      } | undefined;

      const MAX_REPLAN_CASCADES = 3;

      while (true) {
        const dispatchCtx: TaskDispatchContext = {
          intent,
          taste,
          graph,
          phases,
          priorCompleted: carryOver?.completed,
          priorEscalated: carryOver?.escalated,
          priorResults: carryOver?.results,
          replanGeneration: replanCount,
        };

        try {
          const result = await runner.run(
            taskDispatchDef,
            dispatchCtx,
            state.id,
          );

          // ── Final Evaluation: senses assess the complete project output ──
          if (result.completedTasks.length > 0) {
            const future = thalamus.getManifestedFuture() ?? undefined;
            const finalDescription = formatFinalEvaluation(result, graph, future);
            const finalEvalTask = createTask(newId(), finalDescription, {
              role: "final-evaluation",
              completedCount: result.completedTasks.length,
            });

            thalamus.assembleGestalt({ task: finalEvalTask });
            const finalEvalCtx: SensoryCortexContext = {
              task: finalEvalTask,
              intent,
              taste,
            };

            emit("project:final-eval-start", {
              completedTasks: result.completedTasks.length,
              escalatedTasks: result.escalatedTasks.length,
            });

            const finalEvalResult = await runner.run(sensoryCortexDef, finalEvalCtx, state.id);
            thalamus.clearGestalt(finalEvalTask.id);

            emit("project:final-eval-complete", {
              confidence: finalEvalResult.confidence,
            });

            state.accumulator.__finalEvaluation = finalEvalResult;

            log.info("Final evaluation complete", {
              confidence: finalEvalResult.confidence.toFixed(2),
              status: finalEvalResult.status,
            });
          }

          return result; // Normal completion
        } catch (err) {
          // Hard interrupt (amygdala) → convert to pending escalation for gate pause
          if (err instanceof RhythmAbortedError) {
            log.warn("Task dispatch aborted (hard interrupt)", {
              rhythmId: err.rhythmId,
              source: err.source,
            });
            state.accumulator.__pendingEscalation = {
              source: "amygdala" as const,
              severity: "emergency" as const,
              reason: err.message,
              detail: `Hard interrupt from ${err.source}: ${err.message}`,
            };
            return {
              completedTasks: [],
              escalatedTasks: [],
              taskResults: new Map(),
            };
          }

          if (!(err instanceof EscalationError)) throw err;
          const ctx = err.decision.context;

          // Non-replan escalations → store on accumulator, let gate pause
          if (ctx.type !== "replan-request") {
            const sourceMap: Record<string, "drift-monitor" | "attention-scheduler" | "cognitive-flexibility" | "amygdala"> = {
              "triage-escalation": "attention-scheduler",
              "diagnostic-escalation": "attention-scheduler",
              "conviction-escalation": "attention-scheduler",
              "scheduler-escalation": "attention-scheduler",
            };
            state.accumulator.__pendingEscalation = {
              source: sourceMap[ctx.type as string] ?? "attention-scheduler",
              severity: err.decision.severity === "critical" ? "urgent" : "blocking",
              reason: err.decision.reason,
              detail: ctx.reasoning as string ?? err.decision.reason,
              question: (ctx.questions as string[] | undefined)?.[0],
              proposedActions: ctx.questions as string[] | undefined,
            };
            return {
              completedTasks: (ctx.completedTasks as string[]) ?? [],
              escalatedTasks: (ctx.escalatedTasks as string[]) ?? [],
              taskResults: (ctx.taskResults as Map<string, OrchestratorResult>) ?? new Map(),
            };
          }

          // Extract carry-over from escalation context
          const completedIds = new Set(ctx.completedTasks as string[]);
          const escalatedIds = new Set(ctx.escalatedTasks as string[]);
          const taskResults = (ctx.taskResults as Map<string, OrchestratorResult>) ?? new Map();
          const driftAssessment = (ctx.driftAssessment as DriftAssessment | null) ?? null;

          replanCount++;

          emit("project:replan-triggered", {
            replanCount,
            completedCount: completedIds.size,
            escalatedCount: escalatedIds.size,
            driftLevel: driftAssessment?.driftLevel,
          });

          log.info("Replan triggered", {
            replanCount,
            completedTasks: completedIds.size,
            escalatedTasks: escalatedIds.size,
            driftLevel: driftAssessment?.driftLevel,
            driftSummary: driftAssessment?.driftSummary,
          });

          // ── Triage: route to the right intervention ──────────
          let diagnosticDirective: string | undefined;

          // Triage reads WM conviction trajectory + signals to decide route
          const triageResult = projectDiagnostics?.triage({
            convictionTrajectory: wm.getConvictionTrajectory(),
            convictionHistory: wm.getConvictionHistory(),
            senseTrends: wm.getSenseTrends(),
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            cerebellumAccuracy: hooks.getCerebellumAccuracy(),
            replanCount,
            maxReplans: MAX_REPLAN_CASCADES,
          });

          const route = triageResult?.route ?? "replan";

          emit("project:triage-result", {
            replanCount,
            route,
            firedRule: triageResult?.firedRule ?? "no-diagnostics",
            reasoning: triageResult?.reasoning,
          });

          log.info("Triage result", {
            replanCount,
            route,
            firedRule: triageResult?.firedRule ?? "no-diagnostics",
          });

          // ── Escalate ─────────────────────────────────────────
          if (route === "escalate") {
            log.warn("Triage: escalating to human", {
              firedRule: triageResult?.firedRule,
            });
            throw new EscalationError(state.id, {
              action: "escalate",
              severity: "critical",
              reason: triageResult?.reasoning ?? "Replan cascade exhausted",
              context: {
                type: "triage-escalation",
                replanCount,
                firedRule: triageResult?.firedRule,
              },
            });
          }

          // ── Full diagnostic (heavy LLM call) ─────────────────
          if (route === "full-diagnostic" && projectDiagnostics) {
            const convictionHistory = wm.getConvictionHistory();

            const diagCtx: DiagnosticContext = {
              taskResults,
              driftAssessment,
              convictionHistory: convictionHistory.map((e) => ({
                verdict: e.verdict,
                level: e.level,
                delta: e.delta,
                evidence: [],
                shaping: { notes: [] },
                decidingStep: e.decidingStep,
              })),
              senseTrends: wm.getSenseTrends(),
              worldModelMaxims: worldModel?.getMaximsForBriefing() ?? [],
              manifestedFuture: thalamus.getManifestedFuture() ?? "",
              originalGraph,
              currentGraph: graph,
              intent,
              taste,
              replanCount,
            };

            const diagResult = await projectDiagnostics.diagnose(diagCtx);

            emit("project:diagnostic-result", {
              diagnosis: diagResult.diagnosis,
              selfHealType: diagResult.selfHealAction?.type ?? "escalate",
            });

            // Environmental → cannot self-heal, escalate to human
            if (diagResult.diagnosis === "environmental" || !diagResult.selfHealAction) {
              throw new EscalationError(state.id, {
                action: "escalate",
                severity: "critical",
                reason: `ProjectDiagnostics: ${diagResult.diagnosis} — ${diagResult.reasoning}`,
                context: {
                  type: "diagnostic-escalation",
                  diagnosis: diagResult.diagnosis,
                  reasoning: diagResult.reasoning,
                  escalationContext: diagResult.escalationContext,
                },
              });
            }

            // Apply self-heal action
            switch (diagResult.selfHealAction.type) {
              case "re-manifest":
                log.info("Diagnostic: re-manifesting");
                if (planner) {
                  await runManifestation(planner, thalamus, sensoryCortexDef, runner, state.id, intent, taste);
                }
                break;
              case "replan-with-directive":
                diagnosticDirective = diagResult.selfHealAction.directive;
                log.info("Diagnostic: replan with directive", { directive: diagnosticDirective });
                break;
              case "recalibrate-evaluation":
                log.info("Diagnostic: recalibrate evaluation", { directive: diagResult.selfHealAction.directive });
                diagnosticDirective = `Recalibration needed: ${diagResult.selfHealAction.directive}`;
                break;
              case "propose-taste-update":
                log.info("Diagnostic: propose taste update", { changes: diagResult.selfHealAction.proposedChanges });
                diagnosticDirective = `Taste adjustment needed: ${diagResult.selfHealAction.proposedChanges}`;
                break;
            }
          }

          // ── Re-manifest (triage-driven, without full diagnostic) ──
          if (route === "re-manifest" && planner) {
            log.info("Triage: re-manifesting before replan");
            await runManifestation(planner, thalamus, sensoryCortexDef, runner, state.id, intent, taste);
          }

          // ── Replan (all non-escalation routes end here) ──────
          if (planner) {
            const completedDescriptions = [...completedIds].map((id) => {
              const node = graph.find((n) => n.task.id === id);
              return { id, description: node?.task.description ?? "Unknown" };
            });

            // Sense-specific directive from triage R4 flows as diagnostic directive
            const effectiveDirective = diagnosticDirective ?? triageResult?.senseDirective;

            const replanCtx: ReplanContext = {
              completedTasks: completedDescriptions,
              escalatedTasks: [...escalatedIds],
              driftSummary: driftAssessment?.driftSummary ?? err.decision.reason,
              driftAnalysis: driftAssessment?.deepAnalysis ?? null,
              originalGraph: graph,
              manifestedFuture: thalamus.getManifestedFuture() ?? "",
              completedIds,
              diagnosticDirective: effectiveDirective,
            };

            const maxims = worldModel?.getMaximsForBriefing();
            const capabilities = pns?.describeCapabilities();

            const replanResult = await planner.replan(
              replanCtx,
              intent,
              taste,
              maxims,
              capabilities,
            );

            graph = replanResult.graph;
            phases = replanResult.phases;

            emit("project:replan-complete", {
              replanCount,
              taskCount: graph.length,
              rejectedCount: replanResult.rejected.length,
            });

            log.info("Replan complete", {
              replanCount,
              tasks: graph.length,
              rejected: replanResult.rejected.length,
            });

            // Rebuild world model with updated graph
            if (worldModel) {
              await worldModel.rebuild("replan", {
                wm,
                intent,
                taste,
                projectId: intent.id,
                taskGraph: graph,
                completedTaskIds: completedIds,
                escalatedTaskIds: escalatedIds,
                pns,
              });
            }
          }

          // Set up carry-over for next dispatch round
          carryOver = {
            completed: completedIds,
            escalated: escalatedIds,
            results: taskResults,
          };
        }
      }
    },

    async integrate(executed, state) {
      // Retrospective — stub for now
      // In the real system, this would do a final crystallization sweep
      // and produce a retrospective summary

      log.info("Project retrospective", {
        completed: executed.completedTasks.length,
        escalated: executed.escalatedTasks.length,
      });

      // Final Weltanschauung synthesis — may update cross-project layer
      if (worldModel) {
        await worldModel.rebuild("project-complete", {
          wm,
          intent: state.initialContext.intent,
          taste: state.initialContext.taste,
          projectId: state.initialContext.intent.id,
          taskGraph: state.initialContext.tasks,
          completedTaskIds: new Set(executed.completedTasks),
          escalatedTaskIds: new Set(executed.escalatedTasks),
          pns,
        });
      }

      const resultState: ProjectResult["state"] =
        executed.escalatedTasks.length > 0 ? "paused" : "delivered";

      const finalEval = state.accumulator.__finalEvaluation as OrchestratorResult | undefined;

      return {
        state: resultState,
        taskResults: executed.taskResults,
        retrospective: finalEval?.work,
      };
    },

    async gate(integrated, state) {
      // Check if execute stored a pending escalation for human input
      const pending = state.accumulator.__pendingEscalation as {
        source: "drift-monitor" | "attention-scheduler" | "cognitive-flexibility" | "amygdala";
        severity: "advisory" | "blocking" | "urgent" | "emergency";
        reason: string;
        detail?: string;
        question?: string;
        proposedActions?: string[];
      } | undefined;

      if (pending) {
        log.info("Gate: pausing for human escalation", {
          source: pending.source,
          severity: pending.severity,
          reason: pending.reason,
        });

        return {
          action: "pause" as const,
          reason: pending.reason,
          resumable: true as const,
          escalationContext: {
            source: pending.source,
            severity: pending.severity,
            detail: pending.detail ?? pending.reason,
            question: pending.question,
            proposedActions: pending.proposedActions,
          },
        };
      }

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

// ─── Helpers: evaluation task descriptions ──────────────────────

const MAX_WORK_SUMMARY_CHARS = 500;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "… [truncated]";
}

function formatPlanForEvaluation(
  graph: TaskGraphNode[],
  phases: ProposedPhase[],
  manifestedFuture?: string,
): string {
  const sections: string[] = [
    "Evaluate whether this task decomposition achieves the manifested future.",
  ];

  if (manifestedFuture) {
    sections.push(`MANIFESTED FUTURE:\n${manifestedFuture}`);
  }

  // Group tasks by phase
  const tasksByPhase = new Map<string, TaskGraphNode[]>();
  for (const node of graph) {
    const group = node.phaseGroup ?? "ungrouped";
    const list = tasksByPhase.get(group) ?? [];
    list.push(node);
    tasksByPhase.set(group, list);
  }

  const planLines: string[] = [];
  for (const phase of phases) {
    const phaseTasks = tasksByPhase.get(phase.name) ?? [];
    planLines.push(`Phase: ${phase.name} — Gate: ${phase.gateCondition}`);
    for (const node of phaseTasks) {
      const deps = node.dependsOn.length > 0 ? ` (depends on: ${node.dependsOn.join(", ")})` : "";
      planLines.push(`  - ${node.task.description}${deps}`);
    }
  }

  // Any ungrouped tasks
  const ungrouped = tasksByPhase.get("ungrouped");
  if (ungrouped && ungrouped.length > 0) {
    planLines.push("Ungrouped tasks:");
    for (const node of ungrouped) {
      planLines.push(`  - ${node.task.description}`);
    }
  }

  sections.push(`PROPOSED PLAN (${graph.length} tasks, ${phases.length} phases):\n${planLines.join("\n")}`);

  sections.push(
    "Assess: Is each task necessary? Are any tasks missing? Will this sequence achieve the manifested future? Are the phase gate conditions sufficient to catch integration issues?",
  );

  return sections.join("\n\n");
}

function formatFinalEvaluation(
  result: TaskDispatchResult,
  graph: TaskGraphNode[],
  manifestedFuture?: string,
): string {
  const sections: string[] = [
    "Final integration check: verify the complete project output satisfies the manifested future.",
  ];

  if (manifestedFuture) {
    sections.push(`MANIFESTED FUTURE:\n${manifestedFuture}`);
  }

  // Assemble completed work summaries
  const workLines: string[] = [];
  for (const node of graph) {
    const taskResult = result.taskResults.get(node.task.id);
    if (taskResult) {
      workLines.push(`--- Task: ${node.task.description} (confidence: ${taskResult.confidence.toFixed(2)}) ---`);
      workLines.push(truncate(taskResult.work, MAX_WORK_SUMMARY_CHARS));
    }
  }

  if (workLines.length > 0) {
    sections.push(`ALL COMPLETED WORK (${result.completedTasks.length} tasks):\n${workLines.join("\n\n")}`);
  }

  if (result.escalatedTasks.length > 0) {
    sections.push(`ESCALATED TASKS (${result.escalatedTasks.length}): ${result.escalatedTasks.join(", ")}`);
  }

  sections.push(
    "Produce a synthesis of overall project quality. Identify any cross-phase gaps, inconsistencies, or deviations from the manifested future.",
  );

  return sections.join("\n\n");
}
