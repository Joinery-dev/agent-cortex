/**
 * Cognitive Flexibility — PFC Feature #5.
 *
 * Acts on the conviction loop's "reshape" verdict. Diagnoses WHY
 * the system is stuck and prescribes a specific course correction.
 *
 * Four diagnoses, four actions:
 *   execution-problem  → targeted revision (approach is fine)
 *   strategy-limited   → full re-plan with different approach
 *   tension-evasion    → re-engage suppressed dimension
 *   irreconcilable     → escalate to human
 *
 * One LLM call per trigger. Fires only when conviction says "reshape."
 * Not stateful — the build-cycle accumulator carries approach history
 * and reset directives.
 */

import { z } from "zod";
import type { CortexConfig } from "../types/orchestrator.js";
import type {
  FlexibilityContext,
  FlexibilityAssessment,
} from "../types/cognitive-flexibility.js";
import { callStructured } from "../llm/structured.js";
import {
  cognitiveFlexibilitySystem,
  cognitiveFlexibilityUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("cognitive-flexibility");

const AssessmentResult = z.object({
  diagnosis: z.enum([
    "execution-problem",
    "strategy-limited",
    "tension-evasion",
    "irreconcilable",
  ]),
  reasoning: z.string(),
  shouldReset: z.boolean(),
  avoidApproaches: z.array(z.string()),
  suggestedDirection: z.string(),
  retainFromCurrent: z.array(z.string()),
  shouldEscalate: z.boolean(),
  escalationContext: z.string().optional(),
});

export class CognitiveFlexibility {
  private config: CortexConfig;

  constructor(config: CortexConfig) {
    this.config = config;
  }

  /**
   * Diagnose why the system is stuck and prescribe a course correction.
   *
   * Called from the build-cycle gate phase when the conviction loop
   * returns "reshape". Returns an assessment that the gate acts on:
   * reset the strategy, escalate to human, or fall through to normal revision.
   */
  async assess(context: FlexibilityContext): Promise<FlexibilityAssessment> {
    log.info("Assessing flexibility", {
      taskId: context.task.id,
      cycle: context.cycle,
      convictionLevel: context.conviction.level.toFixed(3),
      decidingStep: context.conviction.decidingStep,
      approachCount: context.approachHistory.length,
    });

    try {
      const result = await callStructured(
        "cognitive-flexibility",
        this.config.models.consultation,
        cognitiveFlexibilitySystem(),
        cognitiveFlexibilityUser(context),
        AssessmentResult,
      );

      const assessment: FlexibilityAssessment = {
        diagnosis: result.diagnosis,
        reasoning: result.reasoning,
        shouldReset: result.shouldReset,
        resetDirective: result.shouldReset
          ? {
              avoidApproaches: result.avoidApproaches,
              suggestedDirection: result.suggestedDirection,
              retainFromCurrent: result.retainFromCurrent,
            }
          : undefined,
        shouldEscalate: result.shouldEscalate,
        escalationContext: result.escalationContext,
      };

      log.info("Flexibility assessment", {
        taskId: context.task.id,
        diagnosis: assessment.diagnosis,
        shouldReset: assessment.shouldReset,
        shouldEscalate: assessment.shouldEscalate,
        reasoning: assessment.reasoning.slice(0, 200),
      });

      emit("flexibility:assessment", {
        taskId: context.task.id,
        cycle: context.cycle,
        diagnosis: assessment.diagnosis,
        shouldReset: assessment.shouldReset,
        shouldEscalate: assessment.shouldEscalate,
      });

      return assessment;
    } catch (err) {
      log.warn("Flexibility assessment failed — falling through to normal gate", {
        taskId: context.task.id,
        error: String(err),
      });

      // On failure, return execution-problem (least disruptive)
      return {
        diagnosis: "execution-problem",
        reasoning: `Flexibility assessment failed: ${String(err)}. Falling through to normal revision.`,
        shouldReset: false,
        shouldEscalate: false,
      };
    }
  }
}
