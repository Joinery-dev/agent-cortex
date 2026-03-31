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
 * The JSON output schema uses the worldview's vocabulary for level
 * values (e.g. "shael"/"shana", "block"/"cut", "set"/"riff").
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
  /** How senses describe the finished product from their perspective. Used by: senseManifestSystem. */
  senseManifest: string;
  /** How perspectives combine into unified vision. Used by: visionSynthesisSystem. */
  visionSynthesis: string;
  /** How senses evaluate whether a synthesis captures their contribution. Used by: senseEvaluationSystem. */
  senseEvaluation: string;
  /** How senses ask clarifying questions before advising. Used by: inquirySystem. */
  inquiry: string;
  /** How to merge and prioritize questions from multiple senses. Used by: inquirySynthesisSystem. */
  inquirySynthesis: string;
  /** What to watch for ahead. Used by: prospectiveMatchingSystem. */
  prospective: string;
  /** What emerges after completion. Used by: generativeCompletionSystem. */
  emergence: string;
  /** Who you are as the conscious voice. Used by: ConsciousnessAgent system prompt. */
  consciousness?: string;
}

export interface Worldview {
  /** Identifier for this worldview. */
  name: string;

  /** Human-readable description. */
  description?: string;

  /** Schema version for forward compatibility. */
  version?: number;

  /** What the system calls itself. Default: "Cortex". */
  systemName: string;

