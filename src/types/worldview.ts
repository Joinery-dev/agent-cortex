/**
 * Worldview — the ontological frame that shapes how Cortex thinks.
 *
 * A worldview is a complete cognitive personality: not vocabulary substitution,
 * but thought substitution. Every cognitive act Cortex performs — sensing,
 * building, evaluating, resolving, learning, reflecting — is shaped by the
 * worldview's frames.
 *
 * Worldviews are authored as .md files (see worldviews/*.md) and loaded at
 * runtime. Each section of the .md provides a "frame" — prose that replaces
 * the identity/epistemology/orientation portion of a prompt function. The
 * structural portion (JSON schemas, output format, mechanical constraints)
 * stays in TypeScript.
 *
 * The JSON output schema uses "shael"/"shana" as protocol tokens
 * regardless of worldview — the Zod schemas stay stable.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface Term {
  singular: string;
  plural: string;
}

/**
 * Frames for each cognitive act. Each frame is prose injected into the
 * corresponding prompt function(s). When a frame is absent, the prompt
 * function uses its built-in default.
 *
 * Frame = WHO you are + HOW you think + WHAT matters.
 * Structure (stays in code) = WHAT to output + FORMAT constraints.
 */
export interface WorldviewFrames {
  /** How senses approach tasks. Used by: consultationSystem, reconsultationSystem, senseQuestionSystem. */
  consultation: string;
  /** What "good" means. Used by: evaluatorBundleSystem, evaluatorAgenticBundleSystem (and legacy evaluatorSystem, evaluatorAgenticSystem). */
  evaluation: string;
  /** Who the builder is. Used by: motorCortexSystem, motorCortexAgenticSystem, revisionPrompt. */
  building: string;
  /** How to plan before building. Used by: premotorSystem, premotorRevisionUser. */
  planning: string;
  /** How to break down the whole. Used by: shaelDecompositionSystem. */
  decomposition: string;
  /** How backward reasoning works. Used by: pathReasoningSystem, replanReasoningSystem. */
  pathReasoning: string;
  /** How tensions dissolve. Used by: resolverSystem, collapseDetectorSystem. */
  resolution: string;
  /** What patterns mean. Used by: potentiationExtractSystem, potentiationSenseExtractSystem, potentiationRefineSystem. */
  learning: string;
  /** How self-understanding works. Used by: weltanschauungSystem. */
  reflection: string;
  /** What plan-execution fit means. Used by: proprioceptionSystem. */
  coherence: string;
  /** What "achievable" means. Used by: efferenceCopySystem. */
  feasibility: string;
  /** What drift/stuck/diagnosis mean. Used by: driftAnalysisSystem, cognitiveFlexibilitySystem, projectDiagnosticsSystem. */
  navigation: string;
  /** What failure scenarios reveal. Used by: hippocampalSimulationSystem, deepSynthesisSystem. */
  simulation: string;
  /** What matters vs what doesn't. Used by: basalGangliaSystem. */
  relevance: string;
  /** How Cortex relates to the Parsifal. Used by: tasteProposalSystem, escalationSenseAssessmentSystem, principleVerificationSystem. */
  partnership: string;
  /** How nodes relate. Used by: semanticMappingSystem, affinityAnalysisSystem. */
  wiring: string;
  /** What cross-task coherence means. Used by: integrationEvaluatorSystem. */
  integration: string;
  /** What the manifested future IS. Used by: Planner.createManifestationTask. */
  manifestation: string;
  /** How senses ask clarifying questions before advising. Used by: inquirySystem. */
  inquiry: string;
  /** What to watch for ahead. Used by: prospectiveMatchingSystem. */
  prospective: string;
  /** What emerges after completion. Used by: generativeCompletionSystem. */
  emergence: string;
}

export interface Worldview {
  /** Identifier for this worldview. */
  name: string;

  /** Human-readable description. */
  description?: string;

  /** Schema version for forward compatibility. */
  version?: number;

  /**
   * The ontological preamble injected at the start of every system prompt.
   * This is the single highest-leverage surface — it frames how the LLM
   * understands what it's doing across ALL cognitive acts.
   */
  preamble: string;

  /** Vocabulary for decomposition-specific prompts (terms interpolated into JSON schemas, etc.). */
  vocabulary: {
    /** What we call high-level decomposition units ("shael" / "epic"). */
    topUnit: Term;
    /** What we call leaf-level executable units ("shana" / "task"). */
    leafUnit: Term;
    /** What we call the completed artifact ("shalem" / "deliverable"). */
    artifact: Term;
    /** Verb phrase for the decomposition process. */
    decomposeVerb: string;
    /** How a leaf unit is completed. */
    completeVerb: string;
    /** What a node "is" — used in prompts like "each node is ___". */
    nodeNature: string;
  };

  /**
   * How the semantic mapping/affinity prompts describe nodes.
   * e.g. "shaels (questions to be lived) and shana (leaf tasks)"
   */
  semanticNodeDescription: string;

  /**
   * Per-cognitive-act frames. Each is prose injected into the relevant
   * prompt function(s), replacing the identity/orientation portion.
   * All frames are optional — missing frames fall back to built-in defaults.
   */
  frames: Partial<WorldviewFrames>;
}

// ─── Frame loading ─────��────────────────────────────────────────
// SHAELA_WORLDVIEW starts with empty frames. On first access, we
// load them from worldviews/shaela.md (sync — loadWorldview uses
// readFileSync). This avoids duplicating the .md prose in code.

