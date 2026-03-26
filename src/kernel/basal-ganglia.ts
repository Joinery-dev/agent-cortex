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
  InhibitionBriefing,
  Routine,
  RoutineFingerprint,
  RoutineMatch,
} from "../types/basal-ganglia.js";
import type { CollapseSignal, CollapseDetail } from "../types/collapse.js";
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

// ─── Stop words for keyword extraction ──────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "and", "but",
  "or", "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some", "such",
  "no", "only", "own", "same", "than", "too", "very", "just", "because",
  "if", "when", "where", "how", "what", "which", "who", "whom", "this",
  "that", "these", "those", "it", "its", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "they", "them", "their",
]);

/** Extract keywords from text: lowercase, split on non-alpha, filter stop words + short tokens. */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. Returns 0 if both empty. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Pending deliberation (bridges action → outcome for learning) ─

interface PendingDeliberation {
  fingerprint: RoutineFingerprint;
  /** The suppression decision the LLM made. */
  decision: SuppressionDecision;
  /** Which senses were active after suppression. */
  activeSenseIds: string[];
  recordedAt: Date;
}

/** Accumulates candidate observations before promoting to a routine. */
interface CandidateAccumulator {
  fingerprint: RoutineFingerprint;
  /** Sense activation sets from each observation. */
  observations: { activeSenseIds: string[]; suppressedSenseIds: string[] }[];
  firstSeen: Date;
  lastSeen: Date;
}

// ─── Basal Ganglia ──────────────────────────────────────────────

export class BasalGanglia {
  private config: BasalGangliaConfig;

  /** Learned routines keyed by ID. */
  private routines: Map<string, Routine> = new Map();
  /** Pending deliberations keyed by taskId — bridges suppress() to reinforceRoutine(). */
  private pendingDeliberations: Map<string, PendingDeliberation> = new Map();
  /** Candidate patterns accumulating toward routine creation, keyed by fingerprint hash. */
  private candidates: Map<string, CandidateAccumulator> = new Map();

  constructor(config?: Partial<BasalGangliaConfig>) {
    this.config = { ...DEFAULT_BASAL_GANGLIA_CONFIG, ...config };
  }

  // ── Routine store accessors ───────────────────────────────────

  /** Number of learned routines. */
  getRoutineCount(): number {
    return this.routines.size;
  }

  /** Get all routines (for dashboard/debugging). */
  getRoutines(): Routine[] {
    return [...this.routines.values()];
  }

  /**
   * Get routine matches for a set of tasks. Used by task-dispatch
   * to populate SchedulerSignals.routineMatches.
   */
  getRoutineMatches(
    briefings: Map<string, InhibitionBriefing>,
  ): Map<string, { confidence: number; routineId: string }> {
    const result = new Map<string, { confidence: number; routineId: string }>();
    for (const [taskId, briefing] of briefings) {
      const fp = this.extractFingerprint(briefing);
      const match = this.findBestMatch(fp);
      if (match) {
        result.set(taskId, {
          confidence: match.effectiveConfidence,
          routineId: match.routine.id,
        });
      }
    }
    return result;
  }

  // ── Fingerprint extraction ────────────────────────────────────

  /**
   * Extract a RoutineFingerprint from an InhibitionBriefing.
   * This is the "cortical input" to the striatum — structured features
   * derived from the thalamus briefing, not raw task text.
   */
  extractFingerprint(briefing: InhibitionBriefing): RoutineFingerprint {
    const domainKeywords = extractKeywords(
      [briefing.intent.summary, briefing.intent.audience ?? ""].join(" "),
    );

    const taskKeywords = briefing.task?.description
      ? extractKeywords(briefing.task.description)
      : [];

    const neLevel = briefing.enrichment.neLevel ?? 0.5;
    const neBucket: "low" | "mid" | "high" =
      neLevel < 0.3 ? "low" : neLevel > 0.7 ? "high" : "mid";

    const tasteKeywords = extractKeywords(
      [briefing.taste.patterns ?? "", briefing.taste.decisionStyle ?? ""].join(" "),
    );

    return {
      domainKeywords,
      taskKeywords,
      neBucket,
      mode: briefing.enrichment.mode,
      senseCount: briefing.enrichment.totalSenseCount,
      tasteKeywords,
    };
  }

  // ── Matching ──────────────────────────────────────────────────

  /**
   * Find the best matching routine for a fingerprint.
   * Returns null if no routine exceeds the similarity threshold.
   */
  findBestMatch(fingerprint: RoutineFingerprint): RoutineMatch | null {
    let best: RoutineMatch | null = null;

    for (const routine of this.routines.values()) {
      const similarity = this.computeSimilarity(fingerprint, routine.fingerprint);
      if (similarity < this.config.similarityThreshold) continue;

      const effectiveConfidence = routine.confidence * similarity;
      if (!best || effectiveConfidence > best.effectiveConfidence) {
        best = { routine, similarity, effectiveConfidence };
      }
    }

    return best;
  }

