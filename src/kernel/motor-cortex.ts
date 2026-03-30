/**
 * Motor Cortex — the builder.
 *
 * Three sub-components:
 *   Premotor        — plans the approach before building (callStructured → MotorPlan)
 *   Primary Motor   — produces the artifact
 *     • Agentic mode: multi-turn LLM with real tools (read/write/shell), curated by PNS
 *     • Legacy mode:  single-turn LLM producing a text artifact (fallback when PNS absent)
 *   Proprioception  — self-checks plan adherence after building (callStructured → SelfAssessment)
 *
 * Single entry point: execute(briefing, opts?) → MotorCortexResult
 */

import { z } from "zod";
import type { CortexConfig } from "../types/orchestrator.js";
import type { MotorBriefing } from "../types/thalamus.js";
import type {
  MotorPlan,
  SelfAssessment,
  MotorCortexResult,
  RevisionContext,
  RevisionPlan,
  AgenticMotorResult,
  BuildQuestion,
  BuildAnswer,
  QuestionHandler,
} from "../types/motor-cortex.js";
import type { EfferenceCopy, EfferenceCopyContext } from "../types/efference-copy.js";
import type { Intention } from "../types/pns.js";
import { createIntention } from "../types/pns.js";
import { call, agenticCall } from "../llm/client.js";
import { callStructured } from "../llm/structured.js";
import type { PeripheralNervousSystem } from "./pns.js";
import {
  premotorSystem,
  premotorUser,
  premotorRevisionUser,
  motorCortexSystem,
  motorCortexUser,
  motorCortexAgenticSystem,
  motorCortexAgenticUser,
  assembleMotorPrompt,
  proprioceptionSystem,
  proprioceptionUser,
  efferenceCopySystem,
  efferenceCopyUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

const log = createLogger("motor-cortex");

// ── Zod schemas for structured outputs ──────────────────────

const PlanStepSchema = z.object({
  description: z.string(),
  rationale: z.string(),
  addressesConcerns: z.array(z.string()),
});

const TensionStrategySchema = z.object({
  senses: z.tuple([z.string(), z.string()]),
  synthesis: z.string(),
});

const PlanRiskSchema = z.object({
  area: z.string(),
  likelihood: z.enum(["low", "medium", "high"]),
  mitigation: z.string(),
});

const PlannedIntentionSchema = z.object({
  description: z.string(),
  category: z.enum(["build", "observe", "communicate", "control"]),
  confidence: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
});

const MotorPlanSchema: z.ZodType<MotorPlan> = z.object({
  approach: z.string(),
  steps: z.array(PlanStepSchema),
  tensionStrategy: z.array(TensionStrategySchema),
  risks: z.array(PlanRiskSchema),
  confidence: z.number().min(0).max(1),
  plannedIntentions: z.array(PlannedIntentionSchema),
  requiresAgentic: z.boolean().default(true),
});

const RevisionStrategySchema = z.union([
  z.object({ kind: z.literal("execution-error"), amendments: z.array(z.string()) }),
  z.object({ kind: z.literal("plan-error"), newApproach: z.string() }),
]);

const RevisionPlanSchema: z.ZodType<RevisionPlan> = z.object({
  approach: z.string(),
  steps: z.array(PlanStepSchema),
  tensionStrategy: z.array(TensionStrategySchema),
  risks: z.array(PlanRiskSchema),
  confidence: z.number().min(0).max(1),
  plannedIntentions: z.array(PlannedIntentionSchema),
  requiresAgentic: z.boolean().default(true),
  revisionStrategy: RevisionStrategySchema,
  delta: z.string(),
});

const DriftAreaSchema = z.object({
  planStep: z.string(),
  actualBehavior: z.string(),
  severity: z.enum(["minor", "significant"]),
});

const SelfAssessmentSchema: z.ZodType<SelfAssessment> = z.object({
  planAdherence: z.number().min(0).max(1),
  driftAreas: z.array(DriftAreaSchema),
  uncertainties: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  suggestedFocus: z.array(z.string()),
});

// ── Efference Copy schemas ───────────────────────────────────

const EfferenceSenseFeasibilitySchema = z.object({
  senseName: z.string(),
  achievableCeiling: z.number().min(1).max(10),
  ceilingRationale: z.string(),
  constrainingFactors: z.array(z.string()),
});

const TensionCostSchema = z.object({
  senseA: z.string(),
  senseB: z.string(),
  costDescription: z.string(),
  severity: z.number().min(0).max(1),
});

const EfferenceCopyOutputSchema = z.object({
  perSense: z.array(EfferenceSenseFeasibilitySchema),
  tensionCosts: z.array(TensionCostSchema),
  hardConstraints: z.array(z.string()),
  convergenceEstimate: z.number().min(1),
  convergenceRationale: z.string(),
  overallFeasibility: z.number().min(0).max(1),
});

// ── Options ─────────────────────────────────────────────────

export interface MotorCortexOpts {
  /** Skip proprioception when false. Modulated by NE + novelty in build-cycle. */
  enableProprioception?: boolean;
  /** Revision context — present on cycle 2+. */
  revision?: RevisionContext;
  /** Previous work artifact for primary motor revision context. */
  previousWork?: string;
  /** Cognitive Flexibility: re-plan from scratch with these constraints. */
  resetDirective?: import("../types/cognitive-flexibility.js").ResetDirective;
  /** Norepinephrine level — passed to PNS for tool activation curation. */
  neLevel?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Mid-build sense consultation callback. When the builder hits ambiguity,
   * it calls this to ask a specific sense (or the Parsifal) a clarifying question.
   * Wired up by the build-cycle rhythm, which routes through the Thalamus.
   * The Motor Cortex stays decoupled from routing — it just asks and gets an answer.
   */
  questionHandler?: QuestionHandler;
}

// ── Class ───────────────────────────────────────────────────

export class MotorCortex {
  private config: CortexConfig;
  private pns?: PeripheralNervousSystem;

  constructor(config: CortexConfig, pns?: PeripheralNervousSystem) {
    this.config = config;
    this.pns = pns;
  }

  /**
   * Full motor cortex cycle: premotor → primary → proprioception.
   * Returns structured result with plan, work, self-assessment, and intentions.
   */
  async execute(
    briefing: MotorBriefing,
    opts?: MotorCortexOpts,
  ): Promise<MotorCortexResult> {
    const taskId = briefing.task.id;
    const isRevision = !!opts?.revision;

    emit("motor:start", { taskId, isRevision });

    // ── Phase 1: Premotor ──────────────────────────────
    const plan = isRevision
      ? await this.premotorRevise(briefing, opts!.revision!)
      : await this.premotorPlan(briefing, opts?.resetDirective);

    emit("motor:plan-complete", {
      taskId,
      approach: plan.approach,
      steps: plan.steps.length,
      confidence: plan.confidence,
      isRevision,
      requiresAgentic: plan.requiresAgentic,
      willUseAgentic: plan.requiresAgentic && !!this.pns,
    });

    const planStepsText = plan.steps
      .map((s, i) => `${i + 1}. ${s.description}${s.rationale ? ` — ${s.rationale}` : ""}`)
      .join("\n");
    getContentStore().record({
      eventSeq: null, kind: "motor-plan", timestamp: new Date().toISOString(),
      component: "motor-cortex", taskId,
      inputs: [contentBlock("Briefing task", briefing.task.description)],
      outputs: [
        contentBlock("Approach", plan.approach),
        contentBlock("Plan steps", planStepsText),
        contentBlock("Confidence", `${(plan.confidence * 100).toFixed(0)}%`),
      ],
      routing: { destinations: ["primary-motor (build phase)"] },
    });

    // ── Phase 2: Primary Motor ─────────────────────────
    let work: string;
    let agenticResult: AgenticMotorResult | undefined;
    const useAgentic = plan.requiresAgentic && !!this.pns;

    if (useAgentic) {
      // Agentic mode: real tools, multi-turn. The builder acts in the world.
      agenticResult = await this.primaryProduceAgentic(
        briefing, plan, opts?.previousWork, opts?.neLevel, opts?.signal,
      );
      work = agenticResult.summary;
    } else {
      // Text-only mode: single-turn artifact. Used when premotor determines
      // the task doesn't need real tool execution, or when PNS is absent.
      work = await this.primaryProduce(briefing, plan, opts?.previousWork);
      if (!plan.requiresAgentic && this.pns) {
        emit("motor:text-only-shortcut", {
          taskId,
          planConfidence: plan.confidence,
          steps: plan.steps.length,
          reason: "premotor determined task does not require agentic execution",
        });
        log.info("Skipping agentic motor — premotor says text-only is sufficient", {
          taskId,
          planConfidence: plan.confidence,
        });
      }
    }

    emit("motor:build-complete", {
      taskId,
      outputLength: work.length,
      agentic: !!agenticResult,
      toolCalls: agenticResult?.toolTrace.length,
      turns: agenticResult?.turns,
    });

    getContentStore().record({
      eventSeq: null, kind: "motor-work", timestamp: new Date().toISOString(),
      component: "motor-cortex", taskId,
      inputs: [contentBlock("Approach", plan.approach)],
      outputs: [contentBlock("Work product", work)],
      routing: { destinations: ["evaluation (all active senses)", "proprioception"] },
    });

    // ── Phase 3: Proprioception (optional) ─────────────
    let selfAssessment: SelfAssessment | undefined;
    if (opts?.enableProprioception !== false) {
      selfAssessment = await this.proprioceive(plan, work);

      emit("motor:proprioception-complete", {
        taskId,
        planAdherence: selfAssessment.planAdherence,
        confidence: selfAssessment.confidence,
        driftAreas: selfAssessment.driftAreas.length,
      });

      const driftText = selfAssessment.driftAreas
        .map((d) => `[${d.severity}] ${d.planStep}: actual="${d.actualBehavior}"`)
        .join("\n");
      getContentStore().record({
        eventSeq: null, kind: "self-assessment", timestamp: new Date().toISOString(),
        component: "motor-cortex", taskId,
        inputs: [contentBlock("Plan approach", plan.approach)],
        outputs: [
          contentBlock("Plan adherence", `${(selfAssessment.planAdherence * 100).toFixed(0)}%`),
          contentBlock("Confidence", `${(selfAssessment.confidence * 100).toFixed(0)}%`),
          ...(driftText ? [contentBlock("Drift areas", driftText)] : []),
        ],
        routing: { destinations: ["gate (conviction input)"] },
      });
    }

    // ── Build Intentions from plan ─────────────────────
    const intentions = this.buildIntentions(taskId, plan);

    emit("motor:complete", {
      taskId,
      outputLength: work.length,
      agentic: !!agenticResult,
      planConfidence: plan.confidence,
      proprioceptionConfidence: selfAssessment?.confidence,
      intentionCount: intentions.length,
    });

    log.info("Motor cortex complete", {
      taskId,
      isRevision,
      agentic: !!agenticResult,
      planConfidence: plan.confidence,
      proprioceptionConfidence: selfAssessment?.confidence,
      outputLength: work.length,
      intentionCount: intentions.length,
    });

    return { work, agenticResult, plan, selfAssessment, intentions };
  }

  /**
   * Ask a sense (or user) a clarifying question mid-build.
   *
   * The Motor Cortex doesn't know who answers — it formulates the question
   * and calls the questionHandler, which routes through the Thalamus.
   * The Thalamus decides: route to a sense (internal) or escalate to the
   * user (external, through PNS).
   *
   * NE modulates the threshold for asking. High NE (unfamiliar territory)
   * = lower bar, more questions allowed. Low NE (well-trodden ground)
   * = the builder should be making most calls autonomously.
   *
   * Returns null if no questionHandler is wired up (graceful degradation).
   */
  async askSenseQuestion(
    question: BuildQuestion,
    questionHandler?: QuestionHandler,
  ): Promise<BuildAnswer | null> {
    if (!questionHandler) {
      log.warn("Build question asked but no questionHandler wired — skipping", {
        questionId: question.id,
        taskId: question.taskId,
      });
      return null;
    }

    emit("motor:question-asked", {
      questionId: question.id,
      taskId: question.taskId,
      targetDimension: question.targetDimension,
      hasOptions: !!question.options?.length,
    });

    log.info("Asking mid-build question", {
      questionId: question.id,
      taskId: question.taskId,
      targetDimension: question.targetDimension,
    });

    const answer = await questionHandler(question);

    emit("motor:question-answered", {
      questionId: question.id,
      taskId: question.taskId,
      sourceType: answer.source.type,
      sourceSenseId: answer.source.type === "sense" ? answer.source.senseId : undefined,
      confidence: answer.confidence,
    });

    log.info("Mid-build question answered", {
      questionId: question.id,
      sourceType: answer.source.type,
      confidence: answer.confidence,
    });

    return answer;
  }

  /**
   * Efference copy: predict what the builder can achieve BEFORE senses deliberate.
   * One lightweight structured LLM call that assesses per-sense buildability,
   * tension costs, hard constraints, and convergence estimates.
   *
   * Counterpart to proprioception:
   *   proprioception = feedback AFTER building
   *   efference copy = feedforward BEFORE building
   */
  async predictFeasibility(
    context: EfferenceCopyContext,
  ): Promise<EfferenceCopy> {
    const model =
      this.config.models.efferenceCopy ??
      this.config.models.premotor ??
      this.config.models.motorCortex;

    log.info("Efference copy: assessing feasibility", {
      taskId: context.task.id,
      activeSenses: context.activeSenses.length,
      similarEpisodes: context.similarEpisodes.length,
    });

    const raw = await callStructured(
      "efference-copy",
      model,
      efferenceCopySystem(),
      efferenceCopyUser(context),
      EfferenceCopyOutputSchema,
      2048,
    );

    const efferenceCopy: EfferenceCopy = {
      taskId: context.task.id,
      perSense: raw.perSense,
      tensionCosts: raw.tensionCosts,
      hardConstraints: raw.hardConstraints,
      convergenceEstimate: raw.convergenceEstimate,
      convergenceRationale: raw.convergenceRationale,
      overallFeasibility: raw.overallFeasibility,
      computedAt: new Date(),
    };

    emit("motor:efference-copy", {
      taskId: context.task.id,
      senseCount: efferenceCopy.perSense.length,
      tensionCostCount: efferenceCopy.tensionCosts.length,
      hardConstraintCount: efferenceCopy.hardConstraints.length,
      convergenceEstimate: efferenceCopy.convergenceEstimate,
      overallFeasibility: efferenceCopy.overallFeasibility,
    });

    log.info("Efference copy complete", {
      taskId: context.task.id,
      overallFeasibility: efferenceCopy.overallFeasibility,
      convergenceEstimate: efferenceCopy.convergenceEstimate,
      senseCount: efferenceCopy.perSense.length,
    });

    return efferenceCopy;
  }

  // ── Private: Premotor (first cycle) ─────────────────────

  private async premotorPlan(
    briefing: MotorBriefing,
    resetDirective?: import("../types/cognitive-flexibility.js").ResetDirective,
  ): Promise<MotorPlan> {
    const model = this.config.models.premotor ?? this.config.models.motorCortex;

    log.info("Premotor planning", {
      taskId: briefing.task.id,
      isStrategyReset: !!resetDirective,
    });

    let userPrompt = premotorUser(briefing);

    // Cognitive Flexibility: strategy reset — re-plan with constraints
    if (resetDirective) {
      const resetSection = [
        "\nSTRATEGY RESET — the previous approach failed. Here's what to do differently:",
        "",
        resetDirective.avoidApproaches.length > 0
          ? `AVOID these approach types: ${resetDirective.avoidApproaches.join(", ")}`
          : "",
        resetDirective.retainFromCurrent.length > 0
          ? `RETAIN from current approach: ${resetDirective.retainFromCurrent.join(", ")}`
          : "",
        `NEW DIRECTION: ${resetDirective.suggestedDirection}`,
        "",
        "Re-plan from scratch. Do not revise the previous approach — design a fundamentally new one.",
      ].filter(Boolean).join("\n");

      userPrompt = resetSection + "\n\n" + userPrompt;
    }

    return callStructured<MotorPlan>(
      "premotor",
      model,
      premotorSystem(),
      userPrompt,
      MotorPlanSchema,
      4096,
    );
  }

  // ── Private: Premotor (revision cycle) ──────────────────

  private async premotorRevise(
    briefing: MotorBriefing,
    revision: RevisionContext,
  ): Promise<RevisionPlan> {
    const model = this.config.models.premotor ?? this.config.models.motorCortex;

    log.info("Premotor revising", { taskId: briefing.task.id });

    return callStructured<RevisionPlan>(
      "premotor",
      model,
      premotorSystem(),
      premotorRevisionUser(briefing, revision),
      RevisionPlanSchema,
      4096,
    );
  }

  // ── Private: Primary Motor ──────────────────────────────

  private async primaryProduce(
    briefing: MotorBriefing,
    plan: MotorPlan,
    previousWork?: string,
  ): Promise<string> {
    // Assemble prompt with plan injected
    const prompt = assembleMotorPrompt(briefing, plan);

    log.info("Primary motor producing", {
      taskId: briefing.task.id,
      promptLength: prompt.length,
      isRevision: !!previousWork,
    });

    const result = await call(
      "motorCortex",
      this.config.models.motorCortex,
      motorCortexSystem(),
      motorCortexUser(prompt, previousWork),
      8192,
    );

    return result.text;
  }

  // ── Private: Primary Motor (Agentic) ──────────────────────

  private async primaryProduceAgentic(
    briefing: MotorBriefing,
    plan: MotorPlan,
    previousWork?: string,
    neLevel?: number,
    signal?: AbortSignal,
  ): Promise<AgenticMotorResult> {
    const ne = neLevel ?? 0.5;
    const toolSet = this.pns!.activateToolsForTask(
      briefing.task.description,
      ne,
    );

    log.info("Primary motor producing (agentic)", {
      taskId: briefing.task.id,
      neLevel: ne,
      tools: toolSet.tools,
      isRevision: !!previousWork,
    });

    const result = await agenticCall(
      "agenticMotor",
      this.config.models.motorCortex,
      motorCortexAgenticSystem(),
      motorCortexAgenticUser(briefing, plan, previousWork),
      toolSet,
      {
        maxTurns: ne > 0.7 ? 20 : ne > 0.3 ? 15 : 10,
        signal,
      },
    );

    log.info("Primary motor complete (agentic)", {
      taskId: briefing.task.id,
      turns: result.turns,
      toolCalls: result.toolTrace.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  // ── Private: Proprioception ─────────────────────────────

  private async proprioceive(
    plan: MotorPlan,
    work: string,
  ): Promise<SelfAssessment> {
    const model = this.config.models.proprioception ?? this.config.models.motorCortex;

    log.info("Proprioception self-check");

    return callStructured<SelfAssessment>(
      "proprioception",
      model,
      proprioceptionSystem(),
      proprioceptionUser(plan, work),
      SelfAssessmentSchema,
      2048,
    );
  }

  // ── Private: Build Intentions ───────────────────────────

  private buildIntentions(taskId: string, plan: MotorPlan): Intention[] {
    return plan.plannedIntentions.map((pi) =>
      createIntention(
        newId(),
        taskId,
        pi.description,
        pi.category,
        [], // operations empty — PNS execution wiring is a separate phase
        { confidence: pi.confidence, novelty: pi.novelty },
      ),
    );
  }
}

