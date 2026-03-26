/**
 * Forward Model — pure prediction functions for the Cerebellum.
 *
 * No state, no side effects, no LLM calls. All functions take
 * inputs and return outputs. The Cerebellum class orchestrates
 * these; this module is the math.
 *
 * The core idea: task similarity is defined by sense activation
 * fingerprint. Two tasks are similar if the same senses activated
 * with similar stakes. The senses have already understood the
 * task — we just remember what happened with similar patterns.
 */

import { emit as emitTrace } from "../events.js";
import type { Consultation, EvaluationPlanEntry } from "../types/consultation.js";
import type { Sense } from "../types/sense.js";
import type { SensoryCortex } from "../senses/cortex.js";
import type {
  TaskFingerprint,
  CerebellumEpisode,
  CerebellumConfig,
  SimilarityWeights,
  ScoredEpisode,
  ReceptorPrediction,
  SenseCeiling,
  SpeedOfLight,
  ApproachCeiling,
} from "../types/cerebellum.js";

// ─── Fingerprinting ─────────────────────────────────────────────

/**
 * Extract a task fingerprint from a Consultation.
 * The fingerprint captures which senses activated with what stakes
 * and which receptors will evaluate — the task's signature.
 */
export function extractFingerprint(consultation: Consultation): TaskFingerprint {
  const senseStakes = new Map<string, number>();
  for (const entry of consultation.stakeDistribution.entries) {
    senseStakes.set(entry.senseName, entry.stake);
  }

  const activeReceptors = new Set<string>();
  for (const entry of consultation.evaluationPlan) {
    activeReceptors.add(entry.receptorId);
  }

  return { senseStakes, activeReceptors };
}

/**
 * Extract a preliminary fingerprint from active senses BEFORE consultation.
 * Used by the efference copy to find similar episodes without waiting
 * for the full consultation (which needs the efference copy's output).
 *
 * Uses uniform stakes (0.5) since we don't have sense-reported stakes yet,
 * and includes ALL receptors under each active sense since we don't know
 * which the senses will select. Directionally correct, not precise —
 * good enough for the efference copy's purposes.
 */
export function extractPreliminaryFingerprint(
  activeSenses: Sense[],
  library: SensoryCortex,
): TaskFingerprint {
  const senseStakes = new Map<string, number>();
  const activeReceptors = new Set<string>();

  for (const sense of activeSenses) {
    // Uniform stake — we don't have consultation-derived stakes yet
    senseStakes.set(sense.name, 0.5);

    // Collect all receptor IDs under this sense
    const subTree = library.getSubTree(sense.id);
    for (const node of subTree) {
      if (node.level === "receptor") {
        activeReceptors.add(node.id);
      }
    }
  }

  return { senseStakes, activeReceptors };
}

// ─── Similarity ─────────────────────────────────────────────────

/** Standard Jaccard: |A ∩ B| / |A ∪ B|. Returns 0 if both empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Mean absolute stake difference for shared senses.
 * Only compares senses present in both maps — missing senses
 * contribute dissimilarity through the Jaccard term, not here.
 * Returns 0 if no shared senses (no basis for comparison).
 */
export function meanStakeDifference(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let totalDiff = 0;
  let count = 0;

  for (const [name, stakeA] of a) {
    const stakeB = b.get(name);
    if (stakeB !== undefined) {
      totalDiff += Math.abs(stakeA - stakeB);
      count++;
    }
  }

  return count === 0 ? 0 : totalDiff / count;
}

/**
 * Compute similarity between two task fingerprints.
 * Weighted combination of three signals:
 *   - Jaccard on active sense names (structural overlap)
 *   - 1 - stake difference on shared senses (behavioral similarity)
 *   - Jaccard on active receptors (evaluation overlap)
 *
 * Returns 0–1. Higher = more similar.
 */
export function computeSimilarity(
  a: TaskFingerprint,
  b: TaskFingerprint,
  weights: SimilarityWeights,
): number {
  const senseKeys = (fp: TaskFingerprint) => new Set(fp.senseStakes.keys());
  const senseKeysA = senseKeys(a);
  const senseKeysB = senseKeys(b);

  const senseJaccard = jaccardSimilarity(senseKeysA, senseKeysB);

  // Stake similarity only meaningful when senses overlap.
  // No shared senses → stake term contributes 0 (no data, not "identical").
  const hasSharedSenses = [...senseKeysA].some((k) => senseKeysB.has(k));
  const stakeSim = hasSharedSenses
    ? 1 - meanStakeDifference(a.senseStakes, b.senseStakes)
    : 0;

  const receptorJaccard = jaccardSimilarity(a.activeReceptors, b.activeReceptors);

  return (
    weights.senseJaccard * senseJaccard +
    weights.stakeDifference * stakeSim +
    weights.receptorJaccard * receptorJaccard
  );
}

// ─── Episode retrieval ──────────────────────────────────────────

