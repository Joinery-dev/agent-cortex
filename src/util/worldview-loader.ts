/**
 * Worldview Loader — parses .md worldview files into Worldview objects.
 *
 * Format:
 *   ---
 *   name: shaela
 *   description: Questions to be lived
 *   version: 1
 *   ---
 *
 *   # preamble
 *   [prose text]
 *
 *   # vocabulary
 *   - topUnit: shael / shaels
 *   - leafUnit: shana / shana
 *   ...
 *
 *   # consultation
 *   [frame prose]
 *
 *   # building
 *   [frame prose]
 *   ...
 *
 * Each `# heading` becomes a key. The `preamble` and `vocabulary` sections
 * are parsed into their respective Worldview fields. All other sections
 * become entries in `frames`.
 */

import { readFileSync } from "node:fs";
import type { Worldview, WorldviewFrames, Term } from "../types/worldview.js";

// ─── Section keys that map to frames ─────────────────────────────

const FRAME_KEYS = new Set<keyof WorldviewFrames>([
  "consultation",
  "evaluation",
  "building",
  "planning",
  "decomposition",
  "pathReasoning",
  "resolution",
  "learning",
  "reflection",
  "coherence",
  "feasibility",
  "navigation",
  "simulation",
  "relevance",
  "partnership",
  "wiring",
  "integration",
  "manifestation",
  "prospective",
  "emergence",
  "inquiry",
]);

/**
 * Map from kebab-case heading names in .md to camelCase frame keys.
 * Headings that are already camelCase or single words map to themselves.
 */
const HEADING_TO_KEY: Record<string, keyof WorldviewFrames> = {
  "consultation": "consultation",
  "evaluation": "evaluation",
  "building": "building",
  "planning": "planning",
  "decomposition": "decomposition",
  "path-reasoning": "pathReasoning",
  "pathReasoning": "pathReasoning",
  "resolution": "resolution",
  "learning": "learning",
  "reflection": "reflection",
  "coherence": "coherence",
  "feasibility": "feasibility",
  "navigation": "navigation",
  "simulation": "simulation",
  "relevance": "relevance",
  "partnership": "partnership",
  "wiring": "wiring",
  "integration": "integration",
  "manifestation": "manifestation",
  "prospective": "prospective",
  "emergence": "emergence",
  "inquiry": "inquiry",
};

// ─── Parser ──────────────────────────────────────────────────────

interface ParsedSection {
  heading: string;
  body: string;
}

function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }
  }

  return { meta, body: match[2] };
}

function parseSections(body: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = body.split("\n");
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^# (\S+)/);
    if (headingMatch) {
      // Save previous section
      if (currentHeading) {
        sections.push({
          heading: currentHeading,
          body: currentLines.join("\n").trim(),
        });
      }
      currentHeading = headingMatch[1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Save last section
  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      body: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

function parseTerm(value: string): Term {
  const parts = value.split("/").map((s) => s.trim());
  return {
    singular: parts[0],
    plural: parts[1] ?? parts[0],
  };
}

function parseVocabulary(body: string): Worldview["vocabulary"] & { semanticNodeDescription?: string } {
  const result: Record<string, string> = {};

  for (const line of body.split("\n")) {
    const match = line.match(/^- (\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }

  return {
    topUnit: parseTerm(result["topUnit"] ?? "shael / shaels"),
    leafUnit: parseTerm(result["leafUnit"] ?? "shana / shana"),
    artifact: parseTerm(result["artifact"] ?? "shalem / shalems"),
    decomposeVerb: result["decomposeVerb"] ?? "decompose",
    completeVerb: result["completeVerb"] ?? "complete",
    nodeNature: result["nodeNature"] ?? "a node",
    semanticNodeDescription: result["semanticNodeDescription"],
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Load a worldview from a .md file.
 *
 * @param filePath — absolute or relative path to the .md file
 * @returns A fully populated Worldview object
 */
export function loadWorldview(filePath: string): Worldview {
  const raw = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);
  const sections = parseSections(body);

  // Extract special sections
  const preambleSection = sections.find((s) => s.heading === "preamble");
  const vocabSection = sections.find((s) => s.heading === "vocabulary");

  // Parse vocabulary
  const vocabResult = vocabSection
    ? parseVocabulary(vocabSection.body)
    : undefined;

  const { semanticNodeDescription: snd, ...vocabulary } = vocabResult ?? {
    topUnit: { singular: "shael", plural: "shaels" },
    leafUnit: { singular: "shana", plural: "shana" },
    artifact: { singular: "shalem", plural: "shalems" },
    decomposeVerb: "decompose",
    completeVerb: "complete",
    nodeNature: "a node",
  };

  // Build frames from remaining sections
  const frames: Partial<WorldviewFrames> = {};
  for (const section of sections) {
    if (section.heading === "preamble" || section.heading === "vocabulary") {
      continue;
    }
    const frameKey = HEADING_TO_KEY[section.heading];
    if (frameKey && FRAME_KEYS.has(frameKey)) {
      frames[frameKey] = section.body;
    }
  }

  return {
    name: meta["name"] ?? "unnamed",
    description: meta["description"],
    version: meta["version"] ? parseInt(meta["version"], 10) : undefined,
    preamble: preambleSection?.body ?? "",
    vocabulary,
    semanticNodeDescription: snd ?? `${vocabulary.topUnit.plural} and ${vocabulary.leafUnit.plural}`,
    frames,
  };
}
