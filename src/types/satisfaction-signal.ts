/**
 * Satisfaction Signal — Human Partnership Feature #25.
 *
 * Human approval, correction, or override flows to plasticity weights.
 * This is Goodhart's law protection — the system can't just optimize
 * its own internal scores. External human signal anchors learning
 * to actual satisfaction, not metric gaming.
 *
 * The satisfaction signal is broader than taste: any human input that
 * indicates approval or disapproval flows through here. But the
 * primary initial consumer is the Taste Feedback Loop (#24), where
 * the human responds to taste divergence proposals.
 *
 * Each response type maps to specific plasticity operations:
 *   "update"   → taste profile mutated, routing weight DOWN (system was right to deviate)
 *   "keep"     → no profile change, routing weight UP (stated preference is intentional)
 *   "nuanced"  → taste profile mutated to new value, routing weight slight DOWN
 *   "deferred" → no changes, proposal stays pending
 *
 * Consumers:
 *   - TasteFeedbackLoop (#24) passes proposals + responses here
 *   - PlasticityStore receives weight deltas with source "satisfaction"
 *   - Thalamus receives taste profile mutations via updateProject()
 */

// ─── Taste Response Types ────────────────────────────────────────

/**
 * The four response types to a taste proposal.
 *
 * These aren't arbitrary categories — each has a distinct learning
 * contract with the plasticity system:
 *   update   — "you're right, I was wrong about what I wanted"
 *   keep     — "I know what I want, even if the scores disagree"
 *   nuanced  — "we both had part of it — here's what I actually mean"
 *   deferred — "let me think about it"
 */
export type TasteResponseType = "update" | "keep" | "nuanced" | "deferred";

/**
 * The human's response to a specific taste proposal.
 */
export interface SatisfactionResponse {
  /** Which proposal this responds to. */
  proposalId: string;
  /** Which of the four response types. */
  type: TasteResponseType;
  /**
   * Human's explanation or refinement.
   * Required for "nuanced" (must explain the new preference).
   * Optional for others (provides learning context).
   */
  detail?: string;
  /**
   * For "nuanced" responses: the new preference value the human
   * articulates. This is neither the stated nor the demonstrated —
   * it's the synthesis that emerged from the conversation.
   */
  newPreference?: string;
  /** When the response was received. */
  receivedAt: Date;
}

// ─── Broader Satisfaction Signals ────────────────────────────────

/**
 * What kind of human input this is.
 *   taste-response    — response to a taste proposal (Feature #24)
 *   task-approval     — human approves a task's output
 *   task-correction   — human corrects a task's output
 *   general-feedback  — human provides general preference signal
 */
export type SatisfactionKind =
  | "taste-response"
  | "task-approval"
  | "task-correction"
  | "general-feedback";

/**
 * A satisfaction signal from the human. The unified input type
 * for all human approval/correction/override signals.
 *
 * Shape varies by kind — taste-response carries a SatisfactionResponse,
 * task-approval carries task-level data. Only the relevant field is
 * populated for each kind.
 */
export interface SatisfactionSignal {
  id: string;
  /** What kind of human input this is. */
  kind: SatisfactionKind;
  /** For taste-response signals: the structured response. */
  tasteResponse?: SatisfactionResponse;
  /** For task-level signals: approval or correction data. */
  taskSignal?: TaskSatisfactionSignal;
  /** Raw human input text (always present for audit trail). */
  raw: string;
  /** When the signal was received. */
  receivedAt: Date;
}

/** Task-level approval or correction. */
export interface TaskSatisfactionSignal {
  /** Which task this applies to. */
  taskId: string;
  /** Whether the human approves the output. */
  approved: boolean;
  /** Human's notes on what was good or what needs correction. */
  notes?: string;
}

// ─── Plasticity Mapping ─────────────────────────────────────────

/**
 * The plasticity operations that result from a satisfaction signal.
 * Computed by processTasteResponse() or processSignal().
 *
 * This is the contract between Feature #25 and the PlasticityStore:
 * the Satisfaction Signal decides WHAT to change, the PlasticityStore
 * executes the changes.
 */
export interface PlasticityMapping {
  /**
   * Weight updates to apply via PlasticityStore.update().
   * Each carries the connectionId, delta, and human-readable context.
   * All use DeltaSource = "satisfaction".
   */
  updates: PlasticityUpdate[];
  /**
   * Taste profile mutation, if the response warrants one.
   * Only present for "update" and "nuanced" response types.
   * The caller is responsible for applying this to the TasteProfile
   * and propagating via Thalamus.updateProject().
   */
  tasteUpdate?: TasteUpdate;
}

/** A single plasticity weight update. */
export interface PlasticityUpdate {
  /** Which plastic connection to adjust. */
  connectionId: string;
  /** The delta to apply (positive or negative). */
  delta: number;
  /** Human-readable context for the audit trail. */
  context: string;
}

/** A taste profile dimension mutation. */
export interface TasteUpdate {
  /** Which dimension changed (e.g. "visual", "decisionStyle"). */
  dimension: string;
  /** The old value (for audit trail). */
  oldValue: string;
  /** The new value to set. */
  newValue: string;
}

// ─── Config ─────────────────────────────────────────────────────

export interface SatisfactionSignalConfig {
  /**
   * Base delta magnitude for satisfaction-driven weight changes.
   * Scaled by proposal strength — stronger divergences produce
   * larger weight adjustments when confirmed by the human.
   */
  baseDelta: number;
  /**
   * How much proposal strength amplifies the delta.
   * Final delta = baseDelta × (1 + strengthScaling × proposalStrength).
   */
  strengthScaling: number;
  /**
   * Delta for task-level approval/correction signals.
   * Smaller than taste signals — individual task feedback is
   * less informative than persistent divergence patterns.
   */
  taskDelta: number;
}

export const DEFAULT_SATISFACTION_CONFIG: SatisfactionSignalConfig = {
  baseDelta: 0.05,
  strengthScaling: 1.0,
  taskDelta: 0.02,
};
