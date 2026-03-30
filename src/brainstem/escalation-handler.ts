/**
 * Escalation Handler — wiring between escalation sources and the runner.
 *
 * This is NOT a brain region — it's integration glue. The Thalamus assembles
 * context, the runner pauses/resumes, WM tracks questions. This handler
 * connects them:
 *
 *   1. createEscalation() → build Escalation record, add question to WM,
 *      assemble briefing via Thalamus, emit "escalation:created"
 *   2. resolve() → resolve WM questions, call runner.resume(),
 *      emit "escalation:resolved"
 *   3. getActive() / getBriefing() → dashboard/API access
 */

import type {
  Escalation,
  EscalationSource,
  EscalationResolution,
  EscalationDeliveryAdapter,
} from "../types/brainstem.js";
import type { EscalationBriefing } from "../types/thalamus.js";
import type { ScoreTrend } from "../types/working-memory.js";
import type { RhythmPhase } from "../types/rhythm.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { WorkingMemory } from "../kernel/working-memory.js";
import type { RhythmRunnerImpl } from "./runner.js";
import type { SensoryCortex } from "../senses/cortex.js";
import type { Sense } from "../types/sense.js";
import {
  verifyWithSenses,
} from "../senses/sense-verification.js";
import {
  escalationSenseAssessmentSystem,
  escalationSenseAssessmentUser,
} from "../llm/prompts.js";
import { newId } from "../util/ids.js";
import { emit } from "../events.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("escalation-handler");

export class EscalationHandler {
  private thalamus: Thalamus;
  private wm: WorkingMemory;
  private runner: RhythmRunnerImpl;
  private library: SensoryCortex | null = null;
  private model: string | null = null;
  private deliveryAdapter: EscalationDeliveryAdapter | null = null;
  private active = new Map<
    string,
    { escalation: Escalation; briefing: EscalationBriefing; wmQuestionId?: string }
  >();

  constructor(thalamus: Thalamus, wm: WorkingMemory, runner: RhythmRunnerImpl) {
    this.thalamus = thalamus;
    this.wm = wm;
    this.runner = runner;
  }

  /**
   * Set the sense library and model for escalation sense assessments.
   * Called by Brainstem after construction.
   */
  setLibraryAndModel(library: SensoryCortex, model: string): void {
    this.library = library;
    this.model = model;
  }

  /**
   * Set a delivery adapter for active escalation transport.
   * Without an adapter, escalations are passive — external code must
   * listen to "escalation:created" events and call resolve() manually.
   */
  setDeliveryAdapter(adapter: EscalationDeliveryAdapter): void {
    this.deliveryAdapter = adapter;
  }

  /**
   * Create an escalation, assemble its briefing, and store it.
   * Called by rhythm code when it decides to pause for Parsifal input.
   */
  async createEscalation(params: {
    source: EscalationSource;
    rhythmId: string;
    severity: Escalation["severity"];
    summary: string;
    detail: string;
    question?: string;
    proposedActions?: string[];
    rhythmState: {
      id: string;
      rhythmType: string;
      phase: RhythmPhase;
      completedCycles: number;
      parentRhythmType?: string;
    };
  }): Promise<Escalation> {
    const escalation: Escalation = {
      id: newId(),
      source: params.source,
      rhythmId: params.rhythmId,
      severity: params.severity,
      summary: params.summary,
      detail: params.detail,
      question: params.question,
      proposedActions: params.proposedActions,
      createdAt: new Date(),
    };

    // Add question to WM so it shows up in open questions
    let wmQuestionId: string | undefined;
    if (params.question) {
      const q = this.wm.addQuestion(
        params.question,
        `Escalation from ${params.source}: ${params.summary}`,
      );
      wmQuestionId = q.id;
    }

    // Assemble Parsifal-facing briefing via Thalamus
    const briefing = await this.thalamus.forEscalation(
      escalation,
      params.rhythmState,
    );

    // Gather per-sense assessments if library is available
    const senseAssessments = await this.gatherSenseAssessments(
      escalation,
      briefing.projectSnapshot,
    );
    if (senseAssessments.length > 0) {
      briefing.projectSnapshot.senseAssessments = senseAssessments;
    }

    this.active.set(escalation.id, { escalation, briefing, wmQuestionId });

    emit("escalation:created", {
      id: escalation.id,
      source: escalation.source,
      severity: escalation.severity,
      summary: escalation.summary,
      rhythmId: escalation.rhythmId,
      question: escalation.question,
    });

    log.info("Escalation created", {
      id: escalation.id,
      source: escalation.source,
      severity: escalation.severity,
    });

    // If a delivery adapter is set, attempt active delivery.
    // Fire-and-forget: the runner is already entering its pause await,
    // so the adapter delivers asynchronously and auto-resolves when
    // the Parsifal responds.
    if (this.deliveryAdapter) {
      this.deliveryAdapter.deliver(escalation, briefing).then((resolution) => {
        if (resolution) {
          this.resolve(escalation.id, resolution);
        }
      }).catch((err) => {
        log.warn("Delivery adapter failed — escalation remains active for manual resolution", {
          escalationId: escalation.id,
          error: String(err),
        });
      });
    }

    return escalation;
  }

