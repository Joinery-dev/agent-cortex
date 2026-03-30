/**
 * Worldview Generator — pipeline orchestrator.
 *
 * Discovery → Seed Synthesis → Gate 1 → Frame Generation → Gate 2
 *   → Persist → Roundtrip Verification → Worldview
 *
 * Each gate allows the Parsifal to approve or redirect (max 3 attempts).
 * After 3 rejections, offers: start over / continue with current / skip to default.
 */

import type { Worldview } from "../types/worldview.js";
import type { AskUserFn } from "./discovery.js";
import type { WorldviewSeed, FrameGenerationResult } from "./types.js";
import { runDiscovery } from "./discovery.js";
import { synthesizeSeed, generateFrames } from "./synthesis.js";
import { persistAndVerify } from "./store.js";
import { isApproval } from "../util/approval.js";
import { createLogger } from "../util/logger.js";
import { DEFAULT_WORLDVIEW } from "../types/worldview.js";

const log = createLogger("worldview-generator");

export interface GenerateWorldviewOptions {
  /** LLM model for synthesis calls. Default: "opus". */
  model?: string;
  /** Name for the generated worldview file. Default: "parsifal". */
  name?: string;
}

const MAX_GATE_ATTEMPTS = 3;

// ─── Gate helpers ───────────────────────────────────────────────

type GateOutcome =
  | { action: "approved" }
  | { action: "revised"; feedback: string }
  | { action: "exhausted"; choice: "start-over" | "continue" | "default" };

async function runGate(
  askUser: AskUserFn,
  presentation: string,
  attempt: number,
): Promise<GateOutcome> {
  const response = await askUser(presentation);

  if (isApproval(response)) {
    return { action: "approved" };
  }

  if (attempt >= MAX_GATE_ATTEMPTS) {
    const exhaustedResponse = await askUser(
      `We've gone through ${MAX_GATE_ATTEMPTS} rounds. Would you like to:\n\n` +
      `  1. Start over from the beginning\n` +
      `  2. Continue with the current version\n` +
      `  3. Skip worldview generation and use the default\n\n` +
      `(Choose 1, 2, or 3)`
    );
    const choice = exhaustedResponse.trim();
    if (choice === "1" || choice.toLowerCase().includes("start over")) {
      return { action: "exhausted", choice: "start-over" };
    }
    if (choice === "3" || choice.toLowerCase().includes("skip") || choice.toLowerCase().includes("default")) {
      return { action: "exhausted", choice: "default" };
    }
    return { action: "exhausted", choice: "continue" };
  }

  return { action: "revised", feedback: response };
}

// ─── Seed presentation ──────────────────────────────────────────

function formatSeedForReview(seed: WorldviewSeed): string {
  const parts = [
    `Here's what I understand about how you see the work:\n`,
    `**How you see work (ontology):**\n${seed.ontology}\n`,
    `**What counts as understanding (epistemology):**\n${seed.epistemology}\n`,
    `**What you value (axiology):**\n${seed.axiology}\n`,
    `**How you handle tension:**\n${seed.tensionPhilosophy}\n`,
    `**How experience changes you:**\n${seed.learningOrientation}\n`,
    `**How we should work together:**\n${seed.collaborationModel}\n`,
  ];

  if (seed.vocabulary) {
    const v = seed.vocabulary;
    parts.push(
      `**Vocabulary I'd use:**\n` +
      `  High-level units: ${v.topUnit.singular} / ${v.topUnit.plural}\n` +
      `  Leaf units: ${v.leafUnit.singular} / ${v.leafUnit.plural}\n` +
      `  Completed artifacts: ${v.artifact.singular} / ${v.artifact.plural}\n` +
      `  Decomposition: "${v.decomposeVerb}"\n` +
      `  Completion: "${v.completeVerb}"\n` +
      `  Each node is: ${v.nodeNature}\n`
    );
  }

  parts.push(`\nIs this you? If something feels off, tell me what — I'll revise.`);
  return parts.join("\n");
}

// ─── Frame presentation ─────────────────────────────────────────

