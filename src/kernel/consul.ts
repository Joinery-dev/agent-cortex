import { z } from "zod";
import type { SensePerspective } from "../types/sense.js";
import type { Sense } from "../types/sense.js";
import type { Council } from "../types/council.js";
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
});

export async function consult(
  briefing: ConsultationBriefing,
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig
): Promise<Council> {
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
      };

      emit("consultation:perspective", {
        sense: sense.name,
        perspectiveLength: result.perspective.length,
        evaluatorCount: result.evaluators.length,
        evaluators: result.evaluators,
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
      } satisfies SensePerspective;
    }
  });

  const perspectives = await Promise.all(perspectivePromises);

  const council: Council = {
    taskId: briefing.task.id,
    perspectives,
    producedAt: new Date(),
    inputSummary: {
      intentSlice: briefing.intent.summary,
      tasteSlice: `${briefing.taste.visual}; ${briefing.taste.decisionStyle}`,
      taskDescription: briefing.task.description,
    },
  };

  const totalEvaluators = perspectives.reduce(
    (sum, p) => sum + p.evaluators.length,
    0
  );

  emit("consultation:complete", {
    perspectives: perspectives.length,
    totalEvaluators,
    senses: perspectives.map((p) => ({
      name: p.senseName,
      words: p.perspective.split(/\s+/).length,
      evaluators: p.evaluators.length,
    })),
  });

  log.info("Consultation complete", {
    perspectives: perspectives.length,
    totalEvaluators,
  });

  return council;
}
