/**
 * Integration Check — phase gate coherence verification.
 *
 * When all tasks in a phaseGroup complete, the integration checker
 * evaluates whether the collective output satisfies the phase's
 * gate condition from each sense's perspective.
 *
 * Two layers:
 *   Layer 1: Quantitative pre-check (no LLM) — fast exit when green
 *   Layer 2: Per-sense LLM evaluation — senses judge collective coherence
 *
 * Output channels:
 *   Integration issues → BetweenTasksSlowPath → replan cascade
 *   Discovered problems → proactive problem discovery (future)
 */

import type { SenseEvaluation } from "./sense.js";

// ─── Configuration ──────────────────────────────────────────────

export interface IntegrationCheckConfig {
  /** Max tokens for integration evaluation per-sense LLM calls. */
  maxTokens: number;
  /** Composite score (1–10) below which integration fails. */
  failureThreshold: number;
  /** NE level above which LLM evaluation runs even if pre-check is green. */
  neOverrideThreshold: number;
}

export const DEFAULT_INTEGRATION_CHECK_CONFIG: IntegrationCheckConfig = {
  maxTokens: 4096,
  failureThreshold: 5.0,
  neOverrideThreshold: 0.6,
};

// ─── Pre-check (Layer 1) ────────────────────────────────────────

/** Quantitative signals read from WM, conviction, drift at phase boundary. */
export interface PreCheckSignals {
  /** Worst sense trend direction across phase tasks. */
  worstTrendDirection: "up" | "stable" | "down";
  /** Lowest current mean across sense trends for phase tasks. */
  lowestSenseMean: number;
  /** Conviction trajectory direction (from WM ledger). */
  convictionDirection: "up" | "stable" | "down";
  /** Current conviction level (0–1). */
  convictionLevel: number;
  /** Number of high-severity tensions across all phase task results. */
  highTensionCount: number;
  /** Drift level from drift monitor (0–1). */
  driftLevel: number;
  /** Current NE level (from the most recent dispatch). */
  neLevel: number;
}

export type PreCheckVerdict = "green" | "yellow" | "red";

export interface PreCheckResult {
  signals: PreCheckSignals;
  verdict: PreCheckVerdict;
  /** If green and NE is low, skip the LLM evaluation. */
  skipLLM: boolean;
  reasoning: string;
}

// ─── Synthetic evaluation plan ──────────────────────────────────

/**
 * Evaluation plan entry for integration (no consultation required).
 * Built from the union of senses that evaluated any task in the phase.
 */
export interface IntegrationEvalEntry {
  receptorId: string;
  senseId: string;
  senseName: string;
  /** Mean stake across the receptor's appearances in phase tasks. */
  stake: number;
  activationPath: string[];
}

// ─── Phase gate result ──────────────────────────────────────────

/** Full result of the phase gate integration check. */
export interface PhaseGateResult {
  phaseGroup: string;
  gateCondition: string;
  preCheck: PreCheckResult;
  /** Per-sense evaluations. Null when pre-check skipped LLM evaluation. */
  evaluations: SenseEvaluation[] | null;
  /** Weighted composite score (1–10). Null if no LLM evaluation ran. */
  compositeScore: number | null;
  /** Whether the phase gate passed. */
  passed: boolean;
  /** Integration issues detected (from failed evaluations). */
  integrationIssues: string[];
  /** Problems discovered for proactive systems (not coherence failures). */
  discoveredProblems: string[];
  /** Time taken for the full check (ms). */
  durationMs: number;
}
