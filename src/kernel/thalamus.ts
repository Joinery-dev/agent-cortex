/**
 * Thalamus — central context relay.
 *
 * Reads from all context sources (Working Memory, PNS, intent, taste,
 * hippocampus, world model) and assembles per-consumer briefings.
 *
 * Three-layer architecture:
 *   World Model → Task Gestalt → Consumer Briefings
 *
 * The gestalt is the per-task canonical snapshot. Assembled once when
 * a task arrives, it captures the world state at that moment. All
 * consumer briefings within a task derive from the gestalt, ensuring
 * consistency. Predictions and speed-of-light attach during the task
 * lifecycle as they become available.
 *
 * API layers:
 *   Gestalt:   assembleGestalt / getGestalt / attachPrediction / attachSpeedOfLight / attachExplorePath / clearGestalt
 *   Layer 1:   Categorical getters — stable primitives, any consumer composes
 *   Layer 2:   Convenience composers — gestalt-based derivation for known consumers
 *   Legacy:    Direct-read composers (forConsultation, forMotor, etc.) — used by
 *              non-task-scoped consumers and during migration to gestalt path
 *
 * Briefings have three parts:
 *   core       — task + intent + taste (what the system always had)
 *   enrichment — WM data, PNS capabilities (what the Thalamus adds)
 *   meta       — transparency: what was included and why
 */

import type {
  BriefingMeta,
  ConsultationBriefing,
  MotorBriefing,
  EvaluationBriefing,
  SchedulingBriefing,
  EscalationBriefing,
  EscalationRhythmContext,
  EscalationProjectSnapshot,
  IntegrationCheckBriefing,
  SenseQuestionBriefing,
  QuestionRouting,
  ProjectContext,
  AccumulatedContext,
  CapabilityContext,
  AccumulatedContextOpts,
  ThalamusSources,
  HippocampusSource,
  WorldModelSource,
  PrincipleSummary,
} from "../types/thalamus.js";
import type { BuildQuestion } from "../types/motor-cortex.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { InhibitionBriefing, SenseSummary } from "../types/basal-ganglia.js";
import type { CerebellumPrediction, ReceptorPrediction, SpeedOfLight, SenseCeiling } from "../types/cerebellum.js";
import type { EfferenceCopy } from "../types/efference-copy.js";
import type { ExplorePath } from "../types/explore.js";
import type { ForwardBriefing, HippocampusEpisodeSummary } from "../types/forward-briefing.js";
import type { Escalation, TaskGraphNode } from "../types/brainstem.js";
import type { RhythmPhase } from "../types/rhythm.js";
import type { ProjectIntent, TasteProfile } from "../types/intent.js";
import type { Task } from "../types/task.js";
import type { Consultation } from "../types/consultation.js";
import type { Sense } from "../types/sense.js";
import type {
  TaskGestalt,
  GestaltWeltanschauung,
  GestaltAccumulated,
  GestaltEpisodic,
  GestaltCapabilities,
  GestaltGraphPosition,
  GestaltAssemblyContext,
} from "../types/task-gestalt.js";
import type { WorkingMemory } from "./working-memory.js";
import type { PeripheralNervousSystem } from "./pns.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";

const log = createLogger("thalamus");

export class Thalamus {
  private wm: WorkingMemory;
  private pns?: PeripheralNervousSystem;
  private hippocampus?: HippocampusSource;
  private worldModel?: WorldModelSource;
  private intent?: ProjectIntent;
  private taste?: TasteProfile;
  private gestalts = new Map<string, TaskGestalt>();
  private taskModes = new Map<string, "explore" | "leverage">();
  private forwardBriefing: ForwardBriefing | null = null;
  private manifestedFuture: string | null = null;

  constructor(sources: ThalamusSources) {
    this.wm = sources.wm;
    this.pns = sources.pns;
    this.hippocampus = sources.hippocampus;
    this.worldModel = sources.worldModel;
  }

  // ── Project Binding ─────────────────────────────────────────────

  updateProject(intent: ProjectIntent, taste: TasteProfile): void {
    this.intent = intent;
    this.taste = taste;

    emit("thalamus:project-updated", {
      intentId: intent.id,
      tasteId: taste.id,
    });

    log.info("Project updated", {
      intentId: intent.id,
      tasteId: taste.id,
    });
  }

  /** Current taste profile, or undefined if no project is bound. */
  getTaste(): TasteProfile | undefined {
    return this.taste;
  }

  /**
   * Update the taste profile without changing the intent.
   * Used by satisfaction-signal when a human response mutates
   * a taste dimension. Propagates to all future briefings.
   */
  updateTaste(taste: TasteProfile): void {
    this.taste = taste;

    emit("thalamus:taste-updated", {
      tasteId: taste.id,
    });

    log.info("Taste profile updated", { tasteId: taste.id });
  }

  // ── Mode Binding ──────────────────────────────────────────────────

  /**
   * Store explore/leverage mode for a task.
   * Called by sensory-cortex.prepare with the scheduler's mode decision.
   * Shapes briefing framing: explore de-emphasizes patterns, leverage reinforces them.
   */
  setTaskMode(taskId: string, mode: "explore" | "leverage"): void {
    this.taskModes.set(taskId, mode);

    emit("thalamus:mode-set", { taskId, mode });
    log.info("Task mode set", { taskId, mode });
  }

  clearTaskMode(taskId: string): void {
    this.taskModes.delete(taskId);
  }

  getTaskMode(taskId: string): "explore" | "leverage" | undefined {
    return this.taskModes.get(taskId);
  }

  /**
   * Per-sense ceiling for a specific sense. Reads from the gestalt.
   * Used by forEvaluation() to give each evaluator its ceiling context.
   */
  getSenseCeiling(taskId: string, senseName: string): SenseCeiling | null {
    const gestalt = this.gestalts.get(taskId);
    const sol = gestalt?.speedOfLight;
    return sol?.perSense.find((s) => s.senseName === senseName) ?? null;
  }

  // ── Forward Briefing ───────────────────────────────────────────

  /**
   * Store a forward briefing from prospective preparation.
   * Called by task-dispatch.integrate() during between-tasks.
   * Consumed by assembleGestalt() for the next task.
   */
  setForwardBriefing(briefing: ForwardBriefing): void {
    this.forwardBriefing = briefing;

    emit("thalamus:forward-briefing-set", {
      tensionCount: briefing.predictedTensions.length,
      bottleneckCount: briefing.predictedBottlenecks.length,
      predictedCycles: briefing.predictedCycles,
    });

    log.info("Forward briefing stored", {
      tensions: briefing.predictedTensions.length,
      bottlenecks: briefing.predictedBottlenecks.length,
      predictedCycles: briefing.predictedCycles,
    });
  }

  /** Clear the forward briefing. */
  clearForwardBriefing(): void {
    this.forwardBriefing = null;
    log.debug("Forward briefing cleared");
  }

  /** Layer 1 getter: forward briefing (for non-gestalt consumers). */
  getForwardBriefing(): ForwardBriefing | null {
    return this.forwardBriefing;
  }

  // ── Manifested Future (Planner Phase A output) ──────────────────

  /**
   * Store the manifested future from Planner Phase A.
   * Called by the project rhythm after planning completes.
   * Flows into ForwardBriefing, ConvictionContext, DriftMonitor.
   */
  setManifestedFuture(future: string): void {
    this.manifestedFuture = future;

    emit("thalamus:manifested-future-set", {
      length: future.length,
    });

    log.info("Manifested future stored", {
      length: future.length,
      preview: future.slice(0, 120),
    });
  }

