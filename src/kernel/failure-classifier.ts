/**
 * Failure Classifier — pure functions, no LLM calls.
 *
 * Classifies gate rejections into categories that determine
 * the right revision strategy. Different failure types need
 * different responses:
 *
 *   local-logic         → targeted surgical fix (few senses object)
 *   integration         → senses conflict, resolution failed
 *   specification-gap   → motor thought it did fine, senses disagree on "done"
 *   approach-bottleneck → the approach itself is the ceiling
 *
 * All inputs are already available in the gate phase.
 * Follows the evaluation-weighter.ts pattern: pure computation layer.
 */

import type { WeightedEvaluation, WeightedComposite } from "./evaluation-weighter.js";
import type { Tension } from "../types/tension.js";
import type { OscillationSignal } from "../types/working-memory.js";
import type { SpeedOfLight } from "../types/cerebellum.js";
import type { CollapseSignal } from "../types/collapse.js";
import type { FailureCategory, FailureClassification } from "../types/motor-cortex.js";

// ─── Input ─────────────────────────────────────────────────────

export interface FailureClassifierInput {
  /** Gate rejection drivers (sorted by impact, highest first). */
  rejectionDrivers: WeightedEvaluation[];
  /** Full weighted composite from evaluation. */
  composite: WeightedComposite;
  /** Tensions detected in this cycle. */
  tensions: Tension[];
  /** Score oscillation signals from working memory. */
  oscillations: OscillationSignal[];
  /** Speed of light for this task (may be absent on cold start). */
  speedOfLight?: SpeedOfLight | null;
  /** Collapse detection signal from basal ganglia. */
  collapseSignal?: CollapseSignal | null;
  /** Conviction verdict from the PFC conviction loop. */
  convictionVerdict?: "proceed" | "reshape" | "escalate";
  /** Plan confidence from the premotor (0–1). */
  planConfidence?: number;
}

// ─── Classification ────────────────────────────────────────────

/**
 * Classify a gate rejection into a failure category.
 *
 * Heuristic priority (checked in order):
 * 1. approach-bottleneck — SoL gap, oscillation on 2+ receptors, or conviction reshape
 * 2. integration — high-severity tensions + rejection drivers from both sides, or collapse
 * 3. specification-gap — significant improvement potential + decent plan confidence
 * 4. local-logic — default (few rejection drivers, no tensions/oscillations)
 */
export function classifyFailure(input: FailureClassifierInput): FailureClassification {
  const signals: string[] = [];

  // Extract objecting sense IDs from rejection drivers
  const objectingSenseIds = deduplicateSenseIds(input.rejectionDrivers);

  // ── 1. Approach bottleneck ───────────────────────────────────
  const bottleneck = checkApproachBottleneck(input, signals);
  if (bottleneck) {
    return {
      category: "approach-bottleneck",
      confidence: bottleneck.confidence,
      objectingSenseIds,
      signals,
      rationale: bottleneck.rationale,
    };
  }

  // ── 2. Integration failure ───────────────────────────────────
  const integration = checkIntegrationFailure(input, signals);
  if (integration) {
    return {
      category: "integration",
      confidence: integration.confidence,
      objectingSenseIds,
      signals,
      rationale: integration.rationale,
    };
  }

  // ── 3. Specification gap ─────────────────────────────────────
  const specGap = checkSpecificationGap(input, signals);
  if (specGap) {
    return {
      category: "specification-gap",
      confidence: specGap.confidence,
      objectingSenseIds,
      signals,
      rationale: specGap.rationale,
    };
  }

  // ── 4. Local logic (default) ─────────────────────────────────
  signals.push(`${objectingSenseIds.length} objecting sense(s), no structural issues detected`);
  return {
    category: "local-logic",
    confidence: 0.7,
    objectingSenseIds,
    signals,
    rationale: `Few rejection drivers (${objectingSenseIds.length} sense(s)), no tensions or oscillations — targeted fix likely sufficient.`,
  };
}

// ─── Heuristic checks ──────────────────────────────────────────

