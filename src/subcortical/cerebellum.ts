/**
 * Cerebellum — prediction engine.
 *
 * Forward models: given this task + these senses, predict evaluation
 * scores before building. Compares predictions to actual outcomes.
 * The delta IS the dopamine signal.
 *
 * Stateful class: holds episode store, pending predictions, and
 * accuracy history. All computation delegated to pure functions
 * in forward-model.ts and dopamine.ts.
 *
 * Follows the WorkingMemory/Thalamus pattern: class with explicit
 * methods, event emission, and a serializable snapshot.
 */

import type { Consultation } from "../types/consultation.js";
import type { SenseEvaluation } from "../types/sense.js";
import type {
  CerebellumConfig,
  CerebellumEpisode,
  CerebellumPrediction,
  SpeedOfLight,
  SenseCeiling,
  ApproachCeiling,
  DopamineSignal,
  AccuracyRecord,
  TaskFingerprint,
  ScoredEpisode,
} from "../types/cerebellum.js";
import { DEFAULT_CEREBELLUM_CONFIG } from "../types/cerebellum.js";
import type { Sense } from "../types/sense.js";
import type { SensoryCortex } from "../senses/cortex.js";
import {
  extractFingerprint,
  extractPreliminaryFingerprint,
  findSimilarEpisodes,
  predictFromEpisodes,
  computeOverallConfidence,
  computeSpeedOfLight,
  filterByApproachTags,
  computeApproachCeiling,
} from "./forward-model.js";
import { classifyApproach as classifyApproachLLM } from "./approach-classifier.js";
import { computeDopamine, computeAccuracy } from "./dopamine.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";

const log = createLogger("cerebellum");

/** Stored alongside the prediction for later outcome comparison. */
interface PendingPrediction {
  prediction: CerebellumPrediction;
  consultation: Consultation;
  fingerprint: TaskFingerprint;
}

export class Cerebellum {
  private episodes: CerebellumEpisode[] = [];
  private pending: Map<string, PendingPrediction> = new Map();
  private speedOfLightCache: Map<string, SpeedOfLight> = new Map();
  private approachTagCache: Map<string, string[]> = new Map();
  private failureModePredictionCache: Map<string, import("../types/cerebellum.js").FailureModePrediction> = new Map();
  private accuracyHistory: AccuracyRecord[] = [];
  private failureModeAccuracy: Array<{
    taskId: string;
    predicted: import("../types/motor-cortex.js").FailureCategory | null;
    actual: import("../types/motor-cortex.js").FailureCategory | null;
    correct: boolean;
    preempted: boolean;
    recordedAt: Date;
  }> = [];
  private sequenceCounter = 0;
  private config: CerebellumConfig;

  constructor(config?: Partial<CerebellumConfig>) {
    this.config = { ...DEFAULT_CEREBELLUM_CONFIG, ...config };
  }

  // ── Prediction ──────────────────────────────────────────────