  /** Layer 1 getter: manifested future from Planner. */
  getManifestedFuture(): string | null {
    return this.manifestedFuture;
  }

  // ── Hippocampus Episode Summaries ─────────────────────────────

  /**
   * Layer 1 getter: lightweight episode summaries for prospective preparation.
   * Maps full hippocampus Episodes to the minimal shape prepareForward() needs.
   */
  getRecentEpisodeSummaries(count: number): HippocampusEpisodeSummary[] {
    if (!this.hippocampus) return [];

    return this.hippocampus.getRecentEpisodes(count).map((ep) => ({
      taskId: ep.taskId,
      cycles: ep.narrative.cycles,
      senseScores: ep.senseParticipation.map((sp) => ({
        senseName: sp.senseName,
        score: sp.finalScore,
      })),
      tensions: ep.narrative.tensionSnapshots.map((t) => ({
        senseA: t.senseA,
        senseB: t.senseB,
      })),
    }));
  }

  // ── Task Gestalt: Assembly + Lifecycle ──────────────────────────

  /**
   * Assemble the canonical per-task snapshot.
   *
   * Called once when a task is dispatched. Reads from all Thalamus
   * sources (WM, PNS, hippocampus, world model, intent, taste) and
   * fuses them with the task-specific context from the dispatch layer.
   *
   * The gestalt persists until clearGestalt() — all consumer briefings
   * within this task derive from it.
   */
  assembleGestalt(context: GestaltAssemblyContext): TaskGestalt {
    const { intent, taste } = this.getProjectContext();
    const taskId = context.task.id;

    // ── World model layer ───────────────────────────────────
    let weltanschauung: GestaltWeltanschauung | null = null;
    if (this.worldModel) {
      const snapshot = this.worldModel.getWeltanschauung();
      if (snapshot) {
        weltanschauung = {
          maxims: snapshot.crossProject.concat(snapshot.perProject)
            .map((m) => m.statement),
          fullMaxims: [...snapshot.crossProject, ...snapshot.perProject],
          sourcesSummary: snapshot.sourcesSummary,
          trigger: snapshot.trigger,
          synthesizedAt: snapshot.synthesizedAt,
        };
      }
    }

    // ── Accumulated context (WM snapshot) ───────────────────
    const accumulated = this.snapshotAccumulated();

    // ── Episodic memory ─────────────────────────────────────
    let episodic: GestaltEpisodic | null = null;
    if (this.hippocampus) {
      const allPrinciples = this.hippocampus.getActivePrinciples().map((p) => ({
        statement: p.statement,
        confidence: p.confidence,
        relevantSenses: p.relevantSenses,
      }));

      // Pre-index by sense for O(1) lookup in evaluation briefings
      const principlesBySense: Record<string, PrincipleSummary[]> = {};
      for (const p of allPrinciples) {
        for (const senseId of p.relevantSenses) {
          const key = senseId.toLowerCase();
          (principlesBySense[key] ??= []).push(p);
        }
      }

      episodic = { principles: allPrinciples, principlesBySense };
    }

    // ── Capabilities ────────────────────────────────────────
    const capabilities = this.snapshotCapabilities();

    // ── Graph position ──────────────────────────────────────
    let graphPosition: GestaltGraphPosition | null = null;
    if (context.graph) {
      const { nodes, completedTaskIds, escalatedTaskIds } = context.graph;
      const thisNode = nodes.find((n) => n.task.id === taskId);

      // Compute reverse dependencies
      const dependedOnBy: string[] = [];
      for (const node of nodes) {
        if (node.dependsOn.includes(taskId)) {
          dependedOnBy.push(node.task.id);
        }
      }

      // Phase group metrics
      const phaseGroup = thisNode?.phaseGroup;
      let completedInPhase: number | undefined;
      let totalInPhase: number | undefined;
      if (phaseGroup) {
        const phaseNodes = nodes.filter((n) => n.phaseGroup === phaseGroup);
        totalInPhase = phaseNodes.length;
        completedInPhase = phaseNodes.filter(
          (n) => completedTaskIds.has(n.task.id),
        ).length;
      }

      graphPosition = {
        totalTasks: nodes.length,
        completedTaskIds: [...completedTaskIds],
        escalatedTaskIds: [...escalatedTaskIds],
        dependsOn: thisNode?.dependsOn ?? [],
        dependedOnBy,
        phaseGroup,
        completedInPhase,
        totalInPhase,
      };
    }

    // ── Assemble ────────────────────────────────────────────
    const gestalt: TaskGestalt = {
      task: context.task,
      assembledAt: new Date(),
      intent,
      taste,
      weltanschauung,
      accumulated,
      episodic,
      capabilities,
      graphPosition,
      neLevel: context.neLevel,
      mode: context.mode,
      budgetPressure: context.budgetPressure,
      taskBudget: context.taskBudget,
      forwardBriefing: this.forwardBriefing ?? undefined,
      prospectiveDirectives: context.prospectiveDirectives,
    };

    this.gestalts.set(taskId, gestalt);

    // ── Pipeline boundary diagnostics: gestalt completeness ──
    // Warn when critical context layers are missing — downstream
    // consumers may produce lower-quality results without them.
    if (!weltanschauung) {
      emitWarn("pipeline:gestalt-missing-layer", { taskId }, {
        component: "thalamus",
        expected: "weltanschauung",
        received: undefined,
      });
    }
    if (!episodic || episodic.principles.length === 0) {
      emitWarn("pipeline:gestalt-missing-layer", { taskId }, {
        component: "thalamus",
        expected: "episodic-principles",
        received: episodic ? `${episodic.principles.length} principles` : undefined,
      });
    }
    if (accumulated.patterns.length === 0 && accumulated.decisions.length === 0 && accumulated.senseTrends.length === 0) {
      emitWarn("pipeline:gestalt-missing-layer", { taskId }, {
        component: "thalamus",
        expected: "accumulated-context",
        received: "empty — WM has no patterns, decisions, or trends",
      });
    }

    emit("thalamus:gestalt-assembled", {
      taskId,
      hasWeltanschauung: weltanschauung !== null,
      hasEpisodic: episodic !== null,
      hasProspectiveDirectives: !!context.prospectiveDirectives?.length,
      hasGraphPosition: graphPosition !== null,
      hasForwardBriefing: !!this.forwardBriefing,
      accumulatedPatterns: accumulated.patterns.length,
      accumulatedDecisions: accumulated.decisions.length,
      principleCount: episodic?.principles.length ?? 0,
    });

    log.info("Gestalt assembled", {
      taskId,
      weltanschauungMaxims: weltanschauung?.maxims.length ?? 0,
      principles: episodic?.principles.length ?? 0,
      graphPosition: graphPosition
        ? `${graphPosition.completedTaskIds.length}/${graphPosition.totalTasks} complete`
        : "none",
    });

    return gestalt;
  }

  /** Retrieve a task's gestalt, or null if not assembled. */
  getGestalt(taskId: string): TaskGestalt | null {
    return this.gestalts.get(taskId) ?? null;
  }

  /**
   * Attach a cerebellum prediction to an existing gestalt.
   * Called after consultation, when the cerebellum has enough
   * context to predict scores.
   */
  attachPrediction(taskId: string, prediction: CerebellumPrediction): void {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      log.warn("attachPrediction: no gestalt for task", { taskId });
      return;
    }
    this.gestalts.set(taskId, { ...gestalt, prediction });

