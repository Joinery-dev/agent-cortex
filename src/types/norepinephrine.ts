/**
 * Norepinephrine Signal — arousal/thoroughness dial.
 *
 * NE modulates how much attention the system gives to everything:
 *   High NE → more senses, lower acceptance thresholds, richer briefings, more checkpoints
 *   Low NE  → fewer senses, fast-tracked, lean briefings, skip proprioception
 *
 * Computed from four inputs:
 *   1. Maturity    — Cerebellum prediction accuracy (training wheels)
 *   2. Risk        — task graph structure, WM state, weight volatility
 *   3. Novelty     — Cerebellum episode similarity (how new is this task?)
 *   4. Conviction  — PFC conviction loop (is the system convincing itself?)
 *
 * Split computation across the lifecycle:
 *   Dispatch time:     maturity + risk     (Scheduler)
 *   After prediction:  + novelty           (sensory-cortex)
 *   Each build cycle:  + conviction        (build-cycle gate)
 */

// ─── Weights ─────────────────────────────────────────────────────

/**
 * Per-signal weights for the NE computation.
 * Learnable by Plasticity in the future — for now, sensible defaults.
 */
export interface NEWeights {
  /** Weight for maturity signal (1 - prediction accuracy). */
  maturity: number;
  /** Weight for risk signal (max of risk factors). */
  risk: number;
  /** Weight for novelty signal (1 - bestSimilarity). */
  novelty: number;
  /** Weight for conviction deficit (1 - conviction level). */
  conviction: number;
  /** Weight for human urgency signal. */
  urgency: number;
}

// ─── Inputs ──────────────────────────────────────────────────────

/**
 * All inputs to the NE computation. Each is optional — absent
 * signals use conservative defaults (see computeNE).
 */
export interface NEInputs {
  /**
   * Cerebellum prediction accuracy (0–1). From Cerebellum.getAccuracy().
   * Low accuracy = immature system = high baseline NE.
   * Absent → 0.5 (conservative unknown, not the Cerebellum's optimistic 0.8).
   */
  cerebellumAccuracy?: number;

  /**
   * Best similarity score from Cerebellum prediction (0–1).
   * High similarity = familiar task = low novelty.
   * Absent → 0 (maximum novelty — no similar episodes found or cold start).
   */
  bestSimilarity?: number;

  /**
   * Current conviction level from the PFC conviction loop (0–1).
   * Low conviction = system isn't convincing itself = raise NE.
   * Absent → 0.5 (neutral — conviction hasn't run yet).
   */
  convictionLevel?: number;

  /** Structured risk factors from task graph and system state. */
  risk?: RiskFactors;

  /**
   * Mapped human urgency (0–1). From ProjectIntent.urgency.
   * low=0.0, normal=0.25, high=0.65, critical=1.0.
   * Absent → 0.25 (normal — no urgency declared).
   */
  humanUrgency?: number;

  /** Amygdala urgency override. When true, NE floors at ~0.95. */
  amygdalaOverride?: boolean;
}

/**
 * Structured risk factors. Each is 0–1 where higher = more risk.
 * The NE computation takes the max (worst risk wins, not additive).
 */
export interface RiskFactors {
  /**
   * Phase gate proximity: completedInPhase / totalInPhase.
   * Close to 1.0 = approaching a phase gate = higher risk.
   */
  phaseGateProximity?: number;

  /**
   * Dependency fan-out: tasks that depend on this / remaining tasks.
   * High = many downstream tasks depend on getting this right.
   */
  dependencyFanOut?: number;

  /**
   * Fraction of sense trends declining (0–1).
   * Quality trajectory is going the wrong direction.
   */
  decliningTrends?: number;

  /** Working memory load (0–1). High = scratchpad is noisy. */
  wmPressure?: number;

  /** Plastic connection weight volatility (0–1). High = weights oscillating. */
  weightVolatility?: number;

  /**
   * Budget pressure: how tight the remaining budget is (0–1).
   * Computed as utilization^2 (quadratic: gentle at 50%, sharp at 80%+).
   * High = mistakes are expensive because the project can't afford to redo.
   * 0 when no budget is set (unconstrained mode).
   */
  budgetPressure?: number;

  /**
   * Territory observation pressure (0–1). From WM.getObservationPressure().
   * High = many untriaged observations piling up = system should be more
   * attentive and trigger synthesis sooner.
   */
  observationPressure?: number;

  /**
   * Recency of failure (0–1). abs(aggregateDopamine) from the last
   * completed task when that dopamine was negative. Per-task, not
   * cumulative — a "be careful" reflex after a miss.
   * 0 when the last task was successful or no previous task exists.
   */
  recentFailure?: number;

  /**
   * Exteroceptive signal pressure (0–1). From ExteroceptionSystem.getSignalPressure().
   * High = many unprocessed external signals piling up = system should be
   * more attentive and process the batch sooner.
   */
  exteroceptivePressure?: number;

  /**
   * Task complexity (0–1). Computed from:
   *   - Number of dependencies (integration surface)
   *   - Task description length (scope proxy)
   *   - Proportion of high-stake senses
   * Complex tasks warrant more attention even when nothing else is risky.
   */
  taskComplexity?: number;
}

// ─── Result ──────────────────────────────────────────────────────

/**
 * Output of the NE computation. Includes the final level and a
 * per-component breakdown for observability (events, dashboard).
 */
export interface NEResult {
  /** Final NE level (0–1). The single number consumers read. */
  ne: number;

  /** Per-component breakdown: what contributed and how much. */
  components: NEComponents;
}

/** Per-input component values before weighting. Each is 0–1. */
export interface NEComponents {
  /** 1 - cerebellumAccuracy. High when immature. */
  maturityComponent: number;
  /** max(riskFactors). High when worst risk factor is high. */
  riskComponent: number;
  /** 1 - bestSimilarity. High when task is novel. */
  noveltyComponent: number;
  /** 1 - convictionLevel. High when conviction is low. */
  convictionComponent: number;
  /** Mapped urgency from human intent. High when critical urgency. */
  urgencyComponent: number;
  /** Whether the amygdala override fired. */
  amygdalaOverride: boolean;
}
