/**
 * Prospective Preparation — the PFC running ahead of itself.
 *
 * Pure functions. No class, no state, no LLM calls.
 * Called by task-dispatch.integrate() during between-tasks.
 *
 * Reads from WM trends, SpeedOfLight, hippocampus episodes, and
 * conviction shaping. Produces a ForwardBriefing that the Thalamus
 * dissolves into consumer briefings via the gestalt.
 *
 * "By the time I announce it, everybody's kind of bought in."
 * — Jensen Huang
 */

import type {
  ForwardBriefing,
  ForwardBriefingSources,
  PredictedTension,
  PredictedBottleneck,
  HippocampusEpisodeSummary,
} from "../types/forward-briefing.js";
import type { ScoreTrend } from "../types/working-memory.js";
import type { SpeedOfLight } from "../types/cerebellum.js";
import { emit } from "../events.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("prospective-preparation");

// ─── Thresholds ─────────────────────────────────────────────────

/** Minimum predicted score gap between senses to flag a tension. */
const TENSION_SCORE_GAP = 2.0;

/** Minimum gap between current mean and ceiling to flag a bottleneck. */
const BOTTLENECK_GAP = 2.0;

/** Minimum episodes with same tension pair to flag an episode pattern. */
const EPISODE_PATTERN_MIN = 2;

/** Minimum episodes needed to predict cycle count. */
const CYCLE_PREDICTION_MIN = 2;

// ─── Main ───────────────────────────────────────────────────────

/**
 * Produce a forward briefing from available system signals.
 *
 * Called during between-tasks. All sources degrade gracefully —
 * empty arrays and nulls produce a valid briefing with zero
 * predictions.
 */
export function prepareForward(sources: ForwardBriefingSources): ForwardBriefing {
  const tensions = detectTensions(sources);
  const bottlenecks = detectBottlenecks(sources.senseTrends, sources.speedOfLight);
  const cycles = predictCycles(sources.recentEpisodes);

  const briefing: ForwardBriefing = {
    assembledAt: new Date(),
    predictedTensions: tensions,
    predictedBottlenecks: bottlenecks,
    convictionCarryForward: sources.convictionShaping,
    predictedCycles: cycles,
    manifestedFuture: sources.manifestedFuture,
  };

  emit("prospective:prepared", {
    tensionCount: tensions.length,
    bottleneckCount: bottlenecks.length,
    predictedCycles: cycles,
    convictionNotes: sources.convictionShaping.notes.length,
    hasReshapeGuidance: !!sources.convictionShaping.reshapeGuidance,
  });

  log.info("Forward briefing prepared", {
    tensions: tensions.length,
    bottlenecks: bottlenecks.length,
    predictedCycles: cycles,
    convictionNotes: sources.convictionShaping.notes.length,
  });

  return briefing;
}

// ─── Tension Detection ──────────────────────────────────────────

/**
 * Detect predicted tensions from three sources, deduplicated.
 *
 * 1. Score divergence — Cerebellum predicts divergent per-sense scores
 * 2. Trend divergence — WM shows senses moving in opposite directions
 * 3. Episode pattern — Hippocampus shows recurring sense conflicts
 *
 * Same sense pair from multiple bases → keep highest severity.
 */
export function detectTensions(sources: ForwardBriefingSources): PredictedTension[] {
  const all: PredictedTension[] = [];

  all.push(...detectScoreDivergence(sources));
  all.push(...detectTrendDivergence(sources.senseTrends));
  all.push(...detectEpisodePatterns(sources.recentEpisodes));

  return deduplicateTensions(all);
}

/**
 * Score divergence: Cerebellum predicts scores for upcoming senses.
 * Sense pairs with large predicted score gaps become tensions.
 *
 * Note: cerebellumPredictions is null between tasks in the current
 * implementation. This algorithm activates when the Planner (Wave 12)
 * can provide predictions ahead of time.
 */
function detectScoreDivergence(sources: ForwardBriefingSources): PredictedTension[] {
  if (!sources.cerebellumPredictions) return [];

  const predictions = sources.cerebellumPredictions;
  const tensions: PredictedTension[] = [];

  // Group receptor predictions by sense name, compute mean per sense
  const senseMeans = new Map<string, { sum: number; count: number }>();
  for (const rp of predictions.receptorPredictions) {
    const senseName = rp.activationPath[0];
    if (!senseName) continue;

    const entry = senseMeans.get(senseName) ?? { sum: 0, count: 0 };
    entry.sum += rp.predicted;
    entry.count++;
    senseMeans.set(senseName, entry);
  }

  const senseScores = new Map<string, number>();
  for (const [name, { sum, count }] of senseMeans) {
    senseScores.set(name, sum / count);
  }

  // Find pairs with large gaps
  const senseNames = [...senseScores.keys()];
  for (let i = 0; i < senseNames.length; i++) {
    for (let j = i + 1; j < senseNames.length; j++) {
      const a = senseNames[i];
      const b = senseNames[j];
      const scoreA = senseScores.get(a)!;
      const scoreB = senseScores.get(b)!;
      const gap = Math.abs(scoreA - scoreB);

      if (gap > TENSION_SCORE_GAP) {
        const severity = clamp((gap - TENSION_SCORE_GAP) / 8, 0, 1);
        const [high, low] = scoreA >= scoreB ? [a, b] : [b, a];
        const highScore = Math.max(scoreA, scoreB);
        const lowScore = Math.min(scoreA, scoreB);

        tensions.push({
          senseA: high,
          senseB: low,
          severity,
          basis: "score-divergence",
          description: `Predicted score divergence: ${high} (${highScore.toFixed(1)}) vs ${low} (${lowScore.toFixed(1)}). Gap of ${gap.toFixed(1)} points suggests these dimensions will conflict.`,
        });
      }
    }
  }

  return tensions;
}