function formatFramesForReview(generated: FrameGenerationResult): string {
  // Show the highest-leverage frames: preamble + consultation + building + evaluation + resolution
  const parts = [
    `Here's how this worldview shapes my thinking. I'm showing the key cognitive frames — the rest follow the same philosophy.\n`,
    `**Preamble** (injected into every cognitive act):\n${generated.preamble}\n`,
    `**Consultation** (how I approach a new task):\n${generated.frames.consultation.slice(0, 300)}${generated.frames.consultation.length > 300 ? "..." : ""}\n`,
    `**Building** (who I am when I build):\n${generated.frames.building.slice(0, 300)}${generated.frames.building.length > 300 ? "..." : ""}\n`,
    `**Evaluation** (what "good" means):\n${generated.frames.evaluation.slice(0, 300)}${generated.frames.evaluation.length > 300 ? "..." : ""}\n`,
    `**Resolution** (how I handle tension):\n${generated.frames.resolution.slice(0, 300)}${generated.frames.resolution.length > 300 ? "..." : ""}\n`,
    `Does this feel right? If something is off, tell me what — I'll regenerate.`,
  ];
  return parts.join("\n");
}

// ─── Main pipeline ──────────────────────────────────────────────

/**
 * Run the full worldview generation pipeline.
 *
 * @param askUser — callback for interactive questions and approval gates
 * @param options — model and name configuration
 * @returns A fully loaded Worldview ready for Cortex
 */
export async function generateWorldview(
  askUser: AskUserFn,
  options?: GenerateWorldviewOptions,
): Promise<Worldview> {
  const model = options?.model ?? "opus";
  const name = options?.name ?? "parsifal";

  log.info("Starting worldview generation pipeline");

  // ── Phase 1: Discovery ──────────────────────────────────────
  const answers = await runDiscovery(askUser);
  log.info("Discovery complete", { answersCount: answers.length });

  // ── Phase 2: Seed Synthesis + Gate 1 ────────────────────────
  let seed: WorldviewSeed;
  let seedAttempt = 0;

  seed = await synthesizeSeed(answers, model);
  seedAttempt++;

  while (true) {
    const presentation = formatSeedForReview(seed);
    const outcome = await runGate(askUser, presentation, seedAttempt);

    if (outcome.action === "approved") {
      log.info("Seed approved", { attempt: seedAttempt });
      break;
    }

    if (outcome.action === "exhausted") {
      if (outcome.choice === "start-over") {
        log.info("Parsifal chose to start over");
        return generateWorldview(askUser, options);
      }
      if (outcome.choice === "default") {
        log.info("Parsifal chose default worldview");
        return DEFAULT_WORLDVIEW;
      }
      // "continue" — proceed with current seed
      log.info("Parsifal chose to continue with current seed");
      break;
    }

    // Revised — re-synthesize with feedback incorporated
    log.info("Seed revision requested", { attempt: seedAttempt, feedback: outcome.feedback.slice(0, 100) });
    // Re-run synthesis with the original answers — the LLM gets the feedback context
    const feedbackMessage = `The Parsifal reviewed the seed and gave this feedback: "${outcome.feedback}". Re-synthesize incorporating this feedback.`;
    // We append feedback to the answers context by re-running synthesis
    // with augmented answers
    const augmentedAnswers = [
      ...answers,
      {
        number: 8,
        dimension: "identity" as const,
        response: `[Revision feedback]: ${outcome.feedback}`,
      },
    ];
    seed = await synthesizeSeed(augmentedAnswers, model);
    seedAttempt++;
  }

  // ── Phase 3: Frame Generation + Gate 2 ──────────────────────
  let generated: FrameGenerationResult;
  let frameAttempt = 0;

  generated = await generateFrames(seed, model);
  frameAttempt++;

  while (true) {
    const presentation = formatFramesForReview(generated);
    const outcome = await runGate(askUser, presentation, frameAttempt);

    if (outcome.action === "approved") {
      log.info("Frames approved", { attempt: frameAttempt });
      break;
    }

    if (outcome.action === "exhausted") {
      if (outcome.choice === "start-over") {
        log.info("Parsifal chose to start over");
        return generateWorldview(askUser, options);
      }
      if (outcome.choice === "default") {
        log.info("Parsifal chose default worldview");
        return DEFAULT_WORLDVIEW;
      }
      // "continue"
      log.info("Parsifal chose to continue with current frames");
      break;
    }

    // Revised — re-generate frames with feedback
    log.info("Frame revision requested", { attempt: frameAttempt, feedback: outcome.feedback.slice(0, 100) });
    generated = await generateFrames(seed, model, outcome.feedback);
    frameAttempt++;
  }

  // ── Phase 4: Persist + Verify ───────────────────────────────
  log.info("Persisting worldview", { name });
  const worldview = persistAndVerify(name, seed, generated);
  log.info("Worldview generation complete", {
    name: worldview.name,
    frameCount: Object.keys(worldview.frames).length,
  });

  return worldview;
}
