import { z } from "zod";
import type { SenseEvaluation } from "../types/sense.js";
import type { Tension, TensionResolution } from "../types/tension.js";
import type { CortexConfig } from "../types/orchestrator.js";
import { callStructured } from "../llm/structured.js";
import { resolverSystem, resolverUser } from "../llm/prompts.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("resolver");

const ResolutionResult = z.object({
  strategy: z.string(),
  satisfiesBoth: z.boolean(),
  revisedInstructions: z.string(),
});

const SCORE_GAP_THRESHOLD = 4;
const LOW_SCORE_THRESHOLD = 5;

/**
 * Detect tensions from evaluation results.
 *
 * Tensions arise from:
 * 1. Score disparity — two senses disagree by more than SCORE_GAP_THRESHOLD
 * 2. Explicit flags — senses flagged tensions in their evaluations
 * 3. Low absolute scores — any sense below LOW_SCORE_THRESHOLD
 */
export function detectTensions(
  evaluations: SenseEvaluation[],
  taskId: string
): Tension[] {
  const tensions: Tension[] = [];
  const seen = new Set<string>();

  // 1. Score disparity between sense pairs
  for (let i = 0; i < evaluations.length; i++) {
    for (let j = i + 1; j < evaluations.length; j++) {
      const a = evaluations[i];
      const b = evaluations[j];
      const gap = Math.abs(a.score - b.score);

      if (gap >= SCORE_GAP_THRESHOLD) {
        const key = [a.senseId, b.senseId].sort().join(":");
        if (seen.has(key)) continue;
        seen.add(key);

        const [high, low] =
          a.score > b.score ? [a, b] : [b, a];

        tensions.push({
          id: newId(),
          taskId,
          senseA: {
            id: high.senseId,
            path: high.activationPath,
            score: high.score,
            assessment: high.assessment,
          },
          senseB: {
            id: low.senseId,
            path: low.activationPath,
            score: low.score,
            assessment: low.assessment,
          },
          description: `${high.activationPath.join(" > ")} scores ${high.score}/10 while ${low.activationPath.join(" > ")} scores ${low.score}/10 — a gap of ${gap} points`,
          severity: gap >= 6 ? "high" : gap >= 4 ? "medium" : "low",
        });
      }
    }
  }

  // 2. Explicit tension flags from evaluators
  for (const eval_ of evaluations) {
    for (const flag of eval_.tensions) {
      const matchingEval = evaluations.find((e) =>
        e.activationPath.some(
          (p) => p.toLowerCase() === flag.withDimension.toLowerCase()
        )
      );

      if (matchingEval) {
        const key = [eval_.senseId, matchingEval.senseId]
          .sort()
          .join(":");
        if (seen.has(key)) continue;
        seen.add(key);

        tensions.push({
          id: newId(),
          taskId,
          senseA: {
            id: eval_.senseId,
            path: eval_.activationPath,
            score: eval_.score,
            assessment: eval_.assessment,
          },
          senseB: {
            id: matchingEval.senseId,
            path: matchingEval.activationPath,
            score: matchingEval.score,
            assessment: matchingEval.assessment,
          },
          description: flag.description,
          severity: "medium",
        });
      }
    }
  }

  for (const t of tensions) {
    emit("tension:detected", {
      severity: t.severity,
      description: t.description,
      senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score },
      senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score },
    });
  }

  log.info("Tension detection complete", {
    total: tensions.length,
    high: tensions.filter((t) => t.severity === "high").length,
    medium: tensions.filter((t) => t.severity === "medium").length,
    low: tensions.filter((t) => t.severity === "low").length,
  });

  return tensions;
}

/**
 * Resolve detected tensions by finding creative synthesis.
 */
export async function resolve(
  tensions: Tension[],
  work: string,
  config: CortexConfig
): Promise<TensionResolution[]> {
  if (tensions.length === 0) return [];

  // Prioritize: resolve high severity first, then medium
  const toResolve = tensions
    .filter((t) => t.severity !== "low")
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.severity] - order[b.severity];
    });

  emit("resolution:start", { count: toResolve.length });
  log.info("Resolving tensions", { count: toResolve.length });

  const resolutionPromises = toResolve.map(async (tension) => {
    const result = await callStructured(
      "resolution",
      config.models.resolution,
      resolverSystem(),
      resolverUser(tension, work),
      ResolutionResult
    );

    tension.resolution = result;

    emit("resolution:complete", {
      tension: tension.description,
      strategy: result.strategy,
      satisfiesBoth: result.satisfiesBoth,
      revisedInstructions: result.revisedInstructions,
    });

    log.info("Tension resolved", {
      tension: tension.description,
      strategy: result.strategy,
      satisfiesBoth: result.satisfiesBoth,
    });

    return result;
  });

  return Promise.all(resolutionPromises);
}