  /**
   * Compute similarity between two fingerprints.
   * Weighted combination of keyword overlap + structural match.
   */
  private computeSimilarity(
    a: RoutineFingerprint,
    b: RoutineFingerprint,
  ): number {
    // Keyword overlap (domain + task combined): weight 0.4
    const allA = [...a.domainKeywords, ...a.taskKeywords];
    const allB = [...b.domainKeywords, ...b.taskKeywords];
    const keywordSim = jaccard(allA, allB);

    // NE bucket match: exact=1, adjacent=0.5, far=0. Weight 0.2
    const buckets = ["low", "mid", "high"] as const;
    const aIdx = buckets.indexOf(a.neBucket);
    const bIdx = buckets.indexOf(b.neBucket);
    const neSim = aIdx === bIdx ? 1 : Math.abs(aIdx - bIdx) === 1 ? 0.5 : 0;

    // Mode match: weight 0.15
    const modeSim = a.mode === b.mode ? 1 : 0;

    // Taste alignment: weight 0.25. Taste is project-level and stable —
    // similarity is 1.0 when taste hasn't changed. When taste changes,
    // old routines lose similarity and fall through to the LLM.
    const tasteSim = jaccard(a.tasteKeywords, b.tasteKeywords);

    return 0.4 * keywordSim + 0.2 * neSim + 0.15 * modeSim + 0.25 * tasteSim;
  }

  // ── Learning: record deliberation ─────────────────────────────

  /**
   * Record a deliberation result for later reinforcement.
   * Called after suppress() (hyperdirect pathway) completes.
   */
  recordDeliberation(
    taskId: string,
    fingerprint: RoutineFingerprint,
    decision: SuppressionDecision,
    activeSenseIds: string[],
  ): void {
    this.pendingDeliberations.set(taskId, {
      fingerprint,
      decision,
      activeSenseIds,
      recordedAt: new Date(),
    });

    // Prune old pending entries (in case tasks never complete)
    if (this.pendingDeliberations.size > 200) {
      const oldest = [...this.pendingDeliberations.entries()]
        .sort((a, b) => a[1].recordedAt.getTime() - b[1].recordedAt.getTime())
        .slice(0, 50);
      for (const [id] of oldest) {
        this.pendingDeliberations.delete(id);
      }
    }
  }

  // ── Learning: reinforce from dopamine ─────────────────────────

  /**
   * Called by SubcorticalHooks.updateRoutines() after dopamine flows.
   * Uses the striatal projection to strengthen/weaken routines.
   */
  reinforceRoutine(taskId: string, striatal: StriatalProjection): void {
    const pending = this.pendingDeliberations.get(taskId);
    if (!pending) return;
    this.pendingDeliberations.delete(taskId);

    const { fingerprint, activeSenseIds, decision } = pending;

    // Check if an existing routine matches this fingerprint
    const match = this.findBestMatch(fingerprint);

    if (match && match.similarity >= this.config.similarityThreshold) {
      // ── Reinforce existing routine ────────────────────────
      const routine = match.routine;
      const learningStep = striatal.reinforcement * 0.1;
      routine.confidence = Math.max(0, Math.min(1, routine.confidence + learningStep));
      routine.observationCount++;
      routine.lastReinforcedAt = new Date();

      // Check if LLM chose differently than the routine would have
      const routineSet = new Set(routine.activateSenses);
      const llmSet = new Set(activeSenseIds);
      const agreesWithRoutine =
        routineSet.size === llmSet.size &&
        [...routineSet].every((s) => llmSet.has(s));

      if (!agreesWithRoutine) {
        routine.overrideCount++;
        // High override rate erodes confidence
        if (routine.overrideCount / routine.observationCount > 0.3) {
          routine.confidence *= 0.9;
        }
      }

      log.debug("Routine reinforced", {
        routineId: routine.id,
        reinforcement: striatal.reinforcement.toFixed(3),
        newConfidence: routine.confidence.toFixed(3),
        overrideRate: (routine.overrideCount / routine.observationCount).toFixed(2),
        agreed: agreesWithRoutine,
      });

      emit("basal-ganglia:routine-reinforced", {
        routineId: routine.id,
        reinforcement: striatal.reinforcement,
        confidence: routine.confidence,
        observationCount: routine.observationCount,
      });
    } else if (striatal.reinforcement > 0) {
      // ── Accumulate candidate ──────────────────────────────
      const hash = this.fingerprintHash(fingerprint);
      const existing = this.candidates.get(hash);

      const suppressedSenseIds = decision.suppress.map((s) => s.senseId);

      if (existing) {
        existing.observations.push({ activeSenseIds, suppressedSenseIds });
        existing.lastSeen = new Date();
      } else {
        this.candidates.set(hash, {
          fingerprint,
          observations: [{ activeSenseIds, suppressedSenseIds }],
          firstSeen: new Date(),
          lastSeen: new Date(),
        });
      }

      const candidate = this.candidates.get(hash)!;
      if (candidate.observations.length >= this.config.stableObservationCount) {
        this.promoteCandidate(hash, candidate);
      }
    }
  }