/**
 * Trend divergence: senses moving in opposite directions.
 * One trending up while another trends down = predicted tension.
 */
function detectTrendDivergence(senseTrends: ScoreTrend[]): PredictedTension[] {
  const tensions: PredictedTension[] = [];

  // Filter to sense-level trends only
  const senseLevel = senseTrends.filter((t) => t.level === "sense");

  const rising = senseLevel.filter((t) => t.direction === "up");
  const falling = senseLevel.filter((t) => t.direction === "down");

  for (const up of rising) {
    for (const down of falling) {
      const gap = Math.abs(up.currentMean - down.currentMean);
      const severity = clamp(gap / 10, 0, 1);

      tensions.push({
        senseA: up.label,
        senseB: down.label,
        severity,
        basis: "trend-divergence",
        description: `${up.label} trending up (${up.currentMean.toFixed(1)}) while ${down.label} trending down (${down.currentMean.toFixed(1)}). Diverging trajectories predict tension.`,
      });
    }
  }

  return tensions;
}

/**
 * Episode pattern: sense pairs that appear in tensions across
 * multiple hippocampus episodes. Recurring conflicts = predicted
 * future conflict.
 */
function detectEpisodePatterns(episodes: HippocampusEpisodeSummary[]): PredictedTension[] {
  if (episodes.length === 0) return [];

  // Count how often each sense pair appears in tensions
  const pairCounts = new Map<string, number>();
  for (const ep of episodes) {
    for (const t of ep.tensions) {
      const key = canonicalPairKey(t.senseA, t.senseB);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }

  const tensions: PredictedTension[] = [];
  for (const [key, count] of pairCounts) {
    if (count >= EPISODE_PATTERN_MIN) {
      const [senseA, senseB] = key.split("|");
      const severity = clamp(count / episodes.length, 0, 1);

      tensions.push({
        senseA,
        senseB,
        severity,
        basis: "episode-pattern",
        description: `${senseA} and ${senseB} conflicted in ${count} of ${episodes.length} recent task(s). Recurring tension pattern.`,
      });
    }
  }

  return tensions;
}

// ─── Bottleneck Detection ───────────────────────────────────────

/**
 * Identify senses whose current score is far below their ceiling.
 * A bottleneck is a dimension dragging the composite score down.
 */
export function detectBottlenecks(
  senseTrends: ScoreTrend[],
  speedOfLight: SpeedOfLight | null,
): PredictedBottleneck[] {
  if (!speedOfLight) return [];

  const bottlenecks: PredictedBottleneck[] = [];

  // Filter to sense-level trends
  const senseLevel = senseTrends.filter((t) => t.level === "sense");

  for (const trend of senseLevel) {
    // Match by sense name: ScoreTrend.id (for sense-level) is the sense name,
    // SenseCeiling.senseName is also the sense name.
    const ceiling = speedOfLight.perSense.find(
      (s) => s.senseName === trend.id,
    );
    if (!ceiling) continue;

    const gap = ceiling.ceiling - trend.currentMean;

    if (gap > BOTTLENECK_GAP) {
      const trending: PredictedBottleneck["trending"] =
        trend.direction === "down" ? "worsening"
        : trend.direction === "up" ? "improving"
        : "stable";

      bottlenecks.push({
        sense: trend.label,
        currentMean: trend.currentMean,
        ceiling: ceiling.ceiling,
        gap,
        trending,
      });
    }
  }

  return bottlenecks;
}

// ─── Predicted Cycles ───────────────────────────────────────────

/**
 * Predict how many build cycles the upcoming task will take.
 * Median of cycle counts from recent hippocampus episodes.
 * Returns null when fewer than 2 episodes exist.
 */
export function predictCycles(
  episodes: HippocampusEpisodeSummary[],
): number | null {
  if (episodes.length < CYCLE_PREDICTION_MIN) return null;

  const sorted = episodes.map((e) => e.cycles).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Deduplicate tensions: same sense pair from multiple bases,
 * keep the one with highest severity.
 */
function deduplicateTensions(tensions: PredictedTension[]): PredictedTension[] {
  const best = new Map<string, PredictedTension>();

  for (const t of tensions) {
    const key = canonicalPairKey(t.senseA, t.senseB);
    const existing = best.get(key);
    if (!existing || t.severity > existing.severity) {
      best.set(key, t);
    }
  }

  return [...best.values()];
}

/** Canonical key for a sense pair — order-independent. */
function canonicalPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
