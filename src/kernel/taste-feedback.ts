/**
 * Taste Feedback Loop — PFC Feature #24.
 *
 * Turns Drift Monitor's taste divergence detection into a conversation
 * with the Parsifal. Evaluated at phase gates (between-tasks slow path)
 * after deep analysis runs.
 *
 * Cortex earns the right to propose through:
 *   - Maturity (low NE, high prediction accuracy)
 *   - Persistence (seeing the divergence across multiple deep analyses)
 *   - Strength (the divergence signal is not noise)
 *
 * A brand-new Cortex doesn't propose. It barely knows the Parsifal.
 *
 * Stateful: tracks divergence history across deep analyses and manages
 * pending proposals. Methods receive sources per call (same pattern as
 * DriftMonitor and WorldModel).
 */

import { z } from "zod";
import type {
  TasteFeedbackConfig,
  TasteFeedbackSources,
  TasteFeedbackState,
  TasteProposal,
  DivergenceRecord,
} from "../types/taste-feedback.js";
import { DEFAULT_TASTE_FEEDBACK_CONFIG } from "../types/taste-feedback.js";
import type { TasteDivergenceItem } from "../types/drift-monitor.js";
import type { SatisfactionResponse } from "../types/satisfaction-signal.js";
import type { PlasticitySource } from "../types/world-model.js";
import type { TasteProposalInputs } from "../llm/prompts.js";
import { tasteProposalSystem, tasteProposalUser, tasteVerificationSystem, tasteVerificationUser } from "../llm/prompts.js";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { verifySense, resolveSenseByName } from "../senses/sense-verification.js";

const log = createLogger("taste-feedback");

// ─── Zod schema for LLM proposal framing ────────────────────────

const ProposalFramingSchema = z.object({
  interpretation: z.string(),
  confidence: z.number().min(0).max(1),
});

// ─── Helpers ─────────────────────────────────────────────────────

let proposalCounter = 0;
function nextProposalId(): string {
  return `taste-proposal-${++proposalCounter}`;
}

/**
 * Persistence factor: how much to trust a divergence based on
 * how many deep analyses have flagged it.
 *   1 sighting  → 0.5 (noise?)
 *   2 sightings → 0.75 (pattern forming)
 *   3+ sightings → 1.0 (confirmed pattern)
 */
function persistenceFactor(persistence: number): number {
  if (persistence <= 1) return 0.5;
  if (persistence === 2) return 0.75;
  return 1.0;
}

/**
 * Maturity factor: how credible is Cortex's observation?
 *
 * Uses cerebellum accuracy directly if available (most precise).
 * Falls back to inverting NE level (high NE = immature = low maturity).
 * Default 0.5 when neither is available.
 */
function maturityFactor(
  cerebellumAccuracy?: number,
  neLevel?: number,
): number {
  if (cerebellumAccuracy !== undefined) return cerebellumAccuracy;
  if (neLevel !== undefined) return 1 - neLevel;
  return 0.5;
}

/** Read drift-monitor.threshold.sensitivity from plasticity. */
function readSensitivity(plasticity?: PlasticitySource): number {
  if (!plasticity) return 0.5;
  const thresholds = plasticity.getByCategory("threshold");
  const weight = thresholds.find(
    (w) => w.connectionId === "drift-monitor.threshold.sensitivity",
  );
  return weight?.value ?? 0.5;
}

// ─── TasteFeedbackLoop ──────────────────────────────────────────

/**
 * Maps taste profile dimensions to the sense best positioned to verify
 * divergences in that dimension. The sense evaluates the work — it
 * knows whether the stated preference actually produces good results.
 */
const TASTE_DIMENSION_TO_SENSE: Record<string, string> = {
  visual: "Design",
  decisionStyle: "Intent Alignment",
  communication: "Developer Experience",
  patterns: "Maintainability",
};

export class TasteFeedbackLoop {
  private config: TasteFeedbackConfig;
  private library: SensoryCortex | null = null;

  /** Per-dimension divergence tracking across deep analyses. */
  private divergenceHistory = new Map<string, DivergenceRecord>();

