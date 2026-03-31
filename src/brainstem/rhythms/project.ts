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
import { isApproval } from "../../util/approval.js";
import { getActiveWorldview } from "../../util/worldview-context.js";
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
// RD import removed — manifestation no longer runs through sensory cortex
import type { SensoryCortexResult } from "../../types/brainstem.js";
import type { ProjectIntent, TasteProfile } from "../../types/intent.js";

import type { ManifestedFuture, ProposedPhase, ShaelNode, HierarchicalPlanResult, DependencyWiringResult, GenerativeCompletionResult } from "../../types/planner.js";
import { createTask } from "../../types/task.js";
import { newId } from "../../util/ids.js";
import { allocateBudget } from "../../kernel/budget-allocator.js";
import type { CostTracker } from "../cost-tracker.js";
import { setCostTaskId } from "../../llm/client.js";
import { inquire, followUpInquire, formatInquiryForParsifal, formatApprovalForParsifal, synthesizeInquiry, formatSynthesizedForParsifal, formatSynthesizedFollowUpForParsifal, buildSynthesizedInquiryContext, manifestSenses, synthesizeVision, evaluateVision } from "../../kernel/consul.js";

/** Options for the interactive parts of manifestation (inquiry + approval). */
interface ManifestationInteraction {
  askUser: (question: string) => Promise<string>;
  library: SensoryCortex;
  config: import("../../types/orchestrator.js").CortexConfig;
}

// isApproval imported from ../../util/approval.js

