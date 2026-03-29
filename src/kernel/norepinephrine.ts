/**
 * Norepinephrine — the arousal/thoroughness dial.
 *
 * Pure function. No class, no state, no LLM calls.
 * Computes a single NE level (0–1) from four input signals:
 *   maturity, risk, novelty, conviction.
 *
 * Uses a max-blend formula: 60% weighted average of all components,
 * 40% the single strongest component. This ensures that one dominant
 * signal (e.g., a completely novel task in a mature system) can pull
 * NE up significantly on its own, while multiple moderate signals
 * combine smoothly through the weighted average.
 *
 * Called at three points in the lifecycle:
 *   1. Scheduler dispatch — maturity + risk only
 *   2. Sensory-cortex prepare — adds novelty (from cerebellum prediction)
 *   3. Build-cycle gate — adds conviction (from conviction loop)
 */

import type { NEWeights, NEInputs, NEResult, NEComponents } from "../types/norepinephrine.js";
import { emit } from "../events.js";

// ─── Defaults ────────────────────────────────────────────────────

export const DEFAULT_NE_WEIGHTS: NEWeights = {
  maturity: 0.27,   // Biggest factor early on, shrinks as system matures
  risk: 0.23,       // Steady contribution from task risk factors
  novelty: 0.23,    // Dominates for novel tasks even in a mature system
  conviction: 0.17, // Conviction erosion raises NE noticeably
  urgency: 0.10,    // Human-declared urgency — the human → NE path
};

/**
 * Blend ratio between the weighted average and the max component.
 * 0.4 means 40% of the final NE comes from the single strongest signal.
 * This prevents a single strong signal from being diluted by quiet ones.
 */
const MAX_BLEND = 0.4;
const AVG_BLEND = 1.0 - MAX_BLEND;

// ─── Computation ─────────────────────────────────────────────────

/**
 * Compute the norepinephrine level from available inputs.
 *
 * Absent inputs use conservative defaults:
 *   cerebellumAccuracy → 0.5 (unknown, not the Cerebellum's optimistic 0.8)
 *   bestSimilarity     → 0   (maximum novelty — no match found)
 *   convictionLevel    → 0.5 (neutral — conviction hasn't run yet)
 *   humanUrgency       → 0.25 (normal — no urgency declared)
 *   risk               → all zeros (no risk factors present)
 *   amygdalaOverride   → false
 */
export function computeNE(
  inputs: NEInputs,
  weights: NEWeights = DEFAULT_NE_WEIGHTS,
): NEResult {
  // Amygdala override: short-circuit to near-ceiling
  if (inputs.amygdalaOverride) {
    return {
      ne: 0.95,
      components: {
        maturityComponent: 0,
        riskComponent: 0,
        noveltyComponent: 0,
        convictionComponent: 0,
        urgencyComponent: 0,
        amygdalaOverride: true,
      },
    };
  }

  // 1. Maturity component: 1 - prediction accuracy.
  //    Low accuracy (immature) → high component → high NE.
  const accuracy = inputs.cerebellumAccuracy ?? 0.5;
  const maturityComponent = 1.0 - accuracy;

  // 2. Risk component: max of individual risk factors.
  //    Worst risk wins — not additive.
  const rf = inputs.risk ?? {};
  const riskSignals = [
    rf.phaseGateProximity ?? 0,
    rf.dependencyFanOut ?? 0,
    rf.decliningTrends ?? 0,
    rf.wmPressure ?? 0,
    rf.weightVolatility ?? 0,
    rf.budgetPressure ?? 0,
    rf.observationPressure ?? 0,
    rf.exteroceptivePressure ?? 0,
    rf.recentFailure ?? 0,
    rf.taskComplexity ?? 0,
  ];
  const riskComponent = Math.max(...riskSignals, 0);

  // 3. Novelty component: 1 - best similarity.
  //    Cold start / no similar episodes → novelty 1.0.
  const noveltyComponent = 1.0 - (inputs.bestSimilarity ?? 0);

  // 4. Conviction component: 1 - conviction level.
  //    Low conviction → high component → NE rises.
  const convictionComponent = 1.0 - (inputs.convictionLevel ?? 0.5);

  // 5. Urgency component: direct mapping from human urgency.
  //    Absent → 0.25 (normal urgency).
  const urgencyComponent = inputs.humanUrgency ?? 0.25;

  // Max-blend: weighted average + strongest single signal
  const weightedAvg =
    weights.maturity * maturityComponent +
    weights.risk * riskComponent +
    weights.novelty * noveltyComponent +
    weights.conviction * convictionComponent +
    weights.urgency * urgencyComponent;

  const maxComponent = Math.max(
    maturityComponent,
    riskComponent,
    noveltyComponent,
    convictionComponent,
    urgencyComponent,
  );

  const ne = Math.min(1.0, Math.max(0.0, AVG_BLEND * weightedAvg + MAX_BLEND * maxComponent));

  const components: NEComponents = {
    maturityComponent,
    riskComponent,
    noveltyComponent,
    convictionComponent,
    urgencyComponent,
    amygdalaOverride: false,
  };

  return { ne, components };
}

