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
 *   core       — task + intent + taste (what Cortex always had)
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
  ObservationHarvestOpts,
  ObservationHarvest,
  AwarenessInsight,
  AwarenessSource,
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
import type { TerritoryObservation } from "../types/territory-observation.js";
import { relevanceThreshold } from "../types/territory-observation.js";
import type { WorkingMemory } from "./working-memory.js";
import type { PeripheralNervousSystem } from "./pns.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn, bus } from "../events.js";
import type { CortexEvent } from "../events.js";
import { newId } from "../util/ids.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

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
  private guidanceStore?: import("./guidance-store.js").GuidanceStore;
  private referenceStore?: import("./reference-store.js").ReferenceStore;

  /** Stream of Awareness — chronological buffer of significant findings. */
  private awarenessBuffer: AwarenessInsight[] = [];
  /** Cleanup function for the event bus listener. */
  private stopAwarenessListening: (() => void) | null = null;
  /** Max buffer size before oldest entries are pruned. */
  private readonly maxAwarenessInsights = 50;

  constructor(sources: ThalamusSources) {
    this.wm = sources.wm;
    this.pns = sources.pns;
    this.hippocampus = sources.hippocampus;
    this.worldModel = sources.worldModel;
    this.guidanceStore = sources.guidanceStore;
    this.referenceStore = sources.referenceStore;
    this.startAwarenessListening();
  }

  /** Get the guidance store (for rest cycle evolution + outcome recording). */
  getGuidanceStore(): import("./guidance-store.js").GuidanceStore | undefined {
    return this.guidanceStore;
  }

  /** Get reference summaries for briefing inclusion. */
  getReferenceSummaries(): string[] {
    return this.referenceStore?.getSummaries() ?? [];
  }

  /** Get the reference store (external system pointers). */
  getReferenceStore(): import("./reference-store.js").ReferenceStore | undefined {
    return this.referenceStore;
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
   * Used by satisfaction-signal when a Parsifal response mutates
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

  /** Inject a pre-computed gestalt (for checkpoint resume). */
  restoreGestalt(taskId: string, gestalt: TaskGestalt): void {
    this.gestalts.set(taskId, gestalt);
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
   * Attach a failure mode prediction to an existing gestalt.
   * Called after consultation (fingerprint available), before build cycle.
   * The Thalamus uses this to inject preemptive context into briefings.
   */
  attachFailureModePrediction(
    taskId: string,
    prediction: import("../types/cerebellum.js").FailureModePrediction,
  ): void {
    const gestalt = this.gestalts.get(taskId);
    if (!gestalt) {
      log.warn("attachFailureModePrediction: no gestalt for task", { taskId });
      return;
    }
    this.gestalts.set(taskId, { ...gestalt, failureModePrediction: prediction });

    emit("thalamus:gestalt-failure-prediction-attached", {
      taskId,
      predicted: prediction.predicted,
      confidence: prediction.confidence,
      episodesConsidered: prediction.episodesConsidered,
    });

    log.info("Failure mode prediction attached to gestalt", {
      taskId,
      predicted: prediction.predicted,
      confidence: prediction.confidence.toFixed(3),
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

  /** Clear all gestalts between projects to prevent memory leaks. */
  clearAllGestalts(): void {
    const count = this.gestalts.size;
    this.gestalts.clear();
    this.clearAwareness();
    log.info("All gestalts cleared", { count });
  }

  // ── Stream of Awareness ─────────────────────────────────────────

  /**
   * Subscribe to the event bus and accumulate significant findings.
   * Passive watching — no active detection. The existing detector
   * systems produce events; this just listens and digests them.
   *
   * Pattern: same as HomeostasisMonitor.startListening().
   */
  private startAwarenessListening(): void {
    const listener = (event: CortexEvent) => {
      const insight = this.digestEvent(event);
      if (insight) {
        this.awarenessBuffer.push(insight);
        this.pruneAwareness();

        emit("thalamus:awareness-insight", {
          source: insight.source,
          taskId: insight.taskId,
          severity: insight.severity,
          summary: insight.summary.slice(0, 120),
        });
      }
    };

    bus.onCortex(listener);
    this.stopAwarenessListening = () => bus.removeListener("cortex", listener);
  }

  /** Stop listening. For cleanup/tests. */
  disposeAwareness(): void {
    this.stopAwarenessListening?.();
    this.stopAwarenessListening = null;
  }

  /**
   * Convert a significant event into an AwarenessInsight, or null if
   * the event isn't significant enough to track.
   *
   * Each case extracts the salient facts from the event data and
   * produces a human-readable summary. No LLM — pure deterministic
   * extraction from existing event payloads.
   */
  private digestEvent(event: CortexEvent): AwarenessInsight | null {
    const taskId = (event.data.taskId as string) ?? event.rhythmContext?.taskId ?? null;
    const ts = new Date(event.timestamp);

    switch (event.type) {
      case "flexibility:assessment": {
        const diagnosis = event.data.diagnosis as string;
        const shouldReset = event.data.shouldReset as boolean;
        const shouldEscalate = event.data.shouldEscalate as boolean;
        if (!shouldReset && !shouldEscalate) return null;
        const action = shouldEscalate ? "needs Parsifal help" : "resetting approach";
        return this.insight(ts, "flexibility", taskId, "warn",
          `Stuck: diagnosed as ${diagnosis} — ${action}`);
      }

      case "drift-monitor:level-changed": {
        const direction = event.data.direction as string;
        const threshold = event.data.threshold as number;
        const newLevel = event.data.newLevel as number;
        if (direction === "crossed-below") return null;
        return this.insight(ts, "drift", taskId, threshold >= 0.8 ? "critical" : "warn",
          `Drift crossed ${threshold} (now ${newLevel.toFixed(2)}) — work may be diverging from intent`);
      }

      case "drift-monitor:deep-analysis": {
        const level = event.data.overallLevel as number;
        if (level < 0.3) return null;
        const intentTrajectory = event.data.intentTrajectory as string;
        const tasteDetected = event.data.tasteDivergenceDetected as boolean;
        const parts = [`Deep drift analysis: level ${level.toFixed(2)}`];
        if (intentTrajectory) parts.push(`intent ${intentTrajectory}`);
        if (tasteDetected) parts.push("taste divergence detected");
        return this.insight(ts, "drift", taskId, level >= 0.5 ? "warn" : "info",
          parts.join(", "));
      }

      case "vitals:reflex": {
        const actions = event.data.actions as Array<{ type: string; reason: string }>;
        if (!actions?.length) return null;
        const summary = actions.map((a) => a.type).join(", ");
        return this.insight(ts, "vitals", null, "warn",
          `Health reflex: ${summary}`);
      }

      case "hippocampus:principle-extracted": {
        const statement = event.data.statement as string;
        return this.insight(ts, "hippocampus", taskId, "info",
          `Learned: ${statement}`);
      }

      case "hippocampus:principle-replaced": {
        const statement = event.data.statement as string;
        const reasoning = (event.data.reasoning as string)?.slice(0, 80);
        return this.insight(ts, "hippocampus", taskId, "info",
          `Understanding changed: ${statement}${reasoning ? ` (${reasoning})` : ""}`);
      }

      case "motor:proprioception-complete": {
        const adherence = event.data.planAdherence as number;
        if (adherence > 0.7) return null;
        const driftAreas = event.data.driftAreas as number;
        return this.insight(ts, "proprioception", taskId, "warn",
          `Builder drifted from plan: adherence ${(adherence * 100).toFixed(0)}%, ${driftAreas} drift area(s)`);
      }

      case "conviction:result": {
        const verdict = event.data.verdict as string;
        if (verdict !== "reshape" && verdict !== "escalate") return null;
        const level = (event.data.level ?? event.data.convictionLevel ?? 0) as number;
        const deciding = event.data.decidingStep as string;
        return this.insight(ts, "conviction", taskId,
          verdict === "escalate" ? "critical" : "warn",
          `Conviction ${verdict}: ${(level * 100).toFixed(0)}%${deciding ? ` (${deciding})` : ""}`);
      }

      case "gate:failure-classified": {
        const mode = (event.data.failureMode ?? event.data.category ?? "unknown") as string;
        return this.insight(ts, "gate", taskId, "warn",
          `Gate rejected work — failure mode: ${mode}`);
      }

      case "sensory-cortex:double-expected": {
        const outerCycle = event.data.outerCycle as number;
        const expected = event.data.expected as number;
        return this.insight(ts, "pacing", taskId, "warn",
          `Task at ${outerCycle} cycles (expected ${expected}) — taking longer than predicted`);
      }

      case "task:complete": {
        const status = event.data.status as string;
        const cycles = event.data.cycles as number;
        const confidence = (event.data.confidence ?? 0) as number;
        const exitReason = event.data.exitReason as string;
        if (status === "complete" && confidence > 0.7) return null;
        return this.insight(ts, "lifecycle", taskId, "info",
          `Task finished: ${status}, ${cycles} cycle(s), confidence ${(confidence * 100).toFixed(0)}%${exitReason ? ` (${exitReason})` : ""}`);
      }

      // ── Identity changes ──────────────────────────────────

      case "world-model:maxim-evolved": {
        const oldStatement = event.data.oldStatement as string;
        const newStatement = event.data.newStatement as string;
        const scope = event.data.scope as string;
        return this.insight(ts, "identity", null, "info",
          `Understanding shifted (${scope}): "${oldStatement?.slice(0, 60)}" → "${newStatement?.slice(0, 60)}"`);
      }

      case "world-model:maxim-dropped": {
        const statement = event.data.statement as string;
        const scope = event.data.scope as string;
        return this.insight(ts, "identity", null, "info",
          `Dropped ${scope} understanding: "${statement?.slice(0, 80)}"`);
      }

      case "world-model:narratives-updated": {
        const newCount = event.data.newCount as number;
        const totalCount = event.data.totalCount as number;
        return this.insight(ts, "identity", null, "info",
          `Self-narratives evolved: ${newCount} new (${totalCount} total)`);
      }

      // ── Phase gates + escalation ──────────────────────────

      case "dispatch:phase-gate-check": {
        const phaseGroup = event.data.phaseGroup as string;
        const passed = event.data.passed as boolean;
        const issueCount = (event.data.issueCount ?? event.data.discoveredProblemCount ?? 0) as number;
        if (passed && issueCount === 0) return null; // clean pass, not notable
        return this.insight(ts, "phase-gate", null, passed ? "info" : "warn",
          `Phase gate "${phaseGroup}": ${passed ? "passed" : "failed"}${issueCount > 0 ? `, ${issueCount} issue(s) found` : ""}`);
      }

      case "escalation:created": {
        const summary = event.data.summary as string;
        return this.insight(ts, "escalation", taskId, "warn",
          `Escalated to Parsifal: ${summary?.slice(0, 100)}`);
      }

      case "escalation:resolved": {
        const answer = event.data.answer as string;
        return this.insight(ts, "escalation", taskId, "info",
          `Parsifal responded: ${answer?.slice(0, 100)}`);
      }

      // ── Plan revisions ────────────────────────────────────

      case "surgery:rework": {
        const reworkTaskId = event.data.taskId as string;
        const reason = event.data.reason as string;
        return this.insight(ts, "surgery", reworkTaskId, "warn",
          `Task reopened for rework: ${reason?.slice(0, 100)}`);
      }

      default:
        return null;
    }
  }

  /** Factory for AwarenessInsight. */
  private insight(
    timestamp: Date,
    source: AwarenessSource,
    taskId: string | null,
    severity: "info" | "warn" | "critical",
    summary: string,
  ): AwarenessInsight {
    return { id: newId(), timestamp, source, taskId, severity, summary };
  }

  /**
   * Prune the awareness buffer when it exceeds max size.
   * Drop oldest "info" entries first, then oldest "warn", keeping "critical" longest.
   */
  private pruneAwareness(): void {
    if (this.awarenessBuffer.length <= this.maxAwarenessInsights) return;

    const priorityOf = (s: string) => s === "critical" ? 2 : s === "warn" ? 1 : 0;
    this.awarenessBuffer.sort((a, b) => {
      const sp = priorityOf(b.severity) - priorityOf(a.severity);
      if (sp !== 0) return sp;
      return b.timestamp.getTime() - a.timestamp.getTime();
    });
    this.awarenessBuffer = this.awarenessBuffer.slice(0, this.maxAwarenessInsights);

    // Re-sort chronologically for streaming
    this.awarenessBuffer.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /** Layer 1 getter: all awareness insights, chronologically ordered. The buffer IS the stream. */
  getAwareness(): AwarenessInsight[] {
    return [...this.awarenessBuffer];
  }

  /** Layer 1 getter: awareness insights for a specific task. */
  getAwarenessForTask(taskId: string): AwarenessInsight[] {
    return this.awarenessBuffer.filter((i) => i.taskId === taskId);
  }

  /** Layer 1 getter: awareness as summary strings for briefing inclusion. Same shape as getWorldModelMaxims(). */
  getAwarenessSummaries(taskId?: string): string[] {
    const insights = taskId
      ? this.awarenessBuffer.filter((i) => i.taskId === taskId || i.taskId === null)
      : this.awarenessBuffer;
    return insights.map((i) => i.summary);
  }

  /** Clear awareness between projects. */
  clearAwareness(): void {
    this.awarenessBuffer = [];
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

  // ── Observation Harvest ───────────────────────────────────────────

  /**
   * Layer 1 getter: harvest territory observations with Thalamus shaping.
   *
   * Three filtering layers that raw WM access lacks:
   *   1. Source credibility — deprioritize components with ≥70% dismissal rate
   *   2. NE re-filtering — re-apply current NE threshold at harvest time
   *   3. Meta tracking — BriefingMeta with what was filtered and why
   */
  harvestObservations(opts: ObservationHarvestOpts): ObservationHarvest {
    const statuses = opts.statuses ?? ["new", "triaged"];

    // 1. Read from WM
    let observations: TerritoryObservation[] = [];
    for (const status of statuses) {
      observations.push(...this.wm.getObservations(status));
    }
    const total = observations.length;

    // 2. Source credibility filtering
    //    WM tracks dismissal rates per component. A source with ≥70%
    //    dismissal rate (min 3 observations) is producing noise.
    const dismissalRates = this.wm.getDismissalRates();
    observations = observations.filter((obs) => {
      if (obs.systemHealth) return true;
      const rate = dismissalRates.get(obs.source.component);
      return !rate || rate.total < 3 || rate.rate < 0.7;
    });
    const afterCredibility = observations.length;

    // 3. NE re-filtering at harvest time
    //    Observations stored during high NE may be irrelevant at low NE.
    const threshold = relevanceThreshold(opts.neLevel);
    observations = observations.filter((obs) => {
      if (obs.systemHealth) return true;
      return obs.relevance >= threshold;
    });

    // Sort by relevance descending — most important first
    observations.sort((a, b) => b.relevance - a.relevance);

    // Meta
    const sources = ["working-memory"];
    const counts: Record<string, number> = {
      observations: observations.length,
      filteredByCredibility: total - afterCredibility,
      filteredByNE: afterCredibility - observations.length,
    };

    emit("thalamus:observation-harvest", {
      neLevel: opts.neLevel,
      threshold,
      total,
      afterCredibility,
      surviving: observations.length,
    });

    return {
      observations,
      meta: this.meta("observation-harvest", undefined, sources, counts),
    };
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
    const legacyConsultAwareness = this.getAwarenessSummaries(task.id);
    const lcSelfMaxims = this.getSelfMaximStatements();
    const lcSelfNarratives = this.getSelfNarrativeStrings();

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      senseTrends: accumulated.senseTrends.length,
      inhibitedSenses: accumulated.inhibitedSenses.length,
      openQuestions: accumulated.openQuestions.length,
      principles: principles.length,
      worldModelMaxims: maxims.length,
      awareness: legacyConsultAwareness.length,
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
        selfMaxims: lcSelfMaxims.length > 0 ? lcSelfMaxims : undefined,
        selfNarratives: lcSelfNarratives.length > 0 ? lcSelfNarratives : undefined,
        awareness: legacyConsultAwareness.length > 0 ? legacyConsultAwareness : undefined,
        references: this.getReferenceSummaries().length > 0 ? this.getReferenceSummaries() : undefined,
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
    const legacyMotorAwareness = this.getAwarenessSummaries(task.id);
    const lmSelfMaxims = this.getSelfMaximStatements();
    const lmSelfNarratives = this.getSelfNarrativeStrings();

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      scoreTrends: accumulated.receptorTrends.length,
      openQuestions: accumulated.openQuestions.length,
      principles: principles.length,
      worldModelMaxims: maxims.length,
      awareness: legacyMotorAwareness.length,
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
        selfMaxims: lmSelfMaxims.length > 0 ? lmSelfMaxims : undefined,
        selfNarratives: lmSelfNarratives.length > 0 ? lmSelfNarratives : undefined,
        awareness: legacyMotorAwareness.length > 0 ? legacyMotorAwareness : undefined,
        references: this.getReferenceSummaries().length > 0 ? this.getReferenceSummaries() : undefined,
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

  /**
   * Assemble context for the Cortex's communication function.
   *
   * Returns a human-readable snapshot of the current state, optimized
   * for understanding rather than action — what's happening, why,
   * and who I am.
   *
   * Uses the gestalt when available (mid-task), falls back to WM
   * directly when no gestalt exists (between tasks, boot).
   */
  forCommunication(taskId?: string): string {
    const parts: string[] = [];

    // ── Task + Intent ────────────────────────────────────────
    const gestalt = taskId ? this.getGestalt(taskId) : this.findActiveGestalt();

    if (gestalt) {
      parts.push(`## Current task`);
      parts.push(`**${gestalt.task.description}**`);
      parts.push(`Intent: ${gestalt.intent.summary}`);
      if (gestalt.intent.audience) parts.push(`Audience: ${gestalt.intent.audience}`);
      if (gestalt.mode) parts.push(`Mode: ${gestalt.mode}`);
      if (gestalt.neLevel != null) parts.push(`NE: ${gestalt.neLevel.toFixed(2)}`);
      if (gestalt.taskBudget != null) parts.push(`Task budget: $${gestalt.taskBudget.toFixed(2)}`);

      // Taste (dissolved for consciousness — natural language)
      const taste = gestalt.taste;
      if (taste) {
        parts.push(`\n## Who we're working for`);
        parts.push(`${taste.name}`);
        if (taste.visual) parts.push(`Visual: ${taste.visual}`);
        if (taste.decisionStyle) parts.push(`Decisions: ${taste.decisionStyle}`);
        if (taste.communication) parts.push(`Communication: ${taste.communication}`);
        if (taste.patterns) parts.push(`Patterns: ${taste.patterns}`);
      }

      // Predictions
      if (gestalt.prediction) {
        const pred = gestalt.prediction;
        parts.push(`\n## Predictions`);
        parts.push(`Confidence: ${pred.overallConfidence.toFixed(2)}, based on ${pred.episodeCount} episode(s)`);
        if (pred.receptorPredictions.length > 0) {
          const topPreds = pred.receptorPredictions.slice(0, 4)
            .map(r => `${r.activationPath.join("→")}: ${r.predicted.toFixed(1)}`);
          parts.push(`Key predictions: ${topPreds.join(", ")}`);
        }
      }

      if (gestalt.speedOfLight) {
        const sol = gestalt.speedOfLight;
        parts.push(`Speed of light (ceiling): ${sol.compositeCeiling.toFixed(1)}${sol.compositeGap != null ? ` (gap: ${sol.compositeGap.toFixed(1)})` : ""}`);
      }

      // Efference copy
      if (gestalt.efferenceCopy) {
        const ef = gestalt.efferenceCopy;
        parts.push(`\nBuilder feasibility: convergence estimate ${ef.convergenceEstimate} cycle(s)`);
        if (ef.hardConstraints?.length) parts.push(`Hard constraints: ${ef.hardConstraints.join(", ")}`);
        if (ef.tensionCosts?.length) {
          const costs = ef.tensionCosts.slice(0, 3).map(t => `${t.senseA}↔${t.senseB}: ${t.costDescription}`);
          parts.push(`Tension costs: ${costs.join("; ")}`);
        }
      }

      // Graph position
      if (gestalt.graphPosition) {
        const gp = gestalt.graphPosition;
        parts.push(`\n## Project position`);
        parts.push(`Completed: ${gp.completedTaskIds.length}/${gp.totalTasks} tasks`);
        if (gp.dependsOn?.length) parts.push(`This task depends on: ${gp.dependsOn.length} other task(s)`);
        if (gp.phaseGroup) parts.push(`Phase: ${gp.phaseGroup}`);
      }

      // Forward briefing
      if (gestalt.forwardBriefing) {
        const fb = gestalt.forwardBriefing;
        if (fb.predictedTensions?.length) {
          parts.push(`\nPredicted tensions: ${fb.predictedTensions.map(t => `${t.senseA} vs ${t.senseB}`).join(", ")}`);
        }
        if (fb.predictedCycles != null) parts.push(`Predicted cycles: ${fb.predictedCycles}`);
      }

      // World model maxims
      if (gestalt.weltanschauung?.maxims?.length) {
        parts.push(`\n## World understanding`);
        for (const m of gestalt.weltanschauung.maxims.slice(0, 5)) {
          parts.push(`- ${m}`);
        }
      }

      // Self-knowledge
      if (this.worldModel) {
        const selfMaxims = this.worldModel.getSelfMaxims();
        const selfNarratives = this.worldModel.getSelfNarratives();
        if (selfMaxims.length > 0 || selfNarratives.length > 0) {
          parts.push(`\n## Self-knowledge`);
          for (const m of selfMaxims.slice(0, 5)) {
            parts.push(`- ${m.statement}`);
          }
          for (const n of selfNarratives.slice(0, 3)) {
            parts.push(`- _${n.narrative}_`);
          }
        }
      }

    } else {
      // No gestalt — use intent + taste directly
      if (this.intent) {
        parts.push(`## Project: ${this.intent.summary}`);
        if (this.intent.audience) parts.push(`Audience: ${this.intent.audience}`);
      }
      if (this.taste) {
        parts.push(`Working for: ${this.taste.name}`);
      }
    }

    // ── Awareness + References (always available) ────────────
    const commAwarenessGlobal = this.getAwarenessSummaries();
    if (commAwarenessGlobal.length > 0) {
      parts.push(`\n## What I've noticed`);
      for (const a of commAwarenessGlobal.slice(-8)) {
        parts.push(`- ${a}`);
      }
    }

    const refsGlobal = this.getReferenceSummaries();
    if (refsGlobal.length > 0) {
      parts.push(`\n## Known references`);
      for (const r of refsGlobal) {
        parts.push(`- ${r}`);
      }
    }

    // ── WM snapshot (always available) ───────────────────────
    const accumulated = this.getAccumulatedContext();

    if (accumulated.senseTrends.length > 0) {
      parts.push(`\n## Sense trends`);
      for (const t of accumulated.senseTrends.slice(0, 6)) {
        parts.push(`- ${t.label}: ${t.direction} (${t.currentMean.toFixed(1)})`);
      }
    }

    if (accumulated.openQuestions.length > 0) {
      parts.push(`\n## Open questions`);
      for (const q of accumulated.openQuestions.slice(0, 5)) {
        parts.push(`- ${q.question}`);
      }
    }

    if (accumulated.decisions.length > 0) {
      parts.push(`\n## Recent decisions`);
      for (const d of accumulated.decisions.slice(-3)) {
        parts.push(`- ${d.description} (confidence: ${d.confidence.toFixed(2)})`);
      }
    }

    // Observations
    const observations = this.wm.getObservations("new");
    if (observations.length > 0) {
      parts.push(`\n## Pending observations (${observations.length})`);
      for (const o of observations.slice(0, 5)) {
        parts.push(`- ${o.fact}`);
      }
    }

    // Conviction
    const conviction = this.wm.getConvictionTrajectory();
    parts.push(`\n## Conviction: ${conviction.direction}, current ${conviction.currentLevel?.toFixed(2) ?? "?"}`);
    if (conviction.levels.length > 1) {
      const recent = conviction.levels.slice(-4).map(l => `${(l * 100).toFixed(0)}%`);
      parts.push(`Trajectory: ${recent.join(" → ")}`);
    }

    return parts.join("\n");
  }

  /** Find the first gestalt that exists (for when taskId isn't known). */
  private findActiveGestalt(): import("../types/task-gestalt.js").TaskGestalt | null {
    for (const g of this.gestalts.values()) {
      return g;
    }
    return null;
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
    const escalationAwareness = this.getAwarenessSummaries();

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
      awareness: escalationAwareness.length > 0 ? escalationAwareness : undefined,
    };

    const counts: Record<string, number> = {
      openQuestions: accumulated.openQuestions.length,
      senseTrends: accumulated.senseTrends.length,
      completedTasks: accumulated.completedSummaries.length,
      worldModelMaxims: worldModelMaxims.length,
      awareness: escalationAwareness.length,
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
  // ── Failure preemption assembly helpers ────────────────────────

  /**
   * Consultation-side: prompt senses to produce information that prevents
   * the predicted failure. Only specification-gap and integration get
   * consultation-side preemption — the others are motor-side problems.
   */
  private assembleConsultationPreemption(
    g: import("../types/task-gestalt.js").TaskGestalt,
  ): import("../types/thalamus.js").ConsultationEnrichment["failurePreemption"] | undefined {
    const fmp = g.failureModePrediction;
    if (!fmp?.predicted || fmp.confidence < 0.4) return undefined;

    // Only specification-gap and integration get consultation-side preemption
    if (fmp.predicted !== "specification-gap" && fmp.predicted !== "integration") return undefined;

    // Read from guidance store when available, fall back to hardcoded defaults
    const variant = this.guidanceStore?.getActive(fmp.predicted, "consultation");
    if (variant) {
      return {
        category: fmp.predicted,
        confidence: fmp.confidence,
        consultationGuidance: variant.text,
      };
    }

    // Hardcoded fallback (used when no guidance store is wired)
    switch (fmp.predicted) {
      case "specification-gap":
        return {
          category: "specification-gap",
          confidence: fmp.confidence,
          consultationGuidance:
            "Tasks like this historically fail because senses and builder disagree on what 'done' means. " +
            "Be explicit about your acceptance criteria: state concrete pass/fail conditions, not just directional preferences. " +
            "For each evaluator you activate, describe the specific observable evidence that would satisfy it.",
        };
      case "integration":
        return {
          category: "integration",
          confidence: fmp.confidence,
          consultationGuidance:
            "Tasks like this historically fail because sense tensions collapse into capitulation instead of synthesis. " +
            "State your hard boundaries: the non-negotiable minimums for your dimension. " +
            "The builder needs pre-resolved constraints, not competing aspirations that will conflict during evaluation.",
        };
    }
  }

  /**
   * Motor-side: inject specific guidance per predicted failure category.
   * Every category gets motor-side preemption with category-specific content.
   */
  private assembleMotorPreemption(
    g: import("../types/task-gestalt.js").TaskGestalt,
    consultation: import("../types/consultation.js").Consultation,
  ): import("../types/thalamus.js").MotorEnrichment["failurePreemption"] | undefined {
    const fmp = g.failureModePrediction;
    if (!fmp?.predicted || fmp.confidence < 0.4) return undefined;

    // Assemble dynamic historical patterns per category (always fresh from consultation/SoL)
    const historicalPatterns: string[] = [];
    switch (fmp.predicted) {
      case "specification-gap":
        historicalPatterns.push(...consultation.perspectives
          .filter((p) => p.stake > 0.3)
          .map((p) => `${p.senseName} (stake ${p.stake.toFixed(1)}): ${p.perspective.slice(0, 200)}`));
        break;
      case "integration":
        historicalPatterns.push(...consultation.perspectives
          .filter((p) => p.stake > 0.4)
          .map((p) => `${p.senseName}: ceiling ${p.ceiling}/10 — ${p.ceilingRationale}`));
        break;
      case "approach-bottleneck":
        if (g.speedOfLight?.approachSpecific) {
          const as = g.speedOfLight.approachSpecific;
          historicalPatterns.push(
            `Current approach class: ${as.approachTags.join(", ")}`,
            `Approach-specific best achieved: ${as.compositeBestAchieved?.toFixed(1) ?? "unknown"}`,
            `Overall best achieved: ${g.speedOfLight.compositeBestAchieved?.toFixed(1) ?? "unknown"}`,
            `Bottleneck gap: ${as.bottleneckGap?.toFixed(1) ?? "unknown"}`,
          );
        }
        break;
      case "local-logic":
        historicalPatterns.push(
          `Failure mode confidence: ${(fmp.confidence * 100).toFixed(0)}% — targeted fix likely sufficient.`,
        );
        break;
      case "execution-problem":
        historicalPatterns.push(
          `Failure mode confidence: ${(fmp.confidence * 100).toFixed(0)}% — execution barrier, not approach problem.`,
          "Verify required tools and permissions are available before building.",
        );
        break;
    }

    // Read guidance text from store when available, fall back to hardcoded defaults
    const variant = this.guidanceStore?.getActive(fmp.predicted, "motor");
    const guidance = variant?.text ?? this.defaultMotorGuidance(fmp.predicted);

    return {
      predictedCategory: fmp.predicted,
      confidence: fmp.confidence,
      guidance,
      historicalPatterns,
    };
  }

  /** Hardcoded fallback motor guidance (used when no guidance store is wired). */
  private defaultMotorGuidance(category: import("../types/motor-cortex.js").FailureCategory): string {
    switch (category) {
      case "specification-gap":
        return "Historical pattern: builder and senses disagree on 'done.' " +
          "The acceptance criteria below are extracted from each sense's consultation. " +
          "Build to satisfy these specific expectations, not a general interpretation of the task.";
      case "integration":
        return "Historical pattern: sense tensions collapse into capitulation. " +
          "Build within the ceiling constraints below. " +
          "Satisfy each sense's minimum rather than maximizing one at the expense of another.";
      case "approach-bottleneck":
        return "Historical pattern: this approach class hits a performance ceiling below the task's requirements. " +
          "Consider a fundamentally different strategy rather than optimizing the current one.";
      case "local-logic":
        return "Historical pattern: similar tasks fail on specific logic issues in a small number of senses. " +
          "Pay extra attention to edge cases and boundary conditions in the areas flagged by high-stake senses.";
      case "execution-problem":
        return "Historical pattern: builder plans well but execution is blocked by tooling or environment issues. " +
          "Verify all required tools are available and permissions are granted before building.";
    }
  }

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
    const awarenessSummaries = this.getAwarenessSummaries(taskId);
    const selfMaximStmts = this.getSelfMaximStatements();
    const selfNarrativeStrs = this.getSelfNarrativeStrings();

    const counts: Record<string, number> = {
      patterns: g.accumulated.patterns.length,
      decisions: g.accumulated.decisions.length,
      senseTrends: g.accumulated.senseTrends.length,
      inhibitedSenses: g.accumulated.inhibitedSenses.length,
      openQuestions: g.accumulated.openQuestions.length,
      principles: principles?.length ?? 0,
      worldModelMaxims: maxims?.length ?? 0,
      awareness: awarenessSummaries.length,
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
        selfMaxims: compressed ? undefined : (selfMaximStmts.length > 0 ? selfMaximStmts : undefined),
        selfNarratives: compressed ? undefined : (selfNarrativeStrs.length > 0 ? selfNarrativeStrs : undefined),
        awareness: compressed ? undefined : (awarenessSummaries.length > 0 ? awarenessSummaries : undefined),
        references: compressed ? undefined : (this.getReferenceSummaries().length > 0 ? this.getReferenceSummaries() : undefined),
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
        failurePreemption: this.assembleConsultationPreemption(g),
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
    if (compressed) droppedSections.push("capabilities", "principles", "worldModel", "awareness", "efference", "senseTrends", "openQuestions");

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

    getContentStore().record({
      eventSeq: null, kind: "briefing", timestamp: new Date().toISOString(),
      component: "thalamus", taskId,
      inputs: [contentBlock("Gestalt sources", JSON.stringify(counts, null, 2))],
      outputs: [contentBlock("Consultation briefing", JSON.stringify(briefing, null, 2))],
      routing: { destinations: ["consultation (all active senses)"] },
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
    const motorAwareness = this.getAwarenessSummaries(taskId);
    const motorSelfMaxims = this.getSelfMaximStatements();
    const motorSelfNarratives = this.getSelfNarrativeStrings();

    const counts: Record<string, number> = {
      patterns: g.accumulated.patterns.length,
      decisions: g.accumulated.decisions.length,
      scoreTrends: g.accumulated.receptorTrends.length,
      openQuestions: g.accumulated.openQuestions.length,
      principles: principles?.length ?? 0,
      worldModelMaxims: maxims?.length ?? 0,
      awareness: motorAwareness.length,
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
        selfMaxims: motorCompressed ? undefined : (motorSelfMaxims.length > 0 ? motorSelfMaxims : undefined),
        selfNarratives: motorCompressed ? undefined : (motorSelfNarratives.length > 0 ? motorSelfNarratives : undefined),
        awareness: motorCompressed ? undefined : (motorAwareness.length > 0 ? motorAwareness : undefined),
        references: this.getReferenceSummaries().length > 0 ? this.getReferenceSummaries() : undefined,
        predictedCycles: mfb?.predictedCycles ?? undefined,
        approachNotes: mfb?.convictionCarryForward.reshapeGuidance
          ? [mfb.convictionCarryForward.reshapeGuidance] : undefined,
        bottleneckSenses: mfb?.predictedBottlenecks.length
          ? mfb.predictedBottlenecks.map((b) => b.sense) : undefined,
        prospectiveDirectives: motorCompressed ? undefined : (g.prospectiveDirectives?.length
          ? g.prospectiveDirectives : undefined),
        selectedPath: g.explorePath ?? undefined,
        failurePreemption: this.assembleMotorPreemption(g, consultation),
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

    getContentStore().record({
      eventSeq: null, kind: "briefing", timestamp: new Date().toISOString(),
      component: "thalamus", taskId,
      inputs: [contentBlock("Gestalt sources", JSON.stringify(counts, null, 2))],
      outputs: [contentBlock("Motor briefing", JSON.stringify(briefing, null, 2))],
      routing: { destinations: ["motor-cortex (premotor → primary → proprioception)"] },
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

    getContentStore().record({
      eventSeq: null, kind: "briefing", timestamp: new Date().toISOString(),
      component: "thalamus", taskId,
      inputs: [contentBlock("Gestalt sources", JSON.stringify(counts, null, 2))],
      outputs: [contentBlock(`Evaluation briefing (${receptorId})`, JSON.stringify(briefing, null, 2))],
      routing: { destinations: [`evaluator (${receptorId})`] },
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

    getContentStore().record({
      eventSeq: null, kind: "briefing", timestamp: new Date().toISOString(),
      component: "thalamus", taskId,
      inputs: [contentBlock("Gestalt sources", JSON.stringify(counts, null, 2))],
      outputs: [contentBlock("Inhibition briefing", JSON.stringify(briefing, null, 2))],
      routing: { destinations: ["basal-ganglia (inhibitor)"] },
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

  /** Self-model maxim statements for briefing inclusion. */
  private getSelfMaximStatements(): string[] {
    if (!this.worldModel) return [];
    return this.worldModel.getSelfMaxims().map((m) => m.statement);
  }

  /** Self-model narrative strings for briefing inclusion. */
  private getSelfNarrativeStrings(): string[] {
    if (!this.worldModel) return [];
    return this.worldModel.getSelfNarratives().map((n) => n.narrative);
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
  // the question escalates to the Parsifal.

  /**
   * Route a mid-build question to the right sense or escalate to Parsifal.
   *
   * Deterministic routing:
   *   1. If targetDimension matches a sense name/ID → route to that sense
   *   2. If no match → find the sense with the highest stake in the task
   *   3. If no sense has stake above threshold → route to Parsifal
   *
   * The minimum stake threshold (0.3) ensures we don't route questions to
   * senses that are only marginally relevant. Better to ask the Parsifal than
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

    // 3. No sense has sufficient stake — escalate to Parsifal
    log.info("Build question escalating to Parsifal — no sense above stake threshold", {
      questionId: question.id,
      topStake: topSense?.stake,
    });

    emit("thalamus:question-routed", {
      questionId: question.id,
      route: "parsifal",
      mechanism: "no-sense-above-threshold",
    });

    return {
      questionId: question.id,
      route: "parsifal",
      rationale: `No sense has sufficient stake to answer (highest: ${topSense?.stake.toFixed(2) ?? "none"}). Escalating to Parsifal.`,
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
