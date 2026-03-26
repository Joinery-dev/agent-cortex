/**
 * Quick Triage — procedural between-task scan of observations.
 *
 * Runs after drift monitor quickCheck in task-dispatch.integrate.
 * No LLM calls. Pure function operating on WM observations + graph state.
 *
 * Can only produce "amend" proposals (never insert/rework/reorder).
 * This keeps blast radius inherently low and avoids the need for
 * conviction checks on triage proposals.
 *
 * Decision logic:
 *   1. Filter observations by NE-modulated relevance threshold
 *   2. Match observations to next ready tasks by keyword overlap
 *   3. If match → propose amend (add observation fact to task context)
 *   4. If observation pressure > 0.7 → flag for early deep synthesis
 *   5. If any observation has relevance > 0.8 → flag for deep synthesis
 *   6. Mark consumed observations as "triaged"
 */

import type { TaskGraphNode } from "../types/brainstem.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { SurgeryProposal, GraphSurgeryAmend } from "../types/graph-surgery.js";
import { relevanceThreshold, observationPressure } from "../types/territory-observation.js";
import { computeBlastRadius } from "./graph-surgery.js";
import type { WorkingMemory } from "./working-memory.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("quick-triage");

// ─── Result Type ────────────────────────────────────────────────

export interface QuickTriageResult {
  /** Number of observations that were consumed by this triage. */
  observationsTriaged: number;
  /** Surgery proposals generated (amend only). */
  proposals: SurgeryProposal[];
  /** Whether deep synthesis should run at next phase gate (or sooner). */
  flagForDeepSynthesis: boolean;
  /** Reason for flagging, if flagged. */
  flagReason?: string;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Quick triage: procedural scan of recent observations.
 *
 * Called from task-dispatch.integrate after drift monitor quickCheck.
 * Pure function — reads from WM but marks observations via the passed instance.
 */
export function quickTriage(
  wm: WorkingMemory,
  graph: TaskGraphNode[],
  completedTaskIds: Set<string>,
  escalatedTaskIds: Set<string>,
  neLevel: number,
): QuickTriageResult {
  const newObs = wm.getNewObservations();
  if (newObs.length === 0) {
    return {
      observationsTriaged: 0,
      proposals: [],
      flagForDeepSynthesis: false,
    };
  }

  const threshold = relevanceThreshold(neLevel);
  const relevant = newObs.filter((o) => o.relevance >= threshold);

  // Find ready tasks (not completed, not escalated, deps satisfied)
  const done = new Set([...completedTaskIds, ...escalatedTaskIds]);
  const readyTasks = graph.filter(
    (n) => !done.has(n.task.id) && n.dependsOn.every((dep) => done.has(dep)),
  );

  const proposals: SurgeryProposal[] = [];
  const triaged: string[] = [];

  // Match each relevant observation against ready tasks
  for (const obs of relevant) {
    const matchingTask = findMatchingTask(obs, readyTasks);
    if (matchingTask) {
      // Build an amend proposal: add the observation fact to the task's context
      const amendOp: GraphSurgeryAmend = {
        op: "amend",
        taskId: matchingTask.task.id,
        description: matchingTask.task.description,
        additionalContext: {
          territoryObservations: [
            ...((matchingTask.task.context.territoryObservations as string[]) ?? []),
            obs.fact,
          ],
        },
      };

      proposals.push({
        id: newId(),
        source: "quick-triage",
        reasoning: `Observation "${obs.fact}" is relevant to task "${matchingTask.task.description}"`,
        operations: [amendOp],
        blastRadius: computeBlastRadius([amendOp], graph, completedTaskIds),
        grounding: [obs.id],
        createdAt: new Date(),
        status: "pending",
      });

      triaged.push(obs.id);
    }
  }

  // Mark consumed observations as triaged
  for (const id of triaged) {
    wm.markObservationTriaged(id);
  }

  // Check flags for deep synthesis
  let flagForDeepSynthesis = false;
  let flagReason: string | undefined;

  // High observation pressure (post-triage) → trigger deep synthesis sooner
  const pressure = observationPressure(wm.getNewObservations());
  if (pressure > 0.7) {
    flagForDeepSynthesis = true;
    flagReason = `Observation pressure ${pressure.toFixed(2)} exceeds threshold (0.7)`;
  }

  // Any high-relevance observation that wasn't already triaged → flag
  if (!flagForDeepSynthesis) {
    const unconsumed = newObs.filter((o) => !triaged.includes(o.id));
    const highRelevance = unconsumed.find((o) => o.relevance > 0.8);
    if (highRelevance) {
      flagForDeepSynthesis = true;
      flagReason = `High-relevance observation: "${highRelevance.fact}" (${highRelevance.relevance})`;
    }
  }

  if (proposals.length > 0 || flagForDeepSynthesis) {
    emit("triage:complete", {
      observationsScanned: newObs.length,
      relevantCount: relevant.length,
      proposalCount: proposals.length,
      flagForDeepSynthesis,
      neLevel,
      threshold,
    });

    log.info("Quick triage complete", {
      scanned: newObs.length,
      relevant: relevant.length,
      proposals: proposals.length,
      flagged: flagForDeepSynthesis,
    });
  }

  return {
    observationsTriaged: triaged.length,
    proposals,
    flagForDeepSynthesis,
    flagReason,
  };
}

// ─── Matching Logic ─────────────────────────────────────────────

/**
 * Find the best matching ready task for an observation.
 *
 * Procedural keyword matching: tokenize both the observation fact and
 * each task description, count overlapping substantive words. Returns
 * the task with the most overlap, or null if no meaningful match.
 */
function findMatchingTask(
  obs: TerritoryObservation,
  readyTasks: TaskGraphNode[],
): TaskGraphNode | null {
  const obsTokens = tokenize(obs.fact);
  if (obsTokens.size === 0) return null;

  let bestMatch: TaskGraphNode | null = null;
  let bestScore = 0;

  for (const node of readyTasks) {
    const taskTokens = tokenize(node.task.description);
    const overlap = intersection(obsTokens, taskTokens);

    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = node;
    }
  }

  // Require at least 2 overlapping substantive words for a match
  return bestScore >= 2 ? bestMatch : null;
}

/** Tokenize a string into a set of lowercase substantive words. */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/** Count of common elements between two sets. */
function intersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) count++;
  }
  return count;
}

/** Common words that shouldn't count as meaningful overlap. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "has",
  "will", "been", "each", "into", "also", "can", "are", "was", "not",
  "but", "its", "all", "any", "use", "using", "used", "should", "would",
  "could", "does", "did", "may", "might", "need", "needs", "make", "made",
  "set", "get", "add", "new", "one", "two", "run", "let",
]);
