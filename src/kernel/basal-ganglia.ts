/**
 * Basal Ganglia — action selection through tonic inhibition.
 *
 * The BG's default state is tonic inhibition of all senses. Selection
 * happens by selectively disinhibiting relevant ones (direct pathway)
 * while maintaining suppression of competitors (indirect pathway).
 *
 * Two capabilities:
 *   1. suppress()       — the hyperdirect pathway's deliberative fallback.
 *                         Calls the LLM to reason about which senses to
 *                         activate/suppress. Used when no learned routine
 *                         matches or confidence is too low.
 *   2. detectCollapse() — PFC-delegated: judges whether a resolution is
 *                         genuine synthesis or capitulation. Returns a
 *                         gate signal for the build-cycle.
 *
 * Owned by the Brainstem, threaded through rhythm definitions.
 */

import { z } from "zod";
import type {
  BasalGangliaConfig,
  InhibitionScope,
  SuppressionDecision,
  CollapseContext,
  CollapseSignal,
  CollapseDetail,
  InhibitionBriefing,
  Routine,
  RoutineFingerprint,
  RoutineMatch,
} from "../types/basal-ganglia.js";
import {
  DEFAULT_BASAL_GANGLIA_CONFIG,
  SCOPE_HIERARCHY,
} from "../types/basal-ganglia.js";
import type { StriatalProjection } from "../types/dopamine.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { WorkingMemory } from "./working-memory.js";
import { callStructured } from "../llm/structured.js";
import {
  basalGangliaSystem,
  basalGangliaUser,
  collapseDetectorSystem,
  collapseDetectorUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

const log = createLogger("basal-ganglia");

// ─── Zod schemas for LLM responses ──────────────────────────────

const SuppressionResultSchema = z.object({
  suppress: z.array(
    z.object({
      senseId: z.string(),
      reason: z.string(),
    }),
  ),
  reactivate: z.array(
    z.object({
      senseId: z.string(),
      reason: z.string(),
    }),
  ),
});

const CollapseResultSchema = z.object({
  details: z.array(
    z.object({
      tensionIndex: z.number(),
      collapsed: z.boolean(),
      capitulatedSense: z.string().nullable(),
      explanation: z.string(),
      reEngagementGuidance: z.string().nullable().optional(),
    }),
  ),
});

// ─── Basal Ganglia ──────────────────────────────────────────────

export class BasalGanglia {
  private config: BasalGangliaConfig;

  constructor(config?: Partial<BasalGangliaConfig>) {
    this.config = { ...DEFAULT_BASAL_GANGLIA_CONFIG, ...config };
  }

  // ── Hyperdirect Pathway: LLM-based deliberation ───────────────

  /**
   * Evaluate which senses are irrelevant for the given context.
   * This is the deliberative fallback — called when no learned
   * routine matches or confidence is too low.
   *
   * 1. Clears previous inhibitions at this scope + narrower scopes
   * 2. Calls the LLM to reason about relevance
   * 3. Applies NE + mode modulation (high NE / explore = suppress fewer)
   * 4. Writes new inhibitions to WM
   */
  async suppress(
    briefing: InhibitionBriefing,
    scope: InhibitionScope,
    wm: WorkingMemory,
    cortexConfig: CortexConfig,
  ): Promise<SuppressionDecision> {
    // Step 1: Clear previous inhibitions at this scope and below
    const cleared = wm.clearInhibitionsByScope(scope);

    emit("basal-ganglia:scope-cleared", { scope, cleared });
    log.info("Scope cleared before suppression", { scope, cleared });

    // Step 2: LLM evaluation
    const model = cortexConfig.models.basalGanglia ?? cortexConfig.models.consultation;
    const raw = await callStructured(
      "inhibition",
      model,
      basalGangliaSystem(),
      basalGangliaUser(briefing),
      SuppressionResultSchema,
    );

    // Step 3: Modulate by NE and mode
    let toSuppress = raw.suppress;

    if (briefing.enrichment.neLevel !== undefined &&
        briefing.enrichment.neLevel >= this.config.highNeThreshold) {
      // High NE: suppress fewer senses — keep only high-confidence suppressions
      const cutoff = Math.ceil(toSuppress.length * 0.5);
      toSuppress = toSuppress.slice(0, cutoff);
      log.info("High NE modulation: reduced suppressions", {
        original: raw.suppress.length,
        reduced: toSuppress.length,
        neLevel: briefing.enrichment.neLevel,
      });
    }

    if (briefing.enrichment.mode === "explore") {
      // Explore: scale down suppressions
      const maxSuppress = Math.floor(
        toSuppress.length * this.config.exploreSuppressionScale,
      );
      toSuppress = toSuppress.slice(0, maxSuppress);
      log.info("Explore mode modulation: reduced suppressions", {
        original: raw.suppress.length,
        reduced: toSuppress.length,
      });
    }

    // Step 4: Enforce minimum active senses
    const totalSenses = briefing.enrichment.totalSenseCount;
    const currentlyInhibitedOtherScope = briefing.enrichment.currentInhibitions
      .filter((s) => s.source !== "basal-ganglia" || !this.isScopeAffected(s.scope, scope))
      .length;
    const wouldBeActive = totalSenses - currentlyInhibitedOtherScope - toSuppress.length;

    if (wouldBeActive < this.config.minActiveSenses) {
      const maxNewSuppressions = Math.max(
        0,
        totalSenses - currentlyInhibitedOtherScope - this.config.minActiveSenses,
      );
      toSuppress = toSuppress.slice(0, maxNewSuppressions);
      log.info("Min active senses enforcement", {
        totalSenses,
        currentlyInhibitedOtherScope,
        maxNewSuppressions,
      });
    }

    // Step 5: Apply to WM
    for (const entry of toSuppress) {
      wm.inhibitSense(entry.senseId, entry.reason, "basal-ganglia", scope);
    }

    for (const entry of raw.reactivate) {
      const success = wm.uninhibitSense(entry.senseId);
      if (success) {
        emit("basal-ganglia:reactivated", {
          senseId: entry.senseId,
          reason: entry.reason,
        });
        log.info("Sense reactivated", {
          senseId: entry.senseId,
          reason: entry.reason,
        });
      }
    }

    const decision: SuppressionDecision = {
      suppress: toSuppress,
      reactivate: raw.reactivate,
    };

    emit("basal-ganglia:suppressed", {
      scope,
      suppressed: toSuppress.map((s) => s.senseId),
      reactivated: raw.reactivate.map((s) => s.senseId),
      totalActive: totalSenses - currentlyInhibitedOtherScope - toSuppress.length,
    });

    log.info("Suppression complete", {
      scope,
      suppressed: toSuppress.length,
      reactivated: raw.reactivate.length,
    });

    return decision;
  }

  // ── Collapsed-Tension Detection (PFC-delegated) ───────────────

  /**
   * Evaluate whether tension resolutions are genuine synthesis or capitulation.
   * Returns a CollapseSignal for the build-cycle gate.
   *
   * NOTE: This is a PFC executive function, not BG action selection.
   * It lives here for convenience until a dedicated CollapseDetector
   * is extracted. The BG hosts it because it was part of the original
   * Inhibitor, and the build-cycle already holds a BG reference.
   */
  async detectCollapse(
    context: CollapseContext,
    cortexConfig: CortexConfig,
  ): Promise<CollapseSignal> {
    // Nothing to check if no tensions were resolved
    if (context.tensions.length === 0 || context.resolutions.length === 0) {
      return { collapsed: false, details: [] };
    }

    const model = cortexConfig.models.collapseDetection ?? cortexConfig.models.consultation;
    const raw = await callStructured(
      "collapse-detection",
      model,
      collapseDetectorSystem(),
      collapseDetectorUser(context),
      CollapseResultSchema,
    );

    const details: CollapseDetail[] = raw.details.map((d) => {
      if (d.tensionIndex < 0 || d.tensionIndex >= context.tensions.length) {
        log.error("LLM returned out-of-bounds tension index", {
          tensionIndex: d.tensionIndex,
          tensionCount: context.tensions.length,
        });
      }
      const tension = context.tensions[d.tensionIndex];
      return {
        tensionId: tension?.id ?? `unknown-${d.tensionIndex}`,
        collapsed: d.collapsed,
        capitulatedSense: d.capitulatedSense ?? undefined,
        explanation: d.explanation,
        reEngagementGuidance: d.reEngagementGuidance ?? undefined,
      };
    });

    const anyCollapsed = details.some((d) => d.collapsed);

    if (anyCollapsed) {
      emit("basal-ganglia:collapse-detected", {
        collapsedCount: details.filter((d) => d.collapsed).length,
        totalTensions: context.tensions.length,
        details: details
          .filter((d) => d.collapsed)
          .map((d) => ({
            tensionId: d.tensionId,
            capitulatedSense: d.capitulatedSense,
            explanation: d.explanation,
          })),
      });

      log.warn("Collapsed tensions detected", {
        collapsedCount: details.filter((d) => d.collapsed).length,
        totalTensions: context.tensions.length,
      });
    } else {
      log.info("No collapsed tensions", {
        totalTensions: context.tensions.length,
      });
    }

    return { collapsed: anyCollapsed, details };
  }

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Check if an inhibition's scope would be affected by clearing
   * at the given scope level.
   */
  private isScopeAffected(
    inhibitionScope: string | undefined,
    clearScope: InhibitionScope,
  ): boolean {
    if (!inhibitionScope) return false;
    const clearIdx = SCOPE_HIERARCHY.indexOf(clearScope);
    const inhIdx = SCOPE_HIERARCHY.indexOf(inhibitionScope as InhibitionScope);
    return inhIdx >= clearIdx;
  }
}
