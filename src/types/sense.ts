export type SenseLevel = "sense" | "pathway" | "receptor";

/** Minimum observation capability a sense needs for meaningful evaluation. */
export type ObservationLevel = "file-only" | "analysis" | "runtime";

export interface Sense {
  id: string;
  name: string;
  level: SenseLevel;
  sensitivity: string;
  parentId?: string;
  children?: string[];
  activationHint: string;
  /** Minimum observation level for meaningful evaluation. If not met, skip rather than produce a meaningless score. */
  minimumObservation?: ObservationLevel;
}

export interface SensePerspective {
  senseId: string;
  senseName: string;
  perspective: string;
  evaluators: string[]; // receptor IDs that should evaluate the work
  /** Self-assessed relevance to this task (0–1). How much would be lost if this sense had no input? */
  stake: number;
  /** Theoretical max score (1–10) for this dimension on this task. What does physics allow? */
  ceiling: number;
  /** Why the ceiling is what it is — the inherent constraints that cap what's achievable. */
  ceilingRationale: string;
}

/** How much improvement is achievable by re-consulting the parent sense. */
export interface ImprovementPotential {
  /** Categorical magnitude of potential improvement from re-consultation. */
  level: "significant" | "moderate" | "marginal" | "none";
  /** What specifically would improve and why. */
  description?: string;
}

export interface SenseEvaluation {
  senseId: string;
  activationPath: string[];
  score: number;
  /** The sense's own judgment: is this work adequate from its perspective? Not derived from score. */
  acceptable: boolean;
  assessment: string;
  tensions: TensionFlag[];
  suggestions: string[];
  /** Would re-engaging this sense's consultation meaningfully improve the work? */
  improvementPotential: ImprovementPotential;
  /** Structured observations from agentic evaluation — what the evaluator actually saw/measured. */
  observations?: EvaluatorObservation[];
  /** Present when this evaluation was produced by a fallback path, not genuine assessment.
   *  Downstream consumers (cerebellum, conviction) must check this before trusting the score. */
  degraded?: {
    reason: string;
    source: "agentic-parse-failure" | "sandbox-unavailable" | "runtime-unavailable" | "llm-failure";
  };
}

export interface TensionFlag {
  withDimension: string;
  description: string;
}

// ── Evaluator Observations ───────────────────────────────────────
// Structured records of what an agentic evaluator perceived before
// scoring. Observations are evidence — verifiable facts that ground
// the assessment. They feed into revision prompts for actionable feedback.

export interface EvaluatorObservation {
  /** What kind of observation this is. */
  kind: "file-read" | "search-result" | "lint-output" | "test-output" | "runtime-check" | "other";
  /** What was examined (file path, search query, command, URL). */
  target: string;
  /** What was found — the raw evidence. */
  finding: string;
  /** Evaluator's interpretation of this observation for its dimension. */
  interpretation: string;
}
