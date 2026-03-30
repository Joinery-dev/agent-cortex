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
 * When tasks are pre-provided (Parsifal-given), planning is skipped.
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
import { computeNE, mapUrgencyToNE } from "../../kernel/norepinephrine.js";
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
import type { TasteFeedbackLoop } from "../../kernel/taste-feedback.js";
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

import type { ManifestedFuture, ProposedPhase, ShaelNode, HierarchicalPlanResult, DependencyWiringResult, GenerativeCompletionResult } from "../../types/planner.js";
import { createTask } from "../../types/task.js";
import { newId } from "../../util/ids.js";
import { allocateBudget } from "../../kernel/budget-allocator.js";
import type { CostTracker } from "../cost-tracker.js";
import { setCostTaskId } from "../../llm/client.js";
import { inquire, formatInquiryForParsifal, formatApprovalForParsifal } from "../../kernel/consul.js";

/** Options for the interactive parts of manifestation (inquiry + approval). */
interface ManifestationInteraction {
  askUser: (question: string) => Promise<string>;
  library: SensoryCortex;
  config: import("../../types/orchestrator.js").CortexConfig;
}

/**
 * Heuristic: is the Parsifal's response an approval or a redirect?
 * Short affirmatives → approval. Anything substantive → redirect.
 */
function isApproval(response: string): boolean {
  const normalized = response.trim().toLowerCase().replace(/[.!,]+$/, "");
  const approvals = [
    "yes", "y", "confirmed", "confirm", "approved", "approve",
    "looks good", "lgtm", "looks right", "that's it", "thats it",
    "proceed", "go ahead", "ship it", "perfect", "exactly",
    "that's what i see", "thats what i see", "correct",
  ];
  return approvals.includes(normalized);
}

async function runManifestation(
  planner: Planner,
  thalamus: Thalamus,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sensoryCortexDef: RD<SensoryCortexContext, SensoryCortexResult, any, any, any>,
  runner: RhythmRunner,
  parentId: string,
  intent: ProjectIntent,
  taste: TasteProfile,
  interaction?: ManifestationInteraction,
): Promise<ManifestedFuture> {
  // ── Phase 1a: Inquiry — senses ask clarifying questions ───
  let inquiryContext: string | undefined;

  if (interaction) {
    const activeSenses = thalamus.getActiveSenses(interaction.library);
    const inquiries = await inquire(
      activeSenses, interaction.library, interaction.config, intent, taste,
    );

    const withQuestions = inquiries.filter((r) => r.questions.length > 0);
    if (withQuestions.length > 0) {
      emit("planner:phase-a-inquiry", {
        sensesWithQuestions: withQuestions.length,
        totalQuestions: withQuestions.reduce((sum, r) => sum + r.questions.length, 0),
      });

      const formatted = formatInquiryForParsifal(withQuestions, intent);
      const answers = await interaction.askUser(formatted);

      // Build context string that flows into the manifestation task
      const qaParts: string[] = [];
      for (const inq of withQuestions) {
        for (const q of inq.questions) {
          qaParts.push(`[${inq.senseName}] ${q.question}`);
        }
      }
      inquiryContext = [
        `Questions asked:`,
        ...qaParts,
        ``,
        `Parsifal's answers:`,
        answers,
      ].join("\n");

      log.info("Inquiry answers received", { answerLength: answers.length });
    } else {
      log.info("No inquiry questions — senses understood the intent");
    }
  }

  // ── Phase 1b: Synthesis — sensory cortex produces concrete vision ──
  emit("planner:phase-a-start", { taskId: "pending", hasInquiryContext: !!inquiryContext });

  let future = await runSynthesis(
    planner, thalamus, sensoryCortexDef, runner, parentId,
    intent, taste, inquiryContext,
  );

  // ── Phase 1c: Approval — question-asker confirms or redirects ──
  if (interaction) {
    const MAX_REDIRECTS = 3;
    let redirectCount = 0;

    while (redirectCount < MAX_REDIRECTS) {
      const approvalMessage = formatApprovalForParsifal(future);
      const response = await interaction.askUser(approvalMessage);

      if (isApproval(response)) {
        emit("planner:phase-a-approved", { redirectCount });
        log.info("Manifested future approved", { redirectCount });
        break;
      }

      // Redirect: re-run synthesis with user feedback
      redirectCount++;
      emit("planner:phase-a-redirect", {
        redirectCount,
        feedbackLength: response.length,
      });

      log.info("Manifested future redirected", {
        redirectCount,
        feedbackLength: response.length,
      });

      const redirectContext = [
        inquiryContext ?? "",
        `\nParsifal feedback on vision (redirect ${redirectCount}):`,
        response,
      ].filter(Boolean).join("\n");

      future = await runSynthesis(
        planner, thalamus, sensoryCortexDef, runner, parentId,
        intent, taste, redirectContext,
      );
    }
  }

  emit("planner:phase-a-complete", {
    confidence: future.confidence,
    visionLength: future.vision.length,
  });

  thalamus.setManifestedFuture(future.vision);
  return future;
}

