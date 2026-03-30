/**
 * Attention Budget — Cortex's cognitive investment plan for a task.
 *
 * Produced by the Attention Scheduler at dispatch. Consumed by the
 * sensory cortex gate. Recorded in Cerebellum episodes for learning.
 *
 * The cycle range replaces the flat maxOuterCycles config with a
 * task-specific, NE-modulated range that the Cerebellum learns to
 * refine over time. NE widens the range (uncertain = more headroom).
 * Cerebellum predictions narrow it (experienced = efficient).
 *
 * Model tier, briefing depth, and explore breadth already have their
 * own modulation paths (ModelSelector, Thalamus, Explore). The
 * attention budget owns the iteration budget — how many outer cycles
 * Cortex will invest in this task.
 *
 * This implements the architecture spec's mandate (Features 7, 18, 22)
 * that hardcoded cycle limits be replaced by learned stopping criteria.
 */

// ─── Cycle Range ─────────────────────────────────────────────

/**
 * The allowed iteration range for a task's outer loop.
 *
 * Gate behavior by zone:
 *   outerCycle < floor      → never exit (minimum investment not met)
 *   floor ≤ outerCycle      → normal gate logic, progressively tightening
 *   outerCycle ≥ expected×2 → cognitive flexibility signal (approach may be wrong)
 *   outerCycle ≥ ceiling    → force exit with diagnostic
 *
 * Values are positive integers. Invariant: floor ≤ expected ≤ ceiling.
 */
export interface CycleRange {
  /** Minimum outer cycles. Gate cannot exit below this, even if quality looks good. */
  floor: number;
  /** Predicted convergence point — the expected number of outer cycles. */
  expected: number;
  /** Maximum outer cycles. Force exit with diagnostic above this. */
  ceiling: number;
}

// ─── Attention Basis ─────────────────────────────────────────

/**
 * What drove an attention budget allocation.
 *
 * Recorded alongside episode actuals so the Cerebellum can learn
 * which allocation bases produce accurate predictions. When basis
 * says "cold-start with NE 0.8" and the task actually used 2 cycles,
 * that's a calibration data point.
 */
export interface AttentionBasis {
  /** NE level at computation time. Drives range width. */
  neLevel: number;
  /** Task importance signal (0–1). From task graph position. */
  importance: number;
  /** How the range was computed — tracks system maturity. */
  source: "cold-start" | "cerebellum" | "efference-revised";
  /** Cerebellum's raw cycle percentiles, if available. */
  cerebellumPercentiles?: CyclePercentiles;
  /** Efference copy's convergence estimate, if revision occurred. */
  efferenceEstimate?: number;
}

/** Cerebellum's learned cycle distribution from similar episodes. */
export interface CyclePercentiles {
  p10: number;
  p50: number;
  p90: number;
  /** How many episodes contributed to this distribution. */
  episodeCount: number;
}

// ─── Attention Budget ────────────────────────────────────────

/**
 * Cortex's cognitive investment plan for a task.
 *
 * Computed at dispatch (Phase 1) from NE + Cerebellum + task importance.
 * Optionally revised at sensory-cortex prepare (Phase 2) when the
 * efference copy provides builder-side feasibility data.
 *
 * The learning loop: episodes record this budget alongside actual cycles.
 * The Cerebellum learns what allocations produce good outcomes, and
 * future budgets become more accurate. Cost prediction is a side effect
 * of accurate cycle prediction — not a constraint, but a learning vector.
 */
export interface AttentionBudget {
  /** The cycle range for this task's outer loop. */
  cycleRange: CycleRange;
  /** What drove this allocation (for learning and observability). */
  basis: AttentionBasis;
  /** When this budget was computed (or last revised). */
  computedAt: Date;
}
