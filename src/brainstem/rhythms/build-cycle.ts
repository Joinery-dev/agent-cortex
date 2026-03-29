/**
 * Build-Cycle Rhythm — the innermost loop.
 *
 *   prepare:   assemble motor briefing (or revision context)
 *   execute:   motor cortex runs premotor → primary → proprioception
 *   integrate: evaluate work → weigh by stake → compute composite → detect tensions → oscillation check
 *   gate:      gate strategy (deliberative/democratic/expedient) decides accept/revise/escalate
 *
 * The Motor Cortex class handles the three-phase build internally.
 * The build-cycle orchestrates the evaluate→revise loop around it.
 */

import type { RhythmDefinition, RhythmState } from "../../types/rhythm.js";
import type { BuildCycleContext, BuildCycleResult } from "../../types/brainstem.js";
import type { SenseEvaluation } from "../../types/sense.js";
import type { Tension, TensionResolution, ResolutionOutcome } from "../../types/tension.js";
import type { CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { MotorBriefing } from "../../types/thalamus.js";
import type { MotorPlan, SelfAssessment, RevisionContext, AgenticMotorResult, BuildQuestion, BuildAnswer, QuestionHandler } from "../../types/motor-cortex.js";
import type { Intention } from "../../types/pns.js";
import type { Sandbox } from "../../kernel/sandbox.js";
import { createSandbox, acceptSandbox, discardSandbox, getSandboxDiff, getSandboxChangedFiles, readSandboxFile } from "../../kernel/sandbox.js";
import type { Gate, GateInput, SignalLandscape } from "../../types/gate.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { WeightedEvaluation, WeightedComposite, StakeAdjuster } from "../../kernel/evaluation-weighter.js";
import type { OscillationSignal } from "../../types/working-memory.js";
import { evaluate } from "../../kernel/evaluator.js";
import type { EvaluationContext, EvaluationOutcome } from "../../kernel/evaluator.js";
import type { RuntimeInstance } from "../../types/runtime.js";
import { startAllRuntimes, stopAllRuntimes } from "../../kernel/runtime-manager.js";
import { captureVisuals, buildCaptureConfig } from "../../kernel/visual-capture.js";
import { detectTensions, resolve } from "../../kernel/resolver.js";
import { weighEvaluations, computeComposite } from "../../kernel/evaluation-weighter.js";
import { revisionPrompt } from "../../llm/prompts.js";
import { addEvent } from "../../types/task.js";
import { emit, emitInfo, emitWarn } from "../../events.js";
import { createLogger } from "../../util/logger.js";
import { estimateCallCost } from "../../types/cost.js";
import { getContentStore, contentBlock } from "../../trace/content-store.js";

const log = createLogger("build-cycle");
import type { SubcorticalHooks } from "../stubs.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { BasalGanglia } from "../../kernel/basal-ganglia.js";
import type { CollapseContext } from "../../types/basal-ganglia.js";
import type { CollapseSignal } from "../../types/collapse.js";
import { computeResolutionOutcomes } from "../../kernel/resolution-quality.js";
import type { ConvictionResult, ConvictionShaping } from "../../types/conviction.js";
import { runConvictionLoop, modulateThresholds, DEFAULT_CONVICTION_THRESHOLDS } from "../../kernel/conviction.js";
import { computeNE, mapUrgencyToNE } from "../../kernel/norepinephrine.js";
import type { RiskFactors } from "../../types/norepinephrine.js";
import { extractRiskFromGestalt } from "./sensory-cortex.js";
import type { CognitiveFlexibility } from "../../kernel/cognitive-flexibility.js";
import type { FlexibilityAssessment, ResetDirective, ApproachHistoryEntry } from "../../types/cognitive-flexibility.js";
import type { PeripheralNervousSystem, NeurotransmitterSignals } from "../../kernel/pns.js";
import type { Perception } from "../../types/pns.js";
import type { Amygdala } from "../../subcortical/amygdala.js";
import type { Consultation } from "../../types/consultation.js";
import { askSense } from "../../kernel/sense-questioner.js";

// ─── Intermediate types for the four phases ─────────────────────

interface PreparedBuild {
  motorBriefing: MotorBriefing;
  isRevision: boolean;
  revision?: RevisionContext;
  /** Present when Cognitive Flexibility forced a strategy reset. */
  resetDirective?: ResetDirective;
}

interface ExecutedBuild {
  work: string;
  plan: MotorPlan;
  selfAssessment?: SelfAssessment;
  intentions: Intention[];
  /** PNS perceptions from executing intentions (empty when PNS absent or no operations). */
  perceptions: Perception[];
  /** Full agentic result when Motor Cortex ran with real tools. */
  agenticResult?: AgenticMotorResult;
  /** Git sandbox for this task (present when agentic mode is active). */
  sandbox?: Sandbox;
  /** Files changed in the sandbox relative to base branch. */
  changedFiles?: string[];
}

interface IntegratedBuild {
  work: string;
  plan: MotorPlan;
  selfAssessment?: SelfAssessment;
  intentions: Intention[];
  evaluations: SenseEvaluation[];
  weighted: WeightedEvaluation[];
  composite: WeightedComposite;
  tensions: Tension[];
  oscillations: OscillationSignal[];
}

// ─── Accumulator shape ──────────────────────────────────────────

interface BuildCycleAccumulator {
  /** Raw evaluations from the latest cycle (for collapse detection + motor revision). */
  lastEvaluations: SenseEvaluation[];
  /** Weighted evaluations from the latest cycle (for gate + revision prompt). */
  lastWeighted: WeightedEvaluation[];
  /** All tensions across all cycles. */
  allTensions: Tension[];
  /** All resolutions across all cycles. */
  allResolutions: TensionResolution[];
  /** The latest produced work. */
  lastWork: string | null;
  /** The latest premotor plan — for revision cycles. */
  lastPlan: MotorPlan | null;
  /** The motor briefing from the first cycle — reused in revisions. */
  motorBriefing: MotorBriefing | null;
  /** Previous conviction result — for delta tracking across cycles. */
  previousConviction: ConvictionResult | null;
  /** Conviction shaping notes — available for next cycle's prepare phase. */
  convictionShaping: ConvictionShaping | null;
  /** Approaches tried within this task (for Cognitive Flexibility). */
  approachHistory: ApproachHistoryEntry[];
  /** Signals prepare phase to re-plan from scratch instead of revise. */
  resetPending: boolean;
  /** Instructions for the premotor when re-planning. */
  resetDirective: ResetDirective | null;
  /** Latest flexibility assessment (for debugging/events). */
  flexibilityAssessment: FlexibilityAssessment | null;
  /** Effective NE from the latest gate computation. Read by next cycle's prepare + execute. */
  effectiveNE: number | null;
  /** Set by amygdala pre-action gate on emergency. Read by gate phase NE computation. */
  amygdalaOverride?: boolean;
  /** Set when sandbox creation fails. Informs integrate phase that evaluators are blind. */
  sandboxFailed?: boolean;
  /** Set when approach classification fails. Feeds conviction as undermining evidence. */
  approachClassificationFailed?: boolean;
  /** Count of degraded evaluations from the latest cycle. Feeds conviction + homeostasis. */
  lastDegradedCount?: number;
  /** Evaluation integrity (0–1) from the latest cycle. Feeds conviction circuit breaker. */
  lastEvaluationIntegrity?: number;
  /** Proprioception confidence from the latest cycle. Feeds conviction as reliability signal. */
  lastProprioceptionConfidence?: number;
  /** Git sandbox for the current task (created on first cycle). */
  sandbox: Sandbox | null;
  /** Running runtime instances (started before evaluation, stopped after). */
  runtimeInstances: RuntimeInstance[] | null;
  // ── Resolution Rework (#13) ──
  /** Weighted evaluations from the cycle that triggered resolution (the "before" snapshot). */
  priorWeighted: WeightedEvaluation[] | null;
  /** Collapse signal from the most recent gate phase (for correlating with quality). */
  lastCollapseSignal: CollapseSignal | null;
  /** Resolution outcomes measured across all cycles. */
  resolutionOutcomes: ResolutionOutcome[];
}

function getAcc(
  state: RhythmState<BuildCycleContext, BuildCycleResult>,
): BuildCycleAccumulator {
  return (state.accumulator as unknown as { __bc: BuildCycleAccumulator }).__bc ??= {
    lastEvaluations: [],
    lastWeighted: [],
    allTensions: [],
    allResolutions: [],
    lastWork: null,
    lastPlan: null,
    motorBriefing: null,
    previousConviction: null,
    convictionShaping: null,
    approachHistory: [],
    resetPending: false,
    resetDirective: null,
    flexibilityAssessment: null,
    effectiveNE: null,
    sandbox: null,
    runtimeInstances: null,
    priorWeighted: null,
    lastCollapseSignal: null,
    resolutionOutcomes: [],
  };
}

// ─── Question handler factory ───────────────────────────────────
// Creates the QuestionHandler callback that the Motor Cortex invokes
// when it hits ambiguity mid-build. Routes through the Thalamus:
// dimension match → highest-stake sense → user escalation.

function createQuestionHandler(
  thalamus: Thalamus,
  library: SensoryCortex,
  config: CortexConfig,
  consultation: Consultation,
  buildProgress?: string,
): QuestionHandler {
  return async (question: BuildQuestion): Promise<BuildAnswer> => {
    const routing = thalamus.routeBuildQuestion(question, consultation);

    if (routing.route === "sense" && routing.targetSenseId) {
      const sense = library.get(routing.targetSenseId);
      if (sense) {
        const briefing = thalamus.forSenseQuestion(
          question, routing, consultation, buildProgress,
        );
        return askSense(briefing, sense, config.models.consultation);
      }
      log.warn("Routed to sense but sense not found in library", {
        questionId: question.id,
        targetSenseId: routing.targetSenseId,
      });
    }

    // Fallback: no sense could answer — return low-confidence answer.
    // The Motor Cortex treats low-confidence answers as unresolved
    // and proceeds with its own judgment.
    log.info("Build question routed to user — no sense handler, returning low-confidence default", {
      questionId: question.id,
      rationale: routing.rationale,
    });
    return {
      questionId: question.id,
      source: { type: "user" },
      answer: "No sense could answer this question with sufficient confidence.",
      confidence: 0,
      rationale: routing.rationale,
    };
  };
}

// ─── Definition factory ─────────────────────────────────────────

export function createBuildCycleDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  wm: WorkingMemory,
  thalamus: Thalamus,
  motorCortex: MotorCortex,
  basalGanglia: BasalGanglia,
  gate: Gate,
  cognitiveFlexibility: CognitiveFlexibility,
  stakeAdjuster?: StakeAdjuster,
  pns?: PeripheralNervousSystem,
  amygdala?: Amygdala,
): RhythmDefinition<BuildCycleContext, BuildCycleResult, PreparedBuild, ExecutedBuild, IntegratedBuild> {
  return {
    name: "build-cycle",
    maxCycles: config.maxCycles,

    // ── Prepare: assemble motor briefing ──────────────────
    async prepare(context, state) {
      const acc = getAcc(state);

      // Strategy reset: Cognitive Flexibility forced a re-plan
      if (acc.resetPending) {
        const motorBriefing = thalamus.forMotorFromGestalt(context.task.id, context.consultation);
        acc.motorBriefing = motorBriefing;
        acc.resetPending = false;

        context.task.status = "producing";
        addEvent(context.task, "status_change", {
          status: "producing",
          cycle: state.completedCycles + 1,
          strategyReset: true,
        });

        return {
          motorBriefing,
          isRevision: false,
          resetDirective: acc.resetDirective ?? undefined,
        };
      }

      if (state.completedCycles === 0) {
        // First cycle: derive motor briefing from the task's gestalt
        const motorBriefing = thalamus.forMotorFromGestalt(context.task.id, context.consultation);
        acc.motorBriefing = motorBriefing;

        // Outer cycle 2+: the sensory cortex already built something and re-consulted.
        // Seed the accumulator with the previous work so the motor cortex can revise.
        if (context.previousWork && context.outerCycle && context.outerCycle > 1) {
          acc.lastWork = context.previousWork;
        }

        context.task.status = "producing";
        addEvent(context.task, "status_change", {
          status: "producing",
          cycle: 1,
          outerCycle: context.outerCycle,
        });

        return { motorBriefing, isRevision: false };
      }

      // Revision cycle: pass revision context to premotor
      context.task.status = "producing";
      addEvent(context.task, "status_change", {
        status: "producing",
        cycle: state.completedCycles + 1,
      });

      return {
        motorBriefing: acc.motorBriefing!,
        isRevision: true,
        revision: {
          previousPlan: acc.lastPlan!,
          evaluations: acc.lastEvaluations,
          resolutions: acc.allResolutions.slice(-acc.lastEvaluations.length),
        },
      };
    },

    // ── Execute: run motor cortex (premotor → primary → proprioception) ──
    async execute(prepared, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;

      emit("cycle:start", { cycle, maxCycles: config.maxCycles });

      // Low NE → skip proprioception (routine task, trust yourself).
      // Cycle 1: reads dispatch-enriched NE from context.
      // Cycle 2+: reads effective NE from previous gate computation.
      const currentNE = acc.effectiveNE ?? state.initialContext.neLevel ?? 0.5;
      const enableProprioception = currentNE >= 0.3;

      // ── Sandbox: create git branch for task isolation (first cycle only) ──
      if (!acc.sandbox && pns) {
        try {
          acc.sandbox = await createSandbox(state.initialContext.task.id, process.cwd());
        } catch (err) {
          log.warn("Sandbox creation failed, falling back to non-sandboxed execution", {
            error: String(err),
          });
          acc.sandboxFailed = true;
        }
      }

      // Wire the mid-build question handler: Motor Cortex can ask senses
      // (or the user) clarifying questions when it hits ambiguity.
      const questionHandler = createQuestionHandler(
        thalamus, library, config,
        state.initialContext.consultation,
        acc.lastWork ?? undefined,
      );

      const result = await motorCortex.execute(prepared.motorBriefing, {
        enableProprioception,
        revision: prepared.revision,
        previousWork: acc.lastWork ?? undefined,
        resetDirective: prepared.resetDirective,
        neLevel: currentNE,
        signal: state.signal,
        questionHandler,
      });

      addEvent(state.initialContext.task, "work_produced", {
        cycle,
        length: result.work.length,
        planConfidence: result.plan.confidence,
        proprioceptionConfidence: result.selfAssessment?.confidence,
      });

      acc.lastWork = result.work;
      acc.lastPlan = result.plan;
      acc.lastProprioceptionConfidence = result.selfAssessment?.confidence;

      // Track approach for Cognitive Flexibility history
      if (result.plan?.approach) {
        // On reset or first cycle, record a new approach entry
        const isNewApproach = acc.approachHistory.length === 0 ||
          acc.approachHistory[acc.approachHistory.length - 1].approach !== result.plan.approach;
        if (isNewApproach) {
          acc.approachHistory.push({ approach: result.plan.approach, bestComposite: 0 });
        }
      }

      // V2: classify approach on first cycle (approach is set once, revisions don't change it)
      if (cycle === 1 && result.plan?.approach) {
        hooks.classifyApproach(
          state.initialContext.task.id,
          state.initialContext.task.description,
          result.plan.approach,
          config.models.consultation,
        ).catch((err) => {
          // Non-blocking for the build, but feeds conviction as undermining evidence
          log.warn("Approach classification failed", { error: String(err) });
          acc.approachClassificationFailed = true;
        });
      }

      // ── Amygdala pre-action gate: scan intentions before PNS execution ──
      // Fast synchronous scan — pattern matching, not deep analysis.
      // Blocked intentions are filtered out. Emergency → hard interrupt.
      let safeIntentions = result.intentions;
      if (amygdala && result.intentions.length > 0) {
        const urgencyThreshold = 0.8; // Default; read from plasticity when wired
        const threat = amygdala.scanIntentions(result.intentions, urgencyThreshold);
        if (threat) {
          const blocked = new Set(threat.blockedIntentionIds);
          safeIntentions = result.intentions.filter((i) => !blocked.has(i.id));

          if (threat.effectiveSeverity === "emergency") {
            // Full response protocol — hard interrupt, NE override, escalate
            amygdala.executeResponse(threat, {
              runner: {
                interrupt: (rhythmId, interrupt) => {
                  // The rhythm will abort at the next checkAbort() call
                  emit("rhythm:interrupt", {
                    rhythmId,
                    source: "amygdala",
                    mode: interrupt.mode,
                    reason: interrupt.mode === "hard" ? (interrupt as { reason: string }).reason : "",
                  });
                },
              },
              wm,
              activeRhythmIds: [state.id],
            });
            // Store override flag for NE computation at gate phase
            acc.amygdalaOverride = true;
          }
        }
      }

      // ── PNS execution: run intentions through the peripheral nervous system ──
      // In agentic mode, the Agent SDK handles tool execution internally —
      // skip the PNS execute loop. In legacy mode, PNS executes as before.
      const perceptions: Perception[] = [];
      if (!result.agenticResult && pns && safeIntentions.length > 0) {
        const gestalt = thalamus.getGestalt(state.initialContext.task.id);
        const ntSignals: NeurotransmitterSignals = {
          norepinephrine: currentNE,
          predictionConfidence: gestalt?.prediction?.overallConfidence,
        };

        for (const intention of safeIntentions) {
          // ── Proprioception gate: should we pause and self-check? ──
          // When checkpoint fires, run a lightweight proprioception on
          // work produced so far. This is the micro-rhythm within execute:
          // the system looks at itself before continuing.
          if (pns.shouldCheckpoint(intention, ntSignals)) {
            const checkpointReason = intention.checkpoint ? "explicit" : "neurotransmitter";
            emit("pns:checkpoint", {
              taskId: state.initialContext.task.id,
              intentionId: intention.id,
              norepinephrine: ntSignals.norepinephrine,
              predictionConfidence: ntSignals.predictionConfidence,
              reason: checkpointReason,
            });

            // Run mid-build proprioception if we have work + a plan to check against
            if (acc.lastWork && acc.lastPlan) {
              const midBuildAssessment = await motorCortex.execute(prepared.motorBriefing, {
                enableProprioception: true,
                previousWork: acc.lastWork,
                neLevel: currentNE,
              });
              // Feed proprioception findings back — next cycle's premotor
              // will see drift areas and uncertainties via revision context.
              if (midBuildAssessment.selfAssessment) {
                emit("pns:checkpoint-proprioception", {
                  taskId: state.initialContext.task.id,
                  intentionId: intention.id,
                  planAdherence: midBuildAssessment.selfAssessment.planAdherence,
                  driftAreas: midBuildAssessment.selfAssessment.driftAreas.length,
                  confidence: midBuildAssessment.selfAssessment.confidence,
                });

                // If significant drift detected, update accumulator so
                // the gate phase sees it in the next cycle's revision context
                const significantDrift = midBuildAssessment.selfAssessment.driftAreas
                  .filter((d) => d.severity === "significant");
                if (significantDrift.length > 0) {
                  log.info("Mid-build checkpoint detected significant drift", {
                    taskId: state.initialContext.task.id,
                    driftAreas: significantDrift.length,
                    planAdherence: midBuildAssessment.selfAssessment.planAdherence,
                  });
                }
              }
            }
          }

          const perception = await pns.execute(intention, ntSignals, state.signal);
          perceptions.push(perception);
        }
      }

      // ── Sandbox inspection: capture what the agentic build changed ──
      let changedFiles: string[] | undefined;
      if (acc.sandbox && result.agenticResult) {
        try {
          changedFiles = await getSandboxChangedFiles(acc.sandbox);
        } catch (err) {
          log.warn("Failed to inspect sandbox changes", { error: String(err) });
        }
      }

      return {
        work: result.work,
        plan: result.plan,
        selfAssessment: result.selfAssessment,
        intentions: result.intentions,
        perceptions,
        agenticResult: result.agenticResult,
        sandbox: acc.sandbox ?? undefined,
        changedFiles,
      };
    },

    // ── Integrate: evaluate → weigh → composite → tensions → oscillation ──
    async integrate(executed, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      ctx.task.status = "evaluating";
      addEvent(ctx.task, "status_change", { status: "evaluating", cycle });

      // ── Assemble evaluation context from sandbox (agentic mode) ──
      let evalContext: EvaluationContext | undefined;
      if (executed.sandbox && executed.agenticResult) {
        try {
          const diff = await getSandboxDiff(executed.sandbox);
          const fileContents = new Map<string, string>();
          for (const f of (executed.changedFiles ?? []).slice(0, 10)) {
            const content = await readSandboxFile(executed.sandbox, f);
            if (content) fileContents.set(f, content);
          }
          evalContext = {
            diff,
            changedFiles: executed.changedFiles,
            fileContents,
            toolTrace: executed.agenticResult.toolTrace,
            sandboxCwd: executed.sandbox.cwd,
          };
        } catch (err) {
          log.warn("Failed to assemble evaluation context from sandbox", { error: String(err) });
        }
      }

      // Build agentic evaluation opts when PNS is available
      const currentNE = acc.effectiveNE ?? state.initialContext.neLevel ?? 0.5;
      const agenticEvalOpts = pns ? { pns, neLevel: currentNE } : undefined;

      // ── Runtime: start dev server for perceptual evaluation ──
      // Only when configured, NE warrants it, and PNS is available.
      const runtimeConfigs = state.initialContext.intent.runtime;
      if (runtimeConfigs && runtimeConfigs.length > 0 && currentNE > 0.5 && pns) {
        try {
          const instances = await startAllRuntimes(
            runtimeConfigs,
            executed.sandbox?.cwd ?? process.cwd(),
          );
          acc.runtimeInstances = instances;

          // Inject runtime URL into evaluation context
          const readyInstance = instances.find((r) => r.ready);
          if (readyInstance) {
            if (!evalContext) evalContext = {};
            evalContext.runtimeUrl = readyInstance.url;
          }
        } catch (err) {
          log.warn("Runtime start failed, evaluating without runtime", { error: String(err) });
        }
      }

      // ── Visual Capture: screenshot + Web Vitals from running instance ──
      if (evalContext?.runtimeUrl) {
        try {
          const captureConfig = buildCaptureConfig(currentNE);
          const visualResult = await captureVisuals(evalContext.runtimeUrl, captureConfig);
          evalContext.visualCaptures = visualResult;
          if (!visualResult.degraded) {
            log.info("Visual captures attached to evaluation context", {
              captures: visualResult.captures.length,
              vitals: visualResult.webVitals.length,
            });
          }
        } catch (err) {
          log.warn("Visual capture failed, evaluating without screenshots", { error: String(err) });
        }
      }

      // 1. Raw evaluation (each receptor evaluates independently)
      const evalOutcome: EvaluationOutcome = await evaluate(
        ctx.consultation,
        ctx.task,
        executed.work,
        library,
        config,
        thalamus,
        evalContext,
        agenticEvalOpts,
      );
      const { evaluations, degradedCount, skippedSenses } = evalOutcome;

      // ── Runtime: stop after evaluation ──
      if (acc.runtimeInstances) {
        try {
          await stopAllRuntimes(acc.runtimeInstances);
        } catch (err) {
          log.warn("Runtime stop failed", { error: String(err) });
        }
        acc.runtimeInstances = null;
      }

      acc.lastEvaluations = evaluations;
      acc.lastDegradedCount = degradedCount;

      // ── Evaluation integrity signal → self-healing loop ──
      // When too many senses skipped or degraded, emit a warning that feeds
      // homeostasis diagnostic load (which triggers spike-ne or rest reflexes).
      const totalSenses = evaluations.length + skippedSenses.length;
      const normalEvals = evaluations.filter((e) => !e.degraded).length;
      const integrity = totalSenses > 0 ? normalEvals / totalSenses : 1.0;
      acc.lastEvaluationIntegrity = integrity;
      if (integrity < 0.7) {
        emitWarn(
          "evaluation:low-integrity",
          {
            taskId: ctx.task.id,
            cycle,
            integrity,
            normalEvals,
            degradedCount,
            skippedCount: skippedSenses.length,
            totalSenses,
            sandboxFailed: !!acc.sandboxFailed,
          },
          {
            component: "build-cycle",
            expected: "≥70% of senses producing genuine evaluations",
            received: `${(integrity * 100).toFixed(0)}% integrity (${normalEvals}/${totalSenses} genuine)`,
          },
        );
      }

      addEvent(ctx.task, "evaluation", {
        cycle,
        scores: evaluations.map((e) => ({
          path: e.activationPath.join(" > "),
          score: e.score,
          acceptable: e.acceptable,
          degraded: !!e.degraded,
        })),
        degradedCount,
        skippedCount: skippedSenses.length,
      });

      // 2. Weigh evaluations by stake from consultation
      const weighted = weighEvaluations(evaluations, ctx.consultation, stakeAdjuster);
      acc.lastWeighted = weighted;

      // 3. Compute weighted composite
      const composite = computeComposite(weighted);

      // Update approach history with best composite
      if (acc.approachHistory.length > 0) {
        const latest = acc.approachHistory[acc.approachHistory.length - 1];
        latest.bestComposite = Math.max(latest.bestComposite, composite.weightedMean);
      }

      // 4. Stake-aware tension detection
      const tensions = detectTensions(weighted, ctx.task.id);
      acc.allTensions = [...acc.allTensions, ...tensions];

      emit("tension:detection-complete", {
        count: tensions.length,
        tensions: tensions.map((t) => ({
          severity: t.severity,
          senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score, stake: t.senseA.stake },
          senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score, stake: t.senseB.stake },
        })),
      });

      if (tensions.length > 0) {
        addEvent(ctx.task, "tension_detected", {
          cycle,
          tensions: tensions.map((t) => ({
            description: t.description,
            severity: t.severity,
          })),
        });
      }

      // 4b. Resolution Rework: measure quality of prior cycle's resolutions
      if (acc.priorWeighted) {
        // Resolved tensions = those with a resolution attached (from prior gate phase)
        const resolvedTensions = acc.allTensions.filter((t) => t.resolution);
        const outcomes = computeResolutionOutcomes(
          resolvedTensions,
          acc.priorWeighted,
          weighted,
          acc.lastCollapseSignal,
        );
        acc.resolutionOutcomes = [...acc.resolutionOutcomes, ...outcomes];
        acc.priorWeighted = null; // consumed
        acc.lastCollapseSignal = null;
      }

      // 5. Record weighted scores in WM
      wm.recordScores(ctx.task.id, weighted);

      // 6. Check for score oscillation
      const oscillations = wm.detectOscillations(ctx.task.id);

      // 7. Subcortical hooks (no-op for now)
      await hooks.recordBuildOutcome(ctx, {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        tensions,
        resolutions: [],
        cycles: cycle,
        accepted: composite.weightedAcceptability > 0.5,
        confidence: composite.confidence,
      });

      return {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        weighted,
        composite,
        tensions,
        oscillations,
      };
    },

    // ── Gate: conviction loop → gate strategy → accept/revise/escalate ──
    async gate(integrated, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      // ── Conviction loop (runs BEFORE gate strategy) ──────────
      // Conviction reads previous cycle's effective NE (sequential, not circular).
      // Cycle 1: reads dispatch-enriched NE. Cycle 2+: reads from accumulator.
      const convictionNE = acc.effectiveNE ?? ctx.neLevel;

      // Pipeline boundary: conviction inputs completeness
      if (!acc.motorBriefing?.enrichment.speedOfLight) {
        emitWarn("pipeline:conviction-missing-input", { taskId: ctx.task.id, cycle }, {
          component: "build-cycle",
          expected: "speedOfLight",
        });
      }
      if (convictionNE === undefined) {
        emitWarn("pipeline:conviction-missing-input", { taskId: ctx.task.id, cycle }, {
          component: "build-cycle",
          expected: "neLevel",
        });
      }

      const convictionCtx = {
        level: "build-cycle" as const,
        cycle,
        composite: integrated.composite,
        oscillations: integrated.oscillations,
        speedOfLight: acc.motorBriefing?.enrichment.speedOfLight,
        worldModelMaxims: acc.motorBriefing?.enrichment.worldModelMaxims,
        neLevel: convictionNE,
        previousConviction: acc.previousConviction ?? undefined,
        // Reliability signals — route failures into the conviction loop
        degradedEvaluationCount: acc.lastDegradedCount ?? 0,
        approachClassificationFailed: acc.approachClassificationFailed ?? false,
        evaluationIntegrity: acc.lastEvaluationIntegrity,
        proprioceptionConfidence: acc.lastProprioceptionConfidence,
        budgetProximity: ctx.budgetProximity,
      };

      const conviction = runConvictionLoop(
        convictionCtx,
        modulateThresholds(DEFAULT_CONVICTION_THRESHOLDS, convictionNE),
      );
      acc.previousConviction = conviction;
      acc.convictionShaping = conviction.shaping;

      emit("conviction:result", {
        level: "build-cycle",
        cycle,
        verdict: conviction.verdict,
        convictionLevel: conviction.level,
        delta: conviction.delta,
        decidingStep: conviction.decidingStep,
        evidenceCount: conviction.evidence.length,
      });

      const evidenceText = conviction.evidence
        .map((e) => `[${e.source}] ${e.description} (${e.valence}, magnitude=${e.magnitude.toFixed(2)})`)
        .join("\n");
      const shapingText = conviction.shaping.notes.length > 0
        ? conviction.shaping.notes.join("\n")
        : "(no shaping notes)";
      getContentStore().record({
        eventSeq: null, kind: "conviction", timestamp: new Date().toISOString(),
        component: "conviction", taskId: ctx.task.id,
        inputs: [
          contentBlock("Composite score", `${integrated.composite.weightedMean.toFixed(1)}/10 (confidence: ${integrated.composite.confidence.toFixed(2)})`),
          contentBlock("Cycle", `${cycle}`),
        ],
        outputs: [
          contentBlock(`Verdict: ${conviction.verdict}`, `Level: ${conviction.level.toFixed(3)}, delta: ${conviction.delta.toFixed(3)}, deciding step: ${conviction.decidingStep}`),
          contentBlock("Evidence", evidenceText),
          contentBlock("Shaping", shapingText),
          ...(conviction.shaping.reshapeGuidance ? [contentBlock("Reshape guidance", conviction.shaping.reshapeGuidance)] : []),
          ...(conviction.shaping.escalationReason ? [contentBlock("Escalation reason", conviction.shaping.escalationReason)] : []),
        ],
        routing: { destinations: ["gate (conviction level)", "NE (conviction folds into arousal)", "thalamus (specification artistry)"] },
      });

      // Conviction escalate → short-circuit before gate strategy
      if (conviction.verdict === "escalate") {
        return {
          action: "escalate" as const,
          severity: "high" as const,
          reason: conviction.shaping.escalationReason ?? "Conviction too low to continue",
          context: { conviction },
        };
      }

      // ── Cognitive Flexibility (runs on reshape) ────────────
      if (conviction.verdict === "reshape") {
        try {
          const assessment = await cognitiveFlexibility.assess({
            conviction,
            previousConviction: acc.previousConviction,
            composite: integrated.composite,
            tensions: integrated.tensions,
            oscillations: integrated.oscillations,
            cycle,
            approachHistory: acc.approachHistory,
            speedOfLight: acc.motorBriefing?.enrichment.speedOfLight ?? null,
            worldModelMaxims: acc.motorBriefing?.enrichment.worldModelMaxims ?? [],
            task: ctx.task,
          });

          acc.flexibilityAssessment = assessment;

          emit("flexibility:assessment", {
            taskId: ctx.task.id,
            cycle,
            diagnosis: assessment.diagnosis,
            shouldReset: assessment.shouldReset,
            shouldEscalate: assessment.shouldEscalate,
          });

          if (assessment.shouldEscalate) {
            return {
              action: "escalate" as const,
              severity: "high" as const,
              reason: assessment.escalationContext ?? assessment.reasoning,
              context: { conviction, flexibility: assessment },
            };
          }

          if (assessment.shouldReset) {
            // Discard sandbox + stop runtimes on strategy reset — fresh start
            if (acc.runtimeInstances) {
              await stopAllRuntimes(acc.runtimeInstances).catch(() => {});
              acc.runtimeInstances = null;
            }
            if (acc.sandbox) {
              try {
                await discardSandbox(acc.sandbox);
                log.info("Sandbox discarded for strategy reset", { branch: acc.sandbox.branchName });
              } catch (err) {
                log.warn("Sandbox discard failed on reset", { error: String(err) });
              }
              acc.sandbox = null;
            }

            acc.resetPending = true;
            acc.resetDirective = assessment.resetDirective ?? null;
            return {
              action: "continue" as const,
              reason: `STRATEGY RESET: ${assessment.reasoning}`,
            };
          }

          // Diagnosis is "execution-problem" → fall through to normal gate
        } catch (err) {
          log.warn("Cognitive Flexibility failed — falling through to normal gate", {
            error: String(err),
          });
        }
      }

      // ── Recompute NE with conviction (conviction folds into NE) ──
      // Use frozen risk from dispatch — consistent across all three NE stages.
      const gestalt = thalamus.getGestalt(ctx.task.id);
      const gateRisk = ctx.riskSnapshot ?? extractRiskFromGestalt(gestalt);

      const effectiveNEResult = computeNE({
        cerebellumAccuracy: hooks.getCerebellumAccuracy(),
        bestSimilarity: gestalt?.prediction?.bestSimilarity,
        convictionLevel: conviction.level,
        risk: gateRisk,
        amygdalaOverride: acc.amygdalaOverride,
        humanUrgency: mapUrgencyToNE(ctx.intent?.urgency),
      });
      acc.effectiveNE = effectiveNEResult.ne;

      emit("ne:recomputed", {
        taskId: ctx.task.id,
        cycle,
        effectiveNE: effectiveNEResult.ne,
        convictionLevel: conviction.level,
        components: effectiveNEResult.components,
      });

      // Estimate the cost of another build cycle from configured model pricing.
      // A cycle is roughly: 1 motor call (~2K in, ~4K out) + N eval calls (~1K in, ~0.5K out each).
      // N is the number of active evaluators from the latest composite. Cold-start heuristic;
      // once the Cerebellum has episode data with cost metadata, this gets replaced by learned predictions.
      const evalCount = Math.max(1, integrated.composite.evaluations.length);
      const motorModel = config.models.motorCortex;
      const evalModel = config.models.evaluation;
      const cycleCostEstimate =
        estimateCallCost(motorModel, 2000, 4000) +
        evalCount * estimateCallCost(evalModel, 1000, 500);

      // Assemble signal landscape (effective NE + conviction + override signals)
      const signals: SignalLandscape = {
        ne: effectiveNEResult.ne,
        conviction: conviction.level,
        // Basal ganglia routine confidence — if a routine fired for this task,
        // the gate can use this to adjust acceptance thresholds.
        routineConfidence: undefined, // Populated by selectAction when available
        // Amygdala urgency — forces deliberative gate strategy
        urgency: acc.amygdalaOverride ?? undefined,
        // Cerebellum prediction accuracy — low accuracy shifts gate toward deliberative
        predictionAccuracy: gestalt?.prediction
          ? hooks.getCerebellumAccuracy()
          : undefined,
        // Cost budget signals — from BuildCycleContext, populated by sensory-cortex
        taskBudgetRemaining: ctx.taskBudgetRemaining,
        estimatedCycleCost: cycleCostEstimate,
        projectBudgetUtilization: ctx.projectBudgetUtilization,
      };

      // Assemble gate input
      const gateInput: GateInput = {
        composite: integrated.composite,
        tensions: integrated.tensions,
        cycle,
        signals,
      };

      // Run gate strategy
      const gateOutput = gate.evaluate(gateInput);

      // ── Gate diagnostic: full cycle journey ──────────────────
      emitInfo("gate:decision", {
        level: "build-cycle",
        taskId: ctx.task.id,
        cycle,
        accept: gateOutput.accept,
        strategy: gateOutput.strategy,
        reason: gateOutput.reason,
        convictionVerdict: conviction.verdict,
        convictionLevel: conviction.level,
        effectiveNE: effectiveNEResult.ne,
        weightedMean: integrated.composite.weightedMean,
        weightedAcceptability: integrated.composite.weightedAcceptability,
        tensionCount: integrated.tensions.length,
        oscillationCount: integrated.oscillations.length,
        flexibilityAssessment: acc.flexibilityAssessment?.diagnosis ?? null,
      });

      if (gateOutput.accept) {
        // ── Cleanup: merge sandbox, stop any lingering runtimes ──
        if (acc.runtimeInstances) {
          await stopAllRuntimes(acc.runtimeInstances).catch(() => {});
          acc.runtimeInstances = null;
        }
        if (acc.sandbox) {
          try {
            await acceptSandbox(acc.sandbox);
            log.info("Sandbox merged on acceptance", { branch: acc.sandbox.branchName });
          } catch (err) {
            log.warn("Sandbox merge failed", { error: String(err) });
          }
          acc.sandbox = null;
        }

        return {
          action: "complete",
          result: {
            work: integrated.work,
            plan: integrated.plan,
            selfAssessment: integrated.selfAssessment,
            intentions: integrated.intentions,
            evaluations: integrated.evaluations,
            tensions: acc.allTensions,
            resolutions: acc.allResolutions,
            resolutionOutcomes: acc.resolutionOutcomes.length > 0 ? acc.resolutionOutcomes : undefined,
            cycles: cycle,
            accepted: true,
            confidence: integrated.composite.confidence,
          },
        };
      }

      // Need revision — resolve tensions for next cycle
      ctx.task.status = "resolving";
      addEvent(ctx.task, "status_change", { status: "resolving", cycle });

      const resolutions = await resolve(integrated.tensions, integrated.work, config);
      acc.allResolutions = [...acc.allResolutions, ...resolutions];

      // Collapsed-tension detection: was this genuine synthesis or capitulation?
      const collapseContext: CollapseContext = {
        tensions: integrated.tensions,
        resolutions,
        evaluations: integrated.evaluations,
        priorEvaluations: state.completedCycles > 0 ? acc.lastEvaluations : undefined,
        work: integrated.work,
      };
      const collapseSignal = await basalGanglia.detectCollapse(collapseContext, config);

      addEvent(ctx.task, "resolution", {
        cycle,
        resolutions: resolutions.map((r) => r.strategy),
        collapsedTensions: collapseSignal.collapsed
          ? collapseSignal.details.filter((d) => d.collapsed).length
          : 0,
      });

      // Resolution Rework: snapshot pre-resolution scores + collapse signal
      // for next cycle's integrate phase to measure outcome quality.
      acc.priorWeighted = [...acc.lastWeighted];
      acc.lastCollapseSignal = collapseSignal;

      addEvent(ctx.task, "cycle_back", { cycle });

      // Build reason with conviction + gate strategy info + oscillation + collapse notes
      let reason = `Cycle ${cycle}: ${gateOutput.reason}. Resolved ${resolutions.length} tension(s), requesting revision.`;

      if (conviction.verdict === "reshape" && conviction.shaping.reshapeGuidance) {
        reason = `CONVICTION: ${conviction.shaping.reshapeGuidance}. ` + reason;
      }

      if (integrated.oscillations.length > 0) {
        reason += ` OSCILLATION: ${integrated.oscillations.length} receptor(s) showing score instability.`;
      }

      if (collapseSignal.collapsed) {
        const guidance = collapseSignal.details
          .filter((d) => d.collapsed && d.reEngagementGuidance)
          .map((d) => d.reEngagementGuidance)
          .join("; ");
        reason += ` COLLAPSED TENSIONS: ${guidance || "Senses capitulated instead of synthesizing. Re-engage with genuine tension."}`;
      }

      return {
        action: "continue",
        reason,
      };
    },

    // ── Cleanup: called by runner on abnormal exit (error/abort) ──
    // On normal exit the gate phase handles sandbox merge + runtime stop.
    // This safety net ensures no orphaned processes or dangling branches.
    async cleanup(state) {
      const acc = getAcc(state);
      if (acc.runtimeInstances) {
        await stopAllRuntimes(acc.runtimeInstances).catch((err) => {
          log.warn("Cleanup: runtime stop failed", { error: String(err) });
        });
        acc.runtimeInstances = null;
      }
      if (acc.sandbox) {
        await discardSandbox(acc.sandbox).catch((err) => {
          log.warn("Cleanup: sandbox discard failed", { error: String(err) });
        });
        acc.sandbox = null;
      }
    },
  };
}
