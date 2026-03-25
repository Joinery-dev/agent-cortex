import { z } from "zod";
import type { SenseEvaluation } from "../types/sense.js";
import type { Consultation } from "../types/consultation.js";
import type { Task } from "../types/task.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { Thalamus } from "./thalamus.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { evaluatorSystem, evaluatorUser } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("evaluator");

const EvaluationResult = z.object({
  score: z.number().min(1).max(10),
  acceptable: z.boolean(),
  assessment: z.string(),
  tensions: z.array(
    z.object({
      withDimension: z.string(),
      description: z.string(),
    })
  ),
  suggestions: z.array(z.string()),
});

interface EvaluatorEntry {
  receptorId: string;
  parentPerspective: string;
}

export async function evaluate(
  consultation: Consultation,
  task: Task,
  work: string,
  library: SensoryCortex,
  config: CortexConfig,
  thalamus?: Thalamus,
): Promise<SenseEvaluation[]> {
  // Read evaluator list from consultation's pre-computed evaluation plan
  const entries: EvaluatorEntry[] = consultation.evaluationPlan.map((entry) => ({
    receptorId: entry.receptorId,
    parentPerspective: entry.parentPerspective,
  }));

  emit("evaluation:start", {
    senseCount: entries.length,
    senses: entries.map((e) => e.receptorId),
  });

  log.info("Evaluating work", {
    senseCount: entries.length,
    receptors: entries.map((e) => e.receptorId),
  });

  // Run all evaluations in parallel
  const evaluationPromises = entries.map(async (entry) => {
    const sense = library.get(entry.receptorId);
    if (!sense) {
      log.warn(`Evaluator receptor not found: ${entry.receptorId}`);
      return null;
    }

    const activationPath = library.getAncestorPath(sense.id);

    // When thalamus is available, get per-receptor trend context + principles
    let trendContext: string | undefined;
    if (thalamus) {
      const evalBriefing = await thalamus.forEvaluation(task, sense.id, activationPath);
      const parts: string[] = [];
      if (evalBriefing.receptorTrends.length > 0) {
        const trend = evalBriefing.receptorTrends[0];
        parts.push(`YOUR RECENT TREND:\n- ${trend.direction} (current mean: ${trend.currentMean.toFixed(1)}, previous: ${trend.previousMean.toFixed(1)}, across ${trend.dataPoints} task(s))`);
      }
      if (evalBriefing.relevantPrinciples && evalBriefing.relevantPrinciples.length > 0) {
        parts.push(`PRINCIPLES FROM EXPERIENCE:\n${evalBriefing.relevantPrinciples.map((p) => `- (${p.confidence.toFixed(2)} confidence) ${p.statement}`).join("\n")}`);
      }
      if (parts.length > 0) trendContext = parts.join("\n\n");
    }

    try {
      const result = await callStructured(
        "evaluation",
        config.models.evaluation,
        evaluatorSystem(sense, activationPath),
        evaluatorUser(task, work, entry.parentPerspective, trendContext),
        EvaluationResult
      );

      const evaluation = {
        senseId: sense.id,
        activationPath,
        score: result.score,
        acceptable: result.acceptable,
        assessment: result.assessment,
        tensions: result.tensions,
        suggestions: result.suggestions,
      } satisfies SenseEvaluation;

      emit("evaluation:score", {
        path: evaluation.activationPath.join(" > "),
        score: evaluation.score,
        acceptable: evaluation.acceptable,
        assessment: evaluation.assessment,
      });

      return evaluation;
    } catch (err) {
      log.warn(`Evaluation failed for ${activationPath.join(" > ")}`, {
        error: String(err),
      });
      return null;
    }
  });

  const results = await Promise.all(evaluationPromises);
  const evaluations = results.filter(
    (r): r is SenseEvaluation => r !== null
  );

  emit("evaluation:complete", {
    scores: evaluations.map((e) => ({
      path: e.activationPath.join(" > "),
      score: e.score,
    })),
  });

  log.info("Evaluations complete", {
    scores: evaluations.map((e) => ({
      path: e.activationPath.join(" > "),
      score: e.score,
    })),
  });

  return evaluations;
}
