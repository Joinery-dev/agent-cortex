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
  DopamineSignal,
  AccuracyRecord,
  TaskFingerprint,
} from "../types/cerebellum.js";
import { DEFAULT_CEREBELLUM_CONFIG } from "../types/cerebellum.js";
import {
  extractFingerprint,
  findSimilarEpisodes,
  predictFromEpisodes,
  computeOverallConfidence,
} from "./forward-model.js";
import { computeDopamine, computeAccuracy } from "./dopamine.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

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
  ): DopamineSignal | null {
    const entry = this.pending.get(taskId);

    // Build actual score maps for the episode
    const receptorScores = new Map<string, number>();
    const senseTotals = new Map<string, { sum: number; count: number }>();

    for (const evaluation of evaluations) {
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

    // Record episode
    const episode: CerebellumEpisode = {
      taskId,
      fingerprint,
      receptorScores,
      senseScores,
      predictedScores,
      sequenceNumber: this.sequenceCounter++,
      recordedAt: new Date(),
    };

    this.episodes.push(episode);

    // Prune if over max
    if (this.episodes.length > this.config.maxEpisodes) {
      const pruned = this.episodes.length - this.config.maxEpisodes;
      this.episodes = this.episodes.slice(pruned);
      log.debug("Pruned oldest episodes", { pruned });
    }

    // Clean up pending
    this.pending.delete(taskId);

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

    // Compute dopamine
    const dopamine = computeDopamine(
      entry.prediction,
      evaluations,
      entry.consultation,
    );

    // Track accuracy
    const { accuracy, meanAbsoluteError, receptorCount } = computeAccuracy(
      entry.prediction,
      evaluations,
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

  /** Number of episodes stored. */
  getEpisodeCount(): number {
    return this.episodes.length;
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