/**
 * Run a single synthesis pass through the sensory cortex.
 * Extracted so runManifestation can loop on redirects.
 */
async function runSynthesis(
  planner: Planner,
  thalamus: Thalamus,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sensoryCortexDef: RD<SensoryCortexContext, SensoryCortexResult, any, any, any>,
  runner: RhythmRunner,
  parentId: string,
  intent: ProjectIntent,
  taste: TasteProfile,
  additionalContext?: string,
): Promise<ManifestedFuture> {
  const manifestationTask = planner.createManifestationTask(intent, additionalContext);
  thalamus.assembleGestalt({ task: manifestationTask });

  const manifestCtx: SensoryCortexContext = {
    task: manifestationTask,
    intent,
    taste,
  };

  const manifestResult = await runner.run(sensoryCortexDef, manifestCtx, parentId);
  thalamus.clearGestalt(manifestationTask.id);

  return planner.extractManifestedFuture(manifestResult);
}

// ─── Hierarchical planning helpers ───────────────────────────────

/**
 * Get shaels whose meta-dependencies are all satisfied.
 * Pure function — reads the wiring result and completed set.
 */
function getReadyShaels(
  shaels: ShaelNode[],
  wiring: DependencyWiringResult,
  completedShaelIds: Set<string>,
): ShaelNode[] {
  // Build dep map: shaelId → IDs it depends on
  const depsFor = new Map<string, string[]>();
  for (const dep of wiring.dependencies) {
    const deps = depsFor.get(dep.from) ?? [];
    deps.push(dep.to);
    depsFor.set(dep.from, deps);
  }

  // Shaels whose deps are all completed (or have no deps)
  const shaelIds = new Set(shaels.map((s) => s.id));
  return shaels.filter((shael) => {
    if (completedShaelIds.has(shael.id)) return false;
    const deps = depsFor.get(shael.id) ?? [];
    // Only count deps that are actually shaels in this plan (not external)
    const relevantDeps = deps.filter((d) => shaelIds.has(d));
    return relevantDeps.every((d) => completedShaelIds.has(d));
  });
}

/**
 * Pick the next shael to execute from ready shaels, preferring
 * topological order from the wiring result.
 */
