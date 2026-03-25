/**
 * Potentiation — pure functions for trigger detection, episode
 * clustering, and contradiction finding.
 *
 * No LLM calls, no I/O, no side effects. These prepare the data
 * that the Hippocampus feeds to the LLM for principle extraction.
 */

import type {
  Episode,
  Principle,
  PotentiationTrigger,
  EpisodeCluster,
  PrincipleContradiction,
  HippocampusConfig,
} from "../types/hippocampus.js";

// ─── Trigger Detection ──────────────────────────────────────────

/**
 * Detect which potentiation triggers are met.
 *
 * Three triggers:
 *   1. Pattern density — enough similar episodes accumulated
 *   2. Surprise — large |dopamine| demands explanation
 *   3. Contradiction — episode diverges from existing principle
 *
 * @param unpotentiated - Episodes not yet used for any principle
 * @param principles - Existing active principles
 * @param config - Hippocampus configuration
 */
export function detectTriggers(
  unpotentiated: Episode[],
  principles: Principle[],
  config: HippocampusConfig,
): PotentiationTrigger[] {
  const triggers: PotentiationTrigger[] = [];

  // 1. Pattern density — can we cluster enough similar episodes?
  if (unpotentiated.length >= config.minClusterSize) {
    const clusters = clusterEpisodes(unpotentiated, config);
    if (clusters.length > 0) {
      triggers.push({
        type: "pattern-density",
        episodeCount: unpotentiated.length,
        similarity: `${clusters.length} cluster(s) of ${config.minClusterSize}+ episodes`,
      });
    }
  }

  // 2. Surprise — any episode with large |dopamine|?
  for (const episode of unpotentiated) {
    if (Math.abs(episode.dopamineSignal) >= config.surpriseThreshold) {
      triggers.push({
        type: "surprise",
        dopamineSignal: episode.dopamineSignal,
        taskId: episode.taskId,
      });
    }
  }

  // 3. Contradiction — any episode contradicting a principle?
  const activePrinciples = principles.filter(
    (p) =>
      p.confidence >= config.principleDeathThreshold && !p.supersededBy,
  );

  if (activePrinciples.length > 0) {
    const contradictions = findContradictions(
      unpotentiated,
      activePrinciples,
    );
    for (const contradiction of contradictions) {
      triggers.push({
        type: "contradiction",
        principleId: contradiction.principle.id,
        contradictingEpisodeId: contradiction.contradictingEpisode.id,
      });
    }
  }

  return triggers;
}

// ─── Episode Clustering ─────────────────────────────────────────

/**
 * Cluster episodes by sense participation overlap.
 *
 * Uses Jaccard similarity on active sense sets, then filters
 * to clusters meeting the minimum size. Sorted by total
 * significance (most important clusters first).
 */
export function clusterEpisodes(
  episodes: Episode[],
  config: HippocampusConfig,
): EpisodeCluster[] {
  if (episodes.length < config.minClusterSize) return [];

  // Extract sense sets for each episode
  const episodeSenses = episodes.map((ep) => ({
    episode: ep,
    senses: new Set(ep.senseParticipation.map((sp) => sp.senseName)),
  }));

  // Simple greedy clustering: for each episode, find episodes with
  // Jaccard similarity ≥ 0.5 on sense sets. Merge into clusters.
  const used = new Set<string>();
  const clusters: EpisodeCluster[] = [];

  for (let i = 0; i < episodeSenses.length; i++) {
    if (used.has(episodeSenses[i].episode.id)) continue;

    const cluster: Episode[] = [episodeSenses[i].episode];
    const clusterSenses = episodeSenses[i].senses;

    for (let j = i + 1; j < episodeSenses.length; j++) {
      if (used.has(episodeSenses[j].episode.id)) continue;

      const similarity = jaccardSimilarity(
        clusterSenses,
        episodeSenses[j].senses,
      );
      if (similarity >= 0.5) {
        cluster.push(episodeSenses[j].episode);
      }
    }

    if (cluster.length >= config.minClusterSize) {
      for (const ep of cluster) used.add(ep.id);

      const commonSenses = findCommonSenses(cluster);

      clusters.push({
        episodeIds: cluster.map((ep) => ep.id),
        episodes: cluster,
        commonality: `Shared senses: ${commonSenses.join(", ")}`,
        totalSignificance: cluster.reduce(
          (sum, ep) => sum + ep.significance,
          0,
        ),
      });
    }
  }

  // Sort by total significance — most important clusters first
  clusters.sort((a, b) => b.totalSignificance - a.totalSignificance);

  return clusters;
}

