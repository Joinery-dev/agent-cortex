/**
 * Episode Builder — transforms an OrchestratorResult into an Episode.
 *
 * Pure function. No LLM calls, no I/O, no side effects.
 * Extracts the narrative structure from raw task data so the
 * episode is legible for potentiation and Thalamus queries.
 */

import type { OrchestratorResult } from "../types/orchestrator.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { Tension, TensionResolution, ResolutionOutcome } from "../types/tension.js";
import type { DecisionRecord } from "../types/intent.js";
import type {
  Episode,
  EpisodeNarrative,
  SenseParticipationRecord,
  ScoreProgressionEntry,
  DecisionSnapshot,
  TensionSnapshot,
} from "../types/hippocampus.js";
import { newId } from "../util/ids.js";

/**
 * Build an Episode from a completed task's result.
 *
 * @param projectId - Which project this episode belongs to
 * @param taskId - The task that produced this result
 * @param taskDescription - Human-readable task description
 * @param result - The full OrchestratorResult
 * @param dopamineSignal - Aggregate dopamine from the cerebellum
 * @param sequenceNumber - Monotonically increasing counter
 * @param significance - Pre-computed encoding strength from hippocampal projection (0–1).
 *   If omitted, falls back to |dopamineSignal| / 3 (legacy behavior).
 */
export function buildEpisode(
  projectId: string,
  taskId: string,
  taskDescription: string,
  result: OrchestratorResult,
  dopamineSignal: number,
  sequenceNumber: number,
  significance?: number,
): Episode {
  const senseParticipation = extractSenseParticipation(result.evaluations);
  const narrative = buildNarrative(taskDescription, result);
  const resolvedSignificance = significance ?? computeSignificance(dopamineSignal);

  return {
    id: newId(),
    taskId,
    projectId,
    narrative,
    senseParticipation,
    dopamineSignal,
    significance: resolvedSignificance,
    potentiatedBy: [],
    faded: false,
    contradicts: [],
    recordedAt: new Date(),
    sequenceNumber,
  };
}

// ─── Narrative extraction ───────────────────────────────────────

function buildNarrative(
  taskDescription: string,
  result: OrchestratorResult,
): EpisodeNarrative {
  return {
    taskDescription,
    cycles: result.cycles,
    outcome: result.status,
    confidence: result.confidence,
    scoreProgression: extractScoreProgression(result),
    decisions: extractDecisions(result.decisionLog),
    tensionSnapshots: extractTensions(result.tensions, result.resolutions, result.resolutionOutcomes),
    approachesTried: extractApproaches(result.decisionLog),
  };
}

/**
 * Extract score progression from the result.
 *
 * Currently OrchestratorResult only carries final evaluations,
 * so we produce a single entry at the final cycle. The array
 * structure anticipates future per-cycle tracking.
 */
function extractScoreProgression(
  result: OrchestratorResult,
): ScoreProgressionEntry[] {
  // Group evaluations by sense (activationPath[0])
  const bySense = new Map<
    string,
    { scores: number[]; acceptable: boolean[]; senseId: string }
  >();

  for (const evaluation of result.evaluations) {
    const senseName = evaluation.activationPath[0] ?? evaluation.senseId;
    const existing = bySense.get(senseName) ?? {
      scores: [],
      acceptable: [],
      senseId: evaluation.senseId,
    };
    existing.scores.push(evaluation.score);
    existing.acceptable.push(evaluation.acceptable);
    bySense.set(senseName, existing);
  }

  const scores = [...bySense.entries()].map(
    ([senseName, { scores, acceptable, senseId }]) => ({
      senseId,
      senseName,
      score: scores.reduce((a, b) => a + b, 0) / scores.length,
      acceptable: acceptable.every(Boolean),
    }),
  );

  return [
    {
      cycle: result.cycles,
      scores,
      overallConfidence: result.confidence,
    },
  ];
}

