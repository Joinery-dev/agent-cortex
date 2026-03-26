/**
 * Evaluation Weighter — pure computation layer.
 *
 * Joins evaluation scores with consultation stakes to produce
 * weighted composites. No LLM calls, no side effects, no state.
 *
 * The stake comes from each sense's self-assessed relevance during
 * consultation. Receptors inherit their parent sense's stake.
 * The stakeAdjuster hook allows Plasticity (Phase 3) to calibrate
 * stake accuracy based on dopamine signal.
 */

import type { SenseEvaluation, TensionFlag, ImprovementPotential, EvaluatorObservation } from "../types/sense.js";
import type { Consultation } from "../types/consultation.js";

// ─── Types ───────────────────────────────────────────────────────

/** A sense evaluation enriched with stake and weighted score. */
export interface WeightedEvaluation {
  senseId: string;
  activationPath: string[];
  score: number;
  acceptable: boolean;
  assessment: string;
  tensions: TensionFlag[];
  suggestions: string[];
  /** Would re-engaging the parent sense's consultation meaningfully improve the work? */
  improvementPotential: ImprovementPotential;
  /** Structured observations from agentic evaluation — what the evaluator actually saw/measured. */
  observations?: EvaluatorObservation[];
  /** Stake inherited from the parent sense's consultation. */
  stake: number;
  /** Stake after adjustment by Plasticity (identity for now). */
  adjustedStake: number;
  /** score * adjustedStake */
  weightedScore: number;
}

/** Aggregated composite from all weighted evaluations. */
export interface WeightedComposite {
  /** Weighted mean: sum(score * adjustedStake) / sum(adjustedStake). 0–10 scale. */
  weightedMean: number;
  /** Weighted acceptability: sum(adjustedStake * acceptable) / sum(adjustedStake). 0–1. */
  weightedAcceptability: number;
  /** weightedMean / 10, normalized to 0–1. Replaces old computeConfidence(). */
  confidence: number;
  /** Mean of all stakes — strategies use this as the relevance baseline. */
  meanStake: number;
  /** All weighted evaluations, for downstream consumers. */
  evaluations: WeightedEvaluation[];
}

/**
 * Plasticity hook: adjusts a sense's self-assessed stake based on
 * learned calibration. Identity function until Phase 3.
 */
export type StakeAdjuster = (senseId: string, rawStake: number) => number;

/** Default: no adjustment. */
export const identityAdjuster: StakeAdjuster = (_senseId, rawStake) => rawStake;

// ─── Functions ───────────────────────────────────────────────────

/**
 * Join evaluations with their parent sense's stake from the consultation.
 *
 * Receptors inherit their parent sense's stake. The parent is identified
 * by matching activationPath[0] (the root sense name) against
 * perspective.senseName in the consultation.
 *
 * If a receptor's parent sense isn't found in the consultation (shouldn't
 * happen, but defensive), stake defaults to 0.
 */
export function weighEvaluations(
  evaluations: SenseEvaluation[],
  consultation: Consultation,
  adjuster: StakeAdjuster = identityAdjuster,
): WeightedEvaluation[] {
  // Build lookup: senseName → stake from pre-computed distribution
  const stakeByName = new Map<string, { stake: number; senseId: string }>();
  for (const entry of consultation.stakeDistribution.entries) {
    stakeByName.set(entry.senseName, {
      stake: entry.stake,
      senseId: entry.senseId,
    });
  }

  return evaluations.map((evaluation): WeightedEvaluation => {
    const rootSenseName = evaluation.activationPath[0];
    const parent = stakeByName.get(rootSenseName);
    const rawStake = parent?.stake ?? 0;
    const parentSenseId = parent?.senseId ?? evaluation.senseId;
    const adjustedStake = adjuster(parentSenseId, rawStake);

    return {
      senseId: evaluation.senseId,
      activationPath: evaluation.activationPath,
      score: evaluation.score,
      acceptable: evaluation.acceptable,
      assessment: evaluation.assessment,
      tensions: evaluation.tensions,
      suggestions: evaluation.suggestions,
      improvementPotential: evaluation.improvementPotential,
      observations: evaluation.observations,
      stake: rawStake,
      adjustedStake,
      weightedScore: evaluation.score * adjustedStake,
    };
  });
}

/**
 * Join evaluations with externally-provided stakes (no consultation required).
 *
 * Used by integration checks where stakes are derived from WM score history
 * rather than a consultation's stake distribution. Root sense name is read
 * from activationPath[0], same as weighEvaluations().
 */
export function weighEvaluationsWithStakes(
  evaluations: SenseEvaluation[],
  stakeMap: Map<string, number>,
  adjuster: StakeAdjuster = identityAdjuster,
): WeightedEvaluation[] {
  return evaluations.map((evaluation): WeightedEvaluation => {
    const rootSenseName = evaluation.activationPath[0];
    const rawStake = stakeMap.get(rootSenseName) ?? 0;
    const adjustedStake = adjuster(evaluation.senseId, rawStake);

    return {
      senseId: evaluation.senseId,
      activationPath: evaluation.activationPath,
      score: evaluation.score,
      acceptable: evaluation.acceptable,
      assessment: evaluation.assessment,
      tensions: evaluation.tensions,
      suggestions: evaluation.suggestions,
      improvementPotential: evaluation.improvementPotential,
      stake: rawStake,
      adjustedStake,
      weightedScore: evaluation.score * adjustedStake,
    };
  });
}

/**
 * Compute aggregate composite from weighted evaluations.
 *
 * Pure math — no strategy logic. Strategies interpret the composite
 * differently (deliberative checks consensus, democratic checks majority, etc.).
 */
export function computeComposite(
  weighted: WeightedEvaluation[],
): WeightedComposite {
  if (weighted.length === 0) {
    return {
      weightedMean: 0,
      weightedAcceptability: 0,
      confidence: 0,
      meanStake: 0,
      evaluations: [],
    };
  }

  const totalStake = weighted.reduce((sum, w) => sum + w.adjustedStake, 0);

  // Guard against all-zero stakes (every sense said "not my business")
  if (totalStake === 0) {
    const rawMean = weighted.reduce((sum, w) => sum + w.score, 0) / weighted.length;
    return {
      weightedMean: rawMean,
      weightedAcceptability: 0,
      confidence: rawMean / 10,
      meanStake: 0,
      evaluations: weighted,
    };
  }

  const weightedMean = weighted.reduce((sum, w) => sum + w.weightedScore, 0) / totalStake;
  const weightedAcceptability = weighted.reduce(
    (sum, w) => sum + w.adjustedStake * (w.acceptable ? 1 : 0),
    0,
  ) / totalStake;
  const meanStake = totalStake / weighted.length;

  return {
    weightedMean,
    weightedAcceptability,
    confidence: weightedMean / 10,
    meanStake,
    evaluations: weighted,
  };
}