  /** Proposals awaiting Parsifal response. */
  private pendingProposals = new Map<string, TasteProposal>();

  /** All proposals ever generated (for state/dashboard). */
  private allProposals: TasteProposal[] = [];

  /** Per-phase-group divergence counts (for state/dashboard). */
  private phaseHistory: Array<{
    phaseGroup: string;
    divergenceCount: number;
    proposalsGenerated: number;
  }> = [];

  constructor(config?: Partial<TasteFeedbackConfig>) {
    this.config = { ...DEFAULT_TASTE_FEEDBACK_CONFIG, ...config };
  }

  /**
   * Set the sense library for taste divergence verification.
   * Called by Brainstem after construction.
   */
  setLibrary(library: SensoryCortex): void {
    this.library = library;
  }

  // ── Core: Evaluate divergences at phase gate ───────────────────

  /**
   * Evaluate taste divergences from the latest deep analysis.
   * Called during between-tasks slow path after driftMonitor.deepAnalysis().
   *
   * Returns proposals for divergences that are strong enough, persistent
   * enough, and Cortex is mature enough to surface. May return empty.
   */
  async evaluate(
    sources: TasteFeedbackSources,
    phaseGroup: string,
  ): Promise<TasteProposal[]> {
    const assessment = sources.driftMonitor.getAssessment();
    const deepAnalysis = assessment.deepAnalysis;

    // No deep analysis yet, or no taste divergence detected
    if (!deepAnalysis || !deepAnalysis.tasteDivergence.detected) {
      log.debug("No taste divergence to evaluate", { phaseGroup });
      this.phaseHistory.push({
        phaseGroup,
        divergenceCount: 0,
        proposalsGenerated: 0,
      });
      return [];
    }

    const divergences = deepAnalysis.tasteDivergence.divergences;
    log.info("Evaluating taste divergences", {
      phaseGroup,
      divergenceCount: divergences.length,
    });

    // Update divergence history
    this.updateDivergenceHistory(divergences, phaseGroup);

    // Compute proposal strength for each tracked dimension
    const maturity = maturityFactor(
      sources.cerebellumAccuracy,
      sources.neLevel,
    );
    const sensitivity = readSensitivity(sources.plasticity);

    const candidates: Array<{
      record: DivergenceRecord;
      strength: number;
      senseVerification?: TasteProposal["senseVerification"];
    }> = [];

    for (const record of this.divergenceHistory.values()) {
      const rawStrength =
        record.peakStrength *
        persistenceFactor(record.persistence) *
        maturity;

      // Sensitivity modulates the effective threshold, not the strength.
      // Higher sensitivity = lower effective threshold = easier to propose.
      const effectiveThreshold =
        this.config.minDivergenceStrength * (1 - (sensitivity - 0.5));

      if (
        rawStrength >= effectiveThreshold &&
        record.persistence >= this.config.minPersistence
      ) {
        candidates.push({ record, strength: rawStrength });
      }
    }

    // Respect max pending proposals
    const available =
      this.config.maxPendingProposals - this.pendingProposals.size;
    if (available <= 0) {
      log.debug("Max pending proposals reached, skipping", {
        pending: this.pendingProposals.size,
        max: this.config.maxPendingProposals,
      });
      this.phaseHistory.push({
        phaseGroup,
        divergenceCount: divergences.length,
        proposalsGenerated: 0,
      });
      return [];
    }

    // Sort by strength descending, take up to available slots
    candidates.sort((a, b) => b.strength - a.strength);

    // Verify each candidate with its relevant sense before proposing.
    // Modulates strength by the sense's agreement — if the sense
    // doesn't see the divergence, the candidate weakens or drops.
    for (const candidate of candidates) {
      const verification = await this.verifyCandidateWithSense(
        candidate.record,
        sources,
      );
      if (verification) {
        candidate.strength *= verification.result.agreement;
        candidate.senseVerification = {
          senseId: verification.senseId,
          senseName: verification.senseName,
          agreement: verification.result.agreement,
          assessment: verification.result.assessment,
        };
      }
    }

    // Re-filter after verification — candidates whose strength dropped
    // below the effective threshold get removed.
    const verifiedCandidates = candidates.filter((c) => {
      const adjustedSensitivity = readSensitivity(sources.plasticity);
      const effectiveThreshold =
        this.config.minDivergenceStrength * (1 - (adjustedSensitivity - 0.5));
      return c.strength >= effectiveThreshold;
    });

    const toPropose = verifiedCandidates.slice(0, available);

    if (toPropose.length === 0) {
      log.debug("No divergences strong/persistent enough to propose", {
        phaseGroup,
        tracked: this.divergenceHistory.size,
        maturity,
      });
      this.phaseHistory.push({
        phaseGroup,
        divergenceCount: divergences.length,
        proposalsGenerated: 0,
      });
      return [];
    }

    // Frame proposals via LLM
    const proposals: TasteProposal[] = [];

    for (const candidate of toPropose) {
      const proposal = await this.frameProposal(
        candidate.record,
        candidate.strength,
        sources,
        phaseGroup,
      );

      if (proposal) {
        // Attach sense verification if available
        if (candidate.senseVerification) {
          proposal.senseVerification = candidate.senseVerification;
        }
        this.pendingProposals.set(proposal.id, proposal);
        this.allProposals.push(proposal);
        proposals.push(proposal);

        emit("taste-feedback:proposal", {
          proposalId: proposal.id,
          dimensions: proposal.dimensions,
          proposalStrength: proposal.proposalStrength,
          persistence: proposal.persistence,
          phaseGroup,
        });
      }
    }

    this.phaseHistory.push({
      phaseGroup,
      divergenceCount: divergences.length,
      proposalsGenerated: proposals.length,
    });

    log.info("Taste feedback evaluation complete", {
      phaseGroup,
      divergenceCount: divergences.length,
      proposalsGenerated: proposals.length,
      pendingTotal: this.pendingProposals.size,
    });

    return proposals;
  }