  /**
   * Resolve an escalation with the Parsifal's response.
   * Resolves questions in WM, then resumes the paused rhythm.
   */
  resolve(escalationId: string, resolution: EscalationResolution): void {
    const entry = this.active.get(escalationId);
    if (!entry) {
      log.warn(`Unknown escalation ${escalationId}`);
      return;
    }

    const { escalation, wmQuestionId } = entry;

    // Mark escalation resolved
    escalation.resolvedAt = resolution.resolvedAt;
    escalation.resolution = resolution.answer;

    // Resolve questions in WM
    if (resolution.resolvedQuestionIds) {
      for (const qId of resolution.resolvedQuestionIds) {
        this.wm.resolveQuestion(qId, resolution.answer);
      }
    } else if (wmQuestionId) {
      // Auto-resolve the question we created
      this.wm.resolveQuestion(wmQuestionId, resolution.answer);
    }

    // Resume the paused rhythm
    this.runner.resume(escalation.rhythmId, resolution);

    this.active.delete(escalationId);

    emit("escalation:resolved", {
      id: escalationId,
      source: escalation.source,
      rhythmId: escalation.rhythmId,
      answer: resolution.answer.slice(0, 200),
    });

    log.info("Escalation resolved", {
      id: escalationId,
      rhythmId: escalation.rhythmId,
    });
  }

  /** Get all active (unresolved) escalations. */
  getActive(): Escalation[] {
    return [...this.active.values()].map((e) => e.escalation);
  }

  /** Get the full briefing for a specific escalation. */
  getBriefing(escalationId: string): EscalationBriefing | null {
    return this.active.get(escalationId)?.briefing ?? null;
  }

  // ── Private: Sense assessments ─────────────────────────────

  /**
   * Gather per-sense assessments for an escalation.
   * Selects senses with non-flat trends (capped at 4), asks each
   * for their perspective on the escalation in parallel.
   */
  private async gatherSenseAssessments(
    escalation: Escalation,
    projectSnapshot: import("../types/thalamus.js").EscalationProjectSnapshot,
  ): Promise<Array<{
    senseId: string;
    senseName: string;
    assessment: string;
    recentTrend: ScoreTrend | null;
  }>> {
    if (!this.library || !this.model) return [];

    // Select senses with non-flat trends, capped at 4
    const senseTrends = projectSnapshot.senseTrends.filter(
      (t) => t.level === "sense" && t.direction !== "stable",
    );
    if (senseTrends.length === 0) return [];

    const trendsBySense = new Map<string, ScoreTrend>();
    const sensesToConsult: Sense[] = [];

    for (const trend of senseTrends.slice(0, 4)) {
      const sense = this.library.getSenses().find(
        (s) => s.name === trend.label || s.id === trend.id,
      );
      if (sense) {
        sensesToConsult.push(sense);
        trendsBySense.set(sense.id, trend);
      }
    }

    if (sensesToConsult.length === 0) return [];

    const intentSummary = projectSnapshot.intentSummary;

    const results = await verifyWithSenses(
      "escalation-assessment",
      this.model,
      sensesToConsult,
      (sense) => {
        const trend = trendsBySense.get(sense.id);
        return {
          system: escalationSenseAssessmentSystem(sense),
          user: escalationSenseAssessmentUser(
            {
              summary: escalation.summary,
              detail: escalation.detail,
              source: escalation.source,
            },
            trend
              ? {
                  direction: trend.direction,
                  currentMean: trend.currentMean,
                  previousMean: trend.previousMean,
                }
              : null,
            intentSummary,
          ),
        };
      },
    );

    const assessments: Array<{
      senseId: string;
      senseName: string;
      assessment: string;
      recentTrend: ScoreTrend | null;
    }> = [];

    for (const [senseId, result] of results) {
      const sense = sensesToConsult.find((s) => s.id === senseId);
      assessments.push({
        senseId,
        senseName: sense?.name ?? senseId,
        assessment: result.assessment,
        recentTrend: trendsBySense.get(senseId) ?? null,
      });
    }

    log.info("Gathered sense assessments for escalation", {
      escalationId: escalation.id,
      sensesConsulted: assessments.length,
    });

    return assessments;
  }
}
