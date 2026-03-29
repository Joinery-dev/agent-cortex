/**
 * Attention Budget — computes task-specific cycle ranges.
 *
 * Pure functions. No class, no state, no LLM calls.
 * Follows the same pattern as norepinephrine.ts.
 *
 * The attention budget replaces the flat maxOuterCycles config with a
 * task-specific {floor, expected, ceiling} range. NE widens the range
 * (uncertain = more headroom). Cerebellum predictions narrow it
 * (experienced = efficient).
 *
 * Called at two points:
 *   1. Scheduler dispatch — coarse allocation from NE + Cerebellum + importance
 *   2. Sensory-cortex prepare — efference copy may revise the range
 */

import type {
  CycleRange,
  CyclePercentiles,
  AttentionBasis,
  AttentionBudget,
} from "../types/attention-budget.js";

// ─── Inputs ──────────────────────────────────────────────────

export interface AttentionBudgetInputs {
  /** NE level at dispatch (0–1). Drives range width. */
  neLevel: number;
  /** Absolute safety cap from CortexConfig.maxOuterCycles. */
  maxOuterCycles: number;
  /** Cerebellum's cycle distribution from similar episodes. Null on cold start. */
  cerebellumPercentiles?: CyclePercentiles | null;
  /** Task importance (0–1). Phase gate proximity, dependency fan-out, etc. */
  taskImportance?: number;
}

// ─── Computation ─────────────────────────────────────────────

/**
 * Compute the attention budget for a task.
 *
 * Two paths:
 *   - Cold start (no cerebellum data): uses sensible defaults, NE widens.
 *   - Learned (cerebellum percentiles): p10/p50/p90 from similar episodes,
 *     NE extends the upper tail.
 *
 * NE modulates width: high NE → wider range (system is uncertain, give headroom).
 * Low NE → tight range (system knows how long this takes).
 *
 * Importance modulates floor: critical tasks get minimum 2 cycles.
 *
 * Ceiling is always clamped to maxOuterCycles (absolute safety cap).
 * Invariant: floor ≤ expected ≤ ceiling.
 */
export function computeAttentionBudget(inputs: AttentionBudgetInputs): AttentionBudget {
  const { neLevel, maxOuterCycles, taskImportance } = inputs;
  const percentiles = inputs.cerebellumPercentiles ?? null;

  let cycleRange: CycleRange;
  let source: AttentionBasis["source"];

  if (percentiles && percentiles.episodeCount >= 2) {
    // ── Learned path: Cerebellum has episode data ──
    const p10 = percentiles.p10;
    const p50 = percentiles.p50;
    const p90 = percentiles.p90;

    let floor = Math.max(1, Math.round(p10));
    let expected = Math.max(1, Math.round(p50));
    // NE extends the upper tail proportionally
    let ceiling = Math.round(p90 + neLevel * (p90 - p50));

    // Enforce invariants
    expected = Math.max(expected, floor);
    ceiling = Math.max(ceiling, expected);
    ceiling = Math.min(ceiling, maxOuterCycles);
    expected = Math.min(expected, ceiling);

    cycleRange = { floor, expected, ceiling };
    source = "cerebellum";
  } else {
    // ── Cold start: no episode data ──
    const expected = 2;
    const floor = 1;
    // NE widens ceiling: NE 0 → 2.0x, NE 0.5 → 2.75x, NE 1.0 → 3.5x
    const ceilingMultiplier = 2.0 + neLevel * 1.5;
    let ceiling = Math.ceil(expected * ceilingMultiplier);
    ceiling = Math.min(ceiling, maxOuterCycles);

    cycleRange = { floor, expected, ceiling };
    source = "cold-start";
  }

  // Importance boost: critical tasks get minimum 2 cycles
  const importance = taskImportance ?? 0.5;
  if (importance > 0.7 && cycleRange.floor < 2) {
    cycleRange = {
      ...cycleRange,
      floor: 2,
      expected: Math.max(cycleRange.expected, 2),
    };
  }

  return {
    cycleRange,
    basis: {
      neLevel,
      importance,
      source,
      cerebellumPercentiles: percentiles ?? undefined,
    },
    computedAt: new Date(),
  };
}

// ─── Efference Revision ──────────────────────────────────────

/**
 * Revise an attention budget based on the Motor Cortex's efference copy.
 *
 * The efference copy's convergenceEstimate is the builder's ground-truth
 * assessment of how many cycles the task will need. When it significantly
 * differs from the current expected, blend toward it.
 *
 * This is Phase 2 of attention budget computation — runs after the
 * efference copy is produced in sensory-cortex prepare (cycle 1 only).
 *
 * "Significant" = more than 1 cycle difference. Small differences
 * stay with the original prediction (avoid noise from minor variation).
 */
export function reviseWithEfference(
  budget: AttentionBudget,
  efferenceEstimate: number,
): AttentionBudget {
  const current = budget.cycleRange;
  const diff = Math.abs(efferenceEstimate - current.expected);

  // Only revise if the efference estimate is significantly different
  if (diff < 1) return budget;

  // Blend: 60% efference (builder's ground truth), 40% current (statistical)
  const blended = Math.round(efferenceEstimate * 0.6 + current.expected * 0.4);
  const expected = Math.max(current.floor, blended);

  // Re-derive ceiling preserving the NE-driven width ratio
  const widthRatio = current.ceiling > 0
    ? current.ceiling / Math.max(current.expected, 1)
    : 2.5;
  let ceiling = Math.round(expected * widthRatio);
  ceiling = Math.max(ceiling, expected);

  // Don't exceed the original safety cap (which was already clamped to maxOuterCycles)
  ceiling = Math.min(ceiling, Math.max(current.ceiling, expected + 2));

  return {
    cycleRange: {
      floor: current.floor,
      expected,
      ceiling,
    },
    basis: {
      ...budget.basis,
      source: "efference-revised",
      efferenceEstimate,
    },
    computedAt: new Date(),
  };
}
