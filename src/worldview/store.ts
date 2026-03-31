/**
 * Worldview Store — detect, persist, and load generated worldviews.
 *
 * Generated worldviews live in ~/.agent-cortex/worldviews/{name}.md.
 * Uses atomic writes (tmp + rename) and the same .md format that
 * loadWorldview() already parses.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { loadWorldview } from "../util/worldview-loader.js";
import type { Worldview } from "../types/worldview.js";
import {
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
import type { WorldviewSeed, FrameGenerationResult } from "./types.js";

// ─── Paths ──────────────────────────────────────────────────────

const CORTEX_DIR = join(homedir(), ".agent-cortex");
const WORLDVIEW_DIR = join(CORTEX_DIR, "worldviews");
const SELECTION_FILE = join(CORTEX_DIR, "worldview-selection.json");
const BUILTIN_NAMES = new Set(["shaela", "project", "hybrid"]);

function ensureDir(): void {
  if (!existsSync(WORLDVIEW_DIR)) {
    mkdirSync(WORLDVIEW_DIR, { recursive: true });
  }
}

// ─── Selection persistence ──────────────────────────────────

interface WorldviewSelection {
  /** The worldview name (matches preset name or generated file name). */
  name: string;
  /** For uploaded worldviews, the original file path. */
  path?: string;
}

/**
 * Persist the user's worldview selection so it survives restarts.
 * Called after preset selection, file upload, or generation.
 */
export function persistSelection(name: string, path?: string): void {
  if (!existsSync(CORTEX_DIR)) {
    mkdirSync(CORTEX_DIR, { recursive: true });
  }
  const selection: WorldviewSelection = { name };
  if (path) selection.path = path;
  writeFileSync(SELECTION_FILE, JSON.stringify(selection, null, 2), "utf-8");
}

/**
 * Read the persisted worldview selection, if any.
 */
function readSelection(): WorldviewSelection | null {
  try {
    if (!existsSync(SELECTION_FILE)) return null;
    return JSON.parse(readFileSync(SELECTION_FILE, "utf-8")) as WorldviewSelection;
  } catch {
    return null;
  }
}

// ─── Detect ─────────────────────────────────────────────────────

/**
 * Find the first generated (non-builtin) worldview in the user's
 * worldview directory. Returns the file path or null.
 */
