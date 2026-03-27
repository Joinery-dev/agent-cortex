import type { SensePerspective } from "./sense.js";

/**
 * The Consultation — produced when the council of active senses
 * weighs in on a task. The system's situational awareness document:
 * what matters, how much, and who will judge the result.
 */
export interface Consultation {
  taskId: string;
  producedAt: Date;

  /** Individual sense perspectives — the raw intelligence. */
  perspectives: SensePerspective[];

  /**
   * Which receptors will judge the work, with their parent sense
   * relationship made explicit. Derived from perspectives at
   * construction time so consumers don't re-derive it.
   */
  evaluationPlan: EvaluationPlanEntry[];

  /**
   * How relevance is distributed across senses for this task.
   * Computed once from stakes, consumed by weighter and gate.
   */
  stakeDistribution: StakeDistribution;

  /**
   * System state when this consultation was produced.
   * Who participated, who was inhibited, what modulation was active.
   */
  conditions: ConsultationConditions;

  /** Which outer cycle produced this consultation. 0 = initial, 1+ = re-consultation. */
  generation: number;

  /** Sense IDs whose perspectives were preserved from a previous generation (not re-consulted). */
  preservedSenseIds?: string[];
}

export interface EvaluationPlanEntry {
  receptorId: string;
  parentSenseId: string;
  parentSenseName: string;
  parentStake: number;
  /** The parent sense's perspective — context for the evaluator. */
  parentPerspective: string;
}

export interface StakeDistribution {
  entries: { senseId: string; senseName: string; stake: number }[];
  totalStake: number;
  meanStake: number;
  max: { senseId: string; senseName: string; stake: number };
}

export interface ConsultationConditions {
  neLevel?: number;
  mode?: "explore" | "leverage";
  activeSenses: { senseId: string; senseName: string }[];
  inhibitedSenses: { senseId: string; reason: string }[];
}