  /**
   * Predict evaluation scores for a task before building.
   * Called after consultation, before the Explore phase.
   *
   * Returns null when there's insufficient data (cold start).
   * This is honest — no predictions when there's no basis.
   */
  predict(
    taskId: string,
    consultation: Consultation,
  ): CerebellumPrediction | null {
    const fingerprint = extractFingerprint(consultation);
    const matches = findSimilarEpisodes(
      fingerprint,
      this.episodes,
      this.config,
    );

    // Speed of light — always computed, even on cold start.
    // The theoretical ceiling comes from sense estimates (always available).
    // Historical enrichment comes from episodes (grows over time).
    const sol = computeSpeedOfLight(taskId, consultation, matches);
    this.speedOfLightCache.set(taskId, sol);

    log.info("Speed of light computed", {
      taskId,
      compositeCeiling: sol.compositeCeiling.toFixed(1),
      hasHistory: sol.hasHistory,
      senses: sol.perSense.map((s) => `${s.senseName}: ${s.ceiling}`).join(", "),
    });

    emit("cerebellum:speed-of-light", {
      taskId,
      compositeCeiling: sol.compositeCeiling,
      compositeBestAchieved: sol.compositeBestAchieved,
      compositeGap: sol.compositeGap,
      hasHistory: sol.hasHistory,
    });

    if (matches.length < this.config.minEpisodes) {
      log.info("Cold start — insufficient episodes for prediction", {
        taskId,
        episodeCount: this.episodes.length,
        matchesFound: matches.length,
        minRequired: this.config.minEpisodes,
      });

      emit("cerebellum:cold-start", {
        taskId,
        episodeCount: this.episodes.length,
        matchesFound: matches.length,
      });

      // Still store fingerprint + consultation so we can record
      // the episode (without dopamine) when the task completes
      this.pending.set(taskId, {
        prediction: null!,
        consultation,
        fingerprint,
      });

      return null;
    }

    const receptorPredictions = predictFromEpisodes(
      matches,
      consultation.evaluationPlan,
    );
    const overallConfidence = computeOverallConfidence(receptorPredictions);

    const prediction: CerebellumPrediction = {
      taskId,
      receptorPredictions,
      overallConfidence,
      episodeCount: matches.length,
      bestSimilarity: matches[0]?.similarity ?? 0,
      predictedAt: new Date(),
    };

    this.pending.set(taskId, { prediction, consultation, fingerprint });

    log.info("Prediction generated", {
      taskId,
      receptorCount: receptorPredictions.length,
      overallConfidence: overallConfidence.toFixed(3),
      episodesUsed: matches.length,
      bestSimilarity: prediction.bestSimilarity.toFixed(3),
    });

    emit("cerebellum:predict", {
      taskId,
      receptorCount: receptorPredictions.length,
      overallConfidence,
      episodesUsed: matches.length,
      bestSimilarity: prediction.bestSimilarity,
    });

    return prediction;
  }

  // ── Preliminary matching (for efference copy) ────────────────

  /**
   * Find similar episodes using a preliminary fingerprint — before
   * consultation. Used by the efference copy so the Motor Cortex
   * can assess feasibility before senses deliberate.
   *
   * Uses uniform stakes and all receptors per sense (directionally
   * correct, not precise). Returns raw episodes, no predictions.
   */
  findPreliminaryMatches(
    activeSenses: Sense[],
    library: SensoryCortex,
  ): ScoredEpisode[] {
    const fingerprint = extractPreliminaryFingerprint(activeSenses, library);
    return findSimilarEpisodes(fingerprint, this.episodes, this.config);
  }

  // ── Outcome recording ───────────────────────────────────────