async function runManifestation(
  thalamus: Thalamus,
  library: SensoryCortex,
  config: CortexConfig,
  runner: RhythmRunner,
  intent: ProjectIntent,
  taste: TasteProfile,
  interaction?: ManifestationInteraction,
  preexistingInquiryContext?: string,
): Promise<ManifestedFuture> {
  // ── Phase 1a: Inquiry — convergence loop ──────────────────
  // Senses ask questions, Parsifal answers, senses ask follow-ups
  // until all senses are satisfied (no more questions).
  let inquiryContext: string | undefined = preexistingInquiryContext;
  const MAX_INQUIRY_ROUNDS = 4;

  if (interaction && !preexistingInquiryContext) {
    const activeSenses = thalamus.getActiveSenses(interaction.library);
    const qaRounds: string[] = [];
    let round = 0;

    while (round < MAX_INQUIRY_ROUNDS) {
      round++;

      const inquiries = round === 1
        ? await inquire(activeSenses, interaction.library, interaction.config, intent, taste)
        : await followUpInquire(activeSenses, interaction.library, interaction.config, intent, taste, qaRounds.join("\n\n"), round);

      const withQuestions = inquiries.filter((r) => r.questions.length > 0);

      if (withQuestions.length === 0) {
        log.info("Inquiry converged — all senses satisfied", { rounds: round });
        emit("planner:inquiry-converged", { rounds: round });
        break;
      }

      emit("planner:phase-a-inquiry", {
        round,
        sensesWithQuestions: withQuestions.length,
        totalQuestions: withQuestions.reduce((sum, r) => sum + r.questions.length, 0),
      });

      // Synthesize every round — merge, deduplicate, tier across senses.
      let formatted: string;
      let buildContext: (answers: string) => string;

      try {
        const synthesis = await synthesizeInquiry(inquiries, interaction.config, intent);
        formatted = round === 1
          ? formatSynthesizedForParsifal(synthesis, intent)
          : formatSynthesizedFollowUpForParsifal(synthesis, intent);
        buildContext = (answers) => buildSynthesizedInquiryContext(synthesis, answers);
      } catch (err) {
        log.warn("Inquiry synthesis failed, falling back to raw format", { error: String(err) });
        formatted = formatInquiryForParsifal(withQuestions, intent, round);
        buildContext = (answers) => {
          const qaParts: string[] = [];
          for (const inq of withQuestions) {
            for (const q of inq.questions) {
              qaParts.push(`[${inq.senseName}] ${q.question}`);
            }
          }
          return [`Questions:`, ...qaParts, ``, `Parsifal's answers:`, answers].join("\n");
        };
      }

      const answers = await interaction.askUser(formatted);

      qaRounds.push([
        `--- Round ${round} ---`,
        buildContext(answers),
      ].join("\n"));

      log.info("Inquiry round complete", { round, answerLength: answers.length });
    }

    if (qaRounds.length > 0) {
      inquiryContext = qaRounds.join("\n\n");

      // Checkpoint after inquiry — preserves Q&A so a crash doesn't lose it
      await runner.checkpoint("post-inquiry", "post-inquiry", {
        inquiryContext,
        intentSummary: intent.summary,
        initialContext: { intent, taste },
      });
    } else {
      log.info("No inquiry questions — senses understood the intent");
    }
  }

  // ── Phase 1b: Synthesis loop — senses manifest → synthesize → evaluate → converge ──
  emit("planner:phase-a-start", { taskId: "pending", hasInquiryContext: !!inquiryContext });

  const activeSensesForManifest = thalamus.getActiveSenses(library);

  // Step 1: Each sense manifests its perspective
  const perspectives = await manifestSenses(
    activeSensesForManifest, library, config, intent, taste, inquiryContext,
  );

  // Step 2: Synthesize into unified vision
  let synthesis = await synthesizeVision(
    perspectives, config, intent, taste, inquiryContext,
  );

  // Steps 3-4: Sense evaluation → convergence loop
  const MAX_CONVERGENCE_ROUNDS = 4;
  let convergenceRound = 0;

  while (convergenceRound < MAX_CONVERGENCE_ROUNDS) {
    convergenceRound++;

    const evaluations = await evaluateVision(
      activeSensesForManifest, library, config,
      synthesis.vision, synthesis.senseContributions, synthesis.tensionResolutions,
    );

    const allSatisfied = evaluations.every((e) => e.satisfied);

    if (allSatisfied) {
      log.info("Manifestation converged — all senses satisfied", { rounds: convergenceRound });
      emit("manifestation-synthesis:converged", { rounds: convergenceRound });
      break;
    }

    // Build feedback from unsatisfied senses
    const unsatisfiedFeedback = evaluations
      .filter((e) => !e.satisfied)
      .map((e) => `[${e.senseName}]: ${e.feedback}`)
      .join("\n\n");

    log.info("Manifestation not converged — re-synthesizing", {
      round: convergenceRound,
      unsatisfied: evaluations.filter((e) => !e.satisfied).map((e) => e.senseName),
    });

    emit("manifestation-synthesis:reconverge", {
      round: convergenceRound,
      unsatisfied: evaluations.filter((e) => !e.satisfied).map((e) => e.senseName),
    });

    // Re-synthesize with sense feedback
    synthesis = await synthesizeVision(
      perspectives, config, intent, taste, inquiryContext, unsatisfiedFeedback,
    );
  }

  // Derive confidence from sense evaluations + synthesis confidence
  const lastEvaluations = await evaluateVision(
    activeSensesForManifest, library, config,
    synthesis.vision, synthesis.senseContributions, synthesis.tensionResolutions,
  );
  const avgSenseConfidence = lastEvaluations.length > 0
    ? lastEvaluations.reduce((sum, e) => sum + e.confidence, 0) / lastEvaluations.length
    : synthesis.confidence;
  const overallConfidence = (avgSenseConfidence + synthesis.confidence) / 2;

  let future: ManifestedFuture = {
    vision: synthesis.vision,
    senseContributions: synthesis.senseContributions,
    confidence: overallConfidence,
    cycles: convergenceRound,
  };

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

      // Redirect: re-synthesize with Parsifal feedback, then re-evaluate with senses
      redirectCount++;
      emit("planner:phase-a-redirect", {
        redirectCount,
        feedbackLength: response.length,
      });

      log.info("Manifested future redirected", {
        redirectCount,
        feedbackLength: response.length,
      });

      const parsiFeedback = [
        `Parsifal feedback on vision (redirect ${redirectCount}):`,
        response,
      ].join("\n");

      // Re-synthesize with Parsifal feedback
      synthesis = await synthesizeVision(
        perspectives, config, intent, taste, inquiryContext, parsiFeedback,
      );

      // Run sense evaluation on the redirected vision
      let redirectRound = 0;
      while (redirectRound < MAX_CONVERGENCE_ROUNDS) {
        redirectRound++;
        const evals = await evaluateVision(
          activeSensesForManifest, library, config,
          synthesis.vision, synthesis.senseContributions, synthesis.tensionResolutions,
        );

        if (evals.every((e) => e.satisfied)) {
          log.info("Post-redirect convergence achieved", { redirectRound });
          break;
        }

        const fb = evals
          .filter((e) => !e.satisfied)
          .map((e) => `[${e.senseName}]: ${e.feedback}`)
          .join("\n\n");

        synthesis = await synthesizeVision(
          perspectives, config, intent, taste, inquiryContext,
          [parsiFeedback, `\nSense feedback:`, fb].join("\n"),
        );
      }

      const redirectEvals = await evaluateVision(
        activeSensesForManifest, library, config,
        synthesis.vision, synthesis.senseContributions, synthesis.tensionResolutions,
      );
      const redirectConfidence = redirectEvals.length > 0
        ? redirectEvals.reduce((sum, e) => sum + e.confidence, 0) / redirectEvals.length
        : synthesis.confidence;

      future = {
        vision: synthesis.vision,
        senseContributions: synthesis.senseContributions,
        confidence: (redirectConfidence + synthesis.confidence) / 2,
        cycles: convergenceRound + redirectRound,
      };
    }
  }

  emit("planner:phase-a-complete", {
    confidence: future.confidence,
    visionLength: future.vision.length,
  });

  thalamus.setManifestedFuture(future.vision);

  // Checkpoint after vision approved — the most expensive interactive work is done
  await runner.checkpoint("post-manifestation", "post-manifestation", {
    manifestedFuture: future,
    inquiryContext,
    intentSummary: intent.summary,
    initialContext: { intent, taste },
  });

  return future;
}

