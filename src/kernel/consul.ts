import { z } from "zod";
import type { SensePerspective, SenseEvaluation } from "../types/sense.js";
import type { Sense } from "../types/sense.js";
import type { Consultation, EvaluationPlanEntry, StakeDistribution, ConsultationConditions } from "../types/consultation.js";
import type { Tension } from "../types/tension.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { ConsultationBriefing } from "../types/thalamus.js";
import type { WeightedEvaluation, WeightedComposite } from "./evaluation-weighter.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { consultationSystem, consultationUser, reconsultationSystem, reconsultationUser } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";

const log = createLogger("consul");

const PerspectiveResult = z.object({
  perspective: z.string(),
  evaluators: z.array(z.string()),
  stake: z.number().min(0).max(1),
  ceiling: z.number().min(1).max(10),
  ceilingRationale: z.string(),
});

/** Conditions context passed by sensory-cortex to record in the consultation. */
export interface ConsultConditions {
  neLevel?: number;
  mode?: "explore" | "leverage";
  activeSenses: Sense[];
  inhibitedSenses: { senseId: string; reason: string }[];
}

export async function consult(
  briefing: ConsultationBriefing,
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  conditions: ConsultConditions,
): Promise<Consultation> {
  emit("consultation:start", {
    senseCount: senses.length,
    names: senses.map((g) => g.name),
  });

  log.info("Consulting senses", {
    count: senses.length,
    names: senses.map((g) => g.name),
  });

  const userPrompt = consultationUser(briefing);

  // Consult all senses in parallel
  const perspectivePromises = senses.map(async (sense) => {
    const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);

    try {
      const result = await callStructured(
        "consultation",
        config.models.consultation,
        consultationSystem(sense, subTree),
        userPrompt,
        PerspectiveResult
      );

      const perspective: SensePerspective = {
        senseId: sense.id,
        senseName: sense.name,
        perspective: result.perspective,
        evaluators: result.evaluators,
        stake: result.stake,
        ceiling: result.ceiling,
        ceilingRationale: result.ceilingRationale,
      };

      emit("consultation:perspective", {
        sense: sense.name,
        perspectiveLength: result.perspective.length,
        evaluatorCount: result.evaluators.length,
        evaluators: result.evaluators,
        stake: result.stake,
      });

      log.info(`${sense.name} perspective`, {
        words: result.perspective.split(/\s+/).length,
        evaluators: result.evaluators.length,
      });

      return perspective;
    } catch (err) {
      log.warn(`Consultation failed for ${sense.name}`, { error: String(err) });
      emitWarn(
        "consultation:fallback:sense-muted",
        {
          senseId: sense.id,
          senseName: sense.name,
          taskId: briefing.task.id,
          error: String(err),
        },
        {
          component: "consul",
          expected: "SensePerspective with stake > 0",
          received: "fallback perspective with stake=0, no evaluators",
        },
      );

      // Return a perspective noting the failure rather than silencing this sense
      return {
        senseId: sense.id,
        senseName: sense.name,
        perspective: `[Consultation failed: ${String(err)}]`,
        evaluators: [],
        stake: 0,
        ceiling: 10,
        ceilingRationale: "No ceiling estimate — consultation failed.",
      } satisfies SensePerspective;
    }
  });

  const perspectives = await Promise.all(perspectivePromises);

  // Derive evaluation plan: flatten receptor → parent sense relationships
  const evaluationPlan: EvaluationPlanEntry[] = [];
  for (const perspective of perspectives) {
    for (const receptorId of perspective.evaluators) {
      evaluationPlan.push({
        receptorId,
        parentSenseId: perspective.senseId,
        parentSenseName: perspective.senseName,
        parentStake: perspective.stake,
        parentPerspective: perspective.perspective,
      });
    }
  }

  // Derive stake distribution
  const stakeEntries = perspectives.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    stake: p.stake,
  }));
  const totalStake = stakeEntries.reduce((sum, e) => sum + e.stake, 0);
  const meanStake = stakeEntries.length > 0 ? totalStake / stakeEntries.length : 0;
  const maxEntry = stakeEntries.reduce(
    (max, e) => (e.stake > max.stake ? e : max),
    { senseId: "", senseName: "", stake: 0 },
  );

  const stakeDistribution: StakeDistribution = {
    entries: stakeEntries,
    totalStake,
    meanStake,
    max: maxEntry,
  };

  // Assemble conditions
  const consultationConditions: ConsultationConditions = {
    neLevel: conditions.neLevel,
    mode: conditions.mode,
    activeSenses: conditions.activeSenses.map((s) => ({ senseId: s.id, senseName: s.name })),
    inhibitedSenses: conditions.inhibitedSenses,
  };

  const consultation: Consultation = {
    taskId: briefing.task.id,
    producedAt: new Date(),
    perspectives,
    evaluationPlan,
    stakeDistribution,
    conditions: consultationConditions,
    generation: 0,
  };

  const totalEvaluators = evaluationPlan.length;

  emit("consultation:complete", {
    perspectives: perspectives.length,
    totalEvaluators,
    senses: perspectives.map((p) => ({
      name: p.senseName,
      words: p.perspective.split(/\s+/).length,
      evaluators: p.evaluators.length,
      stake: p.stake,
    })),
    stakeDistribution: {
      totalStake: stakeDistribution.totalStake,
      meanStake: stakeDistribution.meanStake,
      max: stakeDistribution.max.senseName,
    },
  });

  log.info("Consultation complete", {
    perspectives: perspectives.length,
    totalEvaluators,
    meanStake: stakeDistribution.meanStake.toFixed(2),
  });

  return consultation;
}