  // ── Response handling ──────────────────────────────────────────

  /**
   * Record a Parsifal response to a pending proposal.
   * Returns the proposal (with response attached) or null if not found.
   *
   * The caller is responsible for processing the response via
   * processTasteResponse() from satisfaction-signal.ts.
   */
  receiveResponse(response: SatisfactionResponse): TasteProposal | null {
    const proposal = this.pendingProposals.get(response.proposalId);
    if (!proposal) {
      log.warn("Response for unknown proposal", {
        proposalId: response.proposalId,
      });
      return null;
    }

    proposal.response = response;
    proposal.status =
      response.type === "deferred" ? "deferred" : "responded";

    if (response.type !== "deferred") {
      this.pendingProposals.delete(response.proposalId);
    }

    emit("taste-feedback:response-received", {
      proposalId: response.proposalId,
      responseType: response.type,
    });

    log.info("Proposal response received", {
      proposalId: response.proposalId,
      responseType: response.type,
    });

    return proposal;
  }

  // ── Accessors ─────────────────────────────────────────────────

  getPendingProposals(): TasteProposal[] {
    return [...this.pendingProposals.values()];
  }

  getDivergenceHistory(): DivergenceRecord[] {
    return [...this.divergenceHistory.values()];
  }

  /**
   * Expire proposals older than maxAgeMs. Returns expired count.
   * Call during rest cycles or at project completion.
   */
  expireOldProposals(maxAgeMs: number): number {
    const now = Date.now();
    let expired = 0;

    for (const [id, proposal] of this.pendingProposals) {
      if (now - proposal.createdAt.getTime() >= maxAgeMs) {
        proposal.status = "expired";
        this.pendingProposals.delete(id);
        expired++;

        emit("taste-feedback:expired", { proposalId: id });
      }
    }

    if (expired > 0) {
      log.info("Expired old proposals", { expired });
    }

    return expired;
  }

