/**
 * Guidance Evolver — reflective mutation of failure preemption guidance.
 *
 * Inspired by GEPA (arXiv:2507.19457): an LLM reads execution traces +
 * evaluator feedback and proposes targeted revisions to text artifacts.
 * Natural language traces are "the text-optimization analogue of a gradient."
 *
 * Runs during rest cycles when preemption guidance underperforms.
 * For each underperforming variant:
 *   1. Collect failure + success traces from the content store
 *   2. Assemble a reflection prompt with the current guidance + traces
 *   3. One LLM call proposes a revised version
 *   4. Propose as a challenger in an A/B test via the guidance store
 *
 * Constraints: max 3 mutations per rest cycle, 500 char limit on guidance,
 * minimum 5 uses before evolving, one LLM call per mutation.
 */

import type { GuidanceStore, GuidanceVariant } from "./guidance-store.js";
import { getContentStore } from "../trace/content-store.js";
// ContentEntry is not exported — we use getContentStore().getAll() which returns the entries
import { call } from "../llm/client.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("guidance-evolver");

const MAX_MUTATIONS_PER_REST = 3;
const MAX_GUIDANCE_LENGTH = 500;

// ─── Trace collection ──────────────────────────────────────────

interface EvolutionTrace {
  taskId: string;
  /** What the briefing said (the guidance as injected). */
  briefingExcerpt: string;
  /** What the evaluators said (assessment text). */
  evaluationFeedback: string[];
  /** Whether preemption succeeded (failure predicted but didn't occur). */
  preempted: boolean;
}

/**
 * Collect traces for tasks where a specific failure category was predicted.
 * Pulls from the content store: briefings (what was injected) and
 * evaluations (what the senses said about the outcome).
 *
 * Returns up to maxFailures failure traces + maxSuccesses success traces.
 */
function collectTraces(
  category: string,
  maxFailures = 3,
  maxSuccesses = 2,
): { failures: EvolutionTrace[]; successes: EvolutionTrace[] } {
  const store = getContentStore();
  const all = store.getAll();

  // Find tasks that had failure preemption briefings for this category
  const briefingsByTask = new Map<string, ReturnType<typeof store.getAll>[number]>();
  for (const entry of all) {
    if (entry.kind === "briefing" && entry.taskId) {
      // Check if the briefing output mentions the failure category
      const hasPreemption = entry.outputs.some(
        (o) => o.text.includes("FAILURE PREVENTION") && o.text.includes(category),
      );
      if (hasPreemption) {
        briefingsByTask.set(entry.taskId, entry);
      }
    }
  }

  // For each task with preemption, find the evaluation traces
  const failures: EvolutionTrace[] = [];
  const successes: EvolutionTrace[] = [];

  for (const [taskId, briefing] of briefingsByTask) {
    const evals = store.getForTask(taskId).filter((e) => e.kind === "evaluation");
    const gateDecisions = store.getForTask(taskId).filter((e) => e.kind === "gate-decision");

    // Determine if the predicted failure actually occurred
    const failureOccurred = gateDecisions.some((g) =>
      g.outputs.some((o: { text: string }) => o.text.includes(category)),
    );

    const trace: EvolutionTrace = {
      taskId,
      briefingExcerpt: briefing.outputs.map((o) => o.text).join("\n").slice(0, 1000),
      evaluationFeedback: evals
        .flatMap((e) => e.outputs.map((o) => o.text))
        .slice(0, 5),
      preempted: !failureOccurred,
    };

    if (failureOccurred && failures.length < maxFailures) {
      failures.push(trace);
    } else if (!failureOccurred && successes.length < maxSuccesses) {
      successes.push(trace);
    }

    if (failures.length >= maxFailures && successes.length >= maxSuccesses) break;
  }

  return { failures, successes };
}

// ─── Reflection prompt ─────────────────────────────────────────

