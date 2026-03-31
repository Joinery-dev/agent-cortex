/**
 * Worldview Generator — pipeline orchestrator.
 *
 * Three entry paths:
 *   1. Select a preset worldview (shaela, project, hybrid)
 *   2. Upload a worldview from a file path
 *   3. Create a new worldview through conversation
 *
 * Creation pipeline:
 *   Conversation (until Parsifal approves seed) → Frame Generation
 *     → Frame Review → Persist → Roundtrip Verification → Worldview
 */

import { existsSync } from "node:fs";
import type { Worldview } from "../types/worldview.js";
import type { AskUserFn } from "./discovery.js";
import type { FrameGenerationResult } from "./types.js";
import { buildWorldviewConversation } from "./conversation.js";
import { generateFrames } from "./synthesis.js";
import { persistAndVerify, persistSelection, loadExistingWorldview } from "./store.js";
import { loadWorldview } from "../util/worldview-loader.js";  // used by uploadWorldview
import { isApproval } from "../util/approval.js";
import { createLogger } from "../util/logger.js";
import {
  DEFAULT_WORLDVIEW,
  SHAELA_WORLDVIEW,
  PROJECT_WORLDVIEW,
  HYBRID_WORLDVIEW,
  COVENANT_WORLDVIEW,
  GROOVE_WORLDVIEW,
  ECOSYSTEM_WORLDVIEW,
  DIALECTIC_WORLDVIEW,
  CARTOGRAPH_WORLDVIEW,
  SCULPTOR_WORLDVIEW,
  NARRATIVE_WORLDVIEW,
} from "../types/worldview.js";

const log = createLogger("worldview-generator");

export type { AskUserFn } from "./discovery.js";

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

// ─── Frame presentation ─────────────────────────────────────────

