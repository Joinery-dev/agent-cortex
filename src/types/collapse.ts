/**
 * Collapsed-Tension Detection types.
 *
 * Collapse detection judges whether a tension resolution is genuine
 * synthesis or capitulation. Derived from score trajectories in
 * resolution-quality.ts — no LLM call needed.
 *
 * Produces a gate signal for the build-cycle.
 */

// ─── Collapsed-Tension Detection ────────────────────────────────

/** Output of collapsed-tension detection. */
export interface CollapseSignal {
  /** Whether any tensions collapsed (vs. genuine resolution). */
  collapsed: boolean;
  /** Per-tension details. */
  details: CollapseDetail[];
}

export interface CollapseDetail {
  /** Which tension this applies to. */
  tensionId: string;
  /** Whether this specific tension collapsed. */
  collapsed: boolean;
  /** Which sense capitulated (if any). */
  capitulatedSense?: string;
  /** Why we think this is capitulation vs. synthesis. */
  explanation: string;
  /** Guidance for the next build cycle to re-engage this tension. */
  reEngagementGuidance?: string;
}
