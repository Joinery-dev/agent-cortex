/**
 * Cognitive Flexibility — PFC Feature #5.
 *
 * Acts on the conviction loop's "reshape" verdict. Diagnoses WHY
 * Cortex is stuck and prescribes a specific course correction.
 *
 * Four diagnoses, four actions:
 *   execution-problem  → targeted revision (approach is fine)
 *   strategy-limited   → full re-plan with different approach
 *   tension-evasion    → re-engage suppressed dimension
 *   irreconcilable     → escalate to Parsifal
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
  DispatchFlexibilityContext,
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
  private assessmentHistory: Array<{ diagnosis: string; timestamp: Date }> = [];

  constructor(config: CortexConfig) {
    this.config = config;
  }

  /** Recent assessments for self-model synthesis (CognitiveFlexibilitySource). */
  getRecentAssessments(count: number): Array<{ diagnosis: string; timestamp: Date }> {
    return this.assessmentHistory.slice(-count);
  }

  /**
   * Diagnose why Cortex is stuck and prescribe a course correction.
   *
   * Called from the build-cycle gate phase when the conviction loop
   * returns "reshape". Returns an assessment that the gate acts on:
   * reset the strategy, escalate to Parsifal, or fall through to normal revision.
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

      this.assessmentHistory.push({ diagnosis: assessment.diagnosis, timestamp: new Date() });

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

  /**
   * Dispatch-level flexibility assessment.
   *
   * Heuristic (no LLM) — uses aggregate task-graph signals to diagnose
   * what's wrong at the project execution level. Called from the
   * task-dispatch gate when conviction returns "reshape".
   *
   * Same four diagnoses as build-level, different signal domain:
   *   execution-problem  → individual tasks struggling, strategy is sound
   *   strategy-limited   → task graph itself is the bottleneck
   *   tension-evasion    → system is avoiding a dimension
   *   irreconcilable     → needs Parsifal information to proceed
   */
  assessDispatch(context: DispatchFlexibilityContext, neLevel?: number): FlexibilityAssessment {
    const result = this.assessDispatchInner(context, neLevel);
    this.assessmentHistory.push({ diagnosis: result.diagnosis, timestamp: new Date() });
    return result;
  }

  private assessDispatchInner(context: DispatchFlexibilityContext, neLevel?: number): FlexibilityAssessment {
    const {
      taskGraph, completedTaskIds, escalatedTaskIds,
      senseTrends, schedulerEscalation,
    } = context;

    const total = taskGraph.length;
    const escalated = escalatedTaskIds.size;
    const escalationRate = total > 0 ? escalated / total : 0;

    // NE-modulated escalation rate threshold: high NE → escalate sooner
    const baseEscalationRate = 0.4;
    const sensitivity = 0.4;
    const effectiveEscalationRate = neLevel !== undefined
      ? baseEscalationRate * (1 - sensitivity * Math.max(0, Math.min(1, neLevel)))
      : baseEscalationRate;

    // Heuristic 1: High escalation rate → strategy-limited
    if (escalationRate > effectiveEscalationRate) {
      log.info("Dispatch flexibility: high escalation rate", { escalationRate: escalationRate.toFixed(2) });
      return {
        diagnosis: "strategy-limited",
        reasoning: `${escalated}/${total} tasks escalated (${(escalationRate * 100).toFixed(0)}%). The task graph itself is the bottleneck.`,
        shouldReset: true,
        resetDirective: {
          avoidApproaches: [],
          suggestedDirection: "Redecompose with simpler, more independent tasks.",
          retainFromCurrent: [...completedTaskIds],
        },
        shouldEscalate: false,
      };
    }

    // Heuristic 2: Perseveration
    if (schedulerEscalation?.type === "perseveration") {
      if (escalated <= 1) {
        log.info("Dispatch flexibility: perseveration, single task struggling");
        return {
          diagnosis: "execution-problem",
          reasoning: "Perseveration detected but only one task struggling. Individual task execution problem.",
          shouldReset: false,
          shouldEscalate: false,
        };
      }
      log.info("Dispatch flexibility: perseveration across multiple tasks");
      return {
        diagnosis: "strategy-limited",
        reasoning: "Perseveration detected across multiple tasks. Strategy needs rethinking.",
        shouldReset: true,
        resetDirective: {
          avoidApproaches: [],
          suggestedDirection: "Try fundamentally different task decomposition.",
          retainFromCurrent: [...completedTaskIds],
        },
        shouldEscalate: false,
      };
    }

    // Heuristic 3: Deadlock → graph structure problem
    if (schedulerEscalation?.type === "deadlock") {
      log.info("Dispatch flexibility: deadlock");
      return {
        diagnosis: "strategy-limited",
        reasoning: "Task graph deadlocked — no tasks have satisfied dependencies. Graph structure problem.",
        shouldReset: true,
        resetDirective: {
          avoidApproaches: [],
          suggestedDirection: "Replan with fewer inter-task dependencies.",
          retainFromCurrent: [...completedTaskIds],
        },
        shouldEscalate: false,
      };
    }

    // Heuristic 4: Cratering
    if (schedulerEscalation?.type === "cratering") {
      const downSenses = senseTrends.filter((t) => t.direction === "down");
      if (downSenses.length === senseTrends.length && senseTrends.length > 0) {
        log.info("Dispatch flexibility: all senses cratering");
        return {
          diagnosis: "strategy-limited",
          reasoning: "All senses declining. Fundamental strategy problem.",
          shouldReset: true,
          resetDirective: {
            avoidApproaches: [],
            suggestedDirection: "Rethink the approach from scratch.",
            retainFromCurrent: [...completedTaskIds],
          },
          shouldEscalate: false,
        };
      }
      if (downSenses.length === 1) {
        log.info("Dispatch flexibility: single sense cratering", { sense: downSenses[0].label });
        return {
          diagnosis: "tension-evasion",
          reasoning: `Single sense (${downSenses[0].label}) declining while others stable. System may be avoiding this dimension.`,
          shouldReset: false,
          shouldEscalate: false,
        };
      }
    }

    // Heuristic 5: Open questions → needs Parsifal info
    if (schedulerEscalation?.type === "open-questions") {
      log.info("Dispatch flexibility: too many open questions");
      return {
        diagnosis: "irreconcilable",
        reasoning: "Too many open questions — system lacks information to proceed.",
        shouldReset: false,
        shouldEscalate: true,
        escalationContext: schedulerEscalation.reason,
      };
    }

    // Default: execution-problem (least disruptive)
    log.info("Dispatch flexibility: default execution-problem");
    return {
      diagnosis: "execution-problem",
      reasoning: `Conviction reshape at dispatch level. No strong structural signal. ${context.conviction.shaping.reshapeGuidance ?? ""}`,
      shouldReset: false,
      shouldEscalate: false,
    };
  }
}
