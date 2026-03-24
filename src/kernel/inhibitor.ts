/**
 * Inhibitor — PFC sense suppression + collapsed-tension detection.
 *
 * Two modes:
 *   1. suppress()       — evaluates which senses are irrelevant for a scope.
 *                         Called by the planning layer at scope boundaries.
 *   2. detectCollapse() — judges whether a resolution is genuine synthesis
 *                         or capitulation. Returns a gate signal.
 *
 * The Inhibitor is passive — called by others, doesn't track boundaries.
 * Owned by the Brainstem, threaded through rhythm definitions.
 */

import { z } from "zod";
import type {
  InhibitorConfig,
  InhibitionScope,
  SuppressionDecision,
  CollapseContext,
  CollapseSignal,
  CollapseDetail,
  InhibitionBriefing,
} from "../types/inhibitor.js";
import {
  DEFAULT_INHIBITOR_CONFIG,
  SCOPE_HIERARCHY,
} from "../types/inhibitor.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { WorkingMemory } from "./working-memory.js";
import { callStructured } from "../llm/structured.js";
import {
  inhibitorSystem,
  inhibitorUser,
  collapseDetectorSystem,
  collapseDetectorUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("inhibitor");

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

// ─── Inhibitor ───────────────────────────────────────────────────

export class Inhibitor {
  private config: InhibitorConfig;

  constructor(config?: Partial<InhibitorConfig>) {
    this.config = { ...DEFAULT_INHIBITOR_CONFIG, ...config };
  }

  // ── Mode 1: Suppression ──────────────────────────────────────

  /**
   * Evaluate which senses are irrelevant for the given context.
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

    emit("inhibitor:scope-cleared", { scope, cleared });
    log.info("Scope cleared before suppression", { scope, cleared });

    // Step 2: LLM evaluation
    const model = cortexConfig.models.inhibitor ?? cortexConfig.models.consultation;
    const raw = await callStructured(
      "inhibition",
      model,
      inhibitorSystem(),
      inhibitorUser(briefing),
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
      .filter((s) => s.source !== "inhibitor" || !this.isScopeAffected(s.scope, scope))
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
      wm.inhibitSense(entry.senseId, entry.reason, "inhibitor", scope);
    }

    for (const entry of raw.reactivate) {
      const success = wm.uninhibitSense(entry.senseId);
      if (success) {
        emit("inhibitor:reactivated", {
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

    emit("inhibitor:suppressed", {
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

  // ── Mode 2: Collapsed-Tension Detection ──────────────────────

  /**
   * Evaluate whether tension resolutions are genuine synthesis or capitulation.
   * Returns a CollapseSignal for the build-cycle gate.
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
      emit("inhibitor:collapse-detected", {
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
