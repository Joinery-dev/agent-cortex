/**
 * Hippocampal Simulation — constructive episodic simulation.
 *
 * The hippocampus's 3rd capability (alongside recording + potentiation).
 * Recombines crystallized principles + episodes + world model maxims
 * to construct hypothetical future failure scenarios.
 *
 * Triggered by:
 *   - Crystallization fires (new principle extracted)
 *   - High-relevance observation (relevance > 0.8)
 *   - Phase gate boundary
 *   - High-NE rest cycle
 */

// ─── Simulated Scenarios ────────────────────────────────────────

/** A hypothetical future failure scenario constructed by the hippocampus. */
export interface SimulatedScenario {
  id: string;
  /** Narrative description of the anticipated failure. */
  narrative: string;
  /** Which remaining tasks in the graph could be affected. */
  affectedTaskIds: string[];
  /** What principles, episodes, maxims, and observations ground this simulation. */
  grounding: SimulationGrounding;
  /** Estimated impact if scenario materializes (0-1). */
  impact: number;
  /** Confidence in the simulation's validity (0-1). */
  confidence: number;
  /** What the simulation suggests should happen. Suggestion only — PFC decides. */
  suggestedResponse: string;
  /** When this simulation was constructed. */
  simulatedAt: Date;
  /** Processing status. */
  status: "new" | "synthesized" | "dismissed" | "materialized";
}

export interface SimulationGrounding {
  /** Crystallized principle IDs that informed this simulation. */
  principleIds: string[];
  /** Episode IDs that provided analogical reasoning. */
  episodeIds: string[];
  /** World model maxim statements that shaped the scenario. */
  maximStatements: string[];
  /** Territory observation IDs that triggered or informed this simulation. */
  observationIds: string[];
}

// ─── Triggers ───────────────────────────────────────────────────

/** What triggers a simulation cycle. */
export type SimulationTrigger =
  | { type: "crystallization"; principleId: string }
  | { type: "high-relevance-observation"; observationId: string }
  | { type: "phase-gate"; phaseGroup: string }
  | { type: "rest-cycle" };

// ─── Accuracy Tracking ──────────────────────────────────────────

/** Tracks whether a simulated scenario materialized. */
export interface SimulationAccuracyRecord {
  scenarioId: string;
  /** Did the simulation predict a problem? (always true — only tracked for fired simulations) */
  predicted: boolean;
  /** Did the problem actually materialize? */
  materialized: boolean;
  /** Absolute difference between predicted and actual impact. */
  impactError: number;
  recordedAt: Date;
}

// ─── Configuration ──────────────────────────────────────────────

export interface SimulationConfig {
  /** Maximum scenarios stored in memory. Oldest dismissed/synthesized pruned first. */
  maxScenarios: number;
  /** Minimum confidence threshold for keeping a scenario. */
  minConfidence: number;
  /** Maximum tokens for simulation LLM calls. */
  maxTokens: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  maxScenarios: 20,
  minConfidence: 0.3,
  maxTokens: 4096,
};

// ─── LLM Output Shape ──────────────────────────────────────────

/** What the LLM returns from a simulation call. */
export interface SimulationLLMResult {
  scenarios: Array<{
    narrative: string;
    affectedTaskIds: string[];
    impact: number;
    confidence: number;
    suggestedResponse: string;
    groundingPrinciples: string[];
    groundingEpisodes: string[];
    groundingMaxims: string[];
  }>;
  reasoning: string;
}