  /**
   * Record the actual evaluation outcome and compute dopamine.
   * Called after the final evaluation, in between-tasks processing.
   *
   * Returns the dopamine signal, or null if no prediction was made
   * (cold start — the episode is still recorded for future use).
   */
  recordOutcome(
    taskId: string,
    evaluations: SenseEvaluation[],
    costData?: {
      cost: number;
      callCount: number;
      costByPurpose: Partial<Record<import("../llm/client.js").Purpose, number>>;
      modelsByPurpose?: Partial<Record<import("../llm/client.js").Purpose, string>>;
      briefingDepth?: import("../types/cost.js").BriefingDepth;
    },
    cycleData?: {
      outerCycles: number;
      attentionBudget?: { floor: number; expected: number; ceiling: number };
    },
    failureClassification?: import("../types/motor-cortex.js").FailureClassification,
  ): DopamineSignal | null {
    // Filter out degraded evaluations — the cerebellum must never learn from
    // garbage data. A degraded evaluation (e.g., from an agentic parse failure)
    // has a fake score that would corrupt prediction models and accuracy tracking.
    const cleanEvaluations = evaluations.filter((e) => !e.degraded);
    const degradedCount = evaluations.length - cleanEvaluations.length;

    if (cleanEvaluations.length === 0 && evaluations.length > 0) {
      // All evaluations are degraded — skip episode recording entirely.
      // No learning signal is better than a corrupted learning signal.
      log.warn("All evaluations degraded, skipping episode recording", {
        taskId,
        degradedCount,
      });
      emitWarn("cerebellum:all-evaluations-degraded", { taskId, degradedCount }, {
        component: "cerebellum",
        expected: "at least one genuine evaluation",
        received: `${degradedCount} degraded evaluations`,
      });
      this.pending.delete(taskId);
      this.speedOfLightCache.delete(taskId);
      this.approachTagCache.delete(taskId);
      return null;
    }

    if (degradedCount > 0) {
      log.info("Filtered degraded evaluations from outcome recording", {
        taskId,
        degradedCount,
        remainingCount: cleanEvaluations.length,
      });
    }

    const entry = this.pending.get(taskId);

    // Build actual score maps from clean evaluations only
    const receptorScores = new Map<string, number>();
    const senseTotals = new Map<string, { sum: number; count: number }>();

    for (const evaluation of cleanEvaluations) {
      receptorScores.set(evaluation.senseId, evaluation.score);

      // Aggregate to sense level
      const senseName = evaluation.activationPath[0];
      if (senseName) {
        const existing = senseTotals.get(senseName) ?? { sum: 0, count: 0 };
        existing.sum += evaluation.score;
        existing.count += 1;
        senseTotals.set(senseName, existing);
      }
    }

    const senseScores = new Map<string, number>();
    for (const [name, { sum, count }] of senseTotals) {
      senseScores.set(name, sum / count);
    }

    // Determine fingerprint: from pending entry or reconstruct minimally
    const fingerprint = entry?.fingerprint ?? {
      senseStakes: new Map<string, number>(),
      activeReceptors: new Set(receptorScores.keys()),
    };

    // Store predicted scores if a prediction was made
    const predictedScores = entry?.prediction?.receptorPredictions
      ? new Map(
          entry.prediction.receptorPredictions.map((rp) => [
            rp.receptorId,
            rp.predicted,
          ]),
        )
      : null;

    // Record episode (with V2 approach tags if classified)
    const approachTags = this.approachTagCache.get(taskId);
    const episode: CerebellumEpisode = {
      taskId,
      fingerprint,
      receptorScores,
      senseScores,
      predictedScores,
      approachTags: approachTags ?? undefined,
      sequenceNumber: this.sequenceCounter++,
      recordedAt: new Date(),
      // Cost metadata for cost prediction learning
      cost: costData?.cost,
      callCount: costData?.callCount,
      costByPurpose: costData?.costByPurpose,
      modelsByPurpose: costData?.modelsByPurpose,
      briefingDepth: costData?.briefingDepth,
      // Cycle metadata for attention budget learning
      outerCycles: cycleData?.outerCycles,
      attentionBudget: cycleData?.attentionBudget,
      // Failure classification metadata for failure mode prediction
      failureCategory: failureClassification?.category,
      failureConfidence: failureClassification?.confidence,
      failureObjectingSenseIds: failureClassification?.objectingSenseIds,
    };

    this.episodes.push(episode);

    // Prune if over max
    if (this.episodes.length > this.config.maxEpisodes) {
      const pruned = this.episodes.length - this.config.maxEpisodes;
      this.episodes = this.episodes.slice(pruned);
      log.debug("Pruned oldest episodes", { pruned });
    }

    // ── Failure mode prediction learning loop ──────────────────
    const fmpPrediction = this.failureModePredictionCache.get(taskId);
    if (fmpPrediction?.predicted) {
      const actualCategory = failureClassification?.category ?? null;
      const correct = actualCategory !== null && actualCategory === fmpPrediction.predicted;
      const preempted = actualCategory === null; // predicted failure didn't occur

      this.failureModeAccuracy.push({
        taskId,
        predicted: fmpPrediction.predicted,
        actual: actualCategory,
        correct,
        preempted,
        recordedAt: new Date(),
      });

      // Trim to accuracy window
      if (this.failureModeAccuracy.length > this.config.accuracyWindowSize) {
        this.failureModeAccuracy = this.failureModeAccuracy.slice(
          this.failureModeAccuracy.length - this.config.accuracyWindowSize,
        );
      }

      if (preempted) {
        emit("gate:failure-preempted", {
          taskId,
          predicted: fmpPrediction.predicted,
          confidence: fmpPrediction.confidence,
        });
        log.info("Failure preempted — predicted failure did not occur", {
          taskId,
          predicted: fmpPrediction.predicted,
        });
      } else if (!correct && actualCategory !== null) {
        emit("gate:failure-prediction-error", {
          taskId,
          predicted: fmpPrediction.predicted,
          actual: actualCategory,
        });
        log.info("Failure mode prediction error", {
          taskId,
          predicted: fmpPrediction.predicted,
          actual: actualCategory,
        });
      }
    }

    // Clean up pending state
    this.pending.delete(taskId);
    this.speedOfLightCache.delete(taskId);
    this.approachTagCache.delete(taskId);
    this.failureModePredictionCache.delete(taskId);

    // If no prediction was made, no dopamine — but episode is stored
    if (!entry?.prediction) {
      log.info("Episode recorded (no prediction, no dopamine)", { taskId });

      emit("cerebellum:episode", {
        taskId,
        hasPrediction: false,
        episodeCount: this.episodes.length,
      });

      return null;
    }

    // Compute dopamine from clean evaluations only
    const dopamine = computeDopamine(
      entry.prediction,
      cleanEvaluations,
      entry.consultation,
    );

    // Track accuracy from clean evaluations only
    const { accuracy, meanAbsoluteError, receptorCount } = computeAccuracy(
      entry.prediction,
      cleanEvaluations,
    );

    this.accuracyHistory.push({
      taskId,
      meanAbsoluteError,
      receptorCount,
      recordedAt: new Date(),
    });

    // Trim accuracy window
    if (this.accuracyHistory.length > this.config.accuracyWindowSize) {
      this.accuracyHistory = this.accuracyHistory.slice(
        this.accuracyHistory.length - this.config.accuracyWindowSize,
      );
    }

    log.info("Outcome recorded", {
      taskId,
      aggregateDopamine: dopamine.aggregate.toFixed(3),
      rawAggregate: dopamine.rawAggregate.toFixed(3),
      accuracy: accuracy.toFixed(3),
      receptorsMatched: dopamine.perReceptor.length,
      episodeCount: this.episodes.length,
    });

    emit("cerebellum:outcome", {
      taskId,
      aggregateDopamine: dopamine.aggregate,
      rawAggregate: dopamine.rawAggregate,
      accuracy,
      receptorsMatched: dopamine.perReceptor.length,
      episodeCount: this.episodes.length,
    });

    return dopamine;
  }