function extractDecisions(
  decisionLog: DecisionRecord[],
): DecisionSnapshot[] {
  return decisionLog.map((d) => ({
    description: d.description,
    reasoning: d.reasoning,
    confidence: d.confidence,
  }));
}

function extractTensions(
  tensions: Tension[],
  resolutions: TensionResolution[],
  resolutionOutcomes?: ResolutionOutcome[],
): TensionSnapshot[] {
  // Index outcomes by tensionId for O(1) lookup
  const outcomeByTension = new Map(
    resolutionOutcomes?.map((o) => [o.tensionId, o]) ?? [],
  );

  // Build a map of resolutions by matching tension order
  // (tensions and resolutions are parallel arrays from the resolver)
  return tensions.map((t, i) => {
    const resolution = t.resolution ?? resolutions[i];
    const outcome = outcomeByTension.get(t.id);

    return {
      senseA: t.senseA.path[0] ?? t.senseA.id,
      senseB: t.senseB.path[0] ?? t.senseB.id,
      description: t.description,
      severity: t.severity,
      resolution: resolution
        ? {
            strategy: resolution.strategy,
            satisfiesBoth: resolution.satisfiesBoth,
          }
        : undefined,
      outcome: outcome
        ? {
            quality: outcome.quality,
            gapShrinkage: outcome.gapShrinkage,
            scoresMaintained: outcome.scoresMaintained,
            collapsed: outcome.collapsed,
          }
        : undefined,
    };
  });
}

/**
 * Extract high-level approaches from the decision log.
 * Looks for decisions that indicate strategy shifts — not every
 * minor decision, but meaningful changes in approach.
 */
function extractApproaches(decisionLog: DecisionRecord[]): string[] {
  if (decisionLog.length === 0) return [];

  // Include the first decision (initial approach) and any that
  // indicate a change (low confidence = uncertainty = likely a pivot)
  const approaches: string[] = [];

  for (const decision of decisionLog) {
    // Keep it simple: include the description of each decision.
    // The first is the initial approach, subsequent ones are shifts.
    approaches.push(decision.description);
  }

  return approaches;
}

// ─── Sense participation ────────────────────────────────────────

/**
 * Group evaluations by sense (top-level activationPath[0]) and
 * compute per-sense summaries.
 */
function extractSenseParticipation(
  evaluations: SenseEvaluation[],
): SenseParticipationRecord[] {
  const bySense = new Map<string, SenseEvaluation[]>();

  for (const evaluation of evaluations) {
    const senseName = evaluation.activationPath[0] ?? evaluation.senseId;
    const group = bySense.get(senseName) ?? [];
    group.push(evaluation);
    bySense.set(senseName, group);
  }

  return [...bySense.entries()].map(([senseName, evals]) => {
    const scores = evals.map((e) => e.score);
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    return {
      senseId: evals[0].senseId,
      senseName,
      // Stake is not on SenseEvaluation — it comes from consultation.
      // We can't recover it here without changing the interface.
      // Default to 1.0 (full relevance) — the Thalamus has stake data.
      stake: 1.0,
      finalScore: meanScore,
      acceptable: evals.every((e) => e.acceptable),
      receptorScores: evals.map((e) => ({
        receptorId: e.senseId,
        score: e.score,
      })),
      assessment: evals.map((e) => e.assessment).join(" "),
    };
  });
}

// ─── Significance computation ───────────────────────────────────

/**
 * Compute episode significance from dopamine signal.
 * Maps |dopamine| to 0–1 range. A dopamine of ±3 or beyond
 * saturates at significance 1.0.
 *
 * The normalization factor (3.0) is not a value judgment —
 * it's a scaling constant. The dopamine signal itself already
 * encodes what's surprising based on the cerebellum's predictions.
 */
function computeSignificance(dopamineSignal: number): number {
  return Math.min(1, Math.abs(dopamineSignal) / 3);
}
