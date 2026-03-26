/**
 * Approach Classifier — V2 speed-of-light component.
 *
 * One cheap LLM call classifies a premotor plan's approach into
 * archetype tags from a fixed vocabulary. The tags enable the
 * Cerebellum to filter historical episodes by approach class and
 * detect when the approach is the bottleneck.
 *
 * Fixed vocabulary ensures consistent matching across tasks.
 * Open-ended classification would produce synonyms that fragment
 * the episode space.
 */

import { z } from "zod";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("approach-classifier");

/** The fixed vocabulary of approach archetypes. */
export const APPROACH_ARCHETYPES = [
  "component-based-layout",
  "api-first",
  "progressive-enhancement",
  "content-driven",
  "data-pipeline",
  "configuration",
  "refactor-restructure",
  "visual-design-heavy",
  "performance-optimization",
  "security-hardening",
  "integration-wiring",
] as const;

const ClassificationResult = z.object({
  tags: z.array(z.string()).min(1).max(3),
});

const SYSTEM_PROMPT = `You are classifying a build approach into archetype tags.

Given a task description and the approach chosen by the premotor planner, classify the approach into 1-3 archetype tags from this fixed vocabulary:

${APPROACH_ARCHETYPES.map((t) => `- ${t}`).join("\n")}

Choose only tags that genuinely apply. Most approaches need 1-2 tags. Use 3 only when the approach truly spans multiple archetypes.`;

/**
 * Classify a build approach into archetype tags.
 *
 * Returns 1-3 tags from the fixed vocabulary. Uses the cheapest
 * available model — this is a classification task, not generation.
 */
export async function classifyApproach(
  taskDescription: string,
  approach: string,
  model: string,
): Promise<string[]> {
  const userPrompt = `TASK: ${taskDescription}

APPROACH: ${approach}

Return JSON: { "tags": ["most-relevant-tag", ...] }`;

  log.info("Classifying approach", {
    approachPreview: approach.slice(0, 100),
    model,
  });

  const result = await callStructured(
    "approach-classification",
    model,
    SYSTEM_PROMPT,
    userPrompt,
    ClassificationResult,
    512,
  );

  // Filter to valid archetypes only (LLM might hallucinate tags)
  const validTags = result.tags.filter((t) =>
    (APPROACH_ARCHETYPES as readonly string[]).includes(t),
  );

  // If all tags were invalid, return the raw tags (better than nothing)
  const tags = validTags.length > 0 ? validTags : result.tags.slice(0, 3);

  log.info("Approach classified", { tags });

  return tags;
}