function checkApproachBottleneck(
  input: FailureClassifierInput,
  signals: string[],
): { confidence: number; rationale: string } | null {
  let score = 0;
  const reasons: string[] = [];

  // SoL composite gap > 0.5
  if (input.speedOfLight?.compositeGap != null && input.speedOfLight.compositeGap > 0.5) {
    score += 0.4;
    const gap = input.speedOfLight.compositeGap.toFixed(2);
    signals.push(`SoL composite gap = ${gap} (> 0.5 threshold)`);
    reasons.push(`speed-of-light gap is ${gap}`);
  }

  // Approach-specific bottleneck flag from cerebellum
  if (input.speedOfLight?.approachSpecific?.approachIsBottleneck) {
    score += 0.3;
    signals.push("Cerebellum flagged approach as bottleneck");
    reasons.push("approach class consistently underperforms overall ceiling");
  }

  // Oscillation on 2+ receptors — the system is going in circles
  if (input.oscillations.length >= 2) {
    score += 0.3;
    signals.push(`${input.oscillations.length} oscillating receptors`);
    reasons.push(`${input.oscillations.length} receptors oscillating`);
  }

  // Conviction verdict was "reshape" — PFC already thinks the approach is wrong
  if (input.convictionVerdict === "reshape") {
    score += 0.3;
    signals.push("Conviction verdict = reshape");
    reasons.push("PFC conviction loop called for reshape");
  }

  if (score >= 0.4) {
    return {
      confidence: Math.min(1, score),
      rationale: `Approach bottleneck: ${reasons.join("; ")}.`,
    };
  }
  return null;
}

function checkIntegrationFailure(
  input: FailureClassifierInput,
  signals: string[],
): { confidence: number; rationale: string } | null {
  // Check for collapse (capitulation = failed integration)
  if (input.collapseSignal?.collapsed) {
    const collapsedCount = input.collapseSignal.details.filter((d) => d.collapsed).length;
    signals.push(`${collapsedCount} collapsed tension(s) detected`);
    return {
      confidence: 0.8,
      rationale: `Integration failure: ${collapsedCount} tension(s) collapsed (capitulation, not synthesis).`,
    };
  }

  // High-severity tensions + rejection drivers from both sides of a tension
  const highSeverityTensions = input.tensions.filter((t) => t.severity === "high");
  if (highSeverityTensions.length > 0) {
    const objectingIds = new Set(deduplicateSenseIds(input.rejectionDrivers));
    const tensionWithBothSidesObjecting = highSeverityTensions.some((t) => {
      // A tension involves two senses — check if rejection drivers come from both sides
      return objectingIds.has(t.senseA.id) && objectingIds.has(t.senseB.id);
    });

    if (tensionWithBothSidesObjecting) {
      signals.push(`High-severity tension with both sides objecting`);
      return {
        confidence: 0.7,
        rationale: `Integration failure: high-severity tensions present with rejection drivers from both sides.`,
      };
    }
  }

  return null;
}

function checkSpecificationGap(
  input: FailureClassifierInput,
  signals: string[],
): { confidence: number; rationale: string } | null {
  // Multiple evaluations with significant improvement potential
  const significantPotential = input.rejectionDrivers.filter(
    (d) => d.improvementPotential.level === "significant",
  );

  if (significantPotential.length < 2) return null;

  // Plan confidence was decent (> 0.6) — motor thought it did fine
  const planConfidence = input.planConfidence ?? 0;
  if (planConfidence <= 0.6) return null;

  signals.push(
    `${significantPotential.length} evaluations with significant improvement potential`,
    `Plan confidence = ${planConfidence.toFixed(2)} (> 0.6)`,
  );

  return {
    confidence: 0.65,
    rationale: `Specification gap: ${significantPotential.length} senses see significant improvement potential but plan confidence was ${planConfidence.toFixed(2)} — needs reconsultation, not rebuilding.`,
  };
}

// ─── Helpers ───────────────────────────────────────────────────

/** Extract unique root sense IDs from rejection drivers. */
function deduplicateSenseIds(drivers: WeightedEvaluation[]): string[] {
  const seen = new Set<string>();
  for (const d of drivers) {
    // Use activationPath[0] (root sense name) for deduplication
    const rootSense = d.activationPath[0] ?? d.senseId;
    seen.add(rootSense);
  }
  return [...seen];
}
