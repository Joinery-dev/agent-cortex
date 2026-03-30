/**
 * Worldview Generation Pipeline — types.
 *
 * WorldviewSeed captures the six philosophical/relational commitments
 * that define a Parsifal's worldview. Discovery questions gather the
 * raw material; synthesis distills it into a seed; frame generation
 * grows the seed into a full worldview.
 */

import { z } from "zod";
import type { Term } from "../types/worldview.js";

// ─── Discovery ──────────────────────────────────────────────────

export interface DiscoveryQuestion {
  /** 1-indexed question number. */
  number: number;
  /** Which philosophical dimension this probes. */
  dimension: "ontology" | "epistemology" | "axiology" | "tension" | "learning" | "relationship" | "identity";
  /** The question text presented to the Parsifal. */
  question: string;
  /** Predefined options (null for open-ended). */
  options?: string[];
  /** Follow-up conditions keyed by trigger. */
  followUp?: {
    trigger: "short" | "conditional";
    /** For "conditional": a check function name or inline description. */
    condition?: string;
    question: string;
  };
}

export interface DiscoveryAnswer {
  /** 1-indexed question number. */
  number: number;
  dimension: DiscoveryQuestion["dimension"];
  /** The Parsifal's primary response. */
  response: string;
  /** Follow-up response, if the follow-up was triggered. */
  followUpResponse?: string;
}

// ─── Seed ───────────────────────────────────────────────────────

export interface WorldviewVocabulary {
  topUnit: Term;
  leafUnit: Term;
  artifact: Term;
  decomposeVerb: string;
  completeVerb: string;
  nodeNature: string;
}

export interface WorldviewSeed {
  /** What is the nature of work? */
  ontology: string;
  /** What counts as understanding? */
  epistemology: string;
  /** What is valued? What is "good"? */
  axiology: string;
  /** How contradiction is handled. */
  tensionPhilosophy: string;
  /** How experience changes the seer. */
  learningOrientation: string;
  /** System-human relationship. */
  collaborationModel: string;
  /** Vocabulary derived from ontology. */
  vocabulary?: WorldviewVocabulary;
}

// ─── Zod schemas for LLM structured output ──────────────────────

export const TermSchema = z.object({
  singular: z.string(),
  plural: z.string(),
});

export const WorldviewVocabularySchema = z.object({
  topUnit: TermSchema,
  leafUnit: TermSchema,
  artifact: TermSchema,
  decomposeVerb: z.string(),
  completeVerb: z.string(),
  nodeNature: z.string(),
});

export const WorldviewSeedSchema = z.object({
  ontology: z.string().describe("What is the nature of work?"),
  epistemology: z.string().describe("What counts as understanding?"),
  axiology: z.string().describe("What is valued? What is 'good'?"),
  tensionPhilosophy: z.string().describe("How contradiction is handled"),
  learningOrientation: z.string().describe("How experience changes the seer"),
  collaborationModel: z.string().describe("System-human relationship"),
  vocabulary: WorldviewVocabularySchema.optional().describe("Vocabulary derived from ontology"),
});

/** Frame generation output — all 21 frames keyed by name. */
export const FrameGenerationResultSchema = z.object({
  preamble: z.string().describe("Ontological preamble injected at start of every system prompt"),
  frames: z.object({
    consultation: z.string(),
    evaluation: z.string(),
    building: z.string(),
    planning: z.string(),
    decomposition: z.string(),
    pathReasoning: z.string(),
    resolution: z.string(),
    learning: z.string(),
    reflection: z.string(),
    coherence: z.string(),
    feasibility: z.string(),
    navigation: z.string(),
    simulation: z.string(),
    relevance: z.string(),
    partnership: z.string(),
    wiring: z.string(),
    integration: z.string(),
    manifestation: z.string(),
    inquiry: z.string(),
    prospective: z.string(),
    emergence: z.string(),
  }),
  semanticNodeDescription: z.string().describe("How semantic mapping prompts describe nodes"),
});

export type FrameGenerationResult = z.infer<typeof FrameGenerationResultSchema>;