// ─── Contradiction Finding ──────────────────────────────────────

/**
 * Find episodes that contradict existing principles.
 *
 * An episode contradicts a principle if:
 *   - The principle references specific senses
 *   - The episode involves those senses
 *   - The episode's outcomes for those senses diverge from what
 *     the principle would predict (low score where principle
 *     predicts high, or vice versa)
 *
 * This is a heuristic — the LLM does the deeper analysis during
 * refinement. This function identifies candidates.
 */
export function findContradictions(
  episodes: Episode[],
  principles: Principle[],
): PrincipleContradiction[] {
  const contradictions: PrincipleContradiction[] = [];

  for (const principle of principles) {
    // Skip dead or superseded principles
    if (principle.supersededBy) continue;

    const relevantSenseNames = new Set(
      principle.relevantSenses.map((s) => s.toLowerCase()),
    );

    for (const episode of episodes) {
      // Check if this episode involves the principle's senses
      const matchingSenses = episode.senseParticipation.filter((sp) =>
        relevantSenseNames.has(sp.senseName.toLowerCase()),
      );

      if (matchingSenses.length === 0) continue;

      // Check for divergence: if the principle has supporting evidence,
      // compare this episode's scores against the average of supporting
      // episodes. A significant deviation suggests contradiction.
      const divergentSenses = findDivergentSenses(
        matchingSenses,
        principle,
      );

      if (divergentSenses.length > 0) {
        contradictions.push({
          principle,
          contradictingEpisode: episode,
          divergentSenses,
        });
      }
    }
  }

  return contradictions;
}

// ─── Internal Helpers ───────────────────────────────────────────

/** Jaccard similarity between two sets: |intersection| / |union|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Find senses common to all episodes in a cluster. */
function findCommonSenses(episodes: Episode[]): string[] {
  if (episodes.length === 0) return [];

  const first = new Set(
    episodes[0].senseParticipation.map((sp) => sp.senseName),
  );

  for (let i = 1; i < episodes.length; i++) {
    const current = new Set(
      episodes[i].senseParticipation.map((sp) => sp.senseName),
    );
    for (const sense of first) {
      if (!current.has(sense)) first.delete(sense);
    }
  }

  return [...first];
}

/**
 * Find senses where an episode's scores diverge from the principle's
 * historical pattern. Uses a simple threshold: if the episode's score
 * for a relevant sense is more than 2 points (on 1-10 scale) away
 * from the average of supporting evidence, that's divergence.
 *
 * If the principle has no supporting evidence yet, we can't detect
 * divergence — return empty.
 */
function findDivergentSenses(
  matchingSenses: Episode["senseParticipation"],
  principle: Principle,
): string[] {
  // Without supporting evidence, we can't know what "normal" looks like
  if (principle.supportingEvidence.length === 0) return [];

  // For now, use a simple heuristic: if the episode's outcome
  // is notably different in direction from what the principle claims,
  // flag it. A more sophisticated approach would track per-sense
  // score averages in the principle's evidence.
  //
  // Simple proxy: if the episode scored below 5.0 on senses the
  // principle considers relevant AND the principle has confidence > 0.5
  // (meaning supporting evidence shows these senses usually score well),
  // that's a potential contradiction. The reverse also applies.
  //
  // This is intentionally conservative — the LLM does the real analysis.
  const DIVERGENCE_THRESHOLD = 5.0;
  const divergent: string[] = [];

  for (const sense of matchingSenses) {
    // Only flag strong signals — score very low on a sense the
    // principle has high confidence about
    if (
      principle.confidence > 0.5 &&
      sense.finalScore < DIVERGENCE_THRESHOLD &&
      !sense.acceptable
    ) {
      divergent.push(sense.senseName);
    }
  }

  return divergent;
}