export function detectExistingWorldview(): string | null {
  ensureDir();
  try {
    const files = readdirSync(WORLDVIEW_DIR).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const name = file.replace(/\.md$/, "");
      if (!BUILTIN_NAMES.has(name)) {
        return join(WORLDVIEW_DIR, file);
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return null;
}

const PRESET_WORLDVIEWS: Record<string, Worldview> = {
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

/**
 * Load a previously selected or generated worldview.
 * Checks the selection file first (covers presets + uploads),
 * then falls back to detecting generated worldview files.
 * Returns null if nothing is persisted.
 */
export function loadExistingWorldview(): Worldview | null {
  // Check persisted selection first
  const selection = readSelection();
  if (selection) {
    // Preset worldview
    const preset = PRESET_WORLDVIEWS[selection.name];
    if (preset) return preset;

    // Uploaded file — try the recorded path
    if (selection.path) {
      try { return loadWorldview(selection.path); } catch { /* fall through */ }
    }

    // Generated worldview — look for the file
    const genPath = join(WORLDVIEW_DIR, `${selection.name}.md`);
    if (existsSync(genPath)) {
      try { return loadWorldview(genPath); } catch { /* fall through */ }
    }
  }

  // Fallback: detect any generated (non-builtin) worldview file
  const path = detectExistingWorldview();
  if (!path) return null;
  return loadWorldview(path);
}

// ─── Serialize ──────────────────────────────────────────────────

/**
 * Serialize a worldview seed + generated frames into .md format
 * compatible with loadWorldview().
 */
export function serializeWorldview(
  name: string,
  seed: WorldviewSeed,
  generated: FrameGenerationResult,
): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`name: ${name}`);
  lines.push(`description: Generated worldview — ${seed.ontology.slice(0, 60)}`);
  lines.push("version: 1");
  lines.push(`systemName: ${seed.systemName}`);
  lines.push(`entityName: ${seed.entityName}`);
  lines.push("generated: true");
  lines.push("---");
  lines.push("");

  // Preamble
  lines.push("# preamble");
  lines.push("");
  lines.push(generated.preamble);
  lines.push("");

  // Vocabulary
  const vocab = seed.vocabulary;
  if (vocab) {
    lines.push("# vocabulary");
    lines.push("");
    lines.push(`- topUnit: ${vocab.topUnit.singular} / ${vocab.topUnit.plural}`);
    lines.push(`- leafUnit: ${vocab.leafUnit.singular} / ${vocab.leafUnit.plural}`);
    lines.push(`- artifact: ${vocab.artifact.singular} / ${vocab.artifact.plural}`);
    lines.push(`- decomposeVerb: ${vocab.decomposeVerb}`);
    lines.push(`- completeVerb: ${vocab.completeVerb}`);
    lines.push(`- nodeNature: ${vocab.nodeNature}`);
    lines.push(`- semanticNodeDescription: ${generated.semanticNodeDescription}`);
    lines.push("");
  }

  // Frames — use kebab-case headings for pathReasoning
  const frameOrder: Array<[string, string]> = [
    ["consultation", "consultation"],
    ["evaluation", "evaluation"],
    ["building", "building"],
    ["planning", "planning"],
    ["decomposition", "decomposition"],
    ["path-reasoning", "pathReasoning"],
    ["resolution", "resolution"],
    ["learning", "learning"],
    ["reflection", "reflection"],
    ["coherence", "coherence"],
    ["feasibility", "feasibility"],
    ["navigation", "navigation"],
    ["simulation", "simulation"],
    ["relevance", "relevance"],
    ["partnership", "partnership"],
    ["wiring", "wiring"],
    ["integration", "integration"],
    ["manifestation", "manifestation"],
    ["inquiry", "inquiry"],
    ["inquiry-synthesis", "inquirySynthesis"],
    ["sense-manifest", "senseManifest"],
    ["vision-synthesis", "visionSynthesis"],
    ["sense-evaluation", "senseEvaluation"],
    ["prospective", "prospective"],
    ["emergence", "emergence"],
  ];

  for (const [heading, key] of frameOrder) {
    const text = generated.frames[key as keyof typeof generated.frames];
    if (text) {
      lines.push(`# ${heading}`);
      lines.push("");
      lines.push(text);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── Persist ────────────────────────────────────────────────────

/**
 * Write a worldview to ~/.agent-cortex/worldviews/{name}.md.
 * Uses atomic write (tmp + rename) to prevent partial files.
 * Returns the file path.
 */
export function persistWorldview(
  name: string,
  seed: WorldviewSeed,
  generated: FrameGenerationResult,
): string {
  ensureDir();
  const content = serializeWorldview(name, seed, generated);
  const targetPath = join(WORLDVIEW_DIR, `${name}.md`);

  // Atomic write: write to tmp file, then rename
  const tmpPath = join(WORLDVIEW_DIR, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, targetPath);

  return targetPath;
}

/**
 * Persist and verify roundtrip — write, load back, confirm all frames survived.
 * Returns the loaded Worldview.
 */
export function persistAndVerify(
  name: string,
  seed: WorldviewSeed,
  generated: FrameGenerationResult,
): Worldview {
  const path = persistWorldview(name, seed, generated);
  const loaded = loadWorldview(path);

  // Verify all frames survived the roundtrip
  const expectedKeys = Object.keys(generated.frames) as Array<keyof typeof generated.frames>;
  const missing = expectedKeys.filter((k) => !loaded.frames[k]);
  if (missing.length > 0) {
    throw new Error(`Roundtrip verification failed — frames lost: ${missing.join(", ")}`);
  }

  return loaded;
}