  /** Dashboard/debugging snapshot. */
  getState(): TasteFeedbackState {
    return {
      pendingProposals: this.pendingProposals.size,
      totalProposed: this.allProposals.length,
      totalResponded: this.allProposals.filter(
        (p) => p.status === "responded",
      ).length,
      trackedDimensions: this.divergenceHistory.size,
      divergenceHistory: [...this.phaseHistory],
    };
  }

  // ── Private: Divergence history tracking ───────────────────────

  private updateDivergenceHistory(
    divergences: TasteDivergenceItem[],
    phaseGroup: string,
  ): void {
    for (const div of divergences) {
      const existing = this.divergenceHistory.get(div.dimension);
      if (existing) {
        // Seen before — increment persistence, update peak
        existing.persistence++;
        existing.seenAt.push(phaseGroup);
        existing.peakStrength = Math.max(
          existing.peakStrength,
          div.strength,
        );
        existing.latest = div;
      } else {
        // First sighting — start tracking
        this.divergenceHistory.set(div.dimension, {
          dimension: div.dimension,
          persistence: 1,
          seenAt: [phaseGroup],
          peakStrength: div.strength,
          latest: div,
        });
      }
    }
  }

  // ── Private: LLM proposal framing ─────────────────────────────

  /**
   * Use the LLM to frame a divergence as an evidence-based observation.
   * Returns null on failure (graceful degradation).
   */
  private async frameProposal(
    record: DivergenceRecord,
    proposalStrength: number,
    sources: TasteFeedbackSources,
    phaseGroup: string,
  ): Promise<TasteProposal | null> {
    const inputs: TasteProposalInputs = {
      divergences: [record.latest],
      taste: sources.taste,
      intentSummary: sources.intent.summary,
      persistence: record.persistence,
    };

    try {
      const framing = await callStructured<{
        interpretation: string;
        confidence: number;
      }>(
        "taste-proposal",
        this.config.proposalModel,
        tasteProposalSystem(),
        tasteProposalUser(inputs),
        ProposalFramingSchema,
      );

      return {
        id: nextProposalId(),
        divergences: [record.latest],
        interpretation: framing.interpretation,
        dimensions: [record.dimension],
        persistence: record.persistence,
        proposalStrength,
        phaseGroup,
        createdAt: new Date(),
        status: "pending",
      };
    } catch (err) {
      log.warn("Failed to frame taste proposal — skipping", {
        dimension: record.dimension,
        error: String(err),
      });
      return null;
    }
  }

  // ── Private: Sense verification ────────────────────────────────

  /**
   * Verify a divergence candidate with its mapped sense.
   * Maps the divergence dimension → sense via TASTE_DIMENSION_TO_SENSE,
   * then asks the sense if the divergence is real.
   *
   * Returns null if no library, no mapping, or the call fails.
   */
  private async verifyCandidateWithSense(
    record: DivergenceRecord,
    sources: TasteFeedbackSources,
  ): Promise<{
    senseId: string;
    senseName: string;
    result: import("../senses/sense-verification.js").SenseVerificationResult;
  } | null> {
    if (!this.library) return null;

    const senseName = TASTE_DIMENSION_TO_SENSE[record.dimension];
    if (!senseName) return null;

    const sense = resolveSenseByName(this.library, senseName);
    if (!sense) return null;

    // Build recent scores for this sense from the drift monitor's assessment
    const recentScores: Array<{
      taskDescription: string;
      score: number;
      acceptable: boolean;
    }> = [];
    // We don't have per-task scores readily available here, so pass empty.
    // The sense still has its own perspective to draw from.

    const result = await verifySense(
      "taste-verification",
      this.config.proposalModel,
      sense,
      tasteVerificationSystem(sense),
      tasteVerificationUser(
        {
          dimension: record.dimension,
          stated: record.latest.stated,
          demonstrated: record.latest.demonstrated,
          strength: record.latest.strength,
        },
        recentScores,
      ),
    );

    if (!result) return null;

    log.debug("Taste candidate verified with sense", {
      dimension: record.dimension,
      senseName: sense.name,
      agreement: result.agreement.toFixed(3),
    });

    return {
      senseId: sense.id,
      senseName: sense.name,
      result,
    };
  }
}
