/**
 * Explore Phase — divergent path generation and selection.
 *
 * Generates 3-5 approach sketches in a single structured LLM call.
 * Selection criterion: surprise × quality — the most creative path
 * that clears the quality floor.
 *
 * Skipped in leverage mode. Degrades gracefully on LLM failure.
 */

import { z } from "zod";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { APPROACH_ARCHETYPES } from "../subcortical/approach-classifier.js";
import type { Task } from "../types/task.js";
import type { Consultation } from "../types/consultation.js";
import type { Thalamus } from "./thalamus.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { ExplorePath, ExploreResult } from "../types/explore.js";
import { EXPLORE_QUALITY_FLOOR } from "../types/explore.js";

const log = createLogger("explore");

// ─── Zod schema ──────────────────────────────────────────────

const ExplorePathSchema = z.object({
  name: z.string(),
  approach: z.string(),
  archetypeTags: z.array(z.string()).min(1).max(3),
  divergenceRationale: z.string(),
  tradeoffs: z.array(z.string()),
  senseAlignment: z.object({
    serves: z.array(z.string()),
    sacrifices: z.array(z.string()),
  }),
  quality: z.number().min(0).max(1),
  surprise: z.number().min(0).max(1),
});

const ExploreResponseSchema = z.object({
  paths: z.array(ExplorePathSchema).min(3).max(5),
});

// ─── Prompts ─────────────────────────────────────────────────

const ARCHETYPE_LIST = APPROACH_ARCHETYPES.map((t) => `- ${t}`).join("\n");

function exploreSystem(): string {
  return `You are the Explore Phase — a divergent thinker generating multiple paths from the current state to a fixed destination.

You will receive:
- A task description and project intent
- The manifested future (the destination — fixed, not yours to change)
- Sense perspectives from consultation (what each dimension cares about)
- Cerebellum context (prediction confidence, novelty signal) if available
- A fixed vocabulary of approach archetypes

Generate 3-5 DIVERGENT paths. Each path is a sketch — a strategy for how to reach the manifested future, not an implementation plan. The premotor will flesh out the winning path later.

Rules for divergence:
- At least one path should be the "obvious" approach — the one a competent builder would default to
- At least one path should be genuinely surprising — an approach most builders wouldn't consider
- Paths must use different archetype tag combinations, not all the same tags
- Each path must be a meaningfully different strategic direction, not a variation on a theme

Self-scoring — be honest, inflation defeats the purpose:
- quality (0-1): How well does this path serve the manifested future given the sense concerns? 0.5 is the viability floor — below this, the path isn't credible. 0.8+ means the path has a strong theory for satisfying most senses.
- surprise (0-1): How much does this path defy the conventional approach? 0 = the obvious thing everyone would do. 0.5 = a less common but known approach. 0.8+ = genuinely unexpected strategy.

The selection criterion is surprise × quality. A surprising AND viable path beats both a boring good path and an exciting bad one. Do not inflate surprise on obvious paths or quality on wild paths.

Tag each path with 1-3 archetype tags from this fixed vocabulary:
${ARCHETYPE_LIST}

Return JSON: { "paths": [ ... ] }`;
}

function exploreUser(
  task: Task,
  consultation: Consultation,
  manifestedFuture: string | null,
  thalamus: Thalamus,
): string {
  const sections: string[] = [];

  // Task
  sections.push(`TASK: ${task.description}`);

  // Manifested future
  if (manifestedFuture) {
    sections.push(`MANIFESTED FUTURE (the fixed destination — your paths are different routes here):\n${manifestedFuture}`);
  }

  // Sense perspectives
  const perspectives = consultation.perspectives
    .map((p) => `- ${p.senseName} (stake: ${p.stake.toFixed(2)}, ceiling: ${p.ceiling.toFixed(1)}): ${p.perspective}`)
    .join("\n");
  sections.push(`SENSE PERSPECTIVES (what each dimension cares about):\n${perspectives}`);

  // Cerebellum context
  const gestalt = thalamus.getGestalt(task.id);
  if (gestalt?.prediction) {
    const pred = gestalt.prediction;
    sections.push(
      `CEREBELLUM CONTEXT:\n` +
      `- Best episode similarity: ${pred.bestSimilarity.toFixed(2)} (${pred.bestSimilarity < 0.3 ? "highly novel task" : pred.bestSimilarity < 0.6 ? "somewhat familiar" : "very similar to past work"})\n` +
      `- Prediction confidence: ${pred.overallConfidence.toFixed(2)}\n` +
      `- Episodes available: ${pred.episodeCount}`
    );
  }

  // Speed of light approach ceiling
  if (gestalt?.speedOfLight?.approachSpecific) {
    const ac = gestalt.speedOfLight.approachSpecific;
    if (ac.approachTags.length > 0) {
      sections.push(
        `HISTORICAL APPROACH ARCHETYPES (what the system has used on similar tasks):\n` +
        `Tags: ${ac.approachTags.join(", ")}\n` +
        `Approach is bottleneck: ${ac.approachIsBottleneck ? "YES — a different approach may unlock higher scores" : "no"}`
      );
    }
  }

  // Archetype vocabulary reminder
  sections.push(`ARCHETYPE VOCABULARY (tag each path with 1-3 from this list):\n${ARCHETYPE_LIST}`);

  return sections.join("\n\n");
}

