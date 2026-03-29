import { z } from "zod";
import type { SenseEvaluation } from "../types/sense.js";
import type { Tension, TensionResolution } from "../types/tension.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { WeightedEvaluation } from "./evaluation-weighter.js";
import { callStructured } from "../llm/structured.js";
import { resolverSystem, resolverUser } from "../llm/prompts.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

const log = createLogger("resolver");

const ResolutionResult = z.object({
  strategy: z.string(),
  satisfiesBoth: z.boolean(),
  revisedInstructions: z.string(),
});

const SCORE_GAP_THRESHOLD = 4;
const LOW_SCORE_THRESHOLD = 5;

/**
 * Compute tension severity modulated by stake.
 *
 * Base severity comes from score gap. The max stake of the two senses
 * modulates: if both senses have low stake (below meanStake), severity
 * is capped at "low" regardless of gap — low-stake disagreements
 * don't warrant revision cycles.
 */
function computeSeverity(
  gap: number,
  stakeA: number,
  stakeB: number,
  meanStake: number,
): "low" | "medium" | "high" {
  const baseSeverity: "low" | "medium" | "high" =
    gap >= 6 ? "high" : gap >= 4 ? "medium" : "low";

  // Both senses below mean stake → cap at low
  if (stakeA <= meanStake && stakeB <= meanStake) {
    return "low";
  }

  return baseSeverity;
}

/**
 * Detect tensions from weighted evaluation results.
 *
 * Tensions arise from:
 * 1. Score disparity — two senses disagree by more than SCORE_GAP_THRESHOLD
 * 2. Explicit flags — senses flagged tensions in their evaluations
 *
 * Severity is modulated by stake: low-stake disagreements produce
 * at most "low" severity. High-stake disagreements keep their
 * base severity.
 */
export function detectTensions(
  evaluations: WeightedEvaluation[],
  taskId: string,
): Tension[] {
  const tensions: Tension[] = [];
  const seen = new Set<string>();

  // Compute mean stake for severity modulation
  const meanStake = evaluations.length > 0
    ? evaluations.reduce((sum, e) => sum + e.adjustedStake, 0) / evaluations.length
    : 0;

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
            stake: high.adjustedStake,
          },
          senseB: {
            id: low.senseId,
            path: low.activationPath,
            score: low.score,
            assessment: low.assessment,
            stake: low.adjustedStake,
          },
          description: `${high.activationPath.join(" > ")} scores ${high.score}/10 while ${low.activationPath.join(" > ")} scores ${low.score}/10 — a gap of ${gap} points`,
          severity: computeSeverity(gap, high.adjustedStake, low.adjustedStake, meanStake),
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
            stake: eval_.adjustedStake,
          },
          senseB: {
            id: matchingEval.senseId,
            path: matchingEval.activationPath,
            score: matchingEval.score,
            assessment: matchingEval.assessment,
            stake: matchingEval.adjustedStake,
          },
          description: flag.description,
          severity: computeSeverity(
            Math.abs(eval_.score - matchingEval.score),
            eval_.adjustedStake,
            matchingEval.adjustedStake,
            meanStake,
          ),
        });
      }
    }
  }

  for (const t of tensions) {
    emit("tension:detected", {
      severity: t.severity,
      description: t.description,
      senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score, stake: t.senseA.stake },
      senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score, stake: t.senseB.stake },
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

    getContentStore().record({
      eventSeq: null, kind: "tension-resolution", timestamp: new Date().toISOString(),
      component: "resolver", taskId: null,
      inputs: [
        contentBlock("Tension", tension.description),
        contentBlock(`Sense A: ${tension.senseA.path.join(" > ")}`, `Score: ${tension.senseA.score}/10, stake: ${(tension.senseA.stake ?? 0).toFixed(2)}`),
        contentBlock(`Sense B: ${tension.senseB.path.join(" > ")}`, `Score: ${tension.senseB.score}/10, stake: ${(tension.senseB.stake ?? 0).toFixed(2)}`),
      ],
      outputs: [
        contentBlock("Resolution strategy", result.strategy),
        contentBlock("Revised instructions", result.revisedInstructions),
        contentBlock("Satisfies both?", result.satisfiesBoth ? "Yes" : "No"),
      ],
      routing: { destinations: ["motor-cortex (revision context)", "gate (resolution quality)"] },
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