/**
 * Find similar episodes from the store, filtered and weighted.
 *
 * 1. Compute similarity to every stored episode
 * 2. Filter by threshold
 * 3. Sort descending by similarity
 * 4. Take top-k
 * 5. Apply recency weighting: weight = similarity / (1 + rank * decayRate)
 *    where rank = distance from most recent episode (0 = most recent)
 *
 * Returns scored episodes sorted by weight (descending).
 */
export function findSimilarEpisodes(
  fingerprint: TaskFingerprint,
  episodes: CerebellumEpisode[],
  config: CerebellumConfig,
): ScoredEpisode[] {
  if (episodes.length === 0) return [];

  const maxSeq = episodes.reduce((max, ep) => Math.max(max, ep.sequenceNumber), 0);

  const scored: ScoredEpisode[] = [];
  for (const episode of episodes) {
    const similarity = computeSimilarity(
      fingerprint,
      episode.fingerprint,
      config.similarityWeights,
    );

    if (similarity >= config.similarityThreshold) {
      const rank = maxSeq - episode.sequenceNumber;
      const recency = 1 / (1 + rank * config.decayRate);
      scored.push({
        episode,
        similarity,
        weight: similarity * recency,
      });
    }
  }

  // Sort by similarity first (for top-k selection), then re-sort by weight
  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, config.topK);
  topK.sort((a, b) => b.weight - a.weight);

  return topK;
}

// ─── Prediction ─────────────────────────────────────────────────

/**
 * Predict scores for each receptor in the evaluation plan
 * using weighted similar episodes.
 *
 * For each receptor:
 *   1. Check if matched episodes have direct receptor-level data → weighted average
 *   2. If not: check if matched episodes have parent sense data → sense-fallback
 *   3. If neither: skip this receptor (no prediction possible)
 *
 * Confidence per receptor:
 *   min(1, matchCount / 3) * (1 - normalizedVariance)
 *   where normalizedVariance = stddev / 9 (on the 1–10 scale)
 */
export function predictFromEpisodes(
  matches: ScoredEpisode[],
  evaluationPlan: EvaluationPlanEntry[],
): ReceptorPrediction[] {
  if (matches.length === 0) return [];

  const predictions: ReceptorPrediction[] = [];

  for (const entry of evaluationPlan) {
    const prediction = predictReceptor(matches, entry);
    if (prediction) predictions.push(prediction);
  }

  return predictions;
}

function predictReceptor(
  matches: ScoredEpisode[],
  entry: EvaluationPlanEntry,
): ReceptorPrediction | null {
  // Try direct receptor-level data first
  const receptorMatches = matches.filter(
    (m) => m.episode.receptorScores.has(entry.receptorId),
  );

  if (receptorMatches.length > 0) {
    return buildPrediction(
      receptorMatches,
      (m) => m.episode.receptorScores.get(entry.receptorId)!,
      entry,
      "receptor",
    );
  }

  // Fall back to parent sense data
  const senseMatches = matches.filter(
    (m) => m.episode.senseScores.has(entry.parentSenseName),
  );

  if (senseMatches.length > 0) {
    return buildPrediction(
      senseMatches,
      (m) => m.episode.senseScores.get(entry.parentSenseName)!,
      entry,
      "sense-fallback",
    );
  }

  emitTrace("prediction:skipped:no-data", {
    receptorId: entry.receptorId,
    parentSenseName: entry.parentSenseName,
    matchCount: matches.length,
  });
  return null;
}

function buildPrediction(
  matches: ScoredEpisode[],
  getScore: (m: ScoredEpisode) => number,
  entry: EvaluationPlanEntry,
  source: "receptor" | "sense-fallback",
): ReceptorPrediction {
  const totalWeight = matches.reduce((sum, m) => sum + m.weight, 0);
  const weightedSum = matches.reduce(
    (sum, m) => sum + m.weight * getScore(m),
    0,
  );
  const predicted = totalWeight > 0 ? weightedSum / totalWeight : 5;

  // Compute variance for confidence
  const scores = matches.map(getScore);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance =
    scores.length > 1
      ? scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1)
      : 0;
  const stddev = Math.sqrt(variance);
  const normalizedVariance = Math.min(1, stddev / 9);

  const confidence =
    Math.min(1, matches.length / 3) * (1 - normalizedVariance);

  return {
    receptorId: entry.receptorId,
    activationPath: [entry.parentSenseName, entry.receptorId],
    predicted,
    confidence: Math.max(0, Math.min(1, confidence)),
    basedOnEpisodes: matches.length,
    source,
  };
}

/**
 * Aggregate confidence across all receptor predictions.
 * Simple mean — each receptor contributes equally.
 */
export function computeOverallConfidence(
  predictions: ReceptorPrediction[],
): number {
  if (predictions.length === 0) return 0;
  const total = predictions.reduce((sum, p) => sum + p.confidence, 0);
  return total / predictions.length;
}

// ─── Speed of light ─────────────────────────────────────────────

