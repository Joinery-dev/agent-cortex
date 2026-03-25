import { z } from "zod";
import type { SensePerspective } from "../types/sense.js";
import type { Sense } from "../types/sense.js";
import type { Consultation, EvaluationPlanEntry, StakeDistribution, ConsultationConditions } from "../types/consultation.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { ConsultationBriefing } from "../types/thalamus.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { consultationSystem, consultationUser } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("consul");

const PerspectiveResult = z.object({
  perspective: z.string(),
  evaluators: z.array(z.string()),
  stake: z.number().min(0).max(1),
});

/** Conditions context passed by sensory-cortex to record in the consultation. */
export interface ConsultConditions {
  neLevel?: number;
  mode?: "explore" | "exploit";
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

      // Return a perspective noting the failure rather than silencing this sense
      return {
        senseId: sense.id,
        senseName: sense.name,
        perspective: `[Consultation failed: ${String(err)}]`,
        evaluators: [],
        stake: 0,
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
