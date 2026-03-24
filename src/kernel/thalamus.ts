/**
 * Thalamus — central context relay.
 *
 * Reads from all context sources (Working Memory, PNS, intent, taste)
 * and assembles per-consumer briefings. No context lives here — the
 * Thalamus extracts and routes, never stores.
 *
 * Dual-layer API:
 *   Layer 1: Categorical getters — stable primitives, any consumer composes
 *   Layer 2: Convenience composers — encode selection intelligence for known consumers
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
  ProjectContext,
  AccumulatedContext,
  CapabilityContext,
  AccumulatedContextOpts,
  ThalamusSources,
} from "../types/thalamus.js";
import type { InhibitionBriefing, SenseSummary } from "../types/inhibitor.js";
import type { ProjectIntent, TasteProfile } from "../types/intent.js";
import type { Task } from "../types/task.js";
import type { Council } from "../types/council.js";
import type { Sense } from "../types/sense.js";
import type { WorkingMemory } from "./working-memory.js";
import type { PeripheralNervousSystem } from "./pns.js";
import { SensoryCortex } from "../senses/cortex.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("thalamus");

export class Thalamus {
  private wm: WorkingMemory;
  private pns?: PeripheralNervousSystem;
  private intent?: ProjectIntent;
  private taste?: TasteProfile;

  constructor(sources: ThalamusSources) {
    this.wm = sources.wm;
    this.pns = sources.pns;
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

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      senseTrends: accumulated.senseTrends.length,
      inhibitedSenses: accumulated.inhibitedSenses.length,
      openQuestions: accumulated.openQuestions.length,
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

  async forMotor(task: Task, council: Council): Promise<MotorBriefing> {
    const { intent, taste } = this.getProjectContext();
    const accumulated = this.getAccumulatedContext();
    const capabilities = this.getCapabilityContext();

    const sources = ["working-memory"];
    if (this.intent) sources.push("intent");
    if (this.taste) sources.push("taste");
    if (this.pns) sources.push("pns");

    const counts: Record<string, number> = {
      patterns: accumulated.patterns.length,
      decisions: accumulated.decisions.length,
      scoreTrends: accumulated.receptorTrends.length,
      openQuestions: accumulated.openQuestions.length,
    };

    const briefing: MotorBriefing = {
      task,
      intent,
      taste,
      council,
      enrichment: {
        patterns: accumulated.patterns,
        decisions: accumulated.decisions,
        scoreTrends: accumulated.receptorTrends,
        openQuestions: accumulated.openQuestions,
        capabilities: capabilities.description,
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

    const counts: Record<string, number> = {
      receptorTrends: accumulated.receptorTrends.length,
      relevantPatterns: accumulated.patterns.length,
    };

    const briefing: EvaluationBriefing = {
      receptorTrends: accumulated.receptorTrends,
      relevantPatterns: accumulated.patterns,
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

  async forInhibition(
    library: SensoryCortex,
    task?: Task,
    neLevel?: number,
    mode?: "explore" | "exploit",
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

  // ── Private Helpers ─────────────────────────────────────────────

  private meta(
    consumer: string,
    taskId: string | undefined,
    sources: string[],
    counts: Record<string, number>,
  ): BriefingMeta {
    return {
      consumer,
      taskId,
      assembledAt: new Date(),
      sources,
      enrichmentCounts: counts,
    };
  }
}