// No circular dep: worldview-loader uses `import type` from this
// file, which is erased at compile time. At runtime the import
// graph is one-directional: worldview.ts → worldview-loader.ts.

import { loadWorldview } from "../util/worldview-loader.js";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";

let _defaultFramesLoaded = false;

/**
 * Populate SHAELA_WORLDVIEW.frames from worldviews/shaela.md.
 * Safe to call multiple times — loads once. Fails silently if
 * the .md file isn't found (frames fall back to code defaults).
 */
export function ensureDefaultFrames(): void {
  if (_defaultFramesLoaded) return;
  _defaultFramesLoaded = true;
  try {
    const here = fileURLToPath(import.meta.url);
    const root = resolve(dirname(here), "../..");
    const mdPath = join(root, "worldviews/shaela.md");
    if (!existsSync(mdPath)) return;
    const loaded = loadWorldview(mdPath);
    Object.assign(SHAELA_WORLDVIEW.frames, loaded.frames);
  } catch {
    // Fail silently — bodyOrDefault falls back to hardcoded defaults
  }
}

// ─── Frame accessor ─────────────���────────────────────────────────

/**
 * Get a frame from a worldview, falling back to the default worldview.
 * Every prompt function uses this to get its frame text.
 */
export function getFrame(
  key: keyof WorldviewFrames,
  worldview?: Worldview,
): string | undefined {
  ensureDefaultFrames();
  return worldview?.frames?.[key] ?? DEFAULT_WORLDVIEW.frames?.[key];
}

// ─── Default / Presets ───────────────────────────────────────────
// These are compiled-in presets. Worldviews can also be loaded from
// .md files at runtime via loadWorldview() in util/worldview-loader.ts.
//
// SHAELA_WORLDVIEW frames are populated by loadWorldview() from
// worldviews/shaela.md at first access. The preamble and vocabulary
// are always available as fallbacks even before loading.

export const SHAELA_WORLDVIEW: Worldview = {
  name: "shaela",
  description: "Questions to be lived — hermeneutic epistemology",
  version: 1,

  preamble: `In this system, being is framed as shaela — questions to be lived. \
Shaels are questions nested within questions that are evermore specific. \
A shana is a question specific enough to be lived in one cycle. When lived \
deeply it becomes a shalem — an embodiment, an artifact that crystallizes \
understanding. Your role is to understand deeply enough that the answer emerges.`,

  vocabulary: {
    topUnit: { singular: "shael", plural: "shaels" },
    leafUnit: { singular: "shana", plural: "shana" },
    artifact: { singular: "shalem", plural: "shalems" },
    decomposeVerb: "decompose into questions to be lived",
    completeVerb: "live deeply",
    nodeNature: "a question at the right resolution",
  },

  semanticNodeDescription:
    "shaels (questions to be lived) and shana (leaf tasks)",

  frames: {},  // Populated from worldviews/shaela.md by loadWorldview()
};

export const PROJECT_WORLDVIEW: Worldview = {
  name: "project",
  description: "Forces to be resolved — engineering epistemology",
  version: 1,

  preamble: `You are an engineering system that solves problems. Not a code \
generator, not a task executor — a system that understands problems deeply \
enough to find the minimum solution. Every component you propose exists \
because removing it would cause structural failure. Every dependency you \
identify is a real force relationship, not organizational convenience. The \
measure of your plan is not coverage but economy: the tightest structure \
that produces the full outcome. When you decompose, you are not breaking \
work into smaller work — you are identifying the load-bearing structure \
that connects the current state to the finished one.`,

  vocabulary: {
    topUnit: { singular: "epic", plural: "epics" },
    leafUnit: { singular: "task", plural: "tasks" },
    artifact: { singular: "deliverable", plural: "deliverables" },
    decomposeVerb: "decompose into engineering milestones",
    completeVerb: "deliver",
    nodeNature: "a concrete engineering milestone with verifiable output",
  },

  semanticNodeDescription:
    "epics (engineering milestones) and tasks (leaf deliverables)",

  frames: {},  // TODO: populate from worldviews/project.md
};

export const HYBRID_WORLDVIEW: Worldview = {
  name: "hybrid",
  description: "Engineering questions with deliverable answers — pragmatic epistemology",
  version: 1,

  preamble: `In this system, work is framed as shaela — questions to be lived. \
But these are engineering questions, not philosophical abstractions. A shael \
is a question at the resolution where removing it would leave a structural \
gap — "what must the authentication boundary become?" is a shael because \
without that answer, nothing downstream is secure. A shana is a question \
concrete enough to answer with a deliverable in one cycle. When answered \
deeply, a shana produces a shalem: an artifact that embodies understanding \
so completely that the question dissolves. The question finds the force. \
The answer resolves it. Your role is to find the questions whose answers \
are load-bearing.`,

  vocabulary: {
    topUnit: { singular: "shael", plural: "shaels" },
    leafUnit: { singular: "shana", plural: "shana" },
    artifact: { singular: "shalem", plural: "shalems" },
    decomposeVerb: "decompose into engineering questions",
    completeVerb: "answer with a deliverable",
    nodeNature: "an engineering question with a verifiable answer",
  },

  semanticNodeDescription:
    "shaels (engineering questions at epic resolution) and shana (answerable leaf questions)",

  frames: {},  // TODO: populate from worldviews/hybrid.md
};

// ─── Default ─────────────────────────────────────────────────────

export const DEFAULT_WORLDVIEW = SHAELA_WORLDVIEW;
