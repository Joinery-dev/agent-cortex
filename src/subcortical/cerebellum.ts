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
  private accuracyHistory: AccuracyRecord[] = [];
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
    };

    this.episodes.push(episode);

    // Prune if over max
    if (this.episodes.length > this.config.maxEpisodes) {
      const pruned = this.episodes.length - this.config.maxEpisodes;
      this.episodes = this.episodes.slice(pruned);
      log.debug("Pruned oldest episodes", { pruned });
    }

    // Clean up pending state
    this.pending.delete(taskId);
    this.speedOfLightCache.delete(taskId);
    this.approachTagCache.delete(taskId);

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
