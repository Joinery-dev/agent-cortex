/**
 * Dopamine — pure reward prediction error computation.
 *
 * dopamine = actual - predicted
 *
 * Positive = pleasant surprise (actual better than expected).
 * Negative = disappointment (actual worse than expected).
 * Zero = as expected (no learning signal).
 *
 * No state, no side effects. The Cerebellum class calls these
 * after evaluation to produce the learning gradient.
 */

import type { SenseEvaluation } from "../types/sense.js";
import type { Consultation } from "../types/consultation.js";
import type {
  CerebellumPrediction,
  ReceptorDopamine,
  DopamineSignal,
} from "../types/cerebellum.js";

/**
 * Compute the full dopamine signal by comparing predictions to actuals.
 *
 * Matching: predicted receptors are matched to actual evaluations by
 * senseId (the evaluation's senseId IS the receptor ID in this system).
 *
 * Aggregate: stake-weighted mean of per-receptor deltas.
 * Confidence-modulated: aggregate *= overall prediction confidence.
 */
export function computeDopamine(
  prediction: CerebellumPrediction,
  evaluations: SenseEvaluation[],
  consultation: Consultation,
): DopamineSignal {
  // Build lookup: receptorId → actual score
  const actualByReceptor = new Map<string, number>();
  for (const evaluation of evaluations) {
    actualByReceptor.set(evaluation.senseId, evaluation.score);
  }

  // Build lookup: receptorId → stake (from evaluation plan)
  const stakeByReceptor = new Map<string, number>();
  for (const entry of consultation.evaluationPlan) {
    stakeByReceptor.set(entry.receptorId, entry.parentStake);
  }

  const perReceptor: ReceptorDopamine[] = [];

  for (const rp of prediction.receptorPredictions) {
    const actual = actualByReceptor.get(rp.receptorId);
    if (actual === undefined) continue; // Receptor was predicted but not evaluated

    perReceptor.push({
      receptorId: rp.receptorId,
      predicted: rp.predicted,
      actual,
      delta: actual - rp.predicted,
      confidence: rp.confidence,
    });
  }

  // Raw aggregate: stake-weighted mean of deltas
  let rawAggregate = 0;
  if (perReceptor.length > 0) {
    let totalStake = 0;
    let weightedDelta = 0;

    for (const rd of perReceptor) {
      const stake = stakeByReceptor.get(rd.receptorId) ?? 1;
      weightedDelta += stake * rd.delta;
      totalStake += stake;
    }

    rawAggregate = totalStake > 0 ? weightedDelta / totalStake : 0;
  }

  // Confidence-modulated aggregate
  const aggregate = rawAggregate * prediction.overallConfidence;

  return {
    taskId: prediction.taskId,
    perReceptor,
    aggregate,
    rawAggregate,
    predictionConfidence: prediction.overallConfidence,
  };
}

/**
 * Compute prediction accuracy for a single task (for the accuracy window).
 *
 * Returns 0–1 where 1 = perfect predictions, 0 = maximally wrong.
 * Formula: 1 - (mean |predicted - actual| / 9)
 * The 9 is the max possible error on a 1–10 scale.
 */
export function computeAccuracy(
  prediction: CerebellumPrediction,
  evaluations: SenseEvaluation[],
): { accuracy: number; meanAbsoluteError: number; receptorCount: number } {
  const actualByReceptor = new Map<string, number>();
  for (const evaluation of evaluations) {
    actualByReceptor.set(evaluation.senseId, evaluation.score);
  }

  let totalError = 0;
  let count = 0;

  for (const rp of prediction.receptorPredictions) {
    const actual = actualByReceptor.get(rp.receptorId);
    if (actual === undefined) continue;

    totalError += Math.abs(rp.predicted - actual);
    count++;
  }

  if (count === 0) {
    return { accuracy: 0.8, meanAbsoluteError: 0, receptorCount: 0 };
  }

  const meanAbsoluteError = totalError / count;
  const accuracy = Math.max(0, 1 - meanAbsoluteError / 9);

  return { accuracy, meanAbsoluteError, receptorCount: count };
}
