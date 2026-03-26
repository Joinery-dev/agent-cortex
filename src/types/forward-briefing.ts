/**
 * Forward Briefing — the PFC's anticipatory context.
 *
 * Produced during between-tasks by prepareForward(). Stored on the
 * Thalamus via setForwardBriefing(). Dissolved into consumer briefings
 * via the gestalt.
 *
 * Contains only things not available from any single gestalt source —
 * multi-source syntheses and forward extrapolations. Five fields,
 * each genuinely new context:
 *
 *   predictedTensions    — sense pairs predicted to conflict
 *   predictedBottlenecks — senses dragging composite down
 *   convictionCarryForward — tactical notes from completed task
 *   predictedCycles      — expected build cycles from similar tasks
 *   manifestedFuture     — Planner anchor (Wave 12 stub)
 */

import type { ScoreTrend } from "./working-memory.js";
import type { SpeedOfLight, CerebellumPrediction } from "./cerebellum.js";
import type { ConvictionShaping } from "./conviction.js";

// ─── Forward Briefing ────────────────────────────────────────────

/**
 * The PFC's forward briefing, produced between tasks.
 *
 * Not a data dump — a synthesis. Each field combines multiple sources
 * to produce context that no single component holds alone.
 */
export interface ForwardBriefing {
  /** When this briefing was assembled. */
  assembledAt: Date;

  /**
   * Sense pairs predicted to conflict on upcoming work.
   *
   * Computed from three sources:
   *   1. Cerebellum score predictions showing divergent per-sense scores
   *   2. WM trend data showing senses moving in opposite directions
   *   3. Hippocampus episodes showing recurring sense conflicts
   */
  predictedTensions: PredictedTension[];

  /**
   * Senses dragging the composite score down.
   *
   * A sense is a bottleneck when its current score is far below
   * its theoretical ceiling — the gap between where it is and
   * where the approach can take it.
   */
  predictedBottlenecks: PredictedBottleneck[];

  /**
   * Tactical notes from the completed task's conviction loop.
   *
   * The bridge from Phase 3's conviction shaping to Phase 4's
   * prospective preparation. The conviction loop already produces
   * notes like "approach converging slowly — frontload performance
   * dimension." This carries them forward so the Thalamus can
   * dissolve them into the right consumer's briefing.
   */
  convictionCarryForward: ConvictionShaping;

  /**
   * Predicted build cycle count for the upcoming task.
   * Median of cycles from similar past tasks (hippocampus episodes).
   * null when fewer than 2 comparable episodes exist.
   */
  predictedCycles: number | null;

  /**
   * The Planner's concrete destination (Wave 12).
   *
   * When present, sharpens all predictions from trend-based to
   * distance-based. Evaluation asks "how close to the manifested
   * future?" not "how good?" When absent, predictions anchor
   * against intent + world model maxims.
   */
  manifestedFuture?: string;
}

// ─── Predicted Tension ───────────────────────────────────────────

/** A predicted conflict between two evaluation dimensions. */
export interface PredictedTension {
  /** First sense in the tension (sense name, not ID). */
  senseA: string;
  /** Second sense in the tension. */
  senseB: string;
  /**
   * How severe the predicted tension is (0–1).
   *
   * Computation varies by basis:
   *   score-divergence: (gap - 2) / 8, clamped
   *   trend-divergence: |meanA - meanB| / 10, clamped
   *   episode-pattern:  occurrences / totalEpisodes, clamped
   */
  severity: number;
  /** What evidence suggests this tension. */
  basis: "score-divergence" | "trend-divergence" | "episode-pattern";
  /** Human-readable description for briefing dissolution. */
  description: string;
}

// ─── Predicted Bottleneck ────────────────────────────────────────

/** A sense whose score is far below its theoretical ceiling. */
export interface PredictedBottleneck {
  /** Sense name. */
  sense: string;
  /** Current mean score from WM trends. */
  currentMean: number;
  /** Theoretical ceiling from speed-of-light estimation. */
  ceiling: number;
  /** ceiling - currentMean. Large gap = bottleneck. */
  gap: number;
  /** Whether the trend is making it worse. */
  trending: "worsening" | "improving" | "stable";
}

// ─── Sources ─────────────────────────────────────────────────────

/**
 * What prepareForward() reads from. Assembled by the task-dispatch
 * integrate phase from available system components.
 *
 * All sources degrade gracefully — empty arrays and nulls produce
 * a valid ForwardBriefing with zero predictions.
 */
export interface ForwardBriefingSources {
  /** WM sense-level score trends. */
  senseTrends: ScoreTrend[];
  /** Speed of light from the just-completed task. null on cold start. */
  speedOfLight: SpeedOfLight | null;
  /** Recent hippocampus episodes (lightweight summaries). */
  recentEpisodes: HippocampusEpisodeSummary[];
  /** Conviction shaping from the completed task's conviction loop. */
  convictionShaping: ConvictionShaping;
  /**
   * Cerebellum predictions for upcoming senses. null between tasks
   * (predictions happen after consultation). Field exists for
   * Wave 12 Planner integration.
   */
  cerebellumPredictions: CerebellumPrediction | null;
  /** Planner's manifested future (Wave 12). */
  manifestedFuture?: string;
}

// ─── Hippocampus Episode Summary ─────────────────────────────────

/**
 * Lightweight episode summary — decouples prepareForward() from
 * the full hippocampus Episode type.
 *
 * The Thalamus maps full Episodes to this shape via
 * getRecentEpisodeSummaries(). Only the fields needed for
 * tension detection and cycle prediction are included.
 */
export interface HippocampusEpisodeSummary {
  taskId: string;
  /** How many build-evaluate cycles the task took. */
  cycles: number;
  /** Final score per sense (sense name → score). */
  senseScores: Array<{ senseName: string; score: number }>;
  /** Tensions that occurred during the task. */
  tensions: Array<{ senseA: string; senseB: string }>;
}
