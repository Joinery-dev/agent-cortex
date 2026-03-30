/**
 * Worldview Synthesis — LLM calls for seed and frame generation.
 *
 * Two calls:
 *   1. Seed synthesis: discovery answers → WorldviewSeed
 *   2. Frame generation: seed + CATALOG.md → preamble + 21 frames
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callStructured } from "../llm/structured.js";
import { WorldviewSeedSchema, FrameGenerationResultSchema } from "./types.js";
import type { DiscoveryAnswer, WorldviewSeed, FrameGenerationResult } from "./types.js";

// ─── CATALOG.md loader ──────────────────────────────────────────

let _catalogCache: string | null = null;

function loadCatalog(): string {
  if (_catalogCache) return _catalogCache;
  const here = fileURLToPath(import.meta.url);
  const root = resolve(dirname(here), "../..");
  const catalogPath = join(root, "worldviews/CATALOG.md");
  _catalogCache = readFileSync(catalogPath, "utf-8");
  return _catalogCache;
}

// ─── Seed Synthesis ─────────────────────────────────────────────

const SEED_SYSTEM = `You are a philosophical synthesist. You receive answers from a person about how they see work, understanding, quality, tension, learning, collaboration, and identity. Your job is to distill these into a coherent worldview seed — six philosophical commitments that form a unified perspective.

This is NOT summarization. The answers are raw material. Your job is to find the underlying philosophy — the ontology, epistemology, and axiology that would produce these answers. The person may not have articulated their philosophy explicitly. You are reading between the lines to find the coherent worldview underneath.

Each field should be 2-4 sentences of rich, specific prose. Not generic platitudes ("quality matters") but the specific shape of THIS person's thinking ("quality is structural clarity — the moment where the reader can hold the whole system in their mind at once").

For vocabulary: derive terms that feel native to this person's ontology. If they see work as exploration, the top unit might be "expedition" and the leaf unit "step." If they see work as craft, maybe "piece" and "stroke." The vocabulary should feel inevitable given the ontology, not forced.`;

function formatDiscoveryForSeed(answers: DiscoveryAnswer[]): string {
  const parts: string[] = ["Here are the Parsifal's responses to the worldview discovery questions:\n"];

  for (const a of answers) {
    parts.push(`**${a.dimension}** (Q${a.number}): ${a.response}`);
    if (a.followUpResponse) {
      parts.push(`  Follow-up: ${a.followUpResponse}`);
    }
    parts.push("");
  }

  parts.push("Synthesize these into a WorldviewSeed. Include vocabulary derived from their ontology.");
  return parts.join("\n");
}

export async function synthesizeSeed(
  answers: DiscoveryAnswer[],
  model: string = "opus",
): Promise<WorldviewSeed> {
  const userMessage = formatDiscoveryForSeed(answers);
  return callStructured(
    "worldview-seed",
    model,
    SEED_SYSTEM,
    userMessage,
    WorldviewSeedSchema,
    4096,
  );
}

// ─── Frame Generation ───────────────────────────────────────────

const FRAME_SYSTEM = `You are generating a complete worldview for an AI cognitive system called Cortex. You receive a WorldviewSeed (six philosophical commitments + vocabulary) and a CATALOG of all 21 cognitive acts with their contracts.

Your job: write a preamble and 21 frames — one for each cognitive act — that express this worldview's philosophy while honoring each act's structural contract.

CRITICAL RULES:
1. Each frame REPLACES the default text entirely. It must be self-contained prose.
2. Frames must honor the structural constraints in the CATALOG (score ranges, output schemas, process steps). Don't repeat the constraints — they're appended automatically. Write the IDENTITY and ORIENTATION.
3. The preamble is the single highest-leverage surface. It frames how the LLM understands ALL cognitive acts. Make it 3-5 sentences that capture the ontology in a way that shapes thinking.
4. Use the vocabulary naturally. If the top unit is "expedition," the decomposition frame should talk about breaking expeditions into steps, not shaels into shana.
5. Each frame should be 1-3 paragraphs. Dense, specific, actionable. Not generic philosophy — specific cognitive orientation.
6. The frames must form a COHERENT whole. The same worldview should be recognizable across consultation, evaluation, building, and resolution.
7. semanticNodeDescription should describe nodes using the vocabulary (e.g. "expeditions (high-level explorations) and steps (actionable waypoints)").

Study the CATALOG carefully. Each entry tells you what the frame must convey — identity, epistemology, orientation for that specific cognitive act. Your frames provide those three things through the lens of this worldview.`;

function formatSeedAndCatalog(seed: WorldviewSeed, feedback?: string): string {
  const catalog = loadCatalog();

  const seedText = `## WorldviewSeed

**Ontology:** ${seed.ontology}

**Epistemology:** ${seed.epistemology}

**Axiology:** ${seed.axiology}

**Tension Philosophy:** ${seed.tensionPhilosophy}

**Learning Orientation:** ${seed.learningOrientation}

**Collaboration Model:** ${seed.collaborationModel}

${seed.vocabulary ? `**Vocabulary:**
- topUnit: ${seed.vocabulary.topUnit.singular} / ${seed.vocabulary.topUnit.plural}
- leafUnit: ${seed.vocabulary.leafUnit.singular} / ${seed.vocabulary.leafUnit.plural}
- artifact: ${seed.vocabulary.artifact.singular} / ${seed.vocabulary.artifact.plural}
- decomposeVerb: ${seed.vocabulary.decomposeVerb}
- completeVerb: ${seed.vocabulary.completeVerb}
- nodeNature: ${seed.vocabulary.nodeNature}` : ""}

---

## CATALOG (structural contracts for all 21 cognitive acts)

${catalog}`;

  if (feedback) {
    return seedText + `\n\n---\n\n## Feedback from the Parsifal\n\nThe Parsifal reviewed the previous generation and gave this feedback:\n${feedback}\n\nRevise the frames to incorporate this feedback while maintaining coherence.`;
  }

  return seedText;
}

export async function generateFrames(
  seed: WorldviewSeed,
  model: string = "opus",
  feedback?: string,
): Promise<FrameGenerationResult> {
  const userMessage = formatSeedAndCatalog(seed, feedback);
  return callStructured(
    "worldview-frames",
    model,
    FRAME_SYSTEM,
    userMessage,
    FrameGenerationResultSchema,
    16384, // ~21 frames × ~500 tokens each + preamble
  );
}
