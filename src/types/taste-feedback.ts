/**
 * Taste Feedback Loop — PFC Feature #24.
 *
 * Turns Drift Monitor's taste divergence detection into a conversation
 * with the human. When demonstrated preferences (what actually scores well)
 * diverge from stated preferences (taste profile), the system proposes
 * updates — not as a settings dialog, but as a partner observation:
 * "I noticed something about your preferences worth discussing."
 *
 * The system earns the right to propose through maturity (low NE, high
 * prediction accuracy) and persistence (seeing the divergence across
 * multiple deep analyses). A brand-new system doesn't propose — it
 * barely knows the human.
 *
 * Consumers:
 *   - BetweenTasksSlowPath calls evaluate() at phase gates
 *   - Escalation Pathways (#23) routes proposals to human
 *   - Satisfaction Signal (#25) receives the human's response
 */

import type { TasteDivergenceItem, DriftAssessment } from "./drift-monitor.js";
import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { PlasticitySource } from "./world-model.js";
import type { SatisfactionResponse } from "./satisfaction-signal.js";

// ─── Config ─────────────────────────────────────────────────────

export interface TasteFeedbackConfig {
  /**
   * Minimum divergence strength (0–1) before even considering a proposal.
   * Below this, the divergence is noise — not worth surfacing.
   */
  minDivergenceStrength: number;
  /**
   * Minimum persistence — how many deep analyses must flag this
   * dimension before proposing. First sighting is noise. Second
   * is a pattern. Third is a conversation.
   */
  minPersistence: number;
  /** LLM model for framing proposals. */
  proposalModel: string;
  /**
   * Maximum pending proposals. Don't overwhelm the human —
   * surface the strongest divergences first.
   */
  maxPendingProposals: number;
}

export const DEFAULT_TASTE_FEEDBACK_CONFIG: TasteFeedbackConfig = {
  minDivergenceStrength: 0.3,
  minPersistence: 2,
  proposalModel: "claude-sonnet-4-6-20250514",
  maxPendingProposals: 3,
};

// ─── Sources ─────────────────────────────────────────────────────

/**
 * What the Taste Feedback Loop reads from. Typed as interfaces so
 * the loop depends on shapes, not implementations.
 */
export interface TasteFeedbackSources {
  /** Drift monitor — reads latest deep analysis with taste divergences. */
  driftMonitor: TasteFeedbackDriftSource;
  /** Taste profile — the stated preferences being compared against. */
  taste: TasteProfile;
  /** Project intent — for framing proposals in context. */
  intent: ProjectIntent;
  /** Plasticity — reads drift-monitor.threshold.sensitivity for threshold modulation. */
  plasticity?: PlasticitySource;
  /**
   * Current NE level (0–1). Proxy for system maturity when
   * cerebellum accuracy isn't available. High NE = immature.
   */
  neLevel?: number;
  /**
   * Cerebellum prediction accuracy (0–1). Direct maturity signal.
   * Preferred over neLevel when available.
   */
  cerebellumAccuracy?: number;
}

/** What the Taste Feedback Loop reads from the Drift Monitor. */
export interface TasteFeedbackDriftSource {
  getAssessment(): DriftAssessment;
}

// ─── Divergence Tracking ─────────────────────────────────────────

/**
 * Internal tracking for a taste dimension that has shown divergence.
 * Not exposed externally — the TasteFeedbackLoop manages these.
 */
export interface DivergenceRecord {
  /** The taste dimension (e.g. "visual", "decisionStyle"). */
  dimension: string;
  /** How many deep analyses have flagged this dimension. */
  persistence: number;
  /** Phase groups where this divergence appeared. */
  seenAt: string[];
  /** The strongest divergence strength observed. */
  peakStrength: number;
  /** The most recent divergence item. */
  latest: TasteDivergenceItem;
}

// ─── Proposals ──────────────────────────────────────────────────

export type ProposalStatus = "pending" | "responded" | "deferred" | "expired";

/**
 * A proposal to discuss a taste divergence with the human.
 *
 * This is NOT "should we change setting X?" — it's "I've noticed
 * something about your preferences that's worth discussing."
 * The interpretation frames the evidence as a partner observation.
 */
export interface TasteProposal {
  id: string;
  /** The divergence items that triggered this proposal. */
  divergences: TasteDivergenceItem[];
  /**
   * LLM-framed interpretation of the divergence evidence.
   * Explains what the data shows, what it might mean, and presents
   * the response options in human terms — not as a form, but as
   * a conversation.
   */
  interpretation: string;
  /** Which taste dimensions are involved. */
  dimensions: string[];
  /** How many deep analyses flagged these dimensions. */
  persistence: number;
  /**
   * Composite proposal strength (0–1).
   * divergence.strength × persistenceFactor × maturityFactor.
   * Higher = more confident the divergence is real and worth surfacing.
   */
  proposalStrength: number;
  /** Phase group that produced the triggering deep analysis. */
  phaseGroup: string;
  /** When this proposal was generated. */
  createdAt: Date;
  /** Current lifecycle status. */
  status: ProposalStatus;
  /** Human response, once received. */
  response?: SatisfactionResponse;
  /** Sense verification — did the relevant sense confirm the divergence? */
  senseVerification?: {
    senseId: string;
    senseName: string;
    agreement: number;
    assessment: string;
  };
}

// ─── State snapshot ──────────────────────────────────────────────

/** Serializable snapshot for dashboard/debugging. */
export interface TasteFeedbackState {
  /** Number of currently pending proposals. */
  pendingProposals: number;
  /** Total proposals generated across the project. */
  totalProposed: number;
  /** Total proposals that received a human response. */
  totalResponded: number;
  /** Tracked dimensions with active divergence. */
  trackedDimensions: number;
  /** Per-phase-group divergence history. */
  divergenceHistory: Array<{
    phaseGroup: string;
    divergenceCount: number;
    proposalsGenerated: number;
  }>;
}
