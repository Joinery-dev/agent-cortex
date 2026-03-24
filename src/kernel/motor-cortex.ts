/**
 * Motor Cortex — the builder.
 *
 * Three sub-components:
 *   Premotor        — plans the approach before building (callStructured → MotorPlan)
 *   Primary Motor   — produces the artifact (call → string)
 *   Proprioception  — self-checks plan adherence after building (callStructured → SelfAssessment)
 *
 * Single entry point: execute(briefing, opts?) → MotorCortexResult
 *
 * The old build() function is preserved for backward compatibility with
 * the deprecated orchestrator.ts.
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
} from "../types/motor-cortex.js";
import type { Intention } from "../types/pns.js";
import { createIntention } from "../types/pns.js";
import { call } from "../llm/client.js";
import { callStructured } from "../llm/structured.js";
import {
  premotorSystem,
  premotorUser,
  premotorRevisionUser,
  motorCortexSystem,
  motorCortexUser,
  assembleMotorPrompt,
  proprioceptionSystem,
  proprioceptionUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

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

// ── Options ─────────────────────────────────────────────────

export interface MotorCortexOpts {
  /** Skip proprioception when false. Modulated by NE + novelty in build-cycle. */
  enableProprioception?: boolean;
  /** Revision context — present on cycle 2+. */
  revision?: RevisionContext;
  /** Previous work artifact for primary motor revision context. */
  previousWork?: string;
}

// ── Class ───────────────────────────────────────────────────

export class MotorCortex {
  private config: CortexConfig;

  constructor(config: CortexConfig) {
    this.config = config;
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
      : await this.premotorPlan(briefing);

    emit("motor:plan-complete", {
      taskId,
      approach: plan.approach,
      steps: plan.steps.length,
      confidence: plan.confidence,
      isRevision,
    });

    // ── Phase 2: Primary Motor ─────────────────────────
    const work = await this.primaryProduce(briefing, plan, opts?.previousWork);

    emit("motor:build-complete", {
      taskId,
      outputLength: work.length,
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
    }

    // ── Build Intentions from plan ─────────────────────
    const intentions = this.buildIntentions(taskId, plan);

    emit("motor:complete", {
      taskId,
      outputLength: work.length,
      planConfidence: plan.confidence,
      proprioceptionConfidence: selfAssessment?.confidence,
      intentionCount: intentions.length,
    });

    log.info("Motor cortex complete", {
      taskId,
      isRevision,
      planConfidence: plan.confidence,
      proprioceptionConfidence: selfAssessment?.confidence,
      outputLength: work.length,
      intentionCount: intentions.length,
    });

    return { work, plan, selfAssessment, intentions };
  }

  // ── Private: Premotor (first cycle) ─────────────────────

  private async premotorPlan(briefing: MotorBriefing): Promise<MotorPlan> {
    const model = this.config.models.premotor ?? this.config.models.motorCortex;

    log.info("Premotor planning", { taskId: briefing.task.id });

    return callStructured<MotorPlan>(
      "premotor",
      model,
      premotorSystem(),
      premotorUser(briefing),
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

// ── Backward compatibility ────────────────────────────────────
// The deprecated orchestrator.ts still imports this function.
// It's a thin wrapper that doesn't use the MotorCortex class.

export async function build(
  prompt: string,
  config: CortexConfig,
  previousWork?: string,
): Promise<string> {
  emit("motor:start", { isRevision: !!previousWork });

  log.info("Motor cortex starting (legacy)", {
    promptWords: prompt.split(/\s+/).length,
    isRevision: !!previousWork,
  });

  const result = await call(
    "motorCortex",
    config.models.motorCortex,
    motorCortexSystem(),
    motorCortexUser(prompt, previousWork),
    8192,
  );

  emit("motor:complete", { outputLength: result.text.length, work: result.text });

  log.info("Motor cortex complete (legacy)", {
    outputLength: result.text.length,
  });

  return result.text;
}