function pickNextShael(
  readyShaels: ShaelNode[],
  wiring: DependencyWiringResult,
): ShaelNode {
  // Prefer the one earliest in topological order
  const orderIndex = new Map(wiring.topologicalOrder.map((id, i) => [id, i]));
  const sorted = [...readyShaels].sort(
    (a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity),
  );
  return sorted[0];
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
  tasteFeedbackLoop?: TasteFeedbackLoop,
  planner?: Planner,
  projectDiagnostics?: ProjectDiagnostics,
  prospectiveMemory?: ProspectiveMemory,
  costTracker?: CostTracker,
  qualityPredictor?: import("../../kernel/model-selector.js").ModelQualityPredictor,
  askUser?: (question: string) => Promise<string>,
): RhythmDefinition<ProjectContext, ProjectResult, PreparedProject, TaskDispatchResult, ProjectResult> {
  const integrationChecker = new IntegrationChecker(undefined, library, wm, thalamus, config);
  const taskDispatchDef = createTaskDispatchDefinition(config, library, hooks, homeostasis, wm, thalamus, scheduler, motorCortex, basalGanglia, gate, cognitiveFlexibility, stakeAdjuster, worldModel, pns, driftMonitor, tasteFeedbackLoop, prospectiveMemory, integrationChecker, costTracker, qualityPredictor);

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
      // Produces a ProjectProfile that tells Cortex how to run, test, and build.
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

      // Hydrate intent.runtime from discovered profile if the Parsifal didn't provide one.
      // This means everything downstream (build-cycle, evaluators) just reads
      // intent.runtime and gets the right config whether Parsifal-provided or discovered.
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

      // ── Planning: hierarchical shael decomposition + dispatch ────
      // When no tasks are pre-provided and a Planner is available,
      // plan the whole project as shaels, then dispatch each shael
      // with just-in-time per-shael planning. Each shael's shana
      // become a flat TaskGraphNode[] fed to the existing task-dispatch.
      if (graph.length === 0 && planner) {
        log.info("No tasks provided — running hierarchical planner");

        const interaction = askUser
          ? { askUser, library, config }
          : undefined;
        const future = await runManifestation(planner, thalamus, sensoryCortexDef, runner, state.id, intent, taste, interaction);
        state.accumulator.__manifestedFuture = future;

        emit("planner:phase-b-start", { hierarchical: true });
        const maxims = worldModel?.getMaximsForBriefing();
        const capabilities = pns?.describeCapabilities();
        const planningNE = computeNE({
          cerebellumAccuracy: hooks.getCerebellumAccuracy(),
          parsifalUrgency: mapUrgencyToNE(intent.urgency),
        });

        const hierarchicalPlan = await planner.reasonBackwardHierarchical(
          future, intent, taste, maxims, capabilities, planningNE.ne,
        );

        emit("planner:phase-b-complete", {
          hierarchical: true,
          shaelCount: hierarchicalPlan.shaels.length,
          edgeCount: hierarchicalPlan.wiring.dependencies.length,
          affinityGroupCount: hierarchicalPlan.wiring.affinityGroups.length,
        });

        log.info("Hierarchical planning complete", {
          shaels: hierarchicalPlan.shaels.length,
          edges: hierarchicalPlan.wiring.dependencies.length,
          affinityGroups: hierarchicalPlan.wiring.affinityGroups.length,
        });

        // ── Phase B.3: PFC Review ────────────────────────────────
        // Validate structural integrity against the manifested future.
        // Mechanical checks always run; LLM review when NE ≥ 0.7.
        const pfcReview = await planner.reviewPlan(
          hierarchicalPlan.shaels,
          hierarchicalPlan.wiring,
          future,
          intent,
          planningNE.ne,
        );

        // Use reviewed plan for dispatch (patches applied, topo re-sorted)
        const reviewedShaels = pfcReview.shaels;
        const reviewedWiring = pfcReview.wiring;

        if (pfcReview.warnings.length > 0) {
          log.info("PFC review warnings", {
            total: pfcReview.warnings.length,
            critical: pfcReview.warnings.filter((w) => w.severity === "critical").length,
            patches: pfcReview.patches.length,
          });
        }

        emit("planner:phase-b3-complete", {
          warnings: pfcReview.warnings.length,
          criticalWarnings: pfcReview.warnings.filter((w) => w.severity === "critical").length,
          patches: pfcReview.patches.length,
          thoroughReview: pfcReview.thoroughReview,
        });

        // ── Shael dispatch loop ──────────────────────────────────
        const completedShaelIds = new Set<string>();
        const allTaskResults = new Map<string, OrchestratorResult>();
        const allCompletedTasks: string[] = [];
        const allEscalatedTasks: string[] = [];

        const jitThreshold = config.plannerConfig?.jitWiringThreshold ?? 5;
        const jitNEThreshold = config.plannerConfig?.jitWiringNEThreshold ?? 0.5;
        const graphBuilderModel = config.plannerConfig?.graphBuilderModel ?? config.models.motorCortex;

        let readyShaels = getReadyShaels(
          reviewedShaels, reviewedWiring, completedShaelIds,
        );

        while (readyShaels.length > 0) {
          const shael = pickNextShael(readyShaels, reviewedWiring);

          emit("project:shael-dispatch", {
            shaelId: shael.id,
            description: shael.description,
            completedShaels: completedShaelIds.size,
            totalShaels: reviewedShaels.length,
          });

          log.info("Dispatching shael", {
            shaelId: shael.id,
            description: shael.description.slice(0, 80),
            completed: completedShaelIds.size,
            total: reviewedShaels.length,
          });

          // ── JIT per-shael planning ────────────────────────────
          // Use the existing reasonBackward scoped to this shael's question.
          // The shael's description + gate condition frame the "manifested future"
          // for the sub-plan.
          const shaelFuture: import("../../types/planner.js").ManifestedFuture = {
            vision: `Shael: ${shael.description}\n\nGate condition: ${shael.gateCondition}`,
            senseContributions: hierarchicalPlan.manifestedFuture.senseContributions,
            confidence: hierarchicalPlan.manifestedFuture.confidence,
            cycles: 0,
          };

          const shaelPlanResult = await planner.reasonBackward(
            shaelFuture, intent, taste, maxims, capabilities, planningNE.ne,
          );

          let shanaGraph = shaelPlanResult.graph;
          const shanaPhases = shaelPlanResult.phases;

          // Optionally run B.2 on the shana if complex enough
          const shanaCount = shanaGraph.length;
          const shouldWire = shanaCount >= jitThreshold || planningNE.ne >= jitNEThreshold;

          if (shouldWire && shanaCount > 0) {
            log.info("Running B.2 on shael shana", {
              shaelId: shael.id,
              shanaCount,
              ne: planningNE.ne,
            });

            // Convert flat graph nodes back to ShaelNode for the GraphBuilder
            const shanaNodes: ShaelNode[] = shanaGraph.map((node) => ({
              id: node.task.id,
              description: node.task.description,
              level: "shana" as const,
              phaseGroup: node.phaseGroup ?? shael.phaseGroup,
              parentId: shael.id,
              gateCondition: "",
              necessity: String(node.task.context?.necessity ?? ""),
              formJustification: "",
              scopeJustification: "",
            }));

            const graphBuilder = planner.createGraphBuilder(graphBuilderModel);
            const shanaWiring = await graphBuilder.wire(shanaNodes, planningNE.ne);

            // Rebuild graph from wiring
            shanaGraph = planner.buildGraphFromShana(shanaNodes, shanaWiring, shanaPhases);
          }

          // ── Dispatch shana through existing task-dispatch ─────
          const dispatchCtx: TaskDispatchContext = {
            intent,
            taste,
            graph: shanaGraph,
            phases: shanaPhases,
            shaelId: shael.id,
          };

          try {
            const result = await runner.run(taskDispatchDef, dispatchCtx, state.id);

            allCompletedTasks.push(...result.completedTasks);
            allEscalatedTasks.push(...result.escalatedTasks);
            for (const [id, res] of result.taskResults) {
              allTaskResults.set(id, res);
            }

            completedShaelIds.add(shael.id);

            emit("project:shael-complete", {
              shaelId: shael.id,
              completedTasks: result.completedTasks.length,
              escalatedTasks: result.escalatedTasks.length,
            });

            log.info("Shael complete", {
              shaelId: shael.id,
              completed: result.completedTasks.length,
              escalated: result.escalatedTasks.length,
            });
          } catch (err) {
            if (err instanceof EscalationError) {
              // Shael-level failure — mark as escalated, continue to next
              log.warn("Shael escalated", {
                shaelId: shael.id,
                reason: err.decision.reason,
              });
              completedShaelIds.add(shael.id); // Treat as done (escalated)
              allEscalatedTasks.push(shael.id);
            } else {
              throw err;
            }
          }

          readyShaels = getReadyShaels(
            reviewedShaels, reviewedWiring, completedShaelIds,
          );
        }

        // ── Final evaluation ─────────────────────────────────────
        if (allCompletedTasks.length > 0) {
          const future = thalamus.getManifestedFuture() ?? undefined;
          const finalResult: TaskDispatchResult = {
            completedTasks: allCompletedTasks,
            escalatedTasks: allEscalatedTasks,
            taskResults: allTaskResults,
          };
          const finalDescription = formatFinalEvaluation(finalResult, [], future);
          const finalEvalTask = createTask(newId(), finalDescription, {
            role: "final-evaluation",
            completedCount: allCompletedTasks.length,
          });

          thalamus.assembleGestalt({ task: finalEvalTask });
          const finalEvalCtx: SensoryCortexContext = {
            task: finalEvalTask,
            intent,
            taste,
          };

          emit("project:final-eval-start", {
            completedTasks: allCompletedTasks.length,
            escalatedTasks: allEscalatedTasks.length,
          });

          const finalEvalResult = await runner.run(sensoryCortexDef, finalEvalCtx, state.id);
          thalamus.clearGestalt(finalEvalTask.id);

          emit("project:final-eval-complete", {
            confidence: finalEvalResult.confidence,
          });

          state.accumulator.__finalEvaluation = finalEvalResult;
        }

        return {
          completedTasks: allCompletedTasks,
          escalatedTasks: allEscalatedTasks,
          taskResults: allTaskResults,
        };
      }

      // ── Task dispatch with replan cascade (flat path) ────────────
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

          // All escalation types enter the self-healing cascade.
          // The amygdala path (RhythmAbortedError) is handled above and
          // never reaches here — hard interrupts bypass self-healing.

          // Extract carry-over from escalation context
          const completedIds = new Set((ctx.completedTasks as string[]) ?? []);
          const escalatedIds = new Set((ctx.escalatedTasks as string[]) ?? []);
          const taskResults = (ctx.taskResults as Map<string, OrchestratorResult>) ?? new Map();
          const driftAssessment = (ctx.driftAssessment as DriftAssessment | null) ?? null;

          replanCount++;

          emit("project:self-heal-triggered", {
            replanCount,
            escalationType: ctx.type,
            completedCount: completedIds.size,
            escalatedCount: escalatedIds.size,
            driftLevel: driftAssessment?.driftLevel,
          });

          log.info("Self-heal cascade triggered", {
            replanCount,
            escalationType: ctx.type,
            completedTasks: completedIds.size,
            escalatedTasks: escalatedIds.size,
            driftLevel: driftAssessment?.driftLevel,
            driftSummary: driftAssessment?.driftSummary,
          });

          // ── Triage: route to the right intervention ──────────
          let diagnosticDirective: string | undefined;

          // Build escalation source for triage — scheduler-specific rules
          // fire when the escalation came from a non-replan source.
          const escalationSource = ctx.type !== "replan-request"
            ? {
                type: ctx.type as "conviction-escalation" | "scheduler-escalation" | "pfc-flag",
                schedulerType: ctx.schedulerEscalationType as "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift" | undefined,
                reason: err.decision.reason,
              }
            : undefined;

          // Triage reads WM conviction trajectory + signals to decide route
          const triageResult = projectDiagnostics?.triage({
            convictionTrajectory: wm.getConvictionTrajectory(),
            convictionHistory: wm.getConvictionHistory(),
            senseTrends: wm.getSenseTrends(),
            driftAssessment: driftMonitor?.getAssessment() ?? null,
            cerebellumAccuracy: hooks.getCerebellumAccuracy(),
            replanCount,
            maxReplans: MAX_REPLAN_CASCADES,
            escalationSource,
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
            log.warn("Triage: escalating to Parsifal", {
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

            // Environmental → cannot self-heal, escalate to Parsifal
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

            // Recompute NE at replan time — maturity may have shifted
            const replanNE = computeNE({
              cerebellumAccuracy: hooks.getCerebellumAccuracy(),
              parsifalUrgency: mapUrgencyToNE(intent.urgency),
            });

            const replanResult = await planner.replan(
              replanCtx,
              intent,
              taste,
              maxims,
              capabilities,
              replanNE.ne,
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

      // ── Generative Completion: "What questions couldn't have been asked before?" ──
      let generativeQuestions: GenerativeCompletionResult | undefined;
      const future = state.accumulator.__manifestedFuture as ManifestedFuture | undefined;

      if (planner && future && resultState === "delivered") {
        const completedTaskSummaries = executed.completedTasks.map((taskId) => {
          const result = executed.taskResults.get(taskId);
          const graphNode = state.initialContext.tasks.find((n) => n.task.id === taskId);
          return {
            description: graphNode?.task.description ?? taskId,
            work: result?.work?.slice(0, 500),
          };
        });

        const maxims = worldModel?.getMaximsForBriefing();

        try {
          generativeQuestions = await planner.generateCompletionQuestions(
            future,
            state.initialContext.intent.summary,
            completedTaskSummaries,
            finalEval?.work,
            maxims,
          );

          if (generativeQuestions.questions.length > 0) {
            emit("project:generative-complete", {
              questionCount: generativeQuestions.questions.length,
            });
          }
        } catch (err) {
          log.warn("Generative completion failed (non-fatal)", { error: String(err) });
        }
      }

      return {
        state: resultState,
        taskResults: executed.taskResults,
        retrospective: finalEval?.work,
        generativeQuestions,
      };
    },

    async gate(integrated, state) {
      // Check if execute stored a pending escalation for Parsifal input
      const pending = state.accumulator.__pendingEscalation as {
        source: "drift-monitor" | "attention-scheduler" | "cognitive-flexibility" | "amygdala";
        severity: "advisory" | "blocking" | "urgent" | "emergency";
        reason: string;
        detail?: string;
        question?: string;
        proposedActions?: string[];
      } | undefined;

      if (pending) {
        log.info("Gate: pausing for Parsifal escalation", {
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