// ─── Selection ───────────────────────────────────────────────

function selectPath(paths: ExplorePath[]): {
  selected: ExplorePath | null;
  rationale: string;
} {
  const viable = paths.filter((p) => p.quality >= EXPLORE_QUALITY_FLOOR);

  if (viable.length === 0) {
    return {
      selected: null,
      rationale: `No path cleared quality floor (${EXPLORE_QUALITY_FLOOR}). Scores: ${paths.map((p) => `"${p.name}" q=${p.quality.toFixed(2)}`).join(", ")}`,
    };
  }

  const scored = viable.map((p) => ({
    path: p,
    score: p.surprise * p.quality,
  }));
  scored.sort((a, b) => b.score - a.score);

  const winner = scored[0];
  return {
    selected: winner.path,
    rationale: `Selected "${winner.path.name}" (surprise=${winner.path.surprise.toFixed(2)}, quality=${winner.path.quality.toFixed(2)}, score=${winner.score.toFixed(3)}) over ${scored.length - 1} other viable path(s)`,
  };
}

// ─── Archetype validation ────────────────────────────────────

function validateArchetypeTags(paths: ExplorePath[]): void {
  const valid = APPROACH_ARCHETYPES as readonly string[];
  for (const path of paths) {
    const filtered = path.archetypeTags.filter((t) => valid.includes(t));
    // Keep raw tags if all were invalid (better than nothing)
    if (filtered.length > 0) {
      path.archetypeTags = filtered;
    }
  }
}

// ─── Main entry point ────────────────────────────────────────

/**
 * Run the explore phase. Generates divergent paths and selects
 * the best one by surprise × quality.
 *
 * Returns ExploreSkipped (with reason) if skipped or failed.
 * Returns ExploreSelected with the chosen path on success.
 */
export async function explore(
  task: Task,
  consultation: Consultation,
  thalamus: Thalamus,
  config: CortexConfig,
  mode?: "explore" | "leverage",
): Promise<ExploreResult> {
  // Skip in leverage mode
  if (mode === "leverage") {
    emit("explore:skipped", { taskId: task.id, reason: "leverage-mode" });
    log.info("Explore skipped: leverage mode", { taskId: task.id });
    return { kind: "skipped", reason: "leverage-mode" };
  }

  emit("explore:start", { taskId: task.id, mode: mode ?? "explore" });

  const model = config.models.explore ?? config.models.consultation;
  const manifestedFuture = thalamus.getManifestedFuture();

  // Generate paths
  let paths: ExplorePath[];
  try {
    const response = await callStructured(
      "explore",
      model,
      exploreSystem(),
      exploreUser(task, consultation, manifestedFuture, thalamus),
      ExploreResponseSchema,
      4096,
    );
    paths = response.paths;
  } catch (err) {
    const detail = String(err);
    emit("explore:skipped", { taskId: task.id, reason: "llm-failure", detail });
    log.warn("Explore LLM call failed — skipping", { taskId: task.id, error: detail });
    return { kind: "skipped", reason: "llm-failure", detail };
  }

  // Validate archetype tags against vocabulary
  validateArchetypeTags(paths);

  emit("explore:paths-generated", {
    taskId: task.id,
    pathCount: paths.length,
    paths: paths.map((p) => ({
      name: p.name,
      surprise: p.surprise,
      quality: p.quality,
      combined: p.surprise * p.quality,
    })),
  });

  log.info("Explore paths generated", {
    taskId: task.id,
    pathCount: paths.length,
    paths: paths.map((p) => ({
      name: p.name,
      surprise: p.surprise.toFixed(2),
      quality: p.quality.toFixed(2),
      archetypes: p.archetypeTags,
    })),
  });

  // Select best path
  const { selected, rationale } = selectPath(paths);

  if (!selected) {
    emit("explore:skipped", { taskId: task.id, reason: "no-path-clears-floor", detail: rationale });
    log.info("Explore: no path cleared quality floor", { taskId: task.id, rationale });
    return { kind: "skipped", reason: "no-path-clears-floor", detail: rationale };
  }

  const selectionScore = selected.surprise * selected.quality;

  emit("explore:selected", {
    taskId: task.id,
    pathName: selected.name,
    surprise: selected.surprise,
    quality: selected.quality,
    score: selectionScore,
    archetypeTags: selected.archetypeTags,
  });

  log.info("Explore path selected", {
    taskId: task.id,
    pathName: selected.name,
    score: selectionScore.toFixed(3),
    rationale,
  });

  return {
    kind: "selected",
    paths,
    selected,
    selectionScore,
    selectionRationale: rationale,
  };
}
