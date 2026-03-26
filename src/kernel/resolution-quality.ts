/**
 * Resolution Quality — pure computation layer.
 *
 * Measures whether tension resolutions actually worked by comparing
 * pre-resolution scores (cycle N) to post-resolution scores (cycle N+1).
 * No LLM calls, no side effects, no state.
 *
 * Quality captures two dimensions (approach C):
 *   1. Gap shrinkage — did the two senses converge?
 *   2. Score maintenance — did neither sense's score drop?
 *
 * Collapsed resolutions (capitulation, not synthesis) produce quality = 0.
 * This is the feedback signal that flows to Plasticity (short-term) and
 * Hippocampus episodes (long-term crystallization).
 */

import type { Tension, ResolutionOutcome } from "../types/tension.js";
import type { WeightedEvaluation } from "./evaluation-weighter.js";
import type { CollapseSignal } from "../types/collapse.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("resolution-quality");

// ─── Quality formula ────────────────────────────────────────────

/**
 * Compute the quality of a single resolution attempt.
 *
 * @param preGap   |scoreA - scoreB| before resolution
 * @param postGap  |scoreA - scoreB| after resolution
 * @param senseADelta  postScoreA - preScoreA (positive = improved)
 * @param senseBDelta  postScoreB - preScoreB (positive = improved)
 * @param collapsed  collapse detection flagged this as capitulation
 */
export function computeQuality(
  preGap: number,
  postGap: number,
  senseADelta: number,
  senseBDelta: number,
  collapsed: boolean,
): number {
  if (collapsed) return 0;

  // Gap shrinkage: 1.0 if fully closed, 0.0 if unchanged, 0 floor if grew
  const gapShrinkageScore =
    preGap > 0 ? Math.max(0, Math.min(1, (preGap - postGap) / preGap)) : 1;

  // Score maintenance: penalize if either sense dropped
  let maintenanceScore: number;
  if (senseADelta >= 0 && senseBDelta >= 0) {
    // Both held or improved — genuine synthesis
    maintenanceScore = 1.0;
  } else if (senseADelta >= -1 && senseBDelta >= -1) {
    // Minor drop (≤1 point) on one side — acceptable trade-off
    maintenanceScore = 0.7;
  } else if (senseADelta < -1 && senseBDelta < -1) {
    // Both dropped significantly — resolution made everything worse
    maintenanceScore = 0.0;
  } else {
    // One side dropped significantly — compromise, not synthesis
    maintenanceScore = 0.3;
  }

  return gapShrinkageScore * 0.5 + maintenanceScore * 0.5;
}

// ─── Score maintenance check ────────────────────────────────────

function checkScoresMaintained(
  senseADelta: number,
  senseBDelta: number,
): boolean {
  // "Maintained" = neither sense dropped by more than 1 point
  return senseADelta >= -1 && senseBDelta >= -1;
}

// ─── Outcome computation ────────────────────────────────────────

/**
 * Compute resolution outcomes by comparing pre/post weighted evaluations
 * for each resolved tension.
 *
 * @param resolvedTensions Tensions that had resolutions applied (from acc.allTensions)
 * @param preWeighted      Weighted evaluations from the cycle that triggered resolution
 * @param postWeighted     Weighted evaluations from the cycle after resolution
 * @param collapseSignal   Collapse detection result (may be null on first cycle)
 */
export function computeResolutionOutcomes(
  resolvedTensions: Tension[],
  preWeighted: WeightedEvaluation[],
  postWeighted: WeightedEvaluation[],
  collapseSignal: CollapseSignal | null,
): ResolutionOutcome[] {
  // Only process tensions that actually have resolutions
  const withResolutions = resolvedTensions.filter((t) => t.resolution);
  if (withResolutions.length === 0) return [];

  // Index evaluations by senseId for O(1) lookup
  const preByIdMap = new Map(preWeighted.map((e) => [e.senseId, e]));
  const postByIdMap = new Map(postWeighted.map((e) => [e.senseId, e]));

  // Index collapse details by tensionId
  const collapseByTension = new Map(
    collapseSignal?.details.map((d) => [d.tensionId, d]) ?? [],
  );

  const outcomes: ResolutionOutcome[] = [];

  for (const tension of withResolutions) {
    const preA = preByIdMap.get(tension.senseA.id);
    const preB = preByIdMap.get(tension.senseB.id);
    const postA = postByIdMap.get(tension.senseA.id);
    const postB = postByIdMap.get(tension.senseB.id);

    // Need both senses present in both cycles to measure
    if (!preA || !preB || !postA || !postB) {
      log.debug("Skipping outcome — sense missing from evaluation cycle", {
        tensionId: tension.id,
        senseA: tension.senseA.id,
        senseB: tension.senseB.id,
        hasPre: [!!preA, !!preB],
        hasPost: [!!postA, !!postB],
      });
      continue;
    }

    const preGap = Math.abs(preA.score - preB.score);
    const postGap = Math.abs(postA.score - postB.score);
    const gapShrinkage = preGap - postGap;
    const senseADelta = postA.score - preA.score;
    const senseBDelta = postB.score - preB.score;

    const collapseDetail = collapseByTension.get(tension.id);
    const collapsed = collapseDetail?.collapsed ?? false;

    const quality = computeQuality(
      preGap,
      postGap,
      senseADelta,
      senseBDelta,
      collapsed,
    );

    const outcome: ResolutionOutcome = {
      tensionId: tension.id,
      senseAId: tension.senseA.id,
      senseBId: tension.senseB.id,
      preScores: { senseA: preA.score, senseB: preB.score },
      postScores: { senseA: postA.score, senseB: postB.score },
      preGap,
      postGap,
      gapShrinkage,
      scoresMaintained: checkScoresMaintained(senseADelta, senseBDelta),
      quality,
      collapsed,
    };

    outcomes.push(outcome);

    log.info("Resolution outcome measured", {
      tensionId: tension.id,
      senseA: tension.senseA.path.join(" > "),
      senseB: tension.senseB.path.join(" > "),
      preGap,
      postGap,
      quality: quality.toFixed(2),
      collapsed,
    });
  }

  if (outcomes.length > 0) {
    emit("resolution:outcomes-measured", {
      count: outcomes.length,
      meanQuality:
        outcomes.reduce((sum, o) => sum + o.quality, 0) / outcomes.length,
      collapsed: outcomes.filter((o) => o.collapsed).length,
    });
  }

  return outcomes;
}
