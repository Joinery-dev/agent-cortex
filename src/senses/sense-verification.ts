/**
 * Sense Verification — targeted sense consultation utility.
 *
 * Lightweight LLM calls that ask a specific sense to verify a claim
 * about its domain. Used at three integration points:
 *   1. Principle verification (hippocampus) — does this principle ring true?
 *   2. Escalation assessment (escalation handler) — what's your perspective on this?
 *   3. Taste feedback verification (taste feedback) — is this divergence real?
 *
 * These are NOT full sensory-cortex loops. They're targeted, single-turn
 * consultations at low-frequency moments (rest cycles, escalations, phase gates).
 */

import type { Sense } from "../types/sense.js";
import type { SensoryCortex } from "./cortex.js";
import { call } from "../llm/client.js";
import type { Purpose } from "../llm/client.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("sense-verification");

// ─── Types ──────────────────────────────────────────────────────

export interface SenseVerificationResult {
  /** How much the sense agrees with the claim (0–1). */
  agreement: number;
  /** The sense's assessment in its own voice. */
  assessment: string;
}

// ─── Core functions ─────────────────────────────────────────────

/**
 * Ask a single sense to verify something about its domain.
 * Returns null on failure (graceful degradation — verification
 * is additive, never blocking).
 */
export async function verifySense(
  purpose: Purpose,
  model: string,
  sense: Sense,
  systemPrompt: string,
  userPrompt: string,
): Promise<SenseVerificationResult | null> {
  try {
    const result = await call(purpose, model, systemPrompt, userPrompt, 1024);

    // Parse agreement + assessment from response.
    // Expected format: first line is a number 0-1, rest is assessment.
    const lines = result.text.trim().split("\n");
    const firstLine = lines[0]?.trim() ?? "";

    // Try to parse agreement from the first line
    const agreement = parseAgreement(firstLine);
    const assessment = agreement !== null
      ? lines.slice(1).join("\n").trim() || firstLine
      : result.text.trim();

    return {
      agreement: agreement ?? 0.5, // Default to neutral if parsing fails
      assessment,
    };
  } catch (err) {
    log.warn("Sense verification failed — skipping", {
      purpose,
      senseId: sense.id,
      senseName: sense.name,
      error: String(err),
    });
    return null;
  }
}

/**
 * Ask multiple senses to verify in parallel.
 * Uses Promise.allSettled — individual failures don't block others.
 *
 * @param buildPrompts - Callback that builds system + user prompts for each sense.
 *   Receives the sense object, returns { system, user } strings.
 */
export async function verifyWithSenses(
  purpose: Purpose,
  model: string,
  senses: Sense[],
  buildPrompts: (sense: Sense) => { system: string; user: string },
): Promise<Map<string, SenseVerificationResult>> {
  const results = new Map<string, SenseVerificationResult>();

  const settled = await Promise.allSettled(
    senses.map(async (sense) => {
      const prompts = buildPrompts(sense);
      const result = await verifySense(
        purpose,
        model,
        sense,
        prompts.system,
        prompts.user,
      );
      return { senseId: sense.id, result };
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value.result) {
      results.set(outcome.value.senseId, outcome.value.result);
    }
  }

  return results;
}

/**
 * Resolve a sense name to a Sense object from the library.
 * Case-insensitive lookup by name.
 */
export function resolveSenseByName(
  library: SensoryCortex,
  senseName: string,
): Sense | undefined {
  const lower = senseName.toLowerCase();
  return library
    .getSenses()
    .find((s) => s.name.toLowerCase() === lower);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Try to parse an agreement score from a string. */
function parseAgreement(text: string): number | null {
  // Try direct number parse
  const num = parseFloat(text);
  if (!isNaN(num) && num >= 0 && num <= 1) return num;

  // Try extracting a number from the text (e.g., "Agreement: 0.8")
  const match = text.match(/(\d+\.?\d*)/);
  if (match) {
    const extracted = parseFloat(match[1]);
    if (!isNaN(extracted) && extracted >= 0 && extracted <= 1) return extracted;
    // Handle 0-10 scale
    if (!isNaN(extracted) && extracted >= 0 && extracted <= 10) return extracted / 10;
  }

  return null;
}