function assembleReflectionPrompt(
  variant: GuidanceVariant,
  failures: EvolutionTrace[],
  successes: EvolutionTrace[],
): { system: string; user: string } {
  const categoryDescriptions: Record<string, string> = {
    "specification-gap": "Builder and senses disagree on what 'done' means — the builder thinks it succeeded but evaluators reject for unclear acceptance criteria.",
    "integration": "Two or more senses conflict and the resolution collapses into capitulation instead of genuine synthesis.",
    "approach-bottleneck": "The chosen approach hits a performance ceiling — the strategy itself is the constraint, not the execution quality.",
    "local-logic": "Specific logic errors in a small number of senses — targeted issues, not structural problems.",
  };

  const system = `You are improving an instruction that an AI system (Cortex) gives to its components to prevent a specific type of failure before it happens.

The instruction is injected into a ${variant.consumer === "consultation" ? "consultation briefing (what senses receive before deliberating)" : "motor briefing (what the builder receives before building)"}.

Your task: analyze why the current instruction failed in some cases, and write a better version that addresses the specific failure patterns.

Constraints:
- The revised instruction must be under ${MAX_GUIDANCE_LENGTH} characters
- It must address the same failure category (${variant.category})
- It must be concise and actionable — no preamble, no meta-commentary
- Return ONLY the revised instruction text, nothing else`;

  let user = `FAILURE CATEGORY: ${variant.category}
${categoryDescriptions[variant.category] ?? ""}

CURRENT INSTRUCTION (version ${variant.version}):
${variant.text}

PREEMPTION RATE: ${variant.stats.timesPreempted}/${variant.stats.timesUsed} (${(variant.stats.preemptionRate * 100).toFixed(0)}%)`;

  if (successes.length > 0) {
    user += "\n\nCASES WHERE THE INSTRUCTION PREVENTED THE FAILURE:";
    for (const s of successes) {
      user += `\n\n--- Task ${s.taskId} (SUCCESS) ---`;
      user += `\nEvaluation feedback:\n${s.evaluationFeedback.map((f) => f.slice(0, 300)).join("\n")}`;
    }
  }

  if (failures.length > 0) {
    user += "\n\nCASES WHERE THE FAILURE STILL OCCURRED DESPITE THE INSTRUCTION:";
    for (const f of failures) {
      user += `\n\n--- Task ${f.taskId} (FAILURE) ---`;
      user += `\nEvaluation feedback:\n${f.evaluationFeedback.map((fb) => fb.slice(0, 300)).join("\n")}`;
    }
  }

  user += "\n\nAnalyze WHY the instruction failed in the failure cases. What distinguishes success from failure? Write a revised instruction that addresses the specific failure patterns.";

  return { system, user };
}

// ─── Evolution pipeline ────────────────────────────────────────

export interface EvolutionResult {
  variantsProposed: number;
  categories: string[];
}

/**
 * Run reflective evolution on underperforming guidance variants.
 *
 * Called during rest cycles via SubcorticalHooks.evolvePreemptionGuidance().
 * One LLM call per underperforming variant, capped at MAX_MUTATIONS_PER_REST.
 */
export async function evolvePreemptionGuidance(
  guidanceStore: GuidanceStore,
  model: string,
): Promise<EvolutionResult> {
  const underperformers = guidanceStore.getUnderperformers(0.5, 5);

  if (underperformers.length === 0) {
    log.debug("No underperforming guidance variants — skipping evolution");
    return { variantsProposed: 0, categories: [] };
  }

  const toEvolve = underperformers.slice(0, MAX_MUTATIONS_PER_REST);
  let variantsProposed = 0;
  const categories: string[] = [];

  for (const variant of toEvolve) {
    try {
      const { failures, successes } = collectTraces(variant.category);

      // Need at least 1 failure trace to learn from
      if (failures.length === 0) {
        log.debug("No failure traces available for evolution", {
          category: variant.category,
          consumer: variant.consumer,
        });
        continue;
      }

      const { system, user } = assembleReflectionPrompt(variant, failures, successes);

      const result = await call("guidance-evolution", model, system, user);
      let revisedText = result.text.trim();

      // Strip markdown code fences if the LLM wrapped it
      if (revisedText.startsWith("```")) {
        revisedText = revisedText.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      }

      // Enforce size limit
      if (revisedText.length > MAX_GUIDANCE_LENGTH) {
        revisedText = revisedText.slice(0, MAX_GUIDANCE_LENGTH);
        log.debug("Truncated evolved guidance to max length", {
          category: variant.category,
          originalLength: result.text.trim().length,
        });
      }

      // Reject empty or trivially similar mutations
      if (revisedText.length < 20) {
        log.debug("Evolved guidance too short — skipping", { category: variant.category });
        continue;
      }
      if (revisedText === variant.text) {
        log.debug("Evolved guidance identical to current — skipping", { category: variant.category });
        continue;
      }

      // Propose as A/B challenger
      const challenger = guidanceStore.propose(variant.category, variant.consumer, revisedText);
      if (challenger) {
        variantsProposed++;
        categories.push(variant.category);

        emit("guidance:evolved", {
          category: variant.category,
          consumer: variant.consumer,
          controlId: variant.id,
          challengerId: challenger.id,
          controlRate: variant.stats.preemptionRate,
          failureTraces: failures.length,
          successTraces: successes.length,
        });

        log.info("Guidance mutation proposed", {
          category: variant.category,
          consumer: variant.consumer,
          version: challenger.version,
          preemptionRate: variant.stats.preemptionRate.toFixed(2),
          failureTraces: failures.length,
          successTraces: successes.length,
        });
      }
    } catch (err) {
      log.warn("Guidance evolution failed for variant", {
        category: variant.category,
        consumer: variant.consumer,
        error: String(err),
      });
    }
  }

  return { variantsProposed, categories };
}