// ─── RE-CONSULTATION ────────────────────────────────────────

/** Input for selective re-consultation after the senses have seen actual work. */
export interface ReconsultInput {
  previousConsultation: Consultation;
  work: string;
  evaluations: SenseEvaluation[];
  weighted: WeightedEvaluation[];
  composite: WeightedComposite;
  tensions: Tension[];
}

/**
 * Selective re-consultation: only senses with improvement potential or
 * tension involvement re-engage. Others keep their previous perspective.
 *
 * Returns a new Consultation with updated perspectives merged with preserved ones.
 */
export async function reconsult(
  input: ReconsultInput,
  sensesToReconsult: string[],
  briefing: ConsultationBriefing,
  library: SensoryCortex,
  config: CortexConfig,
  conditions: ConsultConditions,
): Promise<Consultation> {
  const reconsultSet = new Set(sensesToReconsult);
  const previousByIds = new Map(
    input.previousConsultation.perspectives.map((p) => [p.senseId, p]),
  );

  // Partition senses into re-consult vs preserve
  const preservedPerspectives: SensePerspective[] = [];
  const sensesToCall: { sense: Sense; previous: SensePerspective }[] = [];

  for (const perspective of input.previousConsultation.perspectives) {
    if (reconsultSet.has(perspective.senseId)) {
      const sense = library.get(perspective.senseId);
      if (sense) {
        sensesToCall.push({ sense, previous: perspective });
      } else {
        preservedPerspectives.push(perspective);
      }
    } else {
      preservedPerspectives.push(perspective);
    }
  }

  emit("reconsultation:start", {
    taskId: input.previousConsultation.taskId,
    generation: input.previousConsultation.generation + 1,
    reconsultingSenses: sensesToCall.map((s) => s.sense.name),
    preservedSenses: preservedPerspectives.map((p) => p.senseName),
  });

  log.info("Re-consulting senses", {
    reconsulting: sensesToCall.map((s) => s.sense.name),
    preserved: preservedPerspectives.length,
  });

  // Build summaries of other senses' evaluations for context
  const buildOtherSummaries = (excludeSenseId: string) => {
    const others: { senseName: string; score: number; assessment: string }[] = [];
    for (const w of input.weighted) {
      const rootSenseName = w.activationPath[0];
      const rootSense = input.previousConsultation.perspectives.find(
        (p) => p.senseName === rootSenseName,
      );
      if (rootSense && rootSense.senseId !== excludeSenseId) {
        others.push({
          senseName: w.activationPath.join(" > "),
          score: w.score,
          assessment: w.assessment,
        });
      }
    }
    return others;
  };

  // Re-consult selected senses in parallel
  const updatedPromises = sensesToCall.map(async ({ sense, previous }) => {
    const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);

    // Gather this sense's own receptor evaluations
    const ownEvals = input.evaluations.filter((e) => {
      const rootName = e.activationPath[0];
      return rootName === sense.name;
    });

    // Gather tensions involving this sense
    const relevantTensions = input.tensions.filter(
      (t) => t.senseA.path[0] === sense.name || t.senseB.path[0] === sense.name,
    );

    try {
      const result = await callStructured(
        "reconsultation",
        config.models.consultation,
        reconsultationSystem(sense, subTree),
        reconsultationUser({
          briefing,
          work: input.work,
          previousPerspective: previous,
          ownEvaluations: ownEvals,
          otherEvaluationSummaries: buildOtherSummaries(sense.id),
          tensions: relevantTensions,
        }),
        PerspectiveResult,
      );

      const updated: SensePerspective = {
        senseId: sense.id,
        senseName: sense.name,
        perspective: result.perspective,
        evaluators: result.evaluators,
        stake: result.stake,
        ceiling: result.ceiling,
        ceilingRationale: result.ceilingRationale,
      };

      emit("reconsultation:perspective", {
        sense: sense.name,
        stakeChange: updated.stake - previous.stake,
        perspectiveLength: updated.perspective.length,
        evaluatorChange: JSON.stringify(updated.evaluators) !== JSON.stringify(previous.evaluators),
      });

      log.info(`${sense.name} re-consulted`, {
        stakeChange: (updated.stake - previous.stake).toFixed(2),
        newEvaluators: updated.evaluators.length,
      });

      return updated;
    } catch (err) {
      log.warn(`Re-consultation failed for ${sense.name}, preserving previous`, {
        error: String(err),
      });
      emitWarn(
        "reconsultation:fallback:preserved-previous",
        {
          senseId: sense.id,
          senseName: sense.name,
          taskId: input.previousConsultation.taskId,
          generation: input.previousConsultation.generation + 1,
          error: String(err),
        },
        {
          component: "consul",
          expected: "updated perspective from re-consultation",
          received: "preserved previous perspective (stale)",
        },
      );
      return previous;
    }
  });

  const updatedPerspectives = await Promise.all(updatedPromises);

  // Merge: updated perspectives + preserved perspectives
  const mergedPerspectives = [...preservedPerspectives, ...updatedPerspectives];

  // Recompute evaluation plan from merged perspectives
  const evaluationPlan: EvaluationPlanEntry[] = [];
  for (const perspective of mergedPerspectives) {
    for (const receptorId of perspective.evaluators) {
      evaluationPlan.push({
        receptorId,
        parentSenseId: perspective.senseId,
        parentSenseName: perspective.senseName,
        parentStake: perspective.stake,
        parentPerspective: perspective.perspective,
      });
    }
  }

  // Recompute stake distribution
  const stakeEntries = mergedPerspectives.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    stake: p.stake,
  }));
  const totalStake = stakeEntries.reduce((sum, e) => sum + e.stake, 0);
  const meanStake = stakeEntries.length > 0 ? totalStake / stakeEntries.length : 0;
  const maxEntry = stakeEntries.reduce(
    (max, e) => (e.stake > max.stake ? e : max),
    { senseId: "", senseName: "", stake: 0 },
  );

  const stakeDistribution: StakeDistribution = {
    entries: stakeEntries,
    totalStake,
    meanStake,
    max: maxEntry,
  };

  const consultationConditions: ConsultationConditions = {
    neLevel: conditions.neLevel,
    mode: conditions.mode,
    activeSenses: conditions.activeSenses.map((s) => ({ senseId: s.id, senseName: s.name })),
    inhibitedSenses: conditions.inhibitedSenses,
  };

  const newGeneration = input.previousConsultation.generation + 1;
  const preservedSenseIds = preservedPerspectives.map((p) => p.senseId);

  const consultation: Consultation = {
    taskId: input.previousConsultation.taskId,
    producedAt: new Date(),
    perspectives: mergedPerspectives,
    evaluationPlan,
    stakeDistribution,
    conditions: consultationConditions,
    generation: newGeneration,
    preservedSenseIds,
  };

  emit("reconsultation:complete", {
    taskId: consultation.taskId,
    generation: newGeneration,
    reconsultedCount: updatedPerspectives.length,
    preservedCount: preservedPerspectives.length,
    stakeDistribution: {
      totalStake: stakeDistribution.totalStake,
      meanStake: stakeDistribution.meanStake,
      max: stakeDistribution.max.senseName,
    },
  });

  log.info("Re-consultation complete", {
    generation: newGeneration,
    reconsulted: updatedPerspectives.length,
    preserved: preservedPerspectives.length,
    meanStake: stakeDistribution.meanStake.toFixed(2),
  });

  return consultation;
}
