/**
 * World Model (Weltanschauung) — the PFC's integrated understanding of reality.
 *
 * Not a data aggregation dashboard. An LLM synthesis that reads from all
 * system sources and produces compressed wisdom — 3-7 maxims that carry
 * cognitive, axiological, and volitional understanding as a gestalt.
 *
 * Three scopes:
 *   cross-project — Cortex's general identity. Persists to disk.
 *     Changes slowly across projects. Portable.
 *   per-project — formed through experience in a specific project.
 *     Lives in memory. Evolves at rhythm boundaries.
 *   self — who am I? Identity grown through experience. Persists to disk.
 *     Seeded by worldview, deepened by processing history.
 *
 * Follows the Hippocampus pattern: class with explicit methods,
 * event emission, logger, load/save lifecycle, serializable getState().
 */

import { z } from "zod";
import type {
  Maxim,
  SelfNarrative,
  Weltanschauung,
  WorldModelSources,
  WorldModelSourcesSummary,
  WorldModelConfig,
  WorldModelState,
  RebuildTrigger,
} from "../types/world-model.js";
import { DEFAULT_WORLD_MODEL_CONFIG } from "../types/world-model.js";
import type { WeltanschauungInputs } from "../llm/prompts.js";
import { weltanschauungSystem, weltanschauungUser } from "../llm/prompts.js";
import { callStructured } from "../llm/structured.js";
import { WorldModelStore } from "./world-model-store.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("world-model");

// ─── Zod schema for LLM response ───────────────────────────────

const WeltanschauungResponseSchema = z.object({
  maxims: z.array(z.object({
    statement: z.string(),
    cognitive: z.string(),
    axiological: z.string(),
    volitional: z.string(),
    confidence: z.number().min(0).max(1),
    supersedes: z.string().nullable(),
  })).min(1).max(7),
  reasoning: z.string(),
  droppedMaximIds: z.array(z.string()),
});

type WeltanschauungResponse = z.infer<typeof WeltanschauungResponseSchema>;

// ─── WorldModel ─────────────────────────────────────────────────

export class WorldModel {
  private crossProjectMaxims: Maxim[] = [];
  private perProjectMaxims: Maxim[] = [];
  private selfMaxims: Maxim[] = [];
  private selfNarratives: SelfNarrative[] = [];
  private projectId: string | null = null;
  private lastSynthesis: Date | null = null;
  private lastSelfSynthesis: Date | null = null;
  private lastTrigger: RebuildTrigger | null = null;
  private config: WorldModelConfig;
  private store: WorldModelStore;