function formatFramesForReview(generated: FrameGenerationResult): string {
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

// ─── Preset selection ───────────────────────────────────────────

const PRESETS: Record<string, Worldview> = {
  shaela: SHAELA_WORLDVIEW,
  project: PROJECT_WORLDVIEW,
  hybrid: HYBRID_WORLDVIEW,
  covenant: COVENANT_WORLDVIEW,
  groove: GROOVE_WORLDVIEW,
  ecosystem: ECOSYSTEM_WORLDVIEW,
  dialectic: DIALECTIC_WORLDVIEW,
  cartograph: CARTOGRAPH_WORLDVIEW,
  sculptor: SCULPTOR_WORLDVIEW,
  narrative: NARRATIVE_WORLDVIEW,
};

async function selectPreset(askUser: AskUserFn): Promise<Worldview> {
  const response = await askUser(
    `Which worldview would you like to use?\n\n` +
    `  1. **shaela** — Questions to be lived. Understanding emerges from genuine engagement.\n` +
    `  2. **project** — Forces to be resolved. The tightest structure that produces the full outcome.\n` +
    `  3. **hybrid** — Shaela framing, project execution. Engineering questions whose answers are load-bearing.\n` +
    `  4. **covenant** — Commitments honored. Every artifact is a contract. Trust through verification.\n` +
    `  5. **groove** — Play seriously. Improvisation within structure; craft and intent indistinguishable.\n` +
    `  6. **ecosystem** — Cultivate living systems. Health is the capacity to absorb problems, not their absence.\n` +
    `  7. **dialectic** — Contradiction drives progress. Every artifact contains the seed of its own evolution.\n` +
    `  8. **cartograph** — Map unknown territory. Explore honestly, chart accurately, navigate by truth.\n` +
    `  9. **sculptor** — Remove what doesn't belong. The artifact exists inside the constraints; reveal it.\n` +
    `  10. **narrative** — Tell the story. Every artifact has characters, an arc, tension, and resolution.\n\n` +
    `(Choose 1-10, or type a name)`
  );

  const normalized = response.trim().toLowerCase();

  const NUMBER_TO_NAME: Record<string, string> = {
    "1": "shaela", "2": "project", "3": "hybrid", "4": "covenant",
    "5": "groove", "6": "ecosystem", "7": "dialectic", "8": "cartograph",
    "9": "sculptor", "10": "narrative",
  };

  const name = NUMBER_TO_NAME[normalized] ?? (PRESETS[normalized] ? normalized : "shaela");
  persistSelection(name);
  return PRESETS[name];
}

// ─── File upload ────────────────────────────────────────────────

async function uploadWorldview(askUser: AskUserFn): Promise<Worldview> {
  const response = await askUser(
    `Enter the path to your worldview .md file:\n\n` +
    `(The file should follow the worldview format — see worldviews/shaela.md for an example)`
  );

  const filePath = response.trim();
  if (!existsSync(filePath)) {
    await askUser(`File not found: ${filePath}\n\nFalling back to default worldview.`);
    return DEFAULT_WORLDVIEW;
  }

  try {
    const wv = loadWorldview(filePath);
    persistSelection(wv.name, filePath);
    return wv;
  } catch (err) {
    await askUser(`Failed to parse worldview file: ${String(err)}\n\nFalling back to default worldview.`);
    return DEFAULT_WORLDVIEW;
  }
}

// ─── Create via conversation ────────────────────────────────────

/**
 * Run the full worldview creation pipeline:
 * Conversation (until Parsifal approves seed) → Frames → Gate → Persist → Verify
 *
 * The conversation handles seed approval internally — the Parsifal
 * goes as long as they need. No artificial limits.
 */
export async function generateWorldview(
  askUser: AskUserFn,
  options?: GenerateWorldviewOptions,
): Promise<Worldview> {
  const model = options?.model ?? "opus";
  const name = options?.name ?? "parsifal";

  log.info("Starting worldview generation pipeline");

  // ── Phase 1: Conversation → Approved Seed ───────────────────
  // The conversation proposes seeds, incorporates feedback, and
  // continues until the Parsifal approves. No separate gate needed.
  const seed = await buildWorldviewConversation(askUser, { model });
  log.info("Seed approved");

  // ── Phase 2: Frame Generation + Review ──────────────────────
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
      log.info("Parsifal chose to continue with current frames");
      break;
    }

    // Revised — re-generate frames with feedback
    log.info("Frame revision requested", { attempt: frameAttempt, feedback: outcome.feedback.slice(0, 100) });
    generated = await generateFrames(seed, model, outcome.feedback);
    frameAttempt++;
  }

  // ── Phase 3: Persist + Verify ───────────────────────────────
  log.info("Persisting worldview", { name });
  const worldview = persistAndVerify(name, seed, generated);
  persistSelection(name);
  log.info("Worldview generation complete", {
    name: worldview.name,
    frameCount: Object.keys(worldview.frames).length,
  });

  return worldview;
}

// ─── Top-level entry point ──────────────────────────────────────

/**
 * Set up a worldview for Cortex. Checks for an existing custom worldview,
 * then offers: select a preset, upload a file, or create through conversation.
 *
 * @param askUser — callback for interactive prompts
 * @param options — model and name for generation
 * @returns A Worldview ready for Cortex
 */
export async function setupWorldview(
  askUser: AskUserFn,
  options?: GenerateWorldviewOptions,
): Promise<Worldview> {
  // Check for previously selected or generated worldview
  const existing = loadExistingWorldview();
  if (existing) {
    log.info("Found existing worldview", { name: existing.name });
    return existing;
  }

  // No custom worldview — offer options
  const response = await askUser(
    `No custom worldview found. How would you like to set up how I see the work?\n\n` +
    `  1. **Select** a preset worldview\n` +
    `  2. **Upload** a worldview file\n` +
    `  3. **Create** a new worldview together\n\n` +
    `(Choose 1-3)`
  );

  const choice = response.trim();

  if (choice === "1" || choice.toLowerCase().includes("select") || choice.toLowerCase().includes("preset")) {
    return selectPreset(askUser);
  }

  if (choice === "2" || choice.toLowerCase().includes("upload") || choice.toLowerCase().includes("file")) {
    return uploadWorldview(askUser);
  }

  // Default to create (choice 3 or anything else)
  return generateWorldview(askUser, options);
}