  // ── Vital signs ─────────────────────────────────────────────

  /**
   * Rolling prediction accuracy over the window.
   * Returns 0–1 where 1 = perfect. Returns 0.8 (healthy default)
   * when there's no accuracy history yet.
   */
  getAccuracy(): number {
    if (this.accuracyHistory.length === 0) return 0.8;

    const totalError = this.accuracyHistory.reduce(
      (sum, r) => sum + r.meanAbsoluteError,
      0,
    );
    const meanError = totalError / this.accuracyHistory.length;
    return Math.max(0, 1 - meanError / 9);
  }

  /**
   * Rolling failure mode prediction accuracy.
   * Tracks how often the predicted failure mode matches the actual,
   * plus the preemption rate (predicted failure didn't occur).
   */
  getFailureModeAccuracy(): { accuracy: number; preemptionRate: number; sampleCount: number } {
    if (this.failureModeAccuracy.length === 0) {
      return { accuracy: 0.8, preemptionRate: 0, sampleCount: 0 };
    }
    const total = this.failureModeAccuracy.length;
    const correct = this.failureModeAccuracy.filter((r) => r.correct).length;
    const preempted = this.failureModeAccuracy.filter((r) => r.preempted).length;
    return {
      accuracy: correct / total,
      preemptionRate: preempted / total,
      sampleCount: total,
    };
  }

  // ── Cost prediction ─────────────────────────────────────────

