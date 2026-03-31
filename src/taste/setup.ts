/**
 * Taste Profile Setup — interactive one-time configuration.
 *
 * Checks for an existing persisted profile first. If found, returns
 * it silently (no re-prompting). Otherwise, offers presets or custom.
 */

import type { TasteProfile } from "../types/intent.js";
import { persistTasteProfile, loadTasteProfile, DEFAULT_TASTE } from "./store.js";

export type AskUserFn = (question: string) => Promise<string>;

// ─── Presets ────────────────────────────────────────────────────

const PRESETS: Record<string, Omit<TasteProfile, "name">> = {
  craftsman: {
    id: "taste-craftsman",
    visual: "Clean, modern, purposeful",
    decisionStyle: "Pragmatic — simplest thing that works, then iterate",
    communication: "Direct and concise",
    patterns: "Best practices for the technology stack",
    raw: {},
  },
  minimalist: {
    id: "taste-minimalist",
    visual: "Stripped to essentials — no decoration, pure function",
    decisionStyle: "Fewest moving parts. Convention over configuration. Delete before adding",
    communication: "Terse. No filler",
    patterns: "Standard library first. Minimal dependencies. Boring technology",
    raw: {},
  },
  explorer: {
    id: "taste-explorer",
    visual: "Rich, expressive, distinctive",
    decisionStyle: "Experimental — try the interesting approach, back off if it fails",
    communication: "Conversational and detailed",
    patterns: "Modern patterns. Willing to use cutting-edge tools when they fit",
    raw: {},
  },
};

// ─── Setup flow ─────────────────────────────────────────────────

/**
 * Set up the Parsifal's taste profile. Checks for an existing profile
 * first — if found, returns it without prompting.
 */
export async function setupTaste(askUser: AskUserFn): Promise<TasteProfile> {
  // Check for existing profile
  const existing = loadTasteProfile();
  if (existing) return existing;

  // Ask for name
  const nameResponse = await askUser(
    `What should I call you?\n\n(This appears in every briefing. Press enter for "User")`
  );
  const name = nameResponse.trim() || "User";

  // Offer presets or custom
  const choice = await askUser(
    `How would you like me to approach your work?\n\n` +
    `  1. **Craftsman** — Clean and purposeful. Pragmatic decisions. Direct communication. Best practices.\n` +
    `  2. **Minimalist** — Stripped to essentials. Fewest moving parts. Terse. Boring technology.\n` +
    `  3. **Explorer** — Rich and expressive. Experimental. Conversational. Cutting-edge patterns.\n` +
    `  4. **Custom** — Define each dimension yourself.\n\n` +
    `(Choose 1-4)`
  );

  const normalized = choice.trim().toLowerCase();
  let taste: TasteProfile;

  if (normalized === "4" || normalized === "custom") {
    taste = await customSetup(askUser, name);
  } else {
    const presetName =
      normalized === "1" || normalized === "craftsman" ? "craftsman" :
      normalized === "2" || normalized === "minimalist" ? "minimalist" :
      normalized === "3" || normalized === "explorer" ? "explorer" :
      "craftsman"; // default

    taste = { ...PRESETS[presetName], name };
  }

  persistTasteProfile(taste);
  return taste;
}

// ─── Custom setup ───────────────────────────────────────────────

async function customSetup(askUser: AskUserFn, name: string): Promise<TasteProfile> {
  const visual = await askField(askUser,
    "Visual / aesthetic preferences?",
    "e.g., 'Clean and modern', 'Brutalist and functional', 'Rich and expressive'",
    DEFAULT_TASTE.visual,
  );

  const decisionStyle = await askField(askUser,
    "Decision style?",
    "e.g., 'Pragmatic — simplest thing that works', 'Thorough — consider all options', 'Fast — decide and move'",
    DEFAULT_TASTE.decisionStyle,
  );

  const communication = await askField(askUser,
    "Communication tone?",
    "e.g., 'Direct', 'Conversational', 'Formal', 'Terse'",
    DEFAULT_TASTE.communication,
  );

  const patterns = await askField(askUser,
    "Patterns / conventions?",
    "e.g., 'Best practices for the stack', 'Minimal dependencies', 'Convention over configuration'",
    DEFAULT_TASTE.patterns,
  );

  return {
    id: "taste-custom",
    name,
    visual,
    decisionStyle,
    communication,
    patterns,
    raw: {},
  };
}

async function askField(
  askUser: AskUserFn,
  question: string,
  examples: string,
  fallback: string,
): Promise<string> {
  const response = await askUser(`${question}\n\n(${examples})`);
  return response.trim() || fallback;
}
