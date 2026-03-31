/**
 * Problem Model — accumulated structural understanding from build cycle failures.
 *
 * Each failed build cycle reveals constraints about what the solution must
 * satisfy. The accumulated set of constraints IS the problem model — a
 * growing map of the solution space refined through failures.
 *
 * Inspired by Aletheia (arXiv:2602.10177): each failed proof attempt reveals
 * constraints that no single successful attempt could have surfaced.
 *
 * Pure functions, no LLM calls. Follows the evaluation-weighter.ts pattern.
 */

import type { ProblemConstraint } from "../types/motor-cortex.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { WeightedEvaluation } from "./evaluation-weighter.js";
import type { FailureClassification } from "../types/motor-cortex.js";
import type { TensionResolution } from "../types/tension.js";
import type { Tension } from "../types/tension.js";

// ─── Extraction ────────────────────────────────────────────────

let constraintCounter = 0;
function nextId(): string {
  return `pc-${++constraintCounter}`;
}

/** Observation kinds that count as formal verification. */
const FORMAL_OBSERVATION_KINDS = new Set([
  "test-output",
  "lint-output",
  "web-vitals",
  "runtime-check",
]);

/**
 * Extract problem constraints from a failed build cycle.
 *
 * No LLM calls — structured extraction from evaluation data that already
 * exists. The structural insight is already in the evaluation text; this
 * function reframes it as accumulated constraints.
 */
export function extractConstraints(
  cycle: number,
  evaluations: SenseEvaluation[],
  rejectionDrivers: WeightedEvaluation[],
  failureClassification: FailureClassification | null,
  tensions: Tension[],
  resolutions: TensionResolution[],
  previousConstraints: ProblemConstraint[],
): ProblemConstraint[] {
  const newConstraints: ProblemConstraint[] = [];

  // 1. From rejection drivers — each objecting sense's assessment is a structural insight
  for (const driver of rejectionDrivers) {
    if (!driver.acceptable && driver.assessment) {
      const senseName = driver.activationPath[0] ?? driver.senseId;

      // Check if this supersedes an existing constraint from the same sense
      const existing = previousConstraints.find(
        (c) => c.source === senseName && (c.category === "structural" || c.category === "boundary"),
      );

      newConstraints.push({
        id: nextId(),
        cycle,
        category: "structural",
        constraint: driver.assessment.slice(0, 300),
        source: senseName,
        verification: "subjective",
        supersedes: existing?.id,
      });
    }
  }

  // 2. From agentic evaluation observations — formal checks become hard constraints
  for (const evaluation of evaluations) {
    if (!evaluation.observations) continue;
    for (const obs of evaluation.observations) {
      if (FORMAL_OBSERVATION_KINDS.has(obs.kind)) {
        const senseName = evaluation.activationPath[0] ?? evaluation.senseId;
        newConstraints.push({
          id: nextId(),
          cycle,
          category: "hard",
          constraint: `[${obs.kind}] ${obs.target}: ${obs.finding.slice(0, 200)}`,
          source: senseName,
          verification: "formal",
        });
      }
    }
  }

  // 3. From tension resolutions — synthesized tensions become tradeoff constraints.
  // ONLY from prior cycles' resolutions carried forward on the accumulator.
  // The current cycle's resolutions are already in revision.resolutions ("REQUIRED CHANGES")
  // — extracting them here would duplicate information in the revision prompt.
  // Prior-cycle tradeoff constraints are already in previousConstraints from when
  // they were extracted in their own cycle. So we skip tradeoff extraction entirely
  // for the current cycle and let the accumulator carry forward prior ones.
  //
  // If we later need tradeoff constraints from the current cycle (e.g., for
  // crystallization), extract them at a different call site.

  // 4. From failure classification — meta-constraints about the problem structure
  if (failureClassification) {
    switch (failureClassification.category) {
      case "integration": {
        const senses = failureClassification.objectingSenseIds.join(" × ");
        newConstraints.push({
          id: nextId(),
          cycle,
          category: "structural",
          constraint: `Tension between ${senses} must be genuinely synthesized — prior attempt collapsed into capitulation.`,
          source: senses,
          verification: "subjective",
        });
        break;
      }
      case "approach-bottleneck":
        newConstraints.push({
          id: nextId(),
          cycle,
          category: "boundary",
          constraint: "Current approach class cannot reach the performance ceiling — a fundamentally different strategy is required.",
          source: "cerebellum",
          verification: "subjective",
        });
        break;
      // local-logic: specific assessment is sufficient, no meta-constraint needed
      // specification-gap: exits early to reconsultation, shouldn't reach here
    }
  }

  return newConstraints;
}

// ─── Deduplication ─────────────────────────────────────────────

/**
 * Merge new constraints into the existing set, handling supersession.
 * When a new constraint supersedes an old one, the old one is removed.
 */
export function mergeConstraints(
  existing: ProblemConstraint[],
  incoming: ProblemConstraint[],
): ProblemConstraint[] {
  const supersededIds = new Set(
    incoming.filter((c) => c.supersedes).map((c) => c.supersedes!),
  );

  // Keep existing constraints that aren't superseded
  const kept = existing.filter((c) => !supersededIds.has(c.id));

  return [...kept, ...incoming];
}