  /**
   * Predict the dollar cost of a task from similar episodes.
   * Uses the same similarity matching as score prediction.
   * Returns null on cold start (no episodes with cost data).
   */
  predictCost(fingerprint: import("../types/cerebellum.js").TaskFingerprint): number | null {
    const episodesWithCost = this.episodes.filter((e) => e.cost !== undefined);
    if (episodesWithCost.length < this.config.minEpisodes) return null;

    // Find similar episodes using existing similarity infrastructure
    const matches = findSimilarEpisodes(fingerprint, episodesWithCost, this.config);
    if (matches.length === 0) return null;

    // Weighted average cost by similarity
    let weightedSum = 0;
    let totalWeight = 0;
    for (const { episode, similarity } of matches) {
      if (episode.cost === undefined) continue;
      weightedSum += episode.cost * similarity;
      totalWeight += similarity;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : null;
  }

  /**
   * Predict quality (0–10) if a given model tier were used for a purpose.
   * Returns null when insufficient episodes used that model for that purpose.
   * Used by the ModelSelector for learned model downgrading.
   */
  predictQualityByModel(
    purpose: import("../llm/client.js").Purpose,
    modelTier: string,
  ): number | null {
    // Find episodes where this model tier was used for this purpose
    const relevant = this.episodes.filter((ep) => {
      if (!ep.modelsByPurpose) return false;
      const usedModel = ep.modelsByPurpose[purpose];
      return usedModel !== undefined && usedModel.includes(modelTier);
    });

    if (relevant.length < this.config.minEpisodes) return null;

    // Average composite score across those episodes
    let totalScore = 0;
    for (const ep of relevant) {
      let sum = 0;
      let count = 0;
      for (const score of ep.senseScores.values()) {
        sum += score;
        count++;
      }
      if (count > 0) totalScore += sum / count;
    }

    return totalScore / relevant.length;
  }

  // ── Cycle distribution prediction ───────────────────────────

  /**
   * Predict the outer cycle distribution for a task from similar episodes.
   * Returns similarity-weighted p10/p50/p90 percentiles, or null on cold start.
   *
   * Uses the same findSimilarEpisodes infrastructure as predictCost().
   * Only considers episodes that have outerCycles data — early episodes
   * without this field are skipped.
   */
  predictCycleDistribution(
    fingerprint: import("../types/cerebellum.js").TaskFingerprint,
  ): import("../types/attention-budget.js").CyclePercentiles | null {
    const episodesWithCycles = this.episodes.filter((e) => e.outerCycles !== undefined);
    if (episodesWithCycles.length < this.config.minEpisodes) return null;

    const matches = findSimilarEpisodes(fingerprint, episodesWithCycles, this.config);
    if (matches.length === 0) return null;

    // Collect cycle values weighted by similarity
    const weighted: Array<{ cycles: number; weight: number }> = [];
    for (const { episode, similarity } of matches) {
      if (episode.outerCycles === undefined) continue;
      weighted.push({ cycles: episode.outerCycles, weight: similarity });
    }

    if (weighted.length === 0) return null;

    // Sort by cycle count for percentile computation
    weighted.sort((a, b) => a.cycles - b.cycles);

    const p10 = weightedPercentile(weighted, 0.10);
    const p50 = weightedPercentile(weighted, 0.50);
    const p90 = weightedPercentile(weighted, 0.90);

    return { p10, p50, p90, episodeCount: weighted.length };
  }

  // ── Revision prediction gating ──────────────────────────────

  /**
   * Predict whether a revision cycle will produce enough improvement
   * to justify 50-100K+ tokens of premotor + motor + evaluation.
   *
   * Uses existing data (no LLM calls):
   *   - Speed-of-light gap for this task
   *   - Current composite score
   *   - Objecting sense scores from rejection drivers
   *   - Failure classification
   *
   * Conservative by default: shouldSkip requires confidence > revisionSkipConfidence.
   */
  predictRevisionDelta(input: {
    taskId: string;
    compositeScore: number;
    failureCategory: import("../types/motor-cortex.js").FailureCategory;
    objectingScores: number[];
  }): { predictedDelta: number; shouldSkip: boolean; confidence: number; reason: string } {
    const sol = this.speedOfLightCache.get(input.taskId);
    const solGap = sol?.compositeGap ?? null;

    // Note: specification-gap is handled by the build-cycle's early exit
    // (returns accepted=false before predictRevisionDelta is called).
    // No spec-gap case needed here.

    // Approach-bottleneck → delta = 0, revision won't help
    if (input.failureCategory === "approach-bottleneck") {
      return {
        predictedDelta: 0,
        shouldSkip: true,
        confidence: 0.65,
        reason: "Approach bottleneck: revision within current approach unlikely to improve outcome.",
      };
    }

    // SoL gap < 1.0 composite points AND all objecting senses are borderline (5-6)
    if (solGap !== null && solGap < 1.0 && input.objectingScores.length > 0) {
      const allBorderline = input.objectingScores.every((s) => s >= 5 && s <= 6);
      if (allBorderline) {
        const predictedDelta = solGap * 0.3; // optimistic: capture 30% of remaining gap
        const shouldSkip = predictedDelta < this.config.revisionDeltaThreshold;
        const confidence = 0.6;

        if (shouldSkip && confidence >= this.config.revisionSkipConfidence) {
          return {
            predictedDelta,
            shouldSkip: true,
            confidence,
            reason: `Near ceiling (SoL gap ${solGap.toFixed(2)}) with borderline objections (${input.objectingScores.map((s) => s.toFixed(1)).join(", ")}). Predicted delta ${predictedDelta.toFixed(2)} < threshold ${this.config.revisionDeltaThreshold}.`,
          };
        }
      }
    }

    // Default: let revision proceed
    return {
      predictedDelta: solGap ?? 2.0, // assume moderate improvement possible when no SoL data
      shouldSkip: false,
      confidence: 0.4,
      reason: "Revision may improve outcome.",
    };
  }

  // ── Failure mode prediction ─────────────────────────────────

  /**
   * Predict the likely failure mode for a task before building.
   *
   * Uses the same similarity matching infrastructure as score prediction.
   * Filters to episodes that have failure classification data, computes
   * a similarity-weighted vote over failure categories.
   *
   * Returns null on cold start (insufficient episodes with failure data).
   */
  predictFailureMode(
    taskId: string,
    fingerprint: import("../types/cerebellum.js").TaskFingerprint,
  ): import("../types/cerebellum.js").FailureModePrediction | null {
    const episodesWithFailure = this.episodes.filter((e) => e.failureCategory !== undefined);
    if (episodesWithFailure.length < this.config.minEpisodes) return null;

    const matches = findSimilarEpisodes(fingerprint, episodesWithFailure, this.config);
    if (matches.length === 0) return null;

    // Weighted vote over failure categories
    const votes = new Map<string, number>();
    let totalWeight = 0;

    for (const { episode, weight } of matches) {
      if (!episode.failureCategory) continue;
      const current = votes.get(episode.failureCategory) ?? 0;
      votes.set(episode.failureCategory, current + weight);
      totalWeight += weight;
    }

    if (totalWeight === 0) return null;

    // Normalize to distribution
    const distribution: Record<string, number> = {};
    let maxCategory: string | null = null;
    let maxShare = 0;

    for (const [category, weight] of votes) {
      const share = weight / totalWeight;
      distribution[category] = share;
      if (share > maxShare) {
        maxShare = share;
        maxCategory = category;
      }
    }

    // predicted = highest category if vote share > 0.4
    const predicted = maxCategory && maxShare > 0.4
      ? maxCategory as import("../types/motor-cortex.js").FailureCategory
      : null;

    // confidence = vote share × data sufficiency factor
    const confidence = maxShare * Math.min(1, matches.length / 5);

    const prediction: import("../types/cerebellum.js").FailureModePrediction = {
      predicted,
      distribution,
      confidence,
      episodesConsidered: matches.length,
    };

    // Cache for learning loop comparison in recordOutcome()
    this.failureModePredictionCache.set(taskId, prediction);

    log.info("Failure mode predicted", {
      predicted,
      confidence: confidence.toFixed(3),
      episodesConsidered: matches.length,
      distribution,
    });

    emit("cerebellum:failure-mode-predicted", {
      predicted,
      confidence,
      episodesConsidered: matches.length,
      distribution,
    });

    return prediction;
  }

  /** Number of episodes stored. */
  getEpisodeCount(): number {
    return this.episodes.length;
  }

  // ── Speed of light ──────────────────────────────────────────

  /**
   * Retrieve the speed of light computed during predict().
   * Available even on cold start (sense ceilings always exist).
   */
  getSpeedOfLight(taskId: string): SpeedOfLight | null {
    return this.speedOfLightCache.get(taskId) ?? null;
  }

  /**
   * Composite ceiling from the most recently computed SoL.
   * Returns null if no SoL has been computed yet.
   */
  getCompositeCeiling(): number | null {
    const latest = this.getLatestSpeedOfLight();
    return latest?.compositeCeiling ?? null;
  }

  /**
   * Per-sense ceilings from the most recently computed SoL.
   * Returns empty array if no SoL has been computed yet.
   */
  getPerSenseCeilings(): SenseCeiling[] {
    const latest = this.getLatestSpeedOfLight();
    return latest?.perSense ?? [];
  }

  /**
   * Approach bottleneck info from the most recently computed SoL.
   * Returns null if no approach-specific data exists.
   */
  getApproachBottleneckInfo(): { approachIsBottleneck: boolean; bottleneckGap: number | null } | null {
    const latest = this.getLatestSpeedOfLight();
    if (!latest?.approachSpecific) return null;
    return {
      approachIsBottleneck: latest.approachSpecific.approachIsBottleneck,
      bottleneckGap: latest.approachSpecific.bottleneckGap,
    };
  }

  /** Most recently cached SoL (by computedAt). */
  private getLatestSpeedOfLight(): SpeedOfLight | null {
    let latest: SpeedOfLight | null = null;
    for (const sol of this.speedOfLightCache.values()) {
      if (!latest || sol.computedAt > latest.computedAt) {
        latest = sol;
      }
    }
    return latest;
  }

  // ── V2: Approach classification ─────────────────────────────

  /**
   * Classify a premotor plan's approach into archetype tags, then
   * compute an approach-specific ceiling by filtering historical
   * episodes to those with matching tags.
   *
   * Called from build-cycle.execute after the Motor Cortex plans.
   * Attaches the result as `approachSpecific` on the cached SpeedOfLight.
   * Tags are stored by taskId for later episode recording.
   */
  async classifyAndEstimate(
    taskId: string,
    taskDescription: string,
    approach: string,
    model: string,
  ): Promise<ApproachCeiling | null> {
    let tags: string[];
    try {
      tags = await classifyApproachLLM(taskDescription, approach, model);
    } catch (err) {
      log.warn("Approach classification failed", { taskId, error: String(err) });
      return null;
    }

    // Store tags for later episode recording
    this.approachTagCache.set(taskId, tags);

    // Get the V1 speed of light (computed during predict)
    const sol = this.speedOfLightCache.get(taskId);
    if (!sol) {
      log.debug("No speed of light cached — approach classified but no ceiling comparison", { taskId, tags });
      emit("cerebellum:approach-classified", { taskId, tags, hasCeiling: false });
      return null;
    }

    // Recompute similar episodes (cheap — O(50))
    const pending = this.pending.get(taskId);
    const fingerprint = pending?.fingerprint;
    const matches = fingerprint
      ? findSimilarEpisodes(fingerprint, this.episodes, this.config)
      : [];

    // Filter to approach-matched episodes
    const approachMatches = filterByApproachTags(matches, tags);
    const approachCeiling = computeApproachCeiling(sol, approachMatches, tags);

    // Attach to cached SpeedOfLight
    sol.approachSpecific = approachCeiling;

    log.info("Approach classified and ceiling estimated", {
      taskId,
      tags,
      episodesConsidered: approachCeiling.episodesConsidered,
      approachIsBottleneck: approachCeiling.approachIsBottleneck,
      bottleneckGap: approachCeiling.bottleneckGap?.toFixed(2) ?? "n/a",
    });

    emit("cerebellum:approach-classified", {
      taskId,
      tags,
      hasCeiling: true,
      approachIsBottleneck: approachCeiling.approachIsBottleneck,
      episodesConsidered: approachCeiling.episodesConsidered,
    });

    return approachCeiling;
  }

  // ── Recalibration ───────────────────────────────────────────

  /**
   * Recalibrate the forward model. Called during rest cycles
   * when predictionAccuracy drops below threshold.
   *
   * For now: prune oldest episodes and trim accuracy history.
   * Future: could re-weight similarity dimensions, adjust
   * decay rate, or cluster episodes.
   */
  recalibrate(): { recalibrated: boolean; episodesPruned: number } {
    const before = this.episodes.length;
    const accuracyBefore = this.getAccuracy();

    // Prune to 75% of max to make room for fresh data
    const target = Math.floor(this.config.maxEpisodes * 0.75);
    let pruned = 0;
    if (this.episodes.length > target) {
      pruned = this.episodes.length - target;
      this.episodes = this.episodes.slice(pruned);
    }

    // Reset accuracy history to recent half
    const halfWindow = Math.ceil(this.config.accuracyWindowSize / 2);
    if (this.accuracyHistory.length > halfWindow) {
      this.accuracyHistory = this.accuracyHistory.slice(
        this.accuracyHistory.length - halfWindow,
      );
    }

    const accuracyAfter = this.getAccuracy();

    log.info("Recalibration complete", {
      episodesBefore: before,
      episodesAfter: this.episodes.length,
      episodesPruned: pruned,
      accuracyBefore: accuracyBefore.toFixed(3),
      accuracyAfter: accuracyAfter.toFixed(3),
    });

    emit("cerebellum:recalibrate", {
      episodesPruned: pruned,
      accuracyBefore,
      accuracyAfter,
    });

    return { recalibrated: true, episodesPruned: pruned };
  }

  // ── Snapshot ────────────────────────────────────────────────

  /**
   * Serializable state for dashboard/debugging.
   * Maps and Sets converted to plain objects/arrays.
   */
  getState(): {
    episodeCount: number;
    accuracy: number;
    accuracyWindowSize: number;
    failureModeAccuracy: { accuracy: number; preemptionRate: number; sampleCount: number };
    pendingPredictions: string[];
    config: CerebellumConfig;
    recentEpisodes: Array<{
      taskId: string;
      sequenceNumber: number;
      receptorCount: number;
      senseCount: number;
      hadPrediction: boolean;
    }>;
  } {
    return {
      episodeCount: this.episodes.length,
      accuracy: this.getAccuracy(),
      accuracyWindowSize: this.accuracyHistory.length,
      failureModeAccuracy: this.getFailureModeAccuracy(),
      pendingPredictions: [...this.pending.keys()],
      config: this.config,
      recentEpisodes: this.episodes.slice(-5).map((ep) => ({
        taskId: ep.taskId,
        sequenceNumber: ep.sequenceNumber,
        receptorCount: ep.receptorScores.size,
        senseCount: ep.senseScores.size,
        hadPrediction: ep.predictedScores !== null,
      })),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Compute a weighted percentile from sorted (value, weight) pairs.
 * Uses linear interpolation between weighted cumulative positions.
 */
function weightedPercentile(
  sorted: Array<{ cycles: number; weight: number }>,
  p: number,
): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0].cycles;

  const totalWeight = sorted.reduce((s, e) => s + e.weight, 0);
  if (totalWeight === 0) return sorted[0].cycles;

  const target = p * totalWeight;
  let cumulative = 0;

  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].weight;
    if (cumulative >= target) {
      return sorted[i].cycles;
    }
  }

  return sorted[sorted.length - 1].cycles;
}