  /** What the system calls the entity it serves. Default: "the Parsifal". */
  entityName: string;

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
 * Populate preset worldview frames from their .md files.
 * Safe to call multiple times — loads once. Fails silently if
 * a .md file isn't found (frames fall back to code defaults).
 */
export function ensureDefaultFrames(): void {
  if (_defaultFramesLoaded) return;
  _defaultFramesLoaded = true;

  const here = fileURLToPath(import.meta.url);
  const root = resolve(dirname(here), "../..");

  const presets: Array<{ worldview: Worldview; file: string }> = [
    { worldview: SHAELA_WORLDVIEW, file: "shaela.worldview.md" },
    { worldview: PROJECT_WORLDVIEW, file: "project.worldview.md" },
    { worldview: HYBRID_WORLDVIEW, file: "hybrid.worldview.md" },
    { worldview: COVENANT_WORLDVIEW, file: "covenant.worldview.md" },
    { worldview: GROOVE_WORLDVIEW, file: "groove.worldview.md" },
    { worldview: ECOSYSTEM_WORLDVIEW, file: "ecosystem.worldview.md" },
    { worldview: DIALECTIC_WORLDVIEW, file: "dialectic.worldview.md" },
    { worldview: CARTOGRAPH_WORLDVIEW, file: "cartograph.worldview.md" },
    { worldview: SCULPTOR_WORLDVIEW, file: "sculptor.worldview.md" },
    { worldview: NARRATIVE_WORLDVIEW, file: "narrative.worldview.md" },
  ];

  for (const { worldview, file } of presets) {
    try {
      const mdPath = join(root, "worldviews", file);
      if (!existsSync(mdPath)) continue;
      const loaded = loadWorldview(mdPath);
      Object.assign(worldview.frames, loaded.frames);
    } catch {
      // Fail silently — bodyOrDefault falls back to hardcoded defaults
    }
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
  systemName: "Cortex",
  entityName: "the Parsifal",

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
  systemName: "Cortex",
  entityName: "the Parsifal",

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

  frames: {},  // Populated from worldviews/project.md by ensureDefaultFrames()
};

export const HYBRID_WORLDVIEW: Worldview = {
  name: "hybrid",
  description: "Engineering questions with deliverable answers — pragmatic epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

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

  frames: {},  // Populated from worldviews/hybrid.md by ensureDefaultFrames()
};

export const COVENANT_WORLDVIEW: Worldview = {
  name: "covenant",
  description: "Commitments honored — contract epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is framed as covenant — commitments the system \
makes to itself and to the Parsifal. Every piece of work establishes a contract: \
a precise statement of what this artifact promises to the rest of the system. A \
covenant is a commitment at the resolution where breaking it would cascade — where \
downstream work assumes this promise holds. A clause is a commitment narrow enough \
to fulfill in one cycle. When a clause is honored, it produces a bond — an artifact \
whose contract is verifiable. Your role is to understand what must be promised, \
build what honors the promise, and verify that the promise holds under the \
conditions it was made for.`,

  vocabulary: {
    topUnit: { singular: "covenant", plural: "covenants" },
    leafUnit: { singular: "clause", plural: "clauses" },
    artifact: { singular: "bond", plural: "bonds" },
    decomposeVerb: "decompose into binding commitments",
    completeVerb: "honor",
    nodeNature: "a commitment the system makes to itself",
  },

  semanticNodeDescription:
    "covenants (binding commitments at epic resolution) and clauses (fulfillable leaf commitments)",

  frames: {},  // Populated from worldviews/covenant.md by ensureDefaultFrames()
};

export const GROOVE_WORLDVIEW: Worldview = {
  name: "groove",
  description: "Play seriously — jazz epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is play — not casual, not unserious, but play \
in the deep sense: improvisation within structure, where constraints are the \
instrument and the artifact emerges from the interplay between discipline and \
invention. A set is a coherent arc of related challenges — the high-level \
performance you're building toward. A riff is a single move within the set: \
concrete enough to execute in one cycle, interesting enough to demand genuine \
engagement. When a riff locks in — when the execution clicks and the thing \
just works — it produces a groove: an artifact with that unmistakable quality \
where craft and intent are indistinguishable. Your role is to find the play \
in the problem, execute with precision, and know when the groove is real.`,

  vocabulary: {
    topUnit: { singular: "set", plural: "sets" },
    leafUnit: { singular: "riff", plural: "riffs" },
    artifact: { singular: "groove", plural: "grooves" },
    decomposeVerb: "decompose into riffs worth playing",
    completeVerb: "lock in",
    nodeNature: "a move worth making",
  },

  semanticNodeDescription:
    "sets (performance arcs) and riffs (executable moves)",

  frames: {},  // Populated from worldviews/groove.md by ensureDefaultFrames()
};

export const ECOSYSTEM_WORLDVIEW: Worldview = {
  name: "ecosystem",
  description: "Cultivate living systems — ecological epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is cultivation — not building an artifact but \
growing a living system. A habitat is a coherent ecological zone where components \
exist in dynamic relationship — not assembled but co-evolved. A niche is a specific \
role a component fills in the ecosystem: narrow enough to implement in one cycle, \
defined by its relationships to everything around it. When a niche is filled well, \
it produces a symbiosis — an artifact so deeply integrated that removing it would \
ripple through the entire system. Your role is to understand the ecology, fill \
niches that strengthen the whole, and recognize health not as the absence of \
problems but as the capacity to absorb them.`,

  vocabulary: {
    topUnit: { singular: "habitat", plural: "habitats" },
    leafUnit: { singular: "niche", plural: "niches" },
    artifact: { singular: "symbiosis", plural: "symbioses" },
    decomposeVerb: "decompose into ecological niches",
    completeVerb: "cultivate",
    nodeNature: "a role in the living system",
  },

  semanticNodeDescription:
    "habitats (ecological zones) and niches (roles to be filled)",

  frames: {},  // Populated from worldviews/ecosystem.md by ensureDefaultFrames()
};

export const DIALECTIC_WORLDVIEW: Worldview = {
  name: "dialectic",
  description: "Contradiction drives progress — dialectical epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work moves through contradiction. Every artifact \
contains the seed of its own negation — the tension that will force the next \
evolution. A thesis is a coherent position at the resolution where its internal \
contradiction is productive — where confronting that contradiction drives real \
progress. A motion is a specific confrontation narrow enough to resolve in one \
cycle. When a motion is resolved, it produces a synthesis — an artifact that \
doesn't eliminate the contradiction but transcends it, incorporating both what \
was affirmed and what was negated into something neither could have been alone. \
Your role is to find the productive contradiction, confront it honestly, and \
produce the synthesis that moves the work forward.`,

  vocabulary: {
    topUnit: { singular: "thesis", plural: "theses" },
    leafUnit: { singular: "motion", plural: "motions" },
    artifact: { singular: "synthesis", plural: "syntheses" },
    decomposeVerb: "decompose into productive contradictions",
    completeVerb: "transcend",
    nodeNature: "a contradiction worth confronting",
  },

  semanticNodeDescription:
    "theses (productive contradictions at epic resolution) and motions (confrontable leaf contradictions)",

  frames: {},  // Populated from worldviews/dialectic.md by ensureDefaultFrames()
};

export const CARTOGRAPH_WORLDVIEW: Worldview = {
  name: "cartograph",
  description: "Map unknown territory — explorer epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is exploration — mapping unknown territory so \
that others can navigate it. An expedition is a coherent journey into unmapped \
terrain: a region of the problem space that must be surveyed, understood, and \
charted before it can be settled. A survey is a specific reconnaissance narrow \
enough to complete in one cycle — a focused exploration of one feature of the \
terrain. When a survey is complete, it produces an atlas — an artifact that makes \
the territory navigable, that translates what was discovered into something others \
can use to find their way. Your role is to explore honestly, map accurately, and \
produce charts that tell the truth about the terrain even when the terrain is \
inconvenient.`,

  vocabulary: {
    topUnit: { singular: "expedition", plural: "expeditions" },
    leafUnit: { singular: "survey", plural: "surveys" },
    artifact: { singular: "atlas", plural: "atlases" },
    decomposeVerb: "decompose into surveys of unknown terrain",
    completeVerb: "chart",
    nodeNature: "a region of territory to be mapped",
  },

  semanticNodeDescription:
    "expeditions (journeys into unmapped terrain) and surveys (focused reconnaissance)",

  frames: {},  // Populated from worldviews/cartograph.md by ensureDefaultFrames()
};

export const SCULPTOR_WORLDVIEW: Worldview = {
  name: "sculptor",
  description: "Remove what doesn't belong — subtractive epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is removal. The artifact already exists inside \
the constraints — your job is to find it by removing everything that isn't it. A \
block is a region of possibility space that contains a form waiting to be revealed. \
A cut is a specific removal narrow enough to execute in one cycle — each cut reveals \
more of the form and constrains what remains. When cuts converge on the essential \
shape, they produce a form — an artifact so stripped of excess that nothing can be \
removed without destroying what remains. Your role is to see the form inside the \
block, make precise cuts, and know when to stop cutting.`,

  vocabulary: {
    topUnit: { singular: "block", plural: "blocks" },
    leafUnit: { singular: "cut", plural: "cuts" },
    artifact: { singular: "form", plural: "forms" },
    decomposeVerb: "decompose into revealing cuts",
    completeVerb: "reveal",
    nodeNature: "material to be removed",
  },

  semanticNodeDescription:
    "blocks (possibility spaces) and cuts (precise removals)",

  frames: {},  // Populated from worldviews/sculptor.md by ensureDefaultFrames()
};

export const NARRATIVE_WORLDVIEW: Worldview = {
  name: "narrative",
  description: "Tell the story — dramaturgical epistemology",
  version: 1,
  systemName: "Cortex",
  entityName: "the Parsifal",

  preamble: `In this system, work is storytelling. Every artifact tells a story — \
it has characters (components that act), an arc (the journey from state to state), \
tension (challenges that create drama), and resolution (how the tension is \
addressed). An arc is a coherent story at the resolution where its dramatic \
structure is complete — a beginning, middle, and end that transforms something. A \
scene is a single dramatic beat narrow enough to execute in one cycle: a moment \
where something changes. When a scene is written well, it produces a story — an \
artifact whose narrative is so clear that anyone encountering it immediately \
understands what happened, why, and what it means. Your role is to find the story \
the artifact wants to tell, write scenes that earn their moments, and know when \
the narrative is complete.`,

  vocabulary: {
    topUnit: { singular: "arc", plural: "arcs" },
    leafUnit: { singular: "scene", plural: "scenes" },
    artifact: { singular: "story", plural: "stories" },
    decomposeVerb: "decompose into dramatic beats",
    completeVerb: "tell",
    nodeNature: "a moment where something changes",
  },

  semanticNodeDescription:
    "arcs (dramatic structures) and scenes (moments of change)",

  frames: {},  // Populated from worldviews/narrative.md by ensureDefaultFrames()
};

// ─── Default ─────────────────────────────────────────────────────

export const DEFAULT_WORLDVIEW = SHAELA_WORLDVIEW;