    emit("thalamus:gestalt-prediction-attached", {
      taskId,
      receptorCount: prediction.receptorPredictions.length,
      overallConfidence: prediction.overallConfidence,
    });

    log.info("Prediction attached to gestalt", {
      taskId,
      receptors: prediction.receptorPredictions.length,
      confidence: prediction.overallConfidence,
    });
  }

  /**
   * Attach speed-of-light ceiling to an existing gestalt.
   * Called alongside prediction. Available even on cold start
   * (sense ceilings don't require historical episodes).
   */
  attachSpeedOfLight(taskId: string, sol: SpeedOfLight): void {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      log.warn("attachSpeedOfLight: no gestalt for task", { taskId });
      return;
    }
    this.gestalts.set(taskId, { ...gestalt, speedOfLight: sol });

    emit("thalamus:gestalt-sol-attached", {
      taskId,
      compositeCeiling: sol.compositeCeiling,
      hasHistory: sol.hasHistory,
      senseCount: sol.perSense.length,
    });

    log.info("Speed of light attached to gestalt", {
      taskId,
      compositeCeiling: sol.compositeCeiling.toFixed(1),
      hasHistory: sol.hasHistory,
    });
  }

  /**
   * Attach the selected explore path to an existing gestalt.
   * Called after the explore phase, before the build cycle.
   */
  attachExplorePath(taskId: string, path: ExplorePath): void {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      log.warn("attachExplorePath: no gestalt for task", { taskId });
      return;
    }
    this.gestalts.set(taskId, { ...gestalt, explorePath: path });

    emit("thalamus:gestalt-explore-attached", {
      taskId,
      pathName: path.name,
      archetypeTags: path.archetypeTags,
      score: path.surprise * path.quality,
    });

    log.info("Explore path attached to gestalt", {
      taskId,
      pathName: path.name,
      archetypeTags: path.archetypeTags,
    });
  }

  /**
   * Attach the Motor Cortex's efference copy to an existing gestalt.
   * Called before consultation, so the consultation briefing includes
   * the builder's feasibility assessment.
   */
  attachEfferenceCopy(taskId: string, efferenceCopy: EfferenceCopy): void {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      log.warn("attachEfferenceCopy: no gestalt for task", { taskId });
      return;
    }
    this.gestalts.set(taskId, { ...gestalt, efferenceCopy });

    emit("thalamus:gestalt-efference-attached", {
      taskId,
      senseCount: efferenceCopy.perSense.length,
      tensionCostCount: efferenceCopy.tensionCosts.length,
      overallFeasibility: efferenceCopy.overallFeasibility,
    });

    log.info("Efference copy attached to gestalt", {
      taskId,
      senseCount: efferenceCopy.perSense.length,
      overallFeasibility: efferenceCopy.overallFeasibility,
    });
  }

  /**
   * Clear a task's gestalt after the task completes.
   * Prevents accumulation of stale per-task state.
   */
  clearGestalt(taskId: string): void {
    this.gestalts.delete(taskId);
    log.debug("Gestalt cleared", { taskId });
  }

  // ── Private: Gestalt snapshot helpers ─────────────────────────

  /** Snapshot WM state for gestalt assembly. */
  private snapshotAccumulated(): GestaltAccumulated {
    return {
      patterns: this.wm.getPatterns(),
      decisions: this.wm.getDecisions(),
      senseTrends: this.wm.getSenseTrends(),
      receptorTrends: this.wm.getReceptorTrends(),
      inhibitedSenses: this.wm.getInhibitedSenses(),
      openQuestions: this.wm.getOpenQuestions(),
      completedSummaries: this.wm.getCompletedSummaries(),
      completedTaskCount: this.wm.getCompletedSummaries().length,
      load: this.wm.getLoad(),
    };
  }

  /** Snapshot PNS capabilities for gestalt assembly. */
  private snapshotCapabilities(): GestaltCapabilities {
    if (this.pns) {
      return {
        description: this.pns.describeCapabilities(),
        capabilities: this.pns.getCapabilities(),
      };
    }
    return {
      description: "No capabilities registered.",
      capabilities: [],
    };
  }

  // ── Layer 1: Categorical Getters ────────────────────────────────

  getProjectContext(): ProjectContext {
    if (!this.intent || !this.taste) {
      throw new Error(
        "Thalamus: project context unavailable — call updateProject() first",
      );
    }

    log.debug("getProjectContext", {
      intentId: this.intent.id,
      tasteId: this.taste.id,
    });

    return { intent: this.intent, taste: this.taste };
  }

  getAccumulatedContext(opts?: AccumulatedContextOpts): AccumulatedContext {
    let patterns = this.wm.getPatterns();
    const decisions = this.wm.getDecisions();
    let receptorTrends = this.wm.getReceptorTrends();
    const senseTrends = this.wm.getSenseTrends();
    const inhibitedSenses = this.wm.getInhibitedSenses();
    const openQuestions = this.wm.getOpenQuestions();
    const completedSummaries = this.wm.getCompletedSummaries();
    const load = this.wm.getLoad();

    // Filter receptor trends to a specific receptor if requested
    if (opts?.forReceptor) {
      receptorTrends = receptorTrends.filter(
        (t) => t.id === opts.forReceptor,
      );
    }

    // Filter patterns to those relevant to a specific sense
    if (opts?.forSense) {
      const senseName = opts.forSense.toLowerCase();
      patterns = patterns.filter((p) =>
        p.description.toLowerCase().includes(senseName),
      );
    }

    log.debug("getAccumulatedContext", {
      patterns: patterns.length,
      decisions: decisions.length,
      receptorTrends: receptorTrends.length,
      senseTrends: senseTrends.length,
      inhibitedSenses: inhibitedSenses.length,
      openQuestions: openQuestions.length,
      completedSummaries: completedSummaries.length,
      load,
    });

    return {
      patterns,
      decisions,
      receptorTrends,
      senseTrends,
      inhibitedSenses,
      openQuestions,
      completedSummaries,
      load,
    };
  }

  getCapabilityContext(): CapabilityContext {
    if (this.pns) {
      log.debug("getCapabilityContext", { source: "pns" });
      return {
        description: this.pns.describeCapabilities(),
        capabilities: this.pns.getCapabilities(),
      };
    }

    log.debug("getCapabilityContext", { source: "none" });
    return {
      description: "No capabilities registered.",
      capabilities: [],
    };
  }

  getActiveSenses(library: SensoryCortex): Sense[] {
    const allSenses = library.getSenses();
    const inhibited = this.wm.getInhibitedSenses();
    const inhibitedIds = new Set(inhibited.map((s) => s.senseId));

    const active: Sense[] = [];
    const filtered: { senseId: string; reason: string }[] = [];

    for (const sense of allSenses) {
      if (inhibitedIds.has(sense.id)) {
        const inhibition = inhibited.find((s) => s.senseId === sense.id)!;
        filtered.push({ senseId: sense.id, reason: inhibition.reason });
      } else {
        active.push(sense);
      }
    }

    emit("thalamus:sense-filtered", {
      total: allSenses.length,
      active: active.length,
      filtered,
    });

    return active;
  }

  // ── Layer 2: Convenience Composers ──────────────────────────────

  async forConsultation(task: Task): Promise<ConsultationBriefing> {
    const { intent, taste } = this.getProjectContext();
    const accumulated = this.getAccumulatedContext();

    const sources = ["working-memory"];
    if (this.intent) sources.push("intent");
    if (this.taste) sources.push("taste");

    // Hippocampus: include active principles
    const principles = this.getPrincipleSummaries();
    if (principles.length > 0) sources.push("hippocampus");

    // World Model: include maxims as the frame
    const maxims = this.getWorldModelMaxims();
    if (maxims.length > 0) sources.push("world-model");

    // PNS: capability grounding for sense recommendations
    const capSummary = this.pns?.describeCapabilities();
    const hasCaps = capSummary && capSummary !== "No capabilities available.";
    if (hasCaps) sources.push("pns");
    if (this.forwardBriefing) sources.push("forward-briefing");

    const lfb = this.forwardBriefing;

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      senseTrends: accumulated.senseTrends.length,
      inhibitedSenses: accumulated.inhibitedSenses.length,
      openQuestions: accumulated.openQuestions.length,
      principles: principles.length,
      worldModelMaxims: maxims.length,
      capabilities: hasCaps ? 1 : 0,
    };

    const briefing: ConsultationBriefing = {
      task,
      intent,
      taste,
      enrichment: {
        patterns: accumulated.patterns,
        decisions: accumulated.decisions,
        senseTrends: accumulated.senseTrends,
        inhibitedSenses: accumulated.inhibitedSenses,
        openQuestions: accumulated.openQuestions,
        completedTaskCount: accumulated.completedSummaries.length,
        capabilitySummary: hasCaps ? capSummary : undefined,
        principles: principles.length > 0 ? principles : undefined,
        worldModelMaxims: maxims.length > 0 ? maxims : undefined,
        predictedTensions: lfb?.predictedTensions.length
          ? lfb.predictedTensions : undefined,
        convictionNotes: lfb?.convictionCarryForward.notes.length
          ? lfb.convictionCarryForward.notes : undefined,
        mode: this.taskModes.get(task.id),
      },
      meta: this.meta("consultation", task.id, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "consultation",
      taskId: task.id,
      enrichmentCounts: counts,
    });

    log.info("Consultation briefing assembled", {
      taskId: task.id,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  async forMotor(task: Task, consultation: Consultation): Promise<MotorBriefing> {
    const { intent, taste } = this.getProjectContext();
    const accumulated = this.getAccumulatedContext();
    const capabilities = this.getCapabilityContext();

    const sources = ["working-memory"];
    if (this.intent) sources.push("intent");
    if (this.taste) sources.push("taste");
    if (this.pns) sources.push("pns");

    // Hippocampus: include principles relevant to active senses
    const principles = this.getPrincipleSummaries();
    if (principles.length > 0) sources.push("hippocampus");

    // World Model: include maxims as the frame
    const maxims = this.getWorldModelMaxims();
    if (maxims.length > 0) sources.push("world-model");

    const gestalt = this.gestalts.get(task.id);
    const prediction = gestalt?.prediction ?? null;
    if (prediction) sources.push("cerebellum");

    const speedOfLight = gestalt?.speedOfLight ?? null;
    if (speedOfLight) sources.push("cerebellum-ceiling");
    if (this.forwardBriefing) sources.push("forward-briefing");

    const lmfb = this.forwardBriefing;

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      scoreTrends: accumulated.receptorTrends.length,
      openQuestions: accumulated.openQuestions.length,
      principles: principles.length,
      worldModelMaxims: maxims.length,
      predictions: prediction?.receptorPredictions.length ?? 0,
    };

    const briefing: MotorBriefing = {
      task,
      intent,
      taste,
      consultation,
      enrichment: {
        patterns: accumulated.patterns,
        decisions: accumulated.decisions,
        scoreTrends: accumulated.receptorTrends,
        openQuestions: accumulated.openQuestions,
        capabilities: capabilities.description,
        principles: principles.length > 0 ? principles : undefined,
        prediction: prediction ?? undefined,
        speedOfLight: speedOfLight ?? undefined,
        worldModelMaxims: maxims.length > 0 ? maxims : undefined,
        predictedCycles: lmfb?.predictedCycles ?? undefined,
        approachNotes: lmfb?.convictionCarryForward.reshapeGuidance
          ? [lmfb.convictionCarryForward.reshapeGuidance] : undefined,
        bottleneckSenses: lmfb?.predictedBottlenecks.length
          ? lmfb.predictedBottlenecks.map((b) => b.sense) : undefined,
        mode: this.taskModes.get(task.id),
      },
      meta: this.meta("motor", task.id, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "motor",
      taskId: task.id,
      enrichmentCounts: counts,
    });

    log.info("Motor briefing assembled", {
      taskId: task.id,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  async forEvaluation(
    task: Task,
    receptorId: string,
    activationPath: string[],
  ): Promise<EvaluationBriefing> {
    const accumulated = this.getAccumulatedContext({
      forReceptor: receptorId,
      forSense: activationPath[0],
    });

    const sources = ["working-memory"];

    // Hippocampus: principles specific to this evaluator's sense
    const senseName = activationPath[0];
    const principles = senseName
      ? this.getPrincipleSummariesForSense(senseName)
      : [];
    if (principles.length > 0) sources.push("hippocampus");

    const gestalt = this.gestalts.get(task.id);
    const taskPrediction = gestalt?.prediction ?? null;
    let receptorPrediction: ReceptorPrediction | undefined;
    if (taskPrediction) {
      receptorPrediction = taskPrediction.receptorPredictions.find(
        (p) => p.receptorId === receptorId,
      );
      if (receptorPrediction) sources.push("cerebellum");
    }

    const senseCeiling = senseName
      ? this.getSenseCeiling(task.id, senseName) ?? undefined
      : undefined;
    if (senseCeiling) sources.push("cerebellum-ceiling");

    const counts: Record<string, number> = {
      receptorTrends: accumulated.receptorTrends.length,
      relevantPatterns: accumulated.patterns.length,
      relevantPrinciples: principles.length,
      prediction: receptorPrediction ? 1 : 0,
    };

    // Bottleneck flag from forward briefing
    const legacyBottleneck = senseName && this.forwardBriefing
      ? this.forwardBriefing.predictedBottlenecks.some(
          (b) => b.sense.toLowerCase() === senseName.toLowerCase(),
        )
      : undefined;

    const briefing: EvaluationBriefing = {
      receptorTrends: accumulated.receptorTrends,
      relevantPatterns: accumulated.patterns,
      relevantPrinciples: principles.length > 0 ? principles : undefined,
      prediction: receptorPrediction,
      senseCeiling,
      isBottleneck: legacyBottleneck || undefined,
      meta: this.meta("evaluation", task.id, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "evaluation",
      taskId: task.id,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  async forScheduling(): Promise<SchedulingBriefing> {
    const accumulated = this.getAccumulatedContext();

    const sources = ["working-memory"];

    const counts: Record<string, number> = {
      tasks: this.wm.getTasks().length,
      senseTrends: accumulated.senseTrends.length,
      completedSummaries: accumulated.completedSummaries.length,
      openQuestions: accumulated.openQuestions.length,
    };

    const briefing: SchedulingBriefing = {
      tasks: this.wm.getTasks(),
      senseTrends: accumulated.senseTrends,
      completedSummaries: accumulated.completedSummaries,
      load: accumulated.load,
      openQuestions: accumulated.openQuestions,
      meta: this.meta("scheduling", undefined, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "scheduling",
      enrichmentCounts: counts,
    });

    return briefing;
  }

  async forEscalation(
    escalation: Escalation,
    rhythmState: {
      id: string;
      rhythmType: string;
      phase: RhythmPhase;
      completedCycles: number;
      parentRhythmType?: string;
    },
  ): Promise<EscalationBriefing> {
    const accumulated = this.getAccumulatedContext();

    const sources = ["working-memory"];
    if (this.intent) sources.push("intent");
    if (this.worldModel) sources.push("world-model");

    const worldModelMaxims = this.getWorldModelMaxims();

    const rhythmContext: EscalationRhythmContext = {
      rhythmId: rhythmState.id,
      rhythmType: rhythmState.rhythmType,
      phase: rhythmState.phase,
      cycle: rhythmState.completedCycles,
      parentRhythmType: rhythmState.parentRhythmType,
    };

    const projectSnapshot: EscalationProjectSnapshot = {
      intentSummary: this.intent?.summary ?? "Unknown",
      completedTasks: accumulated.completedSummaries.length,
      totalTasks: this.wm.getTasks().length,
      openQuestions: accumulated.openQuestions,
      senseTrends: accumulated.senseTrends,
      worldModelMaxims: worldModelMaxims.length > 0 ? worldModelMaxims : undefined,
    };

    const counts: Record<string, number> = {
      openQuestions: accumulated.openQuestions.length,
      senseTrends: accumulated.senseTrends.length,
      completedTasks: accumulated.completedSummaries.length,
      worldModelMaxims: worldModelMaxims.length,
    };

    const briefing: EscalationBriefing = {
      escalation,
      rhythmContext,
      projectSnapshot,
      meta: this.meta("escalation", undefined, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "escalation",
      enrichmentCounts: counts,
    });

    log.info("Escalation briefing assembled", {
      source: escalation.source,
      severity: escalation.severity,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  async forInhibition(
    library: SensoryCortex,
    task?: Task,
    neLevel?: number,
    mode?: "explore" | "leverage",
  ): Promise<InhibitionBriefing> {
    const { intent, taste } = this.getProjectContext();
    const accumulated = this.getAccumulatedContext();

    const allSenses = library.getSenses();
    const senses: SenseSummary[] = allSenses.map((s) => ({
      id: s.id,
      name: s.name,
      sensitivity: s.sensitivity,
      activationHint: s.activationHint,
    }));

    const sources = ["working-memory", "sense-library"];
    if (this.intent) sources.push("intent");
    if (this.taste) sources.push("taste");

    const counts: Record<string, number> = {
      senses: senses.length,
      currentInhibitions: accumulated.inhibitedSenses.length,
      senseTrends: accumulated.senseTrends.length,
      patterns: accumulated.patterns.length,
    };

    const dissolvedTaste = this.dissolveTaste(taste, "inhibition", task);

    const briefing: InhibitionBriefing = {
      intent,
      taste,
      task,
      enrichment: {
        senses,
        currentInhibitions: accumulated.inhibitedSenses,
        senseTrends: accumulated.senseTrends,
        patterns: accumulated.patterns,
        neLevel,
        mode,
        totalSenseCount: allSenses.length,
        dissolvedTaste,
      },
      meta: this.meta("inhibition", task?.id, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "inhibition",
      taskId: task?.id,
      enrichmentCounts: counts,
    });

    log.info("Inhibition briefing assembled", {
      taskId: task?.id,
      senseCount: senses.length,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  // ── Integration Check Briefing ──────────────────────────────────

  /**
   * Assemble a briefing for phase gate integration checking.
   *
   * Collects work from all phase tasks, plus accumulated context
   * (patterns, trends, principles) for sense evaluators to judge
   * cross-task coherence against the gate condition.
   */
  forIntegrationCheck(
    phaseGroup: string,
    gateCondition: string,
    graph: TaskGraphNode[],
    taskResults: Map<string, OrchestratorResult>,
  ): IntegrationCheckBriefing {
    const phaseNodes = graph.filter((n) => n.phaseGroup === phaseGroup);

    // Collect work + description + confidence from each phase task
    const phaseWork: IntegrationCheckBriefing["phaseWork"] = [];
    for (const node of phaseNodes) {
      const result = taskResults.get(node.task.id);
      if (result) {
        phaseWork.push({
          taskId: node.task.id,
          description: node.task.description,
          work: result.work,
          confidence: result.confidence,
        });
      }
    }

    // Accumulated context from WM
    const accumulated = this.getAccumulatedContext();

    // Principles from hippocampus (if available)
    const principles: PrincipleSummary[] = [];
    if (this.hippocampus) {
      const allPrinciples = this.hippocampus.getActivePrinciples();
      for (const p of allPrinciples.slice(0, 10)) {
        principles.push({
          statement: p.statement,
          confidence: p.confidence,
          relevantSenses: p.relevantSenses ?? [],
        });
      }
    }

    const sources = ["working-memory", "task-results"];
    if (this.intent) sources.push("intent");
    if (this.taste) sources.push("taste");
    if (this.manifestedFuture) sources.push("manifested-future");
    if (this.hippocampus) sources.push("hippocampus");

    const counts: Record<string, number> = {
      phaseTasks: phaseWork.length,
      patterns: accumulated.patterns.length,
      senseTrends: accumulated.senseTrends.length,
      principles: principles.length,
    };

    const briefing: IntegrationCheckBriefing = {
      phaseGroup,
      gateCondition,
      manifestedFuture: this.getManifestedFuture(),
      phaseWork,
      enrichment: {
        patterns: accumulated.patterns,
        senseTrends: accumulated.senseTrends,
        principles,
      },
      meta: this.meta("integration-check", undefined, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "integration-check",
      phaseGroup,
      enrichmentCounts: counts,
    });

    log.info("Integration check briefing assembled", {
      phaseGroup,
      phaseTaskCount: phaseWork.length,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  // ── Layer 3: Gestalt-Based Derivation ───────────────────────────
  //
  // These methods derive consumer briefings from an assembled gestalt
  // instead of re-reading all sources. Used by the rhythm layer after
  // assembleGestalt() has been called for the task.
  //
  // Non-task-scoped consumers (forScheduling, project/phase-level
  // forInhibition) stay on the direct-read path above.

  /**
   * Derive a consultation briefing from the task's gestalt.
   * Replaces forConsultation(task) for gestalt-wired rhythms.
   */
  forConsultationFromGestalt(taskId: string): ConsultationBriefing {
    const g = this.requireGestalt(taskId);

    const sources = ["gestalt", "working-memory"];
    if (g.episodic) sources.push("hippocampus");
    if (g.weltanschauung) sources.push("world-model");
    if (g.graphPosition) sources.push("task-graph");
    if (g.forwardBriefing) sources.push("forward-briefing");
    if (g.efferenceCopy) sources.push("efference-copy");
    const hasCaps = g.capabilities.capabilities.length > 0;
    if (hasCaps) sources.push("pns");

    const principles = g.episodic?.principles;
    const maxims = g.weltanschauung?.maxims;
    const fb = g.forwardBriefing;
    const ec = g.efferenceCopy;

    const counts: Record<string, number> = {
      patterns: g.accumulated.patterns.length,
      decisions: g.accumulated.decisions.length,
      senseTrends: g.accumulated.senseTrends.length,
      inhibitedSenses: g.accumulated.inhibitedSenses.length,
      openQuestions: g.accumulated.openQuestions.length,
      principles: principles?.length ?? 0,
      worldModelMaxims: maxims?.length ?? 0,
      capabilities: g.capabilities.capabilities.length,
      predictedTensions: fb?.predictedTensions.length ?? 0,
      convictionNotes: fb?.convictionCarryForward.notes.length ?? 0,
      efferenceCopy: ec?.perSense.length ?? 0,
    };

    // Budget-aware extraction depth:
    // Combines NE level and budget pressure to determine how much
    // enrichment to include. On cold start, defaults to "standard".
    // As the Cerebellum learns context fidelity, this will be replaced
    // by learned depth selection (see types/cost.ts BriefingDepth doc).
    const ne = g.neLevel ?? 0.5;
    const bp = g.budgetPressure ?? 0;
    // compressed: low NE OR high budget pressure
    // minimal: both low NE AND high budget pressure
    const minimal = ne < 0.3 && bp > 0.7;
    const compressed = minimal || ne < 0.3 || bp > 0.7;
    const depth: import("../types/cost.js").BriefingDepth =
      minimal ? "minimal" : compressed ? "compressed" : ne > 0.7 && bp < 0.3 ? "full" : "standard";

    const droppedSections: string[] = [];

    const briefing: ConsultationBriefing = {
      task: g.task,
      intent: g.intent,
      taste: g.taste,
      enrichment: {
        dissolvedTaste: compressed ? undefined : this.dissolveTaste(g.taste, "consultation", g.task),
        patterns: minimal ? [] : g.accumulated.patterns,
        decisions: minimal ? [] : g.accumulated.decisions,
        senseTrends: compressed ? [] : g.accumulated.senseTrends,
        inhibitedSenses: g.accumulated.inhibitedSenses,
        openQuestions: compressed ? [] : g.accumulated.openQuestions,
        completedTaskCount: g.accumulated.completedTaskCount,
        capabilitySummary: compressed ? undefined : (hasCaps ? g.capabilities.description : undefined),
        principles: compressed ? undefined : (principles && principles.length > 0 ? principles : undefined),
        worldModelMaxims: compressed ? undefined : (maxims && maxims.length > 0 ? maxims : undefined),
        predictedTensions: fb?.predictedTensions.length
          ? fb.predictedTensions : undefined,
        convictionNotes: compressed ? undefined : (fb?.convictionCarryForward.notes.length
          ? fb.convictionCarryForward.notes : undefined),
        prospectiveDirectives: compressed ? undefined : (g.prospectiveDirectives?.length
          ? g.prospectiveDirectives : undefined),
        // Efference copy: builder's feasibility assessment dissolved into consultation
        efferenceCopy: compressed ? undefined : (ec?.perSense.length
          ? ec.perSense : undefined),
        efferenceTensionCosts: compressed ? undefined : (ec?.tensionCosts.length
          ? ec.tensionCosts : undefined),
        efferenceHardConstraints: compressed ? undefined : (ec?.hardConstraints.length
          ? ec.hardConstraints : undefined),
      },
      meta: {
        ...this.meta("consultation", taskId, sources, counts),
        depth,
        droppedSections: compressed
          ? ["capabilities", "principles", "worldModel", "efference", "senseTrends"].filter(
              (s) => counts[s] !== undefined && counts[s] > 0,
            )
          : undefined,
      },
    };

    // Track dropped sections
    if (minimal) droppedSections.push("patterns", "decisions");
    if (compressed) droppedSections.push("capabilities", "principles", "worldModel", "efference", "senseTrends", "openQuestions");

    emit("thalamus:briefing", {
      consumer: "consultation",
      taskId,
      enrichmentCounts: counts,
      fromGestalt: true,
      depth,
      budgetPressure: bp,
      droppedSections: droppedSections.length > 0 ? droppedSections : undefined,
    });

    log.info("Consultation briefing derived from gestalt", {
      taskId,
      enrichmentCounts: counts,
      depth,
    });

    return briefing;
  }

  /**
   * Derive a motor briefing from the task's gestalt.
   * Consultation is passed as argument — it's produced during the
   * task lifecycle, not present at gestalt assembly time.
   */
  forMotorFromGestalt(taskId: string, consultation: Consultation): MotorBriefing {
    const g = this.requireGestalt(taskId);

    const sources = ["gestalt", "working-memory"];
    if (g.capabilities.capabilities.length > 0) sources.push("pns");
    if (g.episodic) sources.push("hippocampus");
    if (g.weltanschauung) sources.push("world-model");
    if (g.prediction) sources.push("cerebellum");
    if (g.speedOfLight) sources.push("cerebellum-ceiling");
    if (g.graphPosition) sources.push("task-graph");
    if (g.forwardBriefing) sources.push("forward-briefing");
    if (g.explorePath) sources.push("explore-phase");

    const principles = g.episodic?.principles;
    const maxims = g.weltanschauung?.maxims;
    const mfb = g.forwardBriefing;

    const counts: Record<string, number> = {
      patterns: g.accumulated.patterns.length,
      decisions: g.accumulated.decisions.length,
      scoreTrends: g.accumulated.receptorTrends.length,
      openQuestions: g.accumulated.openQuestions.length,
      principles: principles?.length ?? 0,
      worldModelMaxims: maxims?.length ?? 0,
      predictions: g.prediction?.receptorPredictions.length ?? 0,
      predictedCycles: mfb?.predictedCycles ?? 0,
      bottleneckSenses: mfb?.predictedBottlenecks.length ?? 0,
      explorePath: g.explorePath ? 1 : 0,
    };

    // Budget-aware extraction depth (same logic as consultation)
    const motorNE = g.neLevel ?? 0.5;
    const motorBP = g.budgetPressure ?? 0;
    const motorMinimal = motorNE < 0.3 && motorBP > 0.7;
    const motorCompressed = motorMinimal || motorNE < 0.3 || motorBP > 0.7;
    const motorDepth: import("../types/cost.js").BriefingDepth =
      motorMinimal ? "minimal" : motorCompressed ? "compressed" : motorNE > 0.7 && motorBP < 0.3 ? "full" : "standard";

    const briefing: MotorBriefing = {
      task: g.task,
      intent: g.intent,
      taste: g.taste,
      consultation,
      enrichment: {
        dissolvedTaste: motorCompressed ? undefined : this.dissolveTaste(g.taste, "motor", g.task),
        patterns: motorMinimal ? [] : g.accumulated.patterns,
        decisions: motorMinimal ? [] : g.accumulated.decisions,
        scoreTrends: motorCompressed ? [] : g.accumulated.receptorTrends,
        openQuestions: motorCompressed ? [] : g.accumulated.openQuestions,
        capabilities: g.capabilities.description,
        principles: motorCompressed ? undefined : (principles && principles.length > 0 ? principles : undefined),
        prediction: motorCompressed ? undefined : (g.prediction ?? undefined),
        speedOfLight: motorCompressed ? undefined : (g.speedOfLight ?? undefined),
        worldModelMaxims: motorCompressed ? undefined : (maxims && maxims.length > 0 ? maxims : undefined),
        predictedCycles: mfb?.predictedCycles ?? undefined,
        approachNotes: mfb?.convictionCarryForward.reshapeGuidance
          ? [mfb.convictionCarryForward.reshapeGuidance] : undefined,
        bottleneckSenses: mfb?.predictedBottlenecks.length
          ? mfb.predictedBottlenecks.map((b) => b.sense) : undefined,
        prospectiveDirectives: motorCompressed ? undefined : (g.prospectiveDirectives?.length
          ? g.prospectiveDirectives : undefined),
        selectedPath: g.explorePath ?? undefined,
      },
      meta: {
        ...this.meta("motor", taskId, sources, counts),
        depth: motorDepth,
      },
    };

    emit("thalamus:briefing", {
      consumer: "motor",
      taskId,
      enrichmentCounts: counts,
      fromGestalt: true,
      depth: motorDepth,
      budgetPressure: motorBP,
    });

    log.info("Motor briefing derived from gestalt", {
      taskId,
      enrichmentCounts: counts,
      depth: motorDepth,
    });

    return briefing;
  }

  /**
   * Derive an evaluation briefing from the task's gestalt.
   * Uses pre-indexed principlesBySense for O(1) sense lookup.
   */
  forEvaluationFromGestalt(
    taskId: string,
    receptorId: string,
    activationPath: string[],
  ): EvaluationBriefing {
    const g = this.requireGestalt(taskId);
    const senseName = activationPath[0];

    // Filter receptor trends to this specific receptor
    const receptorTrends = g.accumulated.receptorTrends.filter(
      (t) => t.id === receptorId,
    );

    // Filter patterns to those relevant to this sense
    const relevantPatterns = senseName
      ? g.accumulated.patterns.filter((p) =>
          p.description.toLowerCase().includes(senseName.toLowerCase()),
        )
      : g.accumulated.patterns;

    // O(1) principle lookup from pre-indexed gestalt
    const principles = senseName && g.episodic
      ? g.episodic.principlesBySense[senseName.toLowerCase()] ?? []
      : [];

    // Extract this receptor's prediction
    let receptorPrediction: ReceptorPrediction | undefined;
    if (g.prediction) {
      receptorPrediction = g.prediction.receptorPredictions.find(
        (p) => p.receptorId === receptorId,
      );
    }

    // Extract this sense's ceiling
    const senseCeiling = senseName && g.speedOfLight
      ? g.speedOfLight.perSense.find((s) => s.senseName === senseName) ?? undefined
      : undefined;

    const sources = ["gestalt"];
    if (principles.length > 0) sources.push("hippocampus");
    if (receptorPrediction) sources.push("cerebellum");
    if (senseCeiling) sources.push("cerebellum-ceiling");

    const counts: Record<string, number> = {
      receptorTrends: receptorTrends.length,
      relevantPatterns: relevantPatterns.length,
      relevantPrinciples: principles.length,
      prediction: receptorPrediction ? 1 : 0,
    };

    // Budget-aware extraction depth
    const evalNE = g.neLevel ?? 0.5;
    const evalBP = g.budgetPressure ?? 0;
    const evalCompressed = evalNE < 0.3 || evalBP > 0.7;
    const evalDepth: import("../types/cost.js").BriefingDepth =
      evalCompressed ? "compressed" : evalNE > 0.7 && evalBP < 0.3 ? "full" : "standard";

    // Bottleneck flag from forward briefing
    const isBottleneck = senseName && g.forwardBriefing
      ? g.forwardBriefing.predictedBottlenecks.some(
          (b) => b.sense.toLowerCase() === senseName.toLowerCase(),
        )
      : undefined;

    const briefing: EvaluationBriefing = {
      receptorTrends,
      relevantPatterns,
      relevantPrinciples: evalCompressed ? undefined : (principles.length > 0 ? principles : undefined),
      prediction: evalCompressed ? undefined : receptorPrediction,
      senseCeiling: evalCompressed ? undefined : senseCeiling,
      isBottleneck: isBottleneck || undefined,
      meta: {
        ...this.meta("evaluation", taskId, sources, counts),
        depth: evalDepth,
      },
    };

    emit("thalamus:briefing", {
      consumer: "evaluation",
      taskId,
      enrichmentCounts: counts,
      fromGestalt: true,
      depth: evalDepth,
      budgetPressure: evalBP,
    });

    return briefing;
  }

  /**
   * Derive an inhibition briefing from the task's gestalt.
   * For task-scoped inhibition only — project/phase scope uses
   * the direct-read forInhibition() above.
   */
  forInhibitionFromGestalt(
    taskId: string,
    library: SensoryCortex,
  ): InhibitionBriefing {
    const g = this.requireGestalt(taskId);

    const allSenses = library.getSenses();
    const senses: SenseSummary[] = allSenses.map((s) => ({
      id: s.id,
      name: s.name,
      sensitivity: s.sensitivity,
      activationHint: s.activationHint,
    }));

    const sources = ["gestalt", "sense-library"];

    const counts: Record<string, number> = {
      senses: senses.length,
      currentInhibitions: g.accumulated.inhibitedSenses.length,
      senseTrends: g.accumulated.senseTrends.length,
      patterns: g.accumulated.patterns.length,
    };

    const briefing: InhibitionBriefing = {
      intent: g.intent,
      taste: g.taste,
      task: g.task,
      enrichment: {
        senses,
        currentInhibitions: g.accumulated.inhibitedSenses,
        senseTrends: g.accumulated.senseTrends,
        patterns: g.accumulated.patterns,
        neLevel: g.neLevel,
        mode: g.mode,
        totalSenseCount: allSenses.length,
      },
      meta: this.meta("inhibition", taskId, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "inhibition",
      taskId,
      enrichmentCounts: counts,
      fromGestalt: true,
    });

    log.info("Inhibition briefing derived from gestalt", {
      taskId,
      senseCount: senses.length,
      enrichmentCounts: counts,
    });

    return briefing;
  }

  // ── Private: Gestalt helpers ──────────────────────────────────

  /** Get a gestalt or throw — for derivation methods that require one. */
  private requireGestalt(taskId: string): TaskGestalt {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      throw new Error(
        `Thalamus: no gestalt for task ${taskId} — call assembleGestalt() first`,
      );
    }
    return gestalt;
  }

  // ── Taste Dissolution ────────────────────────────────────────────
  //
  // "The taste profile is a source the distiller draws from, never a
  // document the agent reads." Taste dissolution rewrites the raw taste
  // profile into consumer-specific natural language guidance, dissolved
  // into the task's context so it shapes behavior without being a
  // separate document the consumer has to parse.

  /**
   * Dissolve a taste profile into task-specific natural language guidance
   * for a given consumer. This is a pure contextual extraction — no LLM
   * call in the current implementation. The rewriting is deterministic,
   * selecting and phrasing the relevant taste dimensions for the consumer.
   *
   * Consumer types shape what's extracted:
   *   consultation: visual, patterns, communication style
   *   motor:        patterns, decisionStyle, visual, communication
   *   evaluation:   all dimensions (evaluators need the full picture)
   *   inhibition:   patterns, decisionStyle (what matters for sense selection)
   */
  dissolveTaste(
    taste: TasteProfile,
    consumer: "consultation" | "motor" | "evaluation" | "inhibition",
    task?: import("../types/task.js").Task,
  ): string {
    const lines: string[] = [];

    // All consumers get the persona frame
    lines.push(`Working for ${taste.name}.`);

    switch (consumer) {
      case "consultation":
        // Senses need to know preferences that shape what "good" looks like
        if (taste.visual) lines.push(`Visual preferences: ${taste.visual}`);
        if (taste.patterns) lines.push(`Established patterns: ${taste.patterns}`);
        if (taste.communication) lines.push(`Communication style: ${taste.communication}`);
        break;

      case "motor":
        // Builder needs actionable style guidance
        if (taste.patterns) lines.push(`Follow these patterns: ${taste.patterns}`);
        if (taste.decisionStyle) lines.push(`Decision style: ${taste.decisionStyle}`);
        if (taste.visual) lines.push(`Visual approach: ${taste.visual}`);
        if (taste.communication) lines.push(`Tone: ${taste.communication}`);
        break;

      case "evaluation":
        // Evaluators need the complete picture to assess alignment
        if (taste.visual) lines.push(`Visual standard: ${taste.visual}`);
        if (taste.decisionStyle) lines.push(`Decision style: ${taste.decisionStyle}`);
        if (taste.communication) lines.push(`Communication expectation: ${taste.communication}`);
        if (taste.patterns) lines.push(`Pattern alignment: ${taste.patterns}`);
        // Include any raw dimensions not captured by the structured fields
        for (const [key, value] of Object.entries(taste.raw)) {
          if (!["visual", "decisionStyle", "communication", "patterns"].includes(key)) {
            lines.push(`${key}: ${value}`);
          }
        }
        break;

      case "inhibition":
        // Sense selection needs pattern + decision style to judge relevance
        if (taste.patterns) lines.push(`Patterns: ${taste.patterns}`);
        if (taste.decisionStyle) lines.push(`Decision style: ${taste.decisionStyle}`);
        break;
    }

    const dissolved = lines.join(" ");

    emit("thalamus:taste-dissolved", {
      consumer,
      taskId: task?.id,
      tasteName: taste.name,
      lineCount: lines.length,
    });

    return dissolved;
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /** Get all active principles as simplified summaries for briefings. */
  private getPrincipleSummaries(): PrincipleSummary[] {
    if (!this.hippocampus) return [];

    return this.hippocampus.getActivePrinciples().map((p) => ({
      statement: p.statement,
      confidence: p.confidence,
      relevantSenses: p.relevantSenses,
    }));
  }

  /** Get world model maxims as statement strings for briefing inclusion. */
  private getWorldModelMaxims(): string[] {
    if (!this.worldModel) return [];
    return this.worldModel.getMaximsForBriefing();
  }

  /** Get principles relevant to a specific sense. */
  private getPrincipleSummariesForSense(senseId: string): PrincipleSummary[] {
    if (!this.hippocampus) return [];

    return this.hippocampus.getPrinciplesForSense(senseId).map((p) => ({
      statement: p.statement,
      confidence: p.confidence,
      relevantSenses: p.relevantSenses,
    }));
  }

  // ── Mid-Build Sense Consultation ──────────────────────────────
  //
  // When the Motor Cortex hits ambiguity during building, it asks a
  // targeted question. The Thalamus routes it to the right sense based
  // on dimension matching and stake analysis. If no sense can answer,
  // the question escalates to the user.

  /**
   * Route a mid-build question to the right sense or escalate to user.
   *
   * Deterministic routing:
   *   1. If targetDimension matches a sense name/ID → route to that sense
   *   2. If no match → find the sense with the highest stake in the task
   *   3. If no sense has stake above threshold → route to user
   *
   * The minimum stake threshold (0.3) ensures we don't route questions to
   * senses that are only marginally relevant. Better to ask the user than
   * get a low-confidence answer from a sense that doesn't really own the dimension.
   */
  routeBuildQuestion(
    question: BuildQuestion,
    consultation: Consultation,
  ): QuestionRouting {
    const STAKE_THRESHOLD = 0.3;
    const perspectives = consultation.perspectives;

    // 1. Try matching targetDimension against sense names/IDs
    if (question.targetDimension) {
      const dimLower = question.targetDimension.toLowerCase();
      const dimensionMatch = perspectives.find(
        (p) =>
          p.senseId.toLowerCase() === dimLower ||
          p.senseName.toLowerCase() === dimLower ||
          p.senseName.toLowerCase().includes(dimLower),
      );

      if (dimensionMatch && dimensionMatch.stake >= STAKE_THRESHOLD) {
        log.info("Build question routed to sense by dimension match", {
          questionId: question.id,
          targetDimension: question.targetDimension,
          senseId: dimensionMatch.senseId,
          stake: dimensionMatch.stake,
        });

        emit("thalamus:question-routed", {
          questionId: question.id,
          route: "sense",
          targetSenseId: dimensionMatch.senseId,
          mechanism: "dimension-match",
        });

        return {
          questionId: question.id,
          route: "sense",
          targetSenseId: dimensionMatch.senseId,
          rationale: `Question targets "${question.targetDimension}" — ${dimensionMatch.senseName} owns this dimension (stake: ${dimensionMatch.stake.toFixed(2)}).`,
        };
      }
    }

    // 2. Fall back to highest-stake sense
    const byStake = [...perspectives].sort((a, b) => b.stake - a.stake);
    const topSense = byStake[0];

    if (topSense && topSense.stake >= STAKE_THRESHOLD) {
      log.info("Build question routed to highest-stake sense", {
        questionId: question.id,
        senseId: topSense.senseId,
        stake: topSense.stake,
      });

      emit("thalamus:question-routed", {
        questionId: question.id,
        route: "sense",
        targetSenseId: topSense.senseId,
        mechanism: "highest-stake",
      });

      return {
        questionId: question.id,
        route: "sense",
        targetSenseId: topSense.senseId,
        rationale: `No dimension match — routing to ${topSense.senseName} as highest-stake sense (stake: ${topSense.stake.toFixed(2)}).`,
      };
    }

    // 3. No sense has sufficient stake — escalate to user
    log.info("Build question escalating to user — no sense above stake threshold", {
      questionId: question.id,
      topStake: topSense?.stake,
    });

    emit("thalamus:question-routed", {
      questionId: question.id,
      route: "user",
      mechanism: "no-sense-above-threshold",
    });

    return {
      questionId: question.id,
      route: "user",
      rationale: `No sense has sufficient stake to answer (highest: ${topSense?.stake.toFixed(2) ?? "none"}). Escalating to user.`,
    };
  }

  /**
   * Assemble a briefing for a sense answering a mid-build question.
   * Lighter than a full consultation — just enough context for a targeted answer.
   */
  forSenseQuestion(
    question: BuildQuestion,
    routing: QuestionRouting,
    consultation: Consultation,
    buildProgress?: string,
  ): SenseQuestionBriefing {
    const taskId = question.taskId;
    const senseId = routing.targetSenseId!;

    // Find the sense's original perspective
    const perspective = consultation.perspectives.find(
      (p) => p.senseId === senseId,
    );

    const gestalt = this.gestalts.get(taskId);
    const task = gestalt?.task ?? { id: taskId, description: "unknown" } as Task;

    const sources = ["consultation", "build-context"];
    if (gestalt) sources.push("gestalt");

    const counts: Record<string, number> = {
      options: question.options?.length ?? 0,
    };

    const briefing: SenseQuestionBriefing = {
      question,
      originalPerspective: perspective?.perspective ?? "(no prior perspective)",
      task,
      buildProgress,
      meta: this.meta("sense-question", taskId, sources, counts),
    };

    emit("thalamus:briefing", {
      consumer: "sense-question",
      taskId,
      targetSenseId: senseId,
      enrichmentCounts: counts,
    });

    log.info("Sense question briefing assembled", {
      questionId: question.id,
      taskId,
      targetSenseId: senseId,
    });

    return briefing;
  }

  private meta(
    consumer: string,
    taskId: string | undefined,
    sources: string[],
    counts: Record<string, number>,
  ): BriefingMeta {
    // Specification artistry: derive toneDirectiveness from gestalt NE.
    // High NE → prescriptive (1.0). Low NE → invitational (0.0).
    // When conviction data flows through the gestalt (future), blend it in.
    let toneDirectiveness: number | undefined;
    if (taskId) {
      const gestalt = this.gestalts.get(taskId);
      if (gestalt?.neLevel !== undefined) {
        toneDirectiveness = gestalt.neLevel;
      }
    }

    return {
      consumer,
      taskId,
      assembledAt: new Date(),
      sources,
      enrichmentCounts: counts,
      toneDirectiveness,
    };
  }
}