  // ── Learning: decay ───────────────────────────────────────────

  /**
   * Decay all routines. Called during rest cycles.
   * Prunes routines below confidence floor and enforces maxRoutines.
   */
  decayRoutines(): { decayed: number; pruned: number } {
    let decayed = 0;
    let pruned = 0;

    for (const [id, routine] of this.routines) {
      routine.confidence -= this.config.routineDecayRate;
      decayed++;

      if (routine.confidence < 0.1) {
        this.routines.delete(id);
        pruned++;
        log.debug("Routine pruned", { routineId: id });
      }
    }

    // Enforce max routines: evict lowest confidence
    if (this.routines.size > this.config.maxRoutines) {
      const sorted = [...this.routines.entries()]
        .sort((a, b) => a[1].confidence - b[1].confidence);
      const toEvict = sorted.slice(0, this.routines.size - this.config.maxRoutines);
      for (const [id] of toEvict) {
        this.routines.delete(id);
        pruned++;
      }
    }

    if (decayed > 0 || pruned > 0) {
      emit("basal-ganglia:decay", { decayed, pruned, remaining: this.routines.size });
      log.debug("Routine decay", { decayed, pruned, remaining: this.routines.size });
    }

    return { decayed, pruned };
  }

  // ── selectAction: the main entry point ─────────────────────

  /**
   * The BG's primary method. Checks for a learned routine first
   * (direct pathway), falls back to LLM deliberation (hyperdirect).
   *
   * Same signature and return type as suppress() — callers don't
   * need to know whether a routine or LLM made the decision.
   */
  async selectAction(
    briefing: InhibitionBriefing,
    scope: InhibitionScope,
    wm: WorkingMemory,
    cortexConfig: CortexConfig,
  ): Promise<SuppressionDecision> {
    const fingerprint = this.extractFingerprint(briefing);
    const match = this.findBestMatch(fingerprint);

    if (match && match.effectiveConfidence >= this.config.routineConfidenceThreshold) {
      // ── DIRECT PATHWAY: use learned routine ─────────────
      log.info("Direct pathway: using learned routine", {
        routineId: match.routine.id,
        similarity: match.similarity.toFixed(3),
        effectiveConfidence: match.effectiveConfidence.toFixed(3),
      });

      emit("basal-ganglia:direct-pathway", {
        routineId: match.routine.id,
        similarity: match.similarity,
        effectiveConfidence: match.effectiveConfidence,
        activateSenses: match.routine.activateSenses,
        suppressSenses: match.routine.suppressSenses,
      });

      const decision = this.applyRoutine(match, scope, wm, briefing);

      // Record so reinforceRoutine() can compare routine vs what would have happened
      if (briefing.task?.id) {
        const activeSenseIds = this.getActiveSenseIds(briefing, decision);
        this.recordDeliberation(briefing.task.id, fingerprint, decision, activeSenseIds);
      }

      return decision;
    }

    // ── HYPERDIRECT PATHWAY: fall back to LLM deliberation ──
    const reason = match
      ? `low-confidence (${match.effectiveConfidence.toFixed(3)} < ${this.config.routineConfidenceThreshold})`
      : "no-match";

    log.info("Hyperdirect pathway: LLM deliberation", { reason });
    emit("basal-ganglia:hyperdirect-pathway", { reason });

    const decision = await this.suppress(briefing, scope, wm, cortexConfig);

    // Record for later learning
    if (briefing.task?.id) {
      const activeSenseIds = this.getActiveSenseIds(briefing, decision);
      this.recordDeliberation(briefing.task.id, fingerprint, decision, activeSenseIds);
    }

    return decision;
  }

  // ── Direct pathway: apply a learned routine ───────────────────