// runSynthesis removed — replaced by manifestation synthesis loop (manifestSenses → synthesizeVision → evaluateVision)

// ─── Shael dispatch loop (extracted for resume support) ──────────

interface ShaelDispatchArgs {
  reviewedShaels: ShaelNode[];
  reviewedWiring: DependencyWiringResult;
  hierarchicalPlan: { manifestedFuture: ManifestedFuture; phases: import("../../types/planner.js").ProposedPhase[] };
  intent: ProjectIntent;
  taste: TasteProfile;
  planner: import("../../kernel/planner.js").Planner;
  runner: RhythmRunner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskDispatchDef: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sensoryCortexDef: any;
  config: CortexConfig;
  planningNE: number;
  maxims?: string[];
  capabilities?: string;
  initialCompletedShaelIds: Set<string>;
  initialCompletedTasks: string[];
  initialEscalatedTasks: string[];
  initialTaskResults: Map<string, OrchestratorResult>;
}

async function runShaelDispatchLoop(args: ShaelDispatchArgs): Promise<{
  allCompletedTasks: string[];
  allEscalatedTasks: string[];
  allTaskResults: Map<string, OrchestratorResult>;
}> {
  const {
    reviewedShaels, reviewedWiring, hierarchicalPlan,
    intent, taste, planner, runner, state, taskDispatchDef,
    config, planningNE, maxims, capabilities,
  } = args;

  const completedShaelIds = new Set(args.initialCompletedShaelIds);
  const allTaskResults = new Map(args.initialTaskResults);
  const allCompletedTasks = [...args.initialCompletedTasks];
  const allEscalatedTasks = [...args.initialEscalatedTasks];

  const jitThreshold = config.plannerConfig?.jitWiringThreshold ?? 5;
  const jitNEThreshold = config.plannerConfig?.jitWiringNEThreshold ?? 0.5;
  const graphBuilderModel = config.plannerConfig?.graphBuilderModel ?? config.models.motorCortex;

  let readyShaels = getReadyShaels(reviewedShaels, reviewedWiring, completedShaelIds);

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

    const shaelFuture: ManifestedFuture = {
      vision: `Shael: ${shael.description}\n\nGate condition: ${shael.gateCondition}`,
      senseContributions: hierarchicalPlan.manifestedFuture.senseContributions,
      confidence: hierarchicalPlan.manifestedFuture.confidence,
      cycles: 0,
    };

    const shaelPlanResult = await planner.reasonBackward(
      shaelFuture, intent, taste, maxims, capabilities, planningNE,
    );

    let shanaGraph = shaelPlanResult.graph;
    const shanaPhases = shaelPlanResult.phases;

    const shanaCount = shanaGraph.length;
    const shouldWire = shanaCount >= jitThreshold || planningNE >= jitNEThreshold;

    if (shouldWire && shanaCount > 0) {
      log.info("Running B.2 on shael shana", {
        shaelId: shael.id,
        shanaCount,
        ne: planningNE,
      });

      const leafLevel = getActiveWorldview()?.vocabulary.leafUnit.singular ?? "shana";
      const shanaNodes: ShaelNode[] = shanaGraph.map((node) => ({
        id: node.task.id,
        description: node.task.description,
        level: leafLevel,
        phaseGroup: node.phaseGroup ?? shael.phaseGroup,
        parentId: shael.id,
        gateCondition: "",
        necessity: String(node.task.context?.necessity ?? ""),
        formJustification: "",
        scopeJustification: "",
      }));

      const graphBuilder = planner.createGraphBuilder(graphBuilderModel);
      const shanaWiring = await graphBuilder.wire(shanaNodes, planningNE);

      shanaGraph = planner.buildGraphFromShana(shanaNodes, shanaWiring, shanaPhases);
    }

    const dispatchCtx: TaskDispatchContext = {
      intent,
      taste,
      graph: shanaGraph,
      phases: shanaPhases,
      shaelId: shael.id,
    };

    try {
      const result = await runner.run(taskDispatchDef, dispatchCtx, state.id) as TaskDispatchResult;

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

      // Checkpoint after each shael — resume picks up at the next shael
      await runner.checkpoint("post-shael", `post-shael ${shael.id}`, {
        manifestedFuture: hierarchicalPlan.manifestedFuture,
        reviewedShaels,
        reviewedWiring,
        hierarchicalPlan,
        planningNE,
        maxims,
        capabilities,
        completedShaelIds: [...completedShaelIds],
        allCompletedTasks,
        allEscalatedTasks,
        allTaskResults: Object.fromEntries(allTaskResults),
        intentSummary: intent.summary,
        initialContext: { intent, taste },
      });
    } catch (err) {
      if (err instanceof EscalationError) {
        log.warn("Shael escalated", {
          shaelId: shael.id,
          reason: err.decision.reason,
        });
        completedShaelIds.add(shael.id);
        allEscalatedTasks.push(shael.id);
      } else {
        throw err;
      }
    }

    readyShaels = getReadyShaels(reviewedShaels, reviewedWiring, completedShaelIds);
  }

  return { allCompletedTasks, allEscalatedTasks, allTaskResults };
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
        // ── Resume detection ─────────────────────────────────────
        // If the accumulator carries resume markers from a checkpoint,
        // skip to the right phase instead of redoing earlier work.
        const resumeKind = state.accumulator.__resumeKind as string | undefined;
        const resumeData = state.accumulator.__resumeData as Record<string, unknown> | undefined;

        if (resumeKind && resumeData) {
          log.info("Resuming project from checkpoint", { kind: resumeKind });

          const resumeIntent = (resumeData.initialContext as Record<string, unknown>)?.intent as ProjectIntent ?? intent;
          const resumeTaste = (resumeData.initialContext as Record<string, unknown>)?.taste as TasteProfile ?? taste;

          if (resumeKind === "post-inquiry") {
            // Inquiry done — run manifestation with saved context, then plan, then dispatch
            log.info("Resume: skipping inquiry, running manifestation");
            const inquiryCtx = resumeData.inquiryContext as string | undefined;
            const interaction2 = askUser ? { askUser, library, config } : undefined;
            const future = await runManifestation(thalamus, library, config, runner, resumeIntent, resumeTaste, interaction2, inquiryCtx);
            state.accumulator.__manifestedFuture = future;
            // Fall through to planning below by clearing resume markers
            delete state.accumulator.__resumeKind;
            delete state.accumulator.__resumeData;
            // Continue to planning (the code below this if-block)
          } else if (resumeKind === "post-manifestation") {
            // Manifestation done — restore future, run planning, then dispatch
            log.info("Resume: skipping manifestation, running planning");
            const future = resumeData.manifestedFuture as ManifestedFuture;
            thalamus.setManifestedFuture(future.vision);
            state.accumulator.__manifestedFuture = future;
            delete state.accumulator.__resumeKind;
            delete state.accumulator.__resumeData;
            // Fall through to planning below
          } else if (resumeKind === "post-plan" || resumeKind === "post-shael") {
            // Planning done (or mid-dispatch) — restore graph + dispatch
            log.info("Resume: skipping planning, running dispatch", { kind: resumeKind });
            const future = resumeData.manifestedFuture as ManifestedFuture;
            thalamus.setManifestedFuture(future.vision);
            state.accumulator.__manifestedFuture = future;

            const savedShaels = resumeData.reviewedShaels as ShaelNode[];
            const savedWiring = resumeData.reviewedWiring as DependencyWiringResult;
            const savedPlan = resumeData.hierarchicalPlan as { manifestedFuture: ManifestedFuture; phases: import("../../types/planner.js").ProposedPhase[] };
            const savedNE = resumeData.planningNE as number ?? computeNE({
              cerebellumAccuracy: hooks.getCerebellumAccuracy(),
              parsifalUrgency: mapUrgencyToNE(intent.urgency),
            }).ne;
            const savedMaxims = resumeData.maxims as string[] | undefined;
            const savedCapabilities = resumeData.capabilities as string | undefined;

            // Restore prior progress for post-shael resume
            const priorCompletedIds = new Set<string>(
              resumeKind === "post-shael" ? resumeData.completedShaelIds as string[] : [],
            );
            const priorCompletedTasks = resumeKind === "post-shael"
              ? resumeData.allCompletedTasks as string[] : [];
            const priorEscalatedTasks = resumeKind === "post-shael"
              ? resumeData.allEscalatedTasks as string[] : [];
            const priorTaskResults = resumeKind === "post-shael" && resumeData.allTaskResults
              ? new Map<string, OrchestratorResult>(Object.entries(resumeData.allTaskResults as Record<string, OrchestratorResult>))
              : new Map<string, OrchestratorResult>();

            log.info("Resume dispatch state", {
              totalShaels: savedShaels.length,
              priorCompleted: priorCompletedIds.size,
              remaining: savedShaels.length - priorCompletedIds.size,
            });

            const dispatchResult = await runShaelDispatchLoop({
              reviewedShaels: savedShaels,
              reviewedWiring: savedWiring,
              hierarchicalPlan: savedPlan,
              intent: resumeIntent,
              taste: resumeTaste,
              planner,
              runner,
              state,
              taskDispatchDef,
              sensoryCortexDef,
              config,
              planningNE: savedNE,
              maxims: savedMaxims,
              capabilities: savedCapabilities,
              initialCompletedShaelIds: priorCompletedIds,
              initialCompletedTasks: priorCompletedTasks,
              initialEscalatedTasks: priorEscalatedTasks,
              initialTaskResults: priorTaskResults,
            });

            return {
              completedTasks: dispatchResult.allCompletedTasks,
              escalatedTasks: dispatchResult.allEscalatedTasks,
              taskResults: dispatchResult.allTaskResults,
            };
          }
        }
        // ── End resume detection ──────────────────────────────────

        log.info("No tasks provided — running hierarchical planner");

        const interaction = askUser
          ? { askUser, library, config }
          : undefined;
        const future = await runManifestation(thalamus, library, config, runner, intent, taste, interaction);
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

        // Checkpoint after planning — full shael graph is built, ready for dispatch
        await runner.checkpoint("post-plan", "post-plan", {
          manifestedFuture: future,
          reviewedShaels,
          reviewedWiring,
          hierarchicalPlan: { manifestedFuture: future, phases: hierarchicalPlan.phases ?? [] },
          planningNE: planningNE.ne,
          maxims,
          capabilities,
          intentSummary: intent.summary,
          initialContext: { intent, taste },
        });

        // ── Shael dispatch loop ──────────────────────────────────
        const dispatchResult = await runShaelDispatchLoop({
          reviewedShaels,
          reviewedWiring,
          hierarchicalPlan: { manifestedFuture: future, phases: hierarchicalPlan.phases ?? [] },
          intent,
          taste,
          planner,
          runner,
          state,
          taskDispatchDef,
          sensoryCortexDef,
          config,
          planningNE: planningNE.ne,
          maxims,
          capabilities,
          // Fresh start — no prior progress
          initialCompletedShaelIds: new Set(),
          initialCompletedTasks: [],
          initialEscalatedTasks: [],
          initialTaskResults: new Map(),
        });
        const { allCompletedTasks, allEscalatedTasks, allTaskResults } = dispatchResult;

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
                  await runManifestation(thalamus, library, config, runner, intent, taste);
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
            await runManifestation(thalamus, library, config, runner, intent, taste);
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