/**
 * Compute the speed of light — theoretical performance ceiling.
 *
 * Per-sense ceilings come from the consultation (what physics allows).
 * Historical best-achieved comes from similar episodes (what we've done).
 * The gap between them is the most actionable signal: it tells you
 * whether past approaches were fundamentally wrong.
 *
 * Always returns a result — the theoretical ceiling is available from
 * task one (from sense estimates). Historical enrichment grows over time.
 */
export function computeSpeedOfLight(
  taskId: string,
  consultation: Consultation,
  similarEpisodes: ScoredEpisode[],
): SpeedOfLight {
  const perSense: SenseCeiling[] = [];
  let ceilingWeightedSum = 0;
  let achievedWeightedSum = 0;
  let achievedStakeSum = 0;
  let totalStake = 0;
  let hasAnyHistory = false;

  for (const perspective of consultation.perspectives) {
    const { senseId, senseName, stake, ceiling, ceilingRationale } = perspective;

    // Find the best score this sense has achieved across similar episodes
    let bestAchieved: number | null = null;
    for (const match of similarEpisodes) {
      const senseScore = match.episode.senseScores.get(senseName);
      if (senseScore !== undefined) {
        bestAchieved = bestAchieved === null
          ? senseScore
          : Math.max(bestAchieved, senseScore);
        hasAnyHistory = true;
      }
    }

    const gap = bestAchieved !== null ? ceiling - bestAchieved : null;

    perSense.push({
      senseName,
      senseId,
      stake,
      ceiling,
      ceilingRationale,
      bestAchieved,
      gap,
    });

    ceilingWeightedSum += stake * ceiling;
    totalStake += stake;

    if (bestAchieved !== null) {
      achievedWeightedSum += stake * bestAchieved;
      achievedStakeSum += stake;
    }
  }

  const compositeCeiling = totalStake > 0
    ? ceilingWeightedSum / totalStake
    : 10;

  // Only compute composite best-achieved when all senses have history
  const allSensesHaveHistory = perSense.every((s) => s.bestAchieved !== null);
  const compositeBestAchieved = allSensesHaveHistory && achievedStakeSum > 0
    ? achievedWeightedSum / achievedStakeSum
    : null;

  const compositeGap = compositeBestAchieved !== null
    ? compositeCeiling - compositeBestAchieved
    : null;

  return {
    taskId,
    perSense,
    compositeCeiling,
    compositeBestAchieved,
    compositeGap,
    hasHistory: hasAnyHistory,
    computedAt: new Date(),
  };
}

// ─── V2: Approach-aware filtering ───────────────────────────────

/**
 * Filter scored episodes to those with matching approach tags.
 * Uses Jaccard overlap > 0 — any shared tag counts as a match.
 */
export function filterByApproachTags(
  episodes: ScoredEpisode[],
  tags: string[],
): ScoredEpisode[] {
  if (tags.length === 0) return [];

  const tagSet = new Set(tags);
  return episodes.filter((m) => {
    const episodeTags = m.episode.approachTags;
    if (!episodeTags || episodeTags.length === 0) return false;
    return jaccardSimilarity(tagSet, new Set(episodeTags)) > 0;
  });
}

/**
 * Compute approach-specific ceiling by comparing approach-filtered
 * best-achieved to the overall speed of light.
 *
 * If the approach class consistently underperforms the overall ceiling,
 * `approachIsBottleneck` is true — the approach is fundamentally limited.
 */
export function computeApproachCeiling(
  overallSol: SpeedOfLight,
  approachMatches: ScoredEpisode[],
  approachTags: string[],
  bottleneckThreshold = 1.5,
): ApproachCeiling {
  // Per-sense best-achieved from approach-filtered episodes
  const perSense: Array<{ senseName: string; bestAchieved: number | null }> = [];
  let achievedWeightedSum = 0;
  let achievedStakeSum = 0;

  for (const sc of overallSol.perSense) {
    let best: number | null = null;
    for (const match of approachMatches) {
      const score = match.episode.senseScores.get(sc.senseName);
      if (score !== undefined) {
        best = best === null ? score : Math.max(best, score);
      }
    }
    perSense.push({ senseName: sc.senseName, bestAchieved: best });

    if (best !== null) {
      achievedWeightedSum += sc.stake * best;
      achievedStakeSum += sc.stake;
    }
  }

  const compositeBestAchieved = achievedStakeSum > 0
    ? achievedWeightedSum / achievedStakeSum
    : null;

  // Bottleneck detection: compare approach best to overall best
  const bottleneckGap =
    overallSol.compositeBestAchieved !== null && compositeBestAchieved !== null
      ? overallSol.compositeBestAchieved - compositeBestAchieved
      : null;

  const approachIsBottleneck = bottleneckGap !== null && bottleneckGap > bottleneckThreshold;

  return {
    approachTags,
    perSense,
    compositeBestAchieved,
    episodesConsidered: approachMatches.length,
    approachIsBottleneck,
    bottleneckGap,
  };
}