  /**
   * Convert a routine's learned activation pattern into a SuppressionDecision.
   * Applies the same NE/mode modulation and minActiveSenses enforcement
   * as the LLM-based suppress() path.
   */
  private applyRoutine(
    match: RoutineMatch,
    scope: InhibitionScope,
    wm: WorkingMemory,
    briefing: InhibitionBriefing,
  ): SuppressionDecision {
    const routine = match.routine;

    // Step 1: Clear previous inhibitions at this scope
    wm.clearInhibitionsByScope(scope);

    // Step 2: Build suppression list from routine
    let toSuppress = routine.suppressSenses.map((senseId) => ({
      senseId,
      reason: `routine:${routine.id}`,
    }));

    // Step 3: NE/mode modulation (same logic as LLM path)
    if (briefing.enrichment.neLevel !== undefined &&
        briefing.enrichment.neLevel >= this.config.highNeThreshold) {
      const cutoff = Math.ceil(toSuppress.length * 0.5);
      toSuppress = toSuppress.slice(0, cutoff);
    }

    if (briefing.enrichment.mode === "explore") {
      const maxSuppress = Math.floor(
        toSuppress.length * this.config.exploreSuppressionScale,
      );
      toSuppress = toSuppress.slice(0, maxSuppress);
    }

    // Step 4: Enforce minimum active senses
    const totalSenses = briefing.enrichment.totalSenseCount;
    const currentlyInhibitedOtherScope = briefing.enrichment.currentInhibitions
      .filter((s) => s.source !== "basal-ganglia" || !this.isScopeAffected(s.scope, scope))
      .length;
    const wouldBeActive = totalSenses - currentlyInhibitedOtherScope - toSuppress.length;

    if (wouldBeActive < this.config.minActiveSenses) {
      const maxNew = Math.max(
        0,
        totalSenses - currentlyInhibitedOtherScope - this.config.minActiveSenses,
      );
      toSuppress = toSuppress.slice(0, maxNew);
    }

    // Step 5: Apply to WM
    for (const entry of toSuppress) {
      wm.inhibitSense(entry.senseId, entry.reason, "basal-ganglia", scope);
    }

    const decision: SuppressionDecision = {
      suppress: toSuppress,
      reactivate: [], // Routines don't reactivate — that's a deliberative judgment
    };

    emit("basal-ganglia:suppressed", {
      scope,
      pathway: "direct",
      routineId: routine.id,
      suppressed: toSuppress.map((s) => s.senseId),
      totalActive: totalSenses - currentlyInhibitedOtherScope - toSuppress.length,
    });

    return decision;
  }

  /**
   * Determine which senses are active after a suppression decision.
   * Used to record what actually happened for learning.
   */
  private getActiveSenseIds(
    briefing: InhibitionBriefing,
    decision: SuppressionDecision,
  ): string[] {
    const suppressedSet = new Set(decision.suppress.map((s) => s.senseId));
    return briefing.enrichment.senses
      .map((s) => s.id)
      .filter((id) => !suppressedSet.has(id));
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

  // ── Private: routine creation ───────────────────────────────

  /**
   * Promote a candidate accumulator to a learned routine.
   * Senses appearing in ≥60% of observations form the activation set.
   */
  private promoteCandidate(hash: string, candidate: CandidateAccumulator): void {
    const { observations, fingerprint } = candidate;
    const threshold = observations.length * 0.6;

    // Count how often each sense appeared in the active set
    const activeCounts = new Map<string, number>();
    const suppressCounts = new Map<string, number>();

    for (const obs of observations) {
      for (const s of obs.activeSenseIds) {
        activeCounts.set(s, (activeCounts.get(s) ?? 0) + 1);
      }
      for (const s of obs.suppressedSenseIds) {
        suppressCounts.set(s, (suppressCounts.get(s) ?? 0) + 1);
      }
    }

    const activateSenses = [...activeCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([id]) => id);

    const suppressSenses = [...suppressCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([id]) => id);

    if (activateSenses.length === 0) {
      // No consistent pattern — don't create a routine
      this.candidates.delete(hash);
      return;
    }

    const routine: Routine = {
      id: newId(),
      fingerprint,
      activateSenses,
      suppressSenses,
      confidence: 0.5, // Start moderate, strengthen with reinforcement
      observationCount: observations.length,
      overrideCount: 0,
      createdAt: new Date(),
      lastReinforcedAt: new Date(),
    };

    this.routines.set(routine.id, routine);
    this.candidates.delete(hash);

    log.info("New routine created", {
      routineId: routine.id,
      activateSenses,
      suppressSenses,
      fromObservations: observations.length,
    });

    emit("basal-ganglia:routine-created", {
      routineId: routine.id,
      activateSenses,
      suppressSenses,
      confidence: routine.confidence,
    });
  }

  /** Simple hash of a fingerprint for candidate deduplication. */
  private fingerprintHash(fp: RoutineFingerprint): string {
    const parts = [
      fp.domainKeywords.sort().join(","),
      fp.taskKeywords.sort().join(","),
      fp.neBucket,
      fp.mode ?? "none",
      String(fp.senseCount),
      fp.tasteKeywords.sort().join(","),
    ];
    return parts.join("|");
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
