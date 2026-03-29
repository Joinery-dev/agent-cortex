/**
 * Consultation Prompt Schema Alignment — Smoke Test
 *
 * Verifies that the JSON schema examples in consultation prompts
 * match the PerspectiveResult Zod schema that consul.ts validates against.
 *
 * This catches the bug where the prompt asked for {firings, guidance, stake}
 * but the code expected {perspective, evaluators, stake, ceiling, ceilingRationale}.
 *
 * Run: npx tsx examples/consultation-prompt-smoke.ts
 */

import { z } from "zod";
import { consultationSystem, consultationUser, reconsultationSystem } from "../src/llm/prompts.js";
import type { Sense } from "../src/types/sense.js";
import type { ConsultationBriefing } from "../src/types/thalamus.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ─── The schema consul.ts actually validates against ─────────────────

const PerspectiveResult = z.object({
  perspective: z.string(),
  evaluators: z.array(z.string()),
  stake: z.number().min(0).max(1),
  ceiling: z.number().min(1).max(10),
  ceilingRationale: z.string(),
});

// ─── Test fixtures ───────────────────────────────────────────────────

const fakeSense: Sense = {
  id: "accessibility",
  name: "ACCESSIBILITY",
  level: "sense",
  sensitivity: "Ensures the product is usable by everyone.",
  activationHint: "UI, interaction, perceivable content",
};

const fakeReceptor: Sense = {
  id: "acc-color-contrast",
  name: "Color Contrast",
  level: "receptor",
  sensitivity: "Detects insufficient color contrast ratios.",
  parentId: "acc-visual",
  activationHint: "colors, contrast, text readability",
};

const fakePathway: Sense = {
  id: "acc-visual",
  name: "Visual Accessibility",
  level: "pathway",
  sensitivity: "Visual perception barriers.",
  parentId: "accessibility",
  activationHint: "visual, sight, color",
};

const subTree = [fakePathway, fakeReceptor];

const fakeBriefing: ConsultationBriefing = {
  task: { id: "test-task-1", description: "Build a login page", status: "pending" },
  intent: {
    summary: "Test project",
    audience: "developers",
    successCriteria: ["works correctly"],
    vision: "a good thing",
    constraints: [],
  },
  taste: {
    visual: "clean",
    decisionStyle: "pragmatic",
    patterns: "none",
    raw: {},
  },
  enrichment: {
    patterns: [],
    decisions: [],
    senseTrends: [],
    inhibitedSenses: [],
    openQuestions: [],
  },
};

// ─── Extract JSON example from a prompt string ──────────────────────

function extractJsonExample(prompt: string): Record<string, unknown> | null {
  // Find the last "Return JSON:" block and extract the JSON object after it
  const marker = "Return JSON:";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = prompt.slice(idx + marker.length).trim();

  // The example JSON uses placeholder values (0.0-1.0, 1-10) that aren't
  // valid JSON. Replace with concrete values to test the shape.
  const concrete = after
    .replace(/0\.0-1\.0/g, "0.5")
    .replace(/1-10/g, "7");

  try {
    return JSON.parse(concrete);
  } catch {
    return null;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

console.log("── consultationSystem prompt schema ──");
{
  const prompt = consultationSystem(fakeSense, subTree);

  // 1. Can extract valid JSON
  const example = extractJsonExample(prompt);
  assert(example !== null, "consultationSystem contains extractable JSON example");

  if (example) {
    // 2. JSON matches PerspectiveResult schema
    const result = PerspectiveResult.safeParse(example);
    assert(result.success, `consultationSystem JSON passes PerspectiveResult schema${
      !result.success ? ` — errors: ${JSON.stringify((result as any).error.issues)}` : ""
    }`);

    // 3. Has the right keys
    assert("perspective" in example, "has 'perspective' field (not 'guidance')");
    assert("evaluators" in example, "has 'evaluators' field (not 'firings')");
    assert("ceiling" in example, "has 'ceiling' field");
    assert("ceilingRationale" in example, "has 'ceilingRationale' field");

    // 4. Does NOT have the old wrong keys
    assert(!("firings" in example), "does NOT have old 'firings' field");
    assert(!("guidance" in example), "does NOT have old 'guidance' field");
  }
}

console.log("\n── consultationUser prompt schema ──");
{
  const prompt = consultationUser(fakeBriefing);

  const example = extractJsonExample(prompt);
  assert(example !== null, "consultationUser contains extractable JSON example");

  if (example) {
    const result = PerspectiveResult.safeParse(example);
    assert(result.success, `consultationUser JSON passes PerspectiveResult schema${
      !result.success ? ` — errors: ${JSON.stringify((result as any).error.issues)}` : ""
    }`);

    assert(!("firings" in example), "does NOT have old 'firings' field");
    assert(!("guidance" in example), "does NOT have old 'guidance' field");
  }
}

console.log("\n── reconsultationSystem prompt schema (should already be correct) ──");
{
  const prompt = reconsultationSystem(fakeSense, subTree);

  const example = extractJsonExample(prompt);
  assert(example !== null, "reconsultationSystem contains extractable JSON example");

  if (example) {
    const result = PerspectiveResult.safeParse(example);
    assert(result.success, `reconsultationSystem JSON passes PerspectiveResult schema${
      !result.success ? ` — errors: ${JSON.stringify((result as any).error.issues)}` : ""
    }`);
  }
}

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("  ❌ PROMPT/SCHEMA MISMATCH — senses will fail consultation");
  process.exit(1);
} else {
  console.log("  ✓ All consultation prompts align with PerspectiveResult schema");
}