  constructor(config?: Partial<WorldModelConfig>) {
    this.config = { ...DEFAULT_WORLD_MODEL_CONFIG, ...config };
    this.store = new WorldModelStore(
      this.config.storageDir || undefined,
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  /** Load cross-project and self maxims from disk. Call once at system startup. */
  async load(): Promise<void> {
    this.crossProjectMaxims = await this.store.loadMaxims();
    this.selfMaxims = await this.store.loadSelfMaxims();
    this.selfNarratives = await this.store.loadSelfNarratives();
    const meta = await this.store.loadMeta();
    this.lastSynthesis = meta.lastSynthesisAt ?? null;

    emit("world-model:loaded", {
      crossProjectMaxims: this.crossProjectMaxims.length,
      selfMaxims: this.selfMaxims.length,
      selfNarratives: this.selfNarratives.length,
    });

    log.info("Loaded from disk", {
      crossProjectMaxims: this.crossProjectMaxims.length,
      selfMaxims: this.selfMaxims.length,
      selfNarratives: this.selfNarratives.length,
      lastSynthesis: this.lastSynthesis?.toISOString(),
    });
  }

  /** Persist cross-project and self maxims to disk. */
  async save(): Promise<void> {
    await this.store.saveMaxims(this.crossProjectMaxims);
    await this.store.saveSelfMaxims(this.selfMaxims);
    await this.store.saveSelfNarratives(this.selfNarratives);
    await this.store.saveMeta({
      lastSynthesisAt: this.lastSynthesis ?? undefined,
    });

    log.debug("Saved to disk", {
      crossProjectMaxims: this.crossProjectMaxims.length,
      selfMaxims: this.selfMaxims.length,
      selfNarratives: this.selfNarratives.length,
    });
  }

  // ── Project Binding ────────────────────────────────────────────

  /** Set the current project. Clears per-project maxims. */
  bindProject(projectId: string): void {
    this.projectId = projectId;
    this.perProjectMaxims = [];

    emit("world-model:project-bound", { projectId });
    log.info("Project bound", { projectId });
  }

  // ── Synthesis ──────────────────────────────────────────────────

  /**
   * Rebuild the Weltanschauung. Called at rhythm boundaries.
   *
   * For project-start: synthesizes per-project from cross-project + intent/taste.
   * For between-tasks / phase-gate / rest-cycle: re-synthesizes per-project.
   * For project-complete: re-synthesizes per-project, then optionally cross-project.
   */
  async rebuild(
    trigger: RebuildTrigger,
    sources: WorldModelSources,
  ): Promise<Weltanschauung> {
    const completedCount = sources.wm.getCompletedSummaries().length;

    // Cold start guard: not enough experience for per-project synthesis.
    // Exception: project-start synthesizes from cross-project + intent/taste alone.
    if (
      trigger !== "project-start" &&
      completedCount < this.config.minTasksForProjectSynthesis
    ) {
      log.debug("Skipping rebuild — cold start", {
        trigger,
        completedCount,
        threshold: this.config.minTasksForProjectSynthesis,
      });
      return this.buildSnapshot(trigger, sources);
    }

    // Synthesize per-project
    log.info("Rebuilding per-project Weltanschauung", { trigger, completedCount });
    const perProjectResult = await this.synthesize(
      "per-project",
      trigger,
      sources,
      this.perProjectMaxims,
    );
    this.perProjectMaxims = perProjectResult;

    // On project-complete: also update cross-project if significant learning occurred
    if (trigger === "project-complete" && this.hasSignificantLearning(sources)) {
      log.info("Updating cross-project Weltanschauung", { trigger });
      const crossResult = await this.synthesize(
        "cross-project",
        trigger,
        sources,
        this.crossProjectMaxims,
      );
      this.crossProjectMaxims = crossResult;
    }

    // Self-model: update at project-complete, rest-cycle, phase-gate (not between-tasks)
    if (this.shouldUpdateSelf(trigger, sources)) {
      log.info("Updating self-model", { trigger });
      const selfResult = await this.synthesize(
        "self",
        trigger,
        sources,
        this.selfMaxims,
      );
      this.selfMaxims = selfResult;
      this.lastSelfSynthesis = new Date();
    }

    // Persist identity scopes if either was updated
    if (
      (trigger === "project-complete" && this.hasSignificantLearning(sources)) ||
      this.shouldUpdateSelf(trigger, sources)
    ) {
      await this.save();
    }

    this.lastSynthesis = new Date();
    this.lastTrigger = trigger;

    const snapshot = this.buildSnapshot(trigger, sources);

    emit("world-model:rebuilt", {
      trigger,
      perProjectMaxims: this.perProjectMaxims.length,
      crossProjectMaxims: this.crossProjectMaxims.length,
      selfMaxims: this.selfMaxims.length,
    });

    return snapshot;
  }

  // ── Accessors ──────────────────────────────────────────────────

  /** Get the full Weltanschauung snapshot, or null if never synthesized. */
  getWeltanschauung(): Weltanschauung | null {
    if (this.perProjectMaxims.length === 0 && this.crossProjectMaxims.length === 0 && this.selfMaxims.length === 0) {
      return null;
    }
    return {
      crossProject: [...this.crossProjectMaxims],
      perProject: [...this.perProjectMaxims],
      self: [...this.selfMaxims],
      selfNarratives: [...this.selfNarratives],
      synthesizedAt: this.lastSynthesis ?? new Date(),
      trigger: this.lastTrigger ?? "project-start",
      sourcesSummary: this.emptySourcesSummary(),
    };
  }

  getCrossProjectMaxims(): Maxim[] {
    return [...this.crossProjectMaxims];
  }

  getPerProjectMaxims(): Maxim[] {
    return [...this.perProjectMaxims];
  }

  getSelfMaxims(): Maxim[] {
    return [...this.selfMaxims];
  }

  getSelfNarratives(): SelfNarrative[] {
    return [...this.selfNarratives];
  }

  getAllMaxims(): Maxim[] {
    return [...this.crossProjectMaxims, ...this.perProjectMaxims, ...this.selfMaxims];
  }

  /** Just the statement strings, for Thalamus briefing inclusion. */
  getMaximsForBriefing(): string[] {
    return this.getAllMaxims().map((m) => m.statement);
  }

  // ── State (dashboard/debugging) ────────────────────────────────

  getState(): WorldModelState {
    return {
      crossProjectMaximCount: this.crossProjectMaxims.length,
      perProjectMaximCount: this.perProjectMaxims.length,
      selfMaximCount: this.selfMaxims.length,
      selfNarrativeCount: this.selfNarratives.length,
      crossProjectMaxims: this.crossProjectMaxims.map((m) => ({
        id: m.id,
        statement: m.statement,
        confidence: m.confidence,
      })),
      perProjectMaxims: this.perProjectMaxims.map((m) => ({
        id: m.id,
        statement: m.statement,
        confidence: m.confidence,
      })),
      selfMaxims: this.selfMaxims.map((m) => ({
        id: m.id,
        statement: m.statement,
        confidence: m.confidence,
      })),
      selfNarratives: this.selfNarratives.map((n) => ({
        id: n.id,
        narrative: n.narrative,
      })),
      projectId: this.projectId,
      lastSynthesisAt: this.lastSynthesis ?? undefined,
      lastTrigger: this.lastTrigger ?? undefined,
    };
  }

  // ── Private: LLM synthesis ─────────────────────────────────────

  private async synthesize(
    scope: "cross-project" | "per-project" | "self",
    trigger: RebuildTrigger,
    sources: WorldModelSources,
    existingMaxims: Maxim[],
  ): Promise<Maxim[]> {
    const inputs = this.assembleInputs(scope, trigger, sources, existingMaxims);
    const system = weltanschauungSystem(scope);
    const user = weltanschauungUser(inputs);

    let response: WeltanschauungResponse;
    try {
      response = await callStructured<WeltanschauungResponse>(
        "weltanschauung",
        this.config.synthesisModel,
        system,
        user,
        WeltanschauungResponseSchema,
      );
    } catch (err) {
      log.error("Weltanschauung synthesis failed", {
        scope,
        trigger,
        error: String(err),
      });
      // Graceful degradation: return existing maxims unchanged
      return existingMaxims;
    }

    log.info("Synthesis complete", {
      scope,
      newMaxims: response.maxims.length,
      dropped: response.droppedMaximIds.length,
      reasoning: response.reasoning.slice(0, 200),
    });

    // Build the new maxim set
    const now = new Date();
    const droppedIds = new Set(response.droppedMaximIds);
    const supersededIds = new Set(
      response.maxims
        .map((m) => m.supersedes)
        .filter((id): id is string => id !== null),
    );

    // Start with existing maxims that aren't dropped or superseded
    const surviving = existingMaxims.filter(
      (m) => !droppedIds.has(m.id) && !supersededIds.has(m.id),
    );

    // Add new maxims from the synthesis
    const newMaxims: Maxim[] = response.maxims.map((m) => ({
      id: newId(),
      statement: m.statement,
      cognitive: m.cognitive,
      axiological: m.axiological,
      volitional: m.volitional,
      confidence: m.confidence,
      synthesizedAt: now,
    }));

    // Merge: new maxims replace superseded ones, surviving maxims stay
    const merged = [...surviving, ...newMaxims];

    // Clamp to max
    const clamped = merged
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.config.maxMaximsPerScope);

    // Emit evolution events
    for (const dropped of droppedIds) {
      const old = existingMaxims.find((m) => m.id === dropped);
      if (old) {
        emit("world-model:maxim-dropped", {
          scope,
          id: dropped,
          statement: old.statement,
        });
      }
    }
    for (const m of response.maxims) {
      if (m.supersedes) {
        const old = existingMaxims.find((e) => e.id === m.supersedes);
        emit("world-model:maxim-evolved", {
          scope,
          oldId: m.supersedes,
          oldStatement: old?.statement,
          newStatement: m.statement,
        });
      }
    }

    return clamped;
  }

  // ── Private: Input assembly ────────────────────────────────────

  private assembleInputs(
    scope: "cross-project" | "per-project" | "self",
    trigger: RebuildTrigger,
    sources: WorldModelSources,
    existingMaxims: Maxim[],
  ): WeltanschauungInputs {
    const inputs: WeltanschauungInputs = {
      scope,
      trigger,
      existingMaxims,
    };

    // Cross-project context for per-project and self synthesis
    if ((scope === "per-project" || scope === "self") && this.crossProjectMaxims.length > 0) {
      inputs.crossProjectMaxims = this.crossProjectMaxims;
    }

    // Self-model specific inputs
    if (scope === "self") {
      // Existing self-narratives for evolution
      if (this.selfNarratives.length > 0) {
        inputs.selfNarratives = this.selfNarratives.map((n) => ({
          narrative: n.narrative,
        }));
      }

      // Conviction patterns from WM — sense trends reveal evaluation biases
      const senseTrends = sources.wm.getSenseTrends();
      if (senseTrends.length > 0) {
        inputs.evaluationTrends = senseTrends.map((t) => ({
          sense: t.label,
          direction: t.direction,
          mean: t.currentMean,
        }));
      }

      // Cognitive flexibility history — what my failure modes are
      if (sources.cognitiveFlexibility) {
        const assessments = sources.cognitiveFlexibility.getRecentAssessments(10);
        if (assessments.length > 0) {
          inputs.flexibilityHistory = assessments.map((a) => ({
            diagnosis: a.diagnosis,
            timestamp: a.timestamp.toISOString(),
          }));
        }
      }

      // Satisfaction signals — how my Parsifal experiences me
      if (sources.satisfactionHistory) {
        const signals = sources.satisfactionHistory.getRecentSignals(10);
        if (signals.length > 0) {
          inputs.satisfactionHistory = signals.map((s) => ({
            signal: s.signal,
            context: s.context,
          }));
        }
      }

      // Cerebellum accuracy — where I'm reliable vs not
      if (sources.cerebellum) {
        inputs.predictionAccuracy = sources.cerebellum.getAccuracy();
        inputs.predictionEpisodes = sources.cerebellum.getEpisodeCount();

        const perSenseCeilings = sources.cerebellum.getPerSenseCeilings();
        if (perSenseCeilings.length > 0) {
          inputs.perSenseCeilings = perSenseCeilings.map((c) => ({
            sense: c.senseName,
            ceiling: c.ceiling,
          }));
        }

        const bottleneck = sources.cerebellum.getApproachBottleneckInfo();
        if (bottleneck) {
          inputs.approachBottleneck = {
            isBottleneck: bottleneck.approachIsBottleneck,
            gap: bottleneck.bottleneckGap,
          };
        }
      }

      // Plasticity — which senses I trust, how my thresholds have adapted
      if (sources.plasticity) {
        const summaries: string[] = [];
        const evalWeights = sources.plasticity.getByCategory("evaluation-influence");
        if (evalWeights.length > 0) {
          const sorted = [...evalWeights].sort((a, b) => b.value - a.value);
          const top = sorted.slice(0, 3);
          const topNames = top.map((w) => {
            const name = w.connectionId.replace("evaluator.sense-weight.", "");
            return `${name} (${w.value.toFixed(2)})`;
          });
          summaries.push(`Evaluation influence leans toward: ${topNames.join(", ")}`);
        }
        if (summaries.length > 0) {
          inputs.weightSummaries = summaries;
        }
      }

      // Hippocampus episodes reflected inward — what they say about ME
      if (sources.hippocampus) {
        const recentEpisodes = sources.hippocampus.getRecentEpisodes(10);
        const significant = recentEpisodes
          .filter((e) => Math.abs(e.dopamineSignal) > 0.5)
          .sort((a, b) => b.significance - a.significance)
          .slice(0, 5);
        if (significant.length > 0) {
          inputs.significantEpisodes = significant.map((e) => ({
            taskDescription: e.narrative.taskDescription,
            outcome: e.narrative.outcome,
            cycles: e.narrative.cycles,
            dopamineSignal: e.dopamineSignal,
            topScores: e.senseParticipation
              .sort((a, b) => Math.abs(b.finalScore - 5) - Math.abs(a.finalScore - 5))
              .slice(0, 3)
              .map((s) => ({ sense: s.senseName, score: s.finalScore })),
            approachesTried: e.narrative.approachesTried,
          }));
        }
      }

      return inputs;
    }

    // Project identity
    if (scope === "per-project" && sources.intent) {
      inputs.projectSummary = sources.intent.summary;
      inputs.projectVision = sources.intent.vision;
      inputs.projectConstraints = sources.intent.constraints;
    }
    if (scope === "per-project" && sources.taste) {
      inputs.tasteDescription = `Visual: ${sources.taste.visual}. Decisions: ${sources.taste.decisionStyle}. Patterns: ${sources.taste.patterns}`;
    }

    // Hippocampus: principles
    if (sources.hippocampus) {
      const allPrinciples = sources.hippocampus.getActivePrinciples();
      if (allPrinciples.length > 0) {
        inputs.principles = allPrinciples.map((p) => ({
          statement: p.statement,
          confidence: p.confidence,
          relevantSenses: p.relevantSenses,
          scope: p.scope,
        }));
      }

      // Per-sense project understanding
      if (scope === "per-project" && sources.projectId) {
        const sensePrinciples: WeltanschauungInputs["sensePrinciples"] = [];
        // Get unique sense IDs from cross-project principles
        const senseIds = new Set(allPrinciples.flatMap((p) => p.relevantSenses));
        for (const senseId of senseIds) {
          const projectPrinciples = sources.hippocampus.getPrinciplesForSenseAndProject(
            senseId,
            sources.projectId,
          );
          for (const p of projectPrinciples) {
            sensePrinciples.push({
              senseId,
              statement: p.statement,
              confidence: p.confidence,
            });
          }
        }
        if (sensePrinciples.length > 0) {
          inputs.sensePrinciples = sensePrinciples;
        }
      }

      // Significant episodes (top 5 by significance)
      const recentEpisodes = sources.hippocampus.getRecentEpisodes(10);
      const significant = recentEpisodes
        .filter((e) => Math.abs(e.dopamineSignal) > 0.5)
        .sort((a, b) => b.significance - a.significance)
        .slice(0, 5);
      if (significant.length > 0) {
        inputs.significantEpisodes = significant.map((e) => ({
          taskDescription: e.narrative.taskDescription,
          outcome: e.narrative.outcome,
          cycles: e.narrative.cycles,
          dopamineSignal: e.dopamineSignal,
          topScores: e.senseParticipation
            .sort((a, b) => Math.abs(b.finalScore - 5) - Math.abs(a.finalScore - 5))
            .slice(0, 3)
            .map((s) => ({ sense: s.senseName, score: s.finalScore })),
          approachesTried: e.narrative.approachesTried,
        }));
      }
    }

    // Working memory
    const patterns = sources.wm.getPatterns();
    if (patterns.length > 0) {
      inputs.patterns = patterns.map((p) => ({
        description: p.description,
        confidence: p.confidence,
      }));
    }

    const decisions = sources.wm.getDecisions();
    if (decisions.length > 0) {
      inputs.decisions = decisions.slice(-10).map((d) => ({
        description: d.description,
        confidence: d.confidence,
      }));
    }

    const senseTrends = sources.wm.getSenseTrends();
    if (senseTrends.length > 0) {
      inputs.senseTrends = senseTrends.map((t) => ({
        sense: t.label,
        direction: t.direction,
        currentMean: t.currentMean,
      }));
    }

    const openQuestions = sources.wm.getOpenQuestions();
    if (openQuestions.length > 0) {
      inputs.openQuestions = openQuestions.map((q) => ({
        question: q.question,
      }));
    }

    inputs.wmLoad = sources.wm.getLoad();
    inputs.completedTaskCount = sources.wm.getCompletedSummaries().length;

    // Cerebellum
    if (sources.cerebellum) {
      inputs.predictionAccuracy = sources.cerebellum.getAccuracy();
      inputs.predictionEpisodes = sources.cerebellum.getEpisodeCount();

      // Speed-of-light ceilings — so the LLM sees "approach is capped at X when project ceiling is Y"
      const compositeCeiling = sources.cerebellum.getCompositeCeiling();
      if (compositeCeiling !== null) {
        inputs.compositeCeiling = compositeCeiling;
      }

      const perSenseCeilings = sources.cerebellum.getPerSenseCeilings();
      if (perSenseCeilings.length > 0) {
        inputs.perSenseCeilings = perSenseCeilings.map((c) => ({
          sense: c.senseName,
          ceiling: c.ceiling,
        }));
      }

      const bottleneck = sources.cerebellum.getApproachBottleneckInfo();
      if (bottleneck) {
        inputs.approachBottleneck = {
          isBottleneck: bottleneck.approachIsBottleneck,
          gap: bottleneck.bottleneckGap,
        };
      }
    }

    // Tonic dopamine
    if (sources.tonic && sources.projectId) {
      const tonic = sources.tonic.get(sources.projectId);
      inputs.tonicLevel = tonic.level;
      inputs.tonicTrend = tonic.trend;
      inputs.tonicSamples = tonic.sampleCount;
    }

    // Plasticity: category-level summaries
    if (sources.plasticity) {
      const summaries: string[] = [];

      // Evaluation influence — which senses Cortex trusts most
      const evalWeights = sources.plasticity.getByCategory("evaluation-influence");
      if (evalWeights.length > 0) {
        const sorted = [...evalWeights].sort((a, b) => b.value - a.value);
        const top = sorted.slice(0, 3);
        const topNames = top.map((w) => {
          const name = w.connectionId.replace("evaluator.sense-weight.", "");
          return `${name} (${w.value.toFixed(2)})`;
        });
        summaries.push(`Evaluation influence leans toward: ${topNames.join(", ")}`);
      }

      // Threshold weights — how aggressive various systems are
      const thresholds = sources.plasticity.getByCategory("threshold");
      for (const w of thresholds) {
        const deviation = w.value - w.defaultValue;
        if (Math.abs(deviation) > 0.1) {
          const direction = deviation > 0 ? "more aggressive" : "more conservative";
          const name = w.connectionId.replace(/^[^.]+\.threshold\./, "");
          summaries.push(`${name}: ${direction} than baseline (${w.value.toFixed(2)} vs ${w.defaultValue.toFixed(2)})`);
        }
      }

      if (summaries.length > 0) {
        inputs.weightSummaries = summaries;
      }
    }

    // PNS capabilities
    if (sources.pns) {
      const caps = sources.pns.getCapabilities();
      if (caps.length > 0) {
        inputs.capabilitySummary = sources.pns.describeCapabilities();
      }
    }

    // System health
    if (sources.vitals) {
      const v = sources.vitals;
      const alerts: string[] = [];
      if (v.workingMemoryLoad > 0.7) alerts.push(`high WM load (${(v.workingMemoryLoad * 100).toFixed(0)}%)`);
      if (v.predictionAccuracy < 0.5) alerts.push(`low prediction accuracy (${(v.predictionAccuracy * 100).toFixed(0)}%)`);
      if (v.weightVolatility > 0.5) alerts.push(`weight volatility (${(v.weightVolatility * 100).toFixed(0)}%)`);
      if (v.tonicDopamine < 0.3) alerts.push(`low tonic dopamine (${v.tonicDopamine.toFixed(2)})`);

      if (alerts.length > 0) {
        inputs.vitalsSummary = `Alerts: ${alerts.join(", ")}`;
      } else {
        inputs.vitalsSummary = "All vitals healthy";
      }
    }

    return inputs;
  }

  // ── Private: Helpers ───────────────────────────────────────────

  /**
   * Should the self-model update at this trigger?
   * Self is stable — updates at project-complete (always), rest-cycle
   * (if enough new experience), phase-gate (if flexibility shifted).
   * NOT at between-tasks (too volatile for identity).
   */
  private shouldUpdateSelf(trigger: RebuildTrigger, sources: WorldModelSources): boolean {
    if (trigger === "project-complete") return true;

    if (trigger === "rest-cycle") {
      // Only if enough experience since last self synthesis
      const completedCount = sources.wm.getCompletedSummaries().length;
      return completedCount >= 3;
    }

    if (trigger === "phase-gate") {
      // Only if cognitive flexibility has produced diagnoses (signals self-relevant change)
      if (sources.cognitiveFlexibility) {
        const assessments = sources.cognitiveFlexibility.getRecentAssessments(3);
        return assessments.length > 0;
      }
    }

    return false;
  }

  /** Determine if the project produced enough learning to update cross-project. */
  private hasSignificantLearning(sources: WorldModelSources): boolean {
    // Heuristic: at least 3 completed tasks and either:
    // - Strong tonic signal (project was notably good or bad)
    // - Multiple new principles were extracted
    const completedCount = sources.wm.getCompletedSummaries().length;
    if (completedCount < 3) return false;

    if (sources.tonic && sources.projectId) {
      const tonic = sources.tonic.get(sources.projectId);
      if (Math.abs(tonic.level) > 1.0) return true;
    }

    if (sources.hippocampus) {
      const principles = sources.hippocampus.getActivePrinciples();
      // If the project produced 3+ principles, it was a significant learning experience
      if (principles.filter((p) => p.scope === "cross-project").length >= 3) {
        return true;
      }
    }

    return false;
  }

  private buildSnapshot(
    trigger: RebuildTrigger,
    sources: WorldModelSources,
  ): Weltanschauung {
    return {
      crossProject: [...this.crossProjectMaxims],
      perProject: [...this.perProjectMaxims],
      self: [...this.selfMaxims],
      selfNarratives: [...this.selfNarratives],
      synthesizedAt: this.lastSynthesis ?? new Date(),
      trigger,
      sourcesSummary: this.buildSourcesSummary(sources),
    };
  }

  private buildSourcesSummary(sources: WorldModelSources): WorldModelSourcesSummary {
    return {
      principleCount: sources.hippocampus?.getActivePrinciples().length ?? 0,
      sensePrincipleCount: 0, // Computed during assembly, not worth re-counting
      episodeCount: sources.hippocampus?.getRecentEpisodes(100).length ?? 0,
      patternCount: sources.wm.getPatterns().length,
      decisionCount: sources.wm.getDecisions().length,
      cerebellumAccuracy: sources.cerebellum?.getAccuracy() ?? 0,
      cerebellumEpisodes: sources.cerebellum?.getEpisodeCount() ?? 0,
      tonicLevel: sources.tonic && sources.projectId
        ? sources.tonic.get(sources.projectId).level
        : null,
      tonicTrend: sources.tonic && sources.projectId
        ? sources.tonic.get(sources.projectId).trend
        : null,
      wmLoad: sources.wm.getLoad(),
      completedTaskCount: sources.wm.getCompletedSummaries().length,
      hasPlasticity: sources.plasticity !== undefined,
      hasVitals: sources.vitals !== undefined,
      hasTaskGraph: sources.taskGraph !== undefined,
      hasPNS: sources.pns !== undefined,
      capabilityCount: sources.pns?.getCapabilities().length ?? 0,
      selfMaximCount: this.selfMaxims.length,
      selfNarrativeCount: this.selfNarratives.length,
    };
  }

  private emptySourcesSummary(): WorldModelSourcesSummary {
    return {
      principleCount: 0,
      sensePrincipleCount: 0,
      episodeCount: 0,
      patternCount: 0,
      decisionCount: 0,
      cerebellumAccuracy: 0,
      cerebellumEpisodes: 0,
      tonicLevel: null,
      tonicTrend: null,
      wmLoad: 0,
      completedTaskCount: 0,
      hasPlasticity: false,
      hasVitals: false,
      hasTaskGraph: false,
      hasPNS: false,
      capabilityCount: 0,
      selfMaximCount: this.selfMaxims.length,
      selfNarrativeCount: this.selfNarratives.length,
    };
  }
}
