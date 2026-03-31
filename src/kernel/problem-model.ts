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

// ─── Evaluator Model Synthesis (Dialectic Convergence) ─────────

import { z } from "zod";
import { callStructured } from "../llm/structured.js";
import type { SpeedOfLight } from "../types/cerebellum.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("problem-model");

const EvaluatorSynthesisSchema = z.object({
  model: z.string(),
  convergence: z.number().min(0).max(1),
  divergenceNote: z.string(),
});

export interface EvaluatorSynthesisInput {
  evaluations: import("../types/sense.js").SenseEvaluation[];
  rejectionDrivers: WeightedEvaluation[];
  failureClassification: FailureClassification | null;
  speedOfLight: SpeedOfLight | null;
  previousEvaluatorModel: string | null;
  builderModel: string | null;
  constraints: ProblemConstraint[];
}

export interface EvaluatorSynthesisResult {
  model: string;
  convergence: number;
  divergenceNote: string;
}

const EVALUATOR_SYNTHESIS_SYSTEM = `You maintain the evaluators' model of what a task's solution must satisfy.

You synthesize evaluation feedback, formal measurements, and failure analysis into a concise problem model — what the solution MUST do to be accepted.

You also assess convergence with the builder's model: how aligned are the builder's understanding and the evaluators' understanding? Score 0-1 (0 = completely different, 1 = saying the same thing).

The speed-of-light ceiling is the anchor: your model should describe what's needed to REACH the ceiling, not just what's needed to be acceptable. Push toward what's achievable, not what's comfortable.

Return JSON:
{
  "model": "2-3 sentences synthesizing what the evaluators have established the solution must satisfy",
  "convergence": 0.0-1.0,
  "divergenceNote": "what specifically differs between builder and evaluator understanding (empty string if convergence >= 0.8)"
}`;

/**
 * Synthesize the evaluators' problem model from evaluation feedback.
 *
 * One cheap LLM call per gate evaluation. Reads evaluations + SoL ceiling +
 * builder's model → produces a synthesized evaluator model + convergence score.
 *
 * This is the verification side of the dialectic. The evaluator model is
 * authored by the senses (via this synthesis), not by the builder.
 */
export async function synthesizeEvaluatorModel(
  input: EvaluatorSynthesisInput,
  model: string,
): Promise<EvaluatorSynthesisResult> {
  // Assemble the user prompt from available data
  const parts: string[] = [];

  if (input.previousEvaluatorModel) {
    parts.push(`PREVIOUS EVALUATOR MODEL:\n${input.previousEvaluatorModel}`);
  }

  if (input.builderModel) {
    parts.push(`BUILDER'S CURRENT MODEL:\n${input.builderModel}`);
  } else {
    parts.push("BUILDER'S CURRENT MODEL: (no model yet — first cycle)");
  }

  // Evaluation assessments
  const evalSummary = input.rejectionDrivers
    .map((d) => `- ${d.activationPath.join(" > ")} (${d.score}/10, stake ${d.adjustedStake.toFixed(2)}): ${d.assessment}`)
    .join("\n");
  if (evalSummary) {
    parts.push(`EVALUATION RESULTS (sorted by impact):\n${evalSummary}`);
  }

  // Formal observations
  const formal = input.evaluations
    .flatMap((e) => (e.observations ?? [])
      .filter((o) => FORMAL_OBSERVATION_KINDS.has(o.kind))
      .map((o) => `- [${o.kind}] ${o.target}: ${o.finding.slice(0, 150)}`))
    .join("\n");
  if (formal) {
    parts.push(`FORMAL MEASUREMENTS:\n${formal}`);
  }

  // Speed of light
  if (input.speedOfLight) {
    const sol = input.speedOfLight;
    const ceilings = sol.perSense
      .map((s) => `${s.senseName}: ceiling ${s.ceiling}/10${s.bestAchieved != null ? `, best achieved ${s.bestAchieved.toFixed(1)}` : ""}`)
      .join(", ");
    parts.push(`SPEED OF LIGHT (what's achievable): composite ceiling ${sol.compositeCeiling.toFixed(1)}/10. Per-sense: ${ceilings}`);
  }

  // Failure classification
  if (input.failureClassification) {
    parts.push(`FAILURE TYPE: ${input.failureClassification.category} — ${input.failureClassification.rationale}`);
  }

  // Structured constraints (as supplementary input)
  if (input.constraints.length > 0) {
    const constraintSummary = input.constraints
      .slice(-5) // most recent 5
      .map((c) => `- [cycle ${c.cycle}, ${c.category}] ${c.constraint.slice(0, 150)}`)
      .join("\n");
    parts.push(`ESTABLISHED CONSTRAINTS:\n${constraintSummary}`);
  }

  parts.push("Synthesize the evaluators' model. Assess convergence with the builder's model.");

  const userMessage = parts.join("\n\n");

  try {
    const result = await callStructured<EvaluatorSynthesisResult>(
      "evaluator-synthesis",
      model,
      EVALUATOR_SYNTHESIS_SYSTEM,
      userMessage,
      EvaluatorSynthesisSchema,
      1024,
    );

    log.info("Evaluator model synthesized", {
      convergence: result.convergence.toFixed(2),
      modelLength: result.model.length,
      hasDivergence: result.divergenceNote.length > 0,
    });

    emit("dialectic:synthesis", {
      convergence: result.convergence,
      modelLength: result.model.length,
      divergenceNote: result.divergenceNote || undefined,
    });

    return result;
  } catch (err) {
    log.warn("Evaluator model synthesis failed — returning neutral", { error: String(err) });
    return {
      model: input.previousEvaluatorModel ?? "(synthesis failed)",
      convergence: 0.5,
      divergenceNote: "Synthesis call failed — using previous model.",
    };
  }
}