// ─── Urgency mapping ────────────────────────────────────────────

/** Map ProjectIntent.urgency to a 0–1 NE input. */
export function mapUrgencyToNE(urgency?: "low" | "normal" | "high" | "critical"): number {
  switch (urgency) {
    case "low": return 0.0;
    case "normal": return 0.25;
    case "high": return 0.65;
    case "critical": return 1.0;
    default: return 0.25;
  }
}

// ─── Task complexity ────────────────────────────────────────────

/**
 * Compute task complexity from structural signals.
 *
 * @param dependencyCount  Number of tasks this depends on (integration surface)
 * @param descriptionLength  Character count of task description (scope proxy)
 * @param highStakeSenseCount  Senses with stake > 0.7 for this task
 * @param totalSenseCount  Total active senses
 * @returns 0–1 where higher = more complex
 */
export function computeTaskComplexity(
  dependencyCount: number,
  descriptionLength: number,
  highStakeSenseCount: number,
  totalSenseCount: number,
): number {
  // Dependency factor: more deps = more integration surface (caps at 5)
  const depFactor = Math.min(1, dependencyCount / 5);
  // Scope factor: long descriptions suggest broad scope (caps at 500 chars)
  const scopeFactor = Math.min(1, descriptionLength / 500);
  // Stake factor: proportion of high-stake senses
  const stakeFactor = totalSenseCount > 0
    ? highStakeSenseCount / totalSenseCount
    : 0;
  // Weighted combination (not max — complexity is additive)
  return Math.min(1, 0.3 * depFactor + 0.3 * scopeFactor + 0.4 * stakeFactor);
}

// ─── Risk factor extraction helpers ──────────────────────────────

/**
 * Extract risk factors from the Scheduler's signals.
 * Used by AttentionScheduler.computeDispatchNE().
 */
export function extractRiskFromSchedulerSignals(
  nodeId: string,
  phaseGroup: string | undefined,
  dependsOnThisTask: number,
  signals: {
    taskGraph: Array<{ task: { id: string }; phaseGroup?: string }>;
    completedTaskIds: Set<string>;
    escalatedTaskIds: Set<string>;
    wmSnapshot: {
      senseTrends: Array<{ direction: string }>;
      load: number;
    };
    vitals: { weightVolatility: number };
    observationPressure?: number;
    lastTaskDopamine?: number;
    exteroceptivePressure?: number;
  },
  taskMetadata?: {
    dependencyCount: number;
    descriptionLength: number;
    highStakeSenseCount: number;
    totalSenseCount: number;
  },
): import("../types/norepinephrine.js").RiskFactors {
  const done = new Set([...signals.completedTaskIds, ...signals.escalatedTaskIds]);

  // Phase gate proximity
  let phaseGateProximity = 0;
  if (phaseGroup) {
    const phaseNodes = signals.taskGraph.filter((n) => n.phaseGroup === phaseGroup);
    const completed = phaseNodes.filter((n) => done.has(n.task.id)).length;
    phaseGateProximity = phaseNodes.length > 0 ? completed / phaseNodes.length : 0;
  }

  // Dependency fan-out
  const remainingTasks = signals.taskGraph.filter((n) => !done.has(n.task.id)).length;
  const dependencyFanOut = remainingTasks > 0 ? dependsOnThisTask / remainingTasks : 0;

  // Declining trends
  const senseTrends = signals.wmSnapshot.senseTrends;
  const downCount = senseTrends.filter((t) => t.direction === "down").length;
  const decliningTrends = senseTrends.length > 0 ? downCount / senseTrends.length : 0;

  // Recency of failure: negative dopamine from the last task = heightened risk
  const lastDop = signals.lastTaskDopamine;
  const recentFailure = lastDop !== undefined && lastDop < 0
    ? Math.min(1, Math.abs(lastDop))
    : 0;

  return {
    phaseGateProximity,
    dependencyFanOut,
    decliningTrends,
    wmPressure: signals.wmSnapshot.load,
    weightVolatility: signals.vitals.weightVolatility,
    observationPressure: signals.observationPressure,
    exteroceptivePressure: signals.exteroceptivePressure,
    recentFailure,
    taskComplexity: taskMetadata
      ? computeTaskComplexity(
          taskMetadata.dependencyCount,
          taskMetadata.descriptionLength,
          taskMetadata.highStakeSenseCount,
          taskMetadata.totalSenseCount,
        )
      : undefined,
  };
}
