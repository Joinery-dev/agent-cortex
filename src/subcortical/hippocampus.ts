/**
 * Hippocampus — episodic memory + potentiation.
 *
 * Transforms experience into understanding through:
 *   1. Recording episodes — full task stories, not just scores
 *   2. Potentiating principles — living theories from episode clusters
 *
 * The hippocampus feeds the Thalamus, never consumers directly.
 * Episodes are project-scoped; principles are cross-project.
 * Persists to disk — first component in Agent Cortex with
 * cross-session memory.
 *
 * Follows the Cerebellum pattern: class with explicit methods,
 * event emission, logger, and serializable getState().
 */

import type { OrchestratorResult } from "../types/orchestrator.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import type {
  Episode,
  Principle,
  EvidenceRef,
  HippocampusConfig,
  HippocampusMeta,
  HippocampusState,
  PotentiationTrigger,
  PrincipleContradiction,
} from "../types/hippocampus.js";
import { DEFAULT_HIPPOCAMPUS_CONFIG } from "../types/hippocampus.js";
import type {
  SimulatedScenario,
  SimulationTrigger,
  SimulationAccuracyRecord,
  SimulationConfig,
} from "../types/hippocampal-simulation.js";
import { DEFAULT_SIMULATION_CONFIG } from "../types/hippocampal-simulation.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import { buildEpisode } from "./episode-builder.js";
import { HippocampusStore } from "./hippocampus-store.js";
import {
  detectTriggers,
  clusterEpisodes,
  findContradictions,
} from "./potentiation.js";
import { callStructured } from "../llm/structured.js";
import {
  potentiationExtractSystem,
  potentiationExtractUser,
  potentiationRefineSystem,
  potentiationRefineUser,
  potentiationSenseExtractSystem,
  potentiationSenseExtractUser,
  hippocampalSimulationSystem,
  hippocampalSimulationUser,
  principleVerificationSystem,
  principleVerificationUser,
} from "../llm/prompts.js";
import type { SensoryCortex } from "../senses/cortex.js";
import {
  verifyWithSenses,
  resolveSenseByName,
} from "../senses/sense-verification.js";
import type { SenseVerificationResult } from "../senses/sense-verification.js";
import { z } from "zod";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

const log = createLogger("hippocampus");

export class Hippocampus {
  private episodes: Map<string, Episode[]> = new Map();
  private principles: Principle[] = [];
  private meta: HippocampusMeta = { sequenceCounter: 0 };
  private config: HippocampusConfig;
  private simulationConfig: SimulationConfig;
  private store: HippocampusStore;
  private loaded = false;
  private library: SensoryCortex | null = null;

  // Simulation state (Feature: Proactive Discovery)
  private simulations: SimulatedScenario[] = [];
  private simulationAccuracy: SimulationAccuracyRecord[] = [];

  constructor(config?: Partial<HippocampusConfig>, simulationConfig?: Partial<SimulationConfig>) {
    this.config = { ...DEFAULT_HIPPOCAMPUS_CONFIG, ...config };
    this.simulationConfig = { ...DEFAULT_SIMULATION_CONFIG, ...simulationConfig };
    this.store = new HippocampusStore(
      this.config.storageDir || undefined,
    );
  }

  // ── Library wiring ───────────────────────────────────────────

  /**
   * Set the sense library for principle verification.
   * Called by Brainstem after construction — the hippocampus
   * doesn't take the library in its constructor because it's
   * a subcortical system that shouldn't depend on the cortex
   * at construction time.
   */
  setLibrary(library: SensoryCortex): void {
    this.library = library;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Load persisted state from disk. Call once before using.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      this.episodes = await this.store.loadAllEpisodes();
      this.principles = await this.store.loadPrinciples();
      this.meta = await this.store.loadMeta();
      this.loaded = true;

      log.info("Loaded from disk", {
        projects: this.episodes.size,
        totalEpisodes: this.getEpisodeCount(),
        principles: this.principles.length,
        sequenceCounter: this.meta.sequenceCounter,
      });

      emit("hippocampus:loaded", {
        projects: this.episodes.size,
        totalEpisodes: this.getEpisodeCount(),
        principles: this.principles.length,
      });
    } catch (err) {
      log.warn("Failed to load from disk — starting fresh", {
        error: String(err),
      });
      this.loaded = true; // Don't retry on failure
    }
  }

  /** Persist current state to disk. */
  async save(): Promise<void> {
    const savePromises: Promise<void>[] = [];

    for (const [projectId, episodes] of this.episodes) {
      savePromises.push(this.store.saveEpisodes(projectId, episodes));
    }
    savePromises.push(this.store.savePrinciples(this.principles));
    savePromises.push(
      this.store.saveMeta({
        ...this.meta,
        lastSaveAt: new Date(),
      }),
    );

    await Promise.all(savePromises);

    log.debug("Saved to disk", {
      projects: this.episodes.size,
      totalEpisodes: this.getEpisodeCount(),
      principles: this.principles.length,
    });
  }

  // ── Feature 14: Episode Recording ─────────────────────────────

  /**
   * Record a full task episode.
   *
   * Called by SubcorticalHooks.recordEpisode() during between-tasks
   * processing. Extracts the narrative, checks for contradictions
   * against existing principles, and persists.
   */
  recordEpisode(
    projectId: string,
    taskId: string,
    taskDescription: string,
    result: OrchestratorResult,
    dopamineSignal: number,
    significance?: number,
  ): Episode {
    const episode = buildEpisode(
      projectId,
      taskId,
      taskDescription,
      result,
      dopamineSignal,
      this.meta.sequenceCounter++,
      significance,
    );

    // Check against existing principles for contradictions
    const contradictions = this.checkForContradictions(episode);
    if (contradictions.length > 0) {
      episode.contradicts = contradictions.map((c) => c.principle.id);

      for (const contradiction of contradictions) {
        // Add as contradicting evidence on the principle
        this.addContradictingEvidence(
          contradiction.principle.id,
          episode,
          `Outcome diverged from principle for senses: ${contradiction.divergentSenses.join(", ")}`,
        );
      }

      log.info("Episode contradicts existing principles", {
        taskId,
        contradictions: contradictions.map((c) => ({
          principleId: c.principle.id,
          senses: c.divergentSenses,
        })),
      });
    }

    // Append to project's episodes
    const projectEpisodes = this.episodes.get(projectId) ?? [];
    projectEpisodes.push(episode);
    this.episodes.set(projectId, projectEpisodes);

    // Prune if over limit
    this.pruneProject(projectId);
    this.pruneGlobal();

    // Check for supporting evidence on project-sense principles.
    // When a sense scores acceptably and doesn't contradict, its
    // episode confirms the sense's existing project understanding.
    this.updateProjectSenseEvidence(projectId, episode);

    emit("hippocampus:episode-recorded", {
      episodeId: episode.id,
      taskId,
      projectId,
      significance: episode.significance,
      dopamineSignal,
      contradictions: episode.contradicts.length,
      senseCount: episode.senseParticipation.length,
    });

    log.info("Episode recorded", {
      episodeId: episode.id,
      taskId,
      projectId,
      significance: episode.significance.toFixed(3),
      senseCount: episode.senseParticipation.length,
      cycles: episode.narrative.cycles,
    });

    // Persist async — don't block the rhythm
    this.store
      .saveEpisodes(projectId, projectEpisodes)
      .then(() => this.store.saveMeta(this.meta))
      .catch((err) =>
        log.error("Failed to persist episode", { error: String(err) }),
      );

    return episode;
  }

  // ── Feature 14: Querying ──────────────────────────────────────

  /** All episodes for a project, chronological. */
  getEpisodesForProject(projectId: string): Episode[] {
    return this.episodes.get(projectId) ?? [];
  }

  /**
   * Episodes where a specific sense participated.
   * Optionally scoped to a project.
   */
  getEpisodesForSense(senseId: string, projectId?: string): Episode[] {
    const source = projectId
      ? [this.episodes.get(projectId) ?? []]
      : [...this.episodes.values()];

    return source.flat().filter((ep) =>
      ep.senseParticipation.some(
        (sp) => sp.senseId === senseId || sp.senseName === senseId,
      ),
    );
  }

  /** Most recent N episodes across all projects. */
  getRecentEpisodes(count: number): Episode[] {
    return this.allEpisodes()
      .sort((a, b) => b.sequenceNumber - a.sequenceNumber)
      .slice(0, count);
  }

  /** Episodes above a significance threshold. */
  getSignificantEpisodes(threshold?: number): Episode[] {
    const t = threshold ?? 0.5;
    return this.allEpisodes().filter((ep) => ep.significance >= t);
  }

  // ── Feature 14: Vital Signs ───────────────────────────────────

  /**
   * Episode density for homeostasis — ratio of unpotentiated
   * episodes to the maximum. Higher = more consolidation pressure.
   */
  getEpisodeDensity(): number {
    const unpotentiated = this.getUnpotentiatedCount();
    return Math.min(1, unpotentiated / this.config.maxTotalEpisodes);
  }

  /** Total episodes across all projects. */
  getEpisodeCount(): number {
    let count = 0;
    for (const episodes of this.episodes.values()) {
      count += episodes.length;
    }
    return count;
  }

  /** Episodes that haven't been potentiated into principles yet. */
  getUnpotentiatedCount(): number {
    return this.allEpisodes().filter((ep) => ep.potentiatedBy.length === 0)
      .length;
  }

  // ── Feature 14: Fading ────────────────────────────────────────

  /**
   * Fade an episode — prune detailed narrative but keep metadata
   * and sense participation. The principle carries the weight.
   *
   * Episodes that contradict existing principles are protected.
   */
  fadeEpisode(episodeId: string): boolean {
    for (const episodes of this.episodes.values()) {
      const episode = episodes.find((e) => e.id === episodeId);
      if (!episode) continue;

      // Don't fade episodes that contradict principles
      if (episode.contradicts.length > 0) {
        log.debug("Refusing to fade contradiction episode", {
          episodeId,
          contradicts: episode.contradicts,
        });
        return false;
      }

      // Don't fade episodes that haven't been potentiated
      if (episode.potentiatedBy.length === 0) {
        log.debug("Refusing to fade unpotentiated episode", { episodeId });
        return false;
      }

      if (episode.faded) return false; // Already faded

      // Prune the narrative — keep the skeleton
      episode.narrative.decisions = [];
      episode.narrative.approachesTried = [];
      episode.narrative.scoreProgression = [];
      // Keep tensionSnapshots — they're compact and useful
      episode.faded = true;
      episode.fadedAt = new Date();

      log.debug("Episode faded", { episodeId });
      return true;
    }

    return false; // Not found
  }

  // ── Feature 15: Potentiation ──────────────────────────────────

  /**
   * Run a potentiation cycle. Called during rest cycles.
   *
   * Detects triggers (pattern density, surprise, contradiction),
   * clusters episodes, and extracts/refines principles via LLM.
   *
   * This is the shell — the actual LLM calls are wired in
   * potentiation.ts and prompts.ts. Without LLM integration,
   * this method detects triggers and reports what would run.
   */
  async potentiate(): Promise<{ principlesExtracted: number }> {
    const allEpisodes = this.allEpisodes();
    const unpotentiated = allEpisodes.filter(
      (ep) => ep.potentiatedBy.length === 0,
    );

    if (unpotentiated.length === 0) {
      log.debug("No unpotentiated episodes — skipping potentiation");
      return { principlesExtracted: 0 };
    }

    const triggers = detectTriggers(
      unpotentiated,
      this.principles,
      this.config,
    );

    if (triggers.length === 0) {
      log.debug("No potentiation triggers met");
      return { principlesExtracted: 0 };
    }

    log.info("Potentiation triggered", {
      triggers: triggers.map((t) => t.type),
      unpotentiatedCount: unpotentiated.length,
      existingPrinciples: this.principles.length,
    });

    let principlesExtracted = 0;

    // Process pattern-density triggers via clustering
    const densityTriggers = triggers.filter(
      (t) => t.type === "pattern-density",
    );
    if (densityTriggers.length > 0) {
      const clusters = clusterEpisodes(unpotentiated, this.config);

      for (const cluster of clusters) {
        const principle = await this.extractPrinciple(cluster.episodes, {
          type: "pattern-density",
          episodeCount: cluster.episodes.length,
          similarity: cluster.commonality,
        });

        if (principle) {
          await this.verifyPrincipleWithSenses(principle, cluster.episodes);
          this.principles.push(principle);
          // Mark episodes as potentiated
          for (const ep of cluster.episodes) {
            ep.potentiatedBy.push(principle.id);
          }
          principlesExtracted++;
        }
      }
    }

    // Process surprise triggers
    for (const trigger of triggers) {
      if (trigger.type !== "surprise") continue;

      const episode = unpotentiated.find(
        (ep) => ep.taskId === trigger.taskId,
      );
      if (!episode) continue;

      const principle = await this.extractPrinciple([episode], trigger);

      if (principle) {
        await this.verifyPrincipleWithSenses(principle, [episode]);
        this.principles.push(principle);
        episode.potentiatedBy.push(principle.id);
        principlesExtracted++;
      }
    }

    // Process contradiction triggers
    const contradictionTriggers = triggers.filter(
      (t) => t.type === "contradiction",
    );
    for (const trigger of contradictionTriggers) {
      if (trigger.type !== "contradiction") continue;

      const principle = this.principles.find(
        (p) => p.id === trigger.principleId,
      );
      const episode = unpotentiated.find(
        (ep) => ep.id === trigger.contradictingEpisodeId,
      );
      if (!principle || !episode) continue;

      const refined = await this.refinePrinciple(principle, episode);
      if (refined && refined !== principle) {
        // Verify the new/refined principle (not the maintained one)
        await this.verifyPrincipleWithSenses(refined, [episode]);
      }
      if (refined) {
        principlesExtracted++; // Counts refinements too
      }
    }

    // ── Sense-scoped pass ──────────────────────────────────────
    // For each project × sense, check if there are enough episodes
    // to extract what that sense has learned about that project.
    const senseScopedCount = await this.potentiatePerSense();
    principlesExtracted += senseScopedCount;

    // Fade eligible episodes
    let fadedCount = 0;
    for (const ep of allEpisodes) {
      if (
        ep.potentiatedBy.length > 0 &&
        ep.contradicts.length === 0 &&
        !ep.faded
      ) {
        if (this.fadeEpisode(ep.id)) fadedCount++;
      }
    }

    this.meta.lastPotentiationAt = new Date();

    emit("hippocampus:potentiation-complete", {
      principlesExtracted,
      fadedCount,
      totalPrinciples: this.principles.length,
      triggers: triggers.map((t) => t.type),
    });

    log.info("Potentiation complete", {
      principlesExtracted,
      fadedCount,
      totalPrinciples: this.principles.length,
    });

    // Persist
    await this.save();

    return { principlesExtracted };
  }

  // ── Feature 15: Principle Querying ────────────────────────────

  /** All principles. */
  getPrinciples(): Principle[] {
    return this.principles;
  }

  /**
   * Active principles — confidence above death threshold,
   * not superseded by a newer principle.
   */
  getActivePrinciples(): Principle[] {
    return this.principles.filter(
      (p) =>
        p.confidence >= this.config.principleDeathThreshold &&
        !p.supersededBy,
    );
  }

  /** Active principles relevant to a specific sense. */
  getPrinciplesForSense(senseId: string): Principle[] {
    return this.getActivePrinciples().filter((p) =>
      p.relevantSenses.some(
        (s) => s === senseId || s.toLowerCase() === senseId.toLowerCase(),
      ),
    );
  }

  /**
   * Active project-sense principles for a specific sense + project.
   * These are what a sense has learned about a specific project.
   */
  getPrinciplesForSenseAndProject(
    senseId: string,
    projectId: string,
  ): Principle[] {
    return this.getActivePrinciples().filter(
      (p) =>
        p.scope === "project-sense" &&
        p.extractionContext.projectId === projectId &&
        p.relevantSenses.some(
          (s) => s === senseId || s.toLowerCase() === senseId.toLowerCase(),
        ),
    );
  }

  // ── Feature 15: Evidence Management ───────────────────────────

  addSupportingEvidence(
    principleId: string,
    episode: Episode,
    relevance: string,
  ): void {
    const principle = this.principles.find((p) => p.id === principleId);
    if (!principle) return;

    const ref: EvidenceRef = {
      episodeId: episode.id,
      projectId: episode.projectId,
      taskId: episode.taskId,
      relevance,
      addedAt: new Date(),
    };

    principle.supportingEvidence.push(ref);
    principle.confidence = Math.min(
      1,
      principle.confidence + this.config.confirmationIncrement,
    );
    principle.lastUpdated = new Date();

    log.debug("Supporting evidence added", {
      principleId,
      episodeId: episode.id,
      newConfidence: principle.confidence.toFixed(3),
    });
  }

  addContradictingEvidence(
    principleId: string,
    episode: Episode,
    relevance: string,
  ): void {
    const principle = this.principles.find((p) => p.id === principleId);
    if (!principle) return;

    const ref: EvidenceRef = {
      episodeId: episode.id,
      projectId: episode.projectId,
      taskId: episode.taskId,
      relevance,
      addedAt: new Date(),
    };

    principle.contradictingEvidence.push(ref);
    principle.confidence = Math.max(
      0,
      principle.confidence - this.config.contradictionDecrement,
    );
    principle.lastUpdated = new Date();

    log.debug("Contradicting evidence added", {
      principleId,
      episodeId: episode.id,
      newConfidence: principle.confidence.toFixed(3),
    });
  }

  // ── Child Cortex Ingestion ─────────────────────────────────────

  /**
   * Ingest episodes from a child Cortex — vicarious learning.
   * The parent learns from the child's process, not just its output.
   *
   * Stores episodes with a "child-cortex" marker, runs contradiction
   * detection against parent's principles, and may trigger potentiation
   * if the child's cluster of episodes reveals a new pattern.
   */
  ingestChildEpisodes(childProjectId: string, episodes: Episode[]): void {
    if (episodes.length === 0) return;

    // Store in parent's project scope (prefixed to distinguish from own episodes)
    const parentProjectId = `child:${childProjectId}`;
    const existing = this.episodes.get(parentProjectId) ?? [];

    for (const ep of episodes) {
      // Only ingest significant episodes (high dopamine or contradictions)
      if (Math.abs(ep.dopamineSignal) < 0.3 && ep.contradicts.length === 0) continue;

      existing.push(ep);
    }

    this.episodes.set(parentProjectId, existing);

    // Run contradiction detection — child may have discovered something
    // that contradicts parent's existing principles
    for (const ep of episodes) {
      if (ep.contradicts.length > 0) {
        for (const principleId of ep.contradicts) {
          const principle = this.principles.find((p) => p.id === principleId);
          if (principle) {
            principle.contradictingEvidence.push({
              episodeId: ep.id,
              projectId: childProjectId,
              taskId: ep.taskId,
              relevance: "child-cortex experience",
              addedAt: new Date(),
            });
          }
        }
      }
    }

    emit("hippocampus:child-episodes-ingested", {
      childProjectId,
      episodeCount: episodes.length,
      significantCount: existing.length,
    });

    log.info("Ingested child Cortex episodes", {
      childProjectId,
      total: episodes.length,
    });

    // Persist asynchronously
    this.store.saveEpisodes(parentProjectId, existing).catch((err) => {
      log.warn("Failed to persist child episodes", { error: String(err) });
    });
  }

  /**
   * Ingest high-confidence principles from a child Cortex.
   * Only accepts principles the child was confident about (> 0.7).
   * Applies a trust discount (child confidence × 0.7) since the
   * parent hasn't verified the principle from its own experience.
   */
  ingestChildPrinciples(childPrinciples: Principle[]): void {
    const accepted: Principle[] = [];

    for (const p of childPrinciples) {
      // Only accept high-confidence principles
      if (p.confidence < 0.7) continue;

      // Trust discount — parent hasn't verified this from own experience
      const discountedPrinciple: Principle = {
        ...p,
        id: `child:${p.id}`,
        confidence: p.confidence * 0.7,
        scope: "cross-project", // Child's learning applies generally
        extractionContext: {
          ...p.extractionContext,
          trigger: p.extractionContext.trigger, // Preserve original trigger — ingestion source tracked by id prefix
        },
      };

      // Check for duplicates — don't ingest if parent already has a similar principle
      const isDuplicate = this.principles.some(
        (existing) => existing.statement.toLowerCase() === discountedPrinciple.statement.toLowerCase(),
      );
      if (isDuplicate) continue;

      this.principles.push(discountedPrinciple);
      accepted.push(discountedPrinciple);
    }

    if (accepted.length > 0) {
      emit("hippocampus:child-principles-ingested", {
        offered: childPrinciples.length,
        accepted: accepted.length,
        statements: accepted.map((p) => p.statement.slice(0, 80)),
      });

      log.info("Ingested child Cortex principles", {
        offered: childPrinciples.length,
        accepted: accepted.length,
      });

      // Persist asynchronously
      this.store.savePrinciples(this.principles).catch((err) => {
        log.warn("Failed to persist ingested principles", { error: String(err) });
      });
    }
  }

  // ── Constructive Episodic Simulation ────────────────────────────

  /**
   * Constructive episodic simulation — the hippocampus's 3rd capability.
   *
   * Recombines crystallized principles + past episodes + world model maxims
   * + territory observations to construct hypothetical future failure scenarios.
   *
   * LLM-assisted. Called at phase gates, after crystallization, on
   * high-relevance observations, and during high-NE rest cycles.
   */
  async simulate(
    trigger: SimulationTrigger,
    remainingTasks: TaskGraphNode[],
    worldModelMaxims: string[],
    observations: TerritoryObservation[],
    model?: string,
  ): Promise<SimulatedScenario[]> {
    const activePrinciples = this.getActivePrinciples();
    const recentEpisodes = this.getRecentEpisodes(10);

    // Need at least some material to simulate from
    if (activePrinciples.length === 0 && recentEpisodes.length === 0) {
      log.debug("Simulation skipped — no principles or episodes");
      return [];
    }

    if (remainingTasks.length === 0) {
      log.debug("Simulation skipped — no remaining tasks");
      return [];
    }

    const simulationModel = model ?? this.config.potentiationModel;

    const systemPrompt = hippocampalSimulationSystem();
    const userPrompt = hippocampalSimulationUser({
      principles: activePrinciples.map((p) => ({
        id: p.id,
        statement: p.statement,
        domain: p.domain,
        confidence: p.confidence,
      })),
      episodes: recentEpisodes.map((e) => ({
        id: e.id,
        taskDescription: e.narrative.taskDescription,
        outcome: e.narrative.outcome,
        dopamineSignal: e.dopamineSignal,
        tensionCount: e.narrative.tensionSnapshots.length,
        cycles: e.narrative.cycles,
      })),
      maxims: worldModelMaxims,
      observations: observations.map((o) => ({
        id: o.id,
        fact: o.fact,
        component: o.source.component,
        relevance: o.relevance,
      })),
      remainingTasks: remainingTasks.map((n) => ({
        id: n.task.id,
        description: n.task.description,
        dependsOn: n.dependsOn,
        phaseGroup: n.phaseGroup,
      })),
      trigger,
    });

    try {
      const result = await callStructured(
        "simulation",
        simulationModel,
        systemPrompt,
        userPrompt,
        SimulationSchema,
        this.simulationConfig.maxTokens,
      );

      const scenarios: SimulatedScenario[] = result.scenarios
        .filter((s) => s.confidence >= this.simulationConfig.minConfidence)
        .map((s) => ({
          id: newId(),
          narrative: s.narrative,
          affectedTaskIds: s.affectedTaskIds,
          grounding: {
            principleIds: s.groundingPrinciples,
            episodeIds: s.groundingEpisodes,
            maximStatements: s.groundingMaxims,
            observationIds: resolveObservationGrounding(
              s.groundingObservations,
              observations,
            ),
          },
          impact: s.impact,
          confidence: s.confidence,
          suggestedResponse: s.suggestedResponse,
          simulatedAt: new Date(),
          status: "new" as const,
        }));

      // Store and prune
      this.simulations.push(...scenarios);
      this.pruneSimulations();

      emit("hippocampus:simulation", {
        trigger: trigger.type,
        scenariosGenerated: scenarios.length,
        principlesUsed: activePrinciples.length,
        episodesUsed: recentEpisodes.length,
        observationsUsed: observations.length,
      });

      log.info("Simulation complete", {
        trigger: trigger.type,
        scenarios: scenarios.length,
      });

      return scenarios;
    } catch (err) {
      log.warn("Simulation failed", { error: String(err), trigger: trigger.type });
      return [];
    }
  }

  /** All simulated scenarios. */
  getSimulations(): SimulatedScenario[] {
    return [...this.simulations];
  }

  /** Simulated scenarios with status "new". */
  getNewSimulations(): SimulatedScenario[] {
    return this.simulations.filter((s) => s.status === "new");
  }

  /** Mark a simulation as consumed by deep synthesis. */
  markSimulationSynthesized(id: string): void {
    const sim = this.simulations.find((s) => s.id === id);
    if (sim) sim.status = "synthesized";
  }

  /** Dismiss a simulation as irrelevant. */
  dismissSimulation(id: string): void {
    const sim = this.simulations.find((s) => s.id === id);
    if (sim) sim.status = "dismissed";
  }

  /**
   * Record whether a simulated scenario materialized.
   * Called after the affected task completes, for calibration.
   */
  recordSimulationOutcome(
    scenarioId: string,
    materialized: boolean,
    actualImpact: number,
  ): void {
    const sim = this.simulations.find((s) => s.id === scenarioId);
    if (!sim) return;

    sim.status = materialized ? "materialized" : "dismissed";

    this.simulationAccuracy.push({
      scenarioId,
      predicted: true,
      materialized,
      impactError: Math.abs(sim.impact - actualImpact),
      recordedAt: new Date(),
    });

    // Keep rolling window of 20
    if (this.simulationAccuracy.length > 20) {
      this.simulationAccuracy = this.simulationAccuracy.slice(-20);
    }

    emit("hippocampus:simulation-outcome", {
      scenarioId,
      materialized,
      predictedImpact: sim.impact,
      actualImpact,
    });
  }

  /**
   * Rolling simulation accuracy (0-1).
   * Returns 0.5 (unknown) when fewer than 3 records exist.
   */
  getSimulationAccuracy(): number {
    if (this.simulationAccuracy.length < 3) return 0.5;
    const correct = this.simulationAccuracy.filter((r) => r.materialized).length;
    return correct / this.simulationAccuracy.length;
  }

  /** Prune simulations to maxScenarios — oldest dismissed/synthesized first. */
  private pruneSimulations(): void {
    if (this.simulations.length <= this.simulationConfig.maxScenarios) return;

    // Sort: dismissed/synthesized first (by date asc), then new/materialized
    this.simulations.sort((a, b) => {
      const aProcessed = a.status === "dismissed" || a.status === "synthesized";
      const bProcessed = b.status === "dismissed" || b.status === "synthesized";
      if (aProcessed && !bProcessed) return -1;
      if (!aProcessed && bProcessed) return 1;
      return a.simulatedAt.getTime() - b.simulatedAt.getTime();
    });

    this.simulations = this.simulations.slice(-this.simulationConfig.maxScenarios);
  }

  // ── Snapshot ───────────────────────────────────────────────────

  getState(): HippocampusState {
    const allEps = this.allEpisodes();
    const activePrinciples = this.getActivePrinciples();
    const deadPrinciples = this.principles.filter(
      (p) => p.confidence < this.config.principleDeathThreshold,
    );
    const supersededPrinciples = this.principles.filter(
      (p) => p.supersededBy,
    );

    const episodesByProject: Record<string, number> = {};
    for (const [projectId, episodes] of this.episodes) {
      episodesByProject[projectId] = episodes.length;
    }

    return {
      totalEpisodes: allEps.length,
      episodesByProject,
      unpotentiatedEpisodes: this.getUnpotentiatedCount(),
      fadedEpisodes: allEps.filter((e) => e.faded).length,
      totalPrinciples: this.principles.length,
      activePrinciples: activePrinciples.length,
      deadPrinciples: deadPrinciples.length,
      supersededPrinciples: supersededPrinciples.length,
      episodeDensity: this.getEpisodeDensity(),
      lastPotentiationAt: this.meta.lastPotentiationAt,
      recentEpisodes: allEps
        .sort((a, b) => b.sequenceNumber - a.sequenceNumber)
        .slice(0, 5)
        .map((ep) => ({
          id: ep.id,
          taskId: ep.taskId,
          projectId: ep.projectId,
          significance: ep.significance,
          dopamineSignal: ep.dopamineSignal,
          faded: ep.faded,
          senseCount: ep.senseParticipation.length,
          cycles: ep.narrative.cycles,
          outcome: ep.narrative.outcome,
        })),
      recentPrinciples: this.principles.slice(-5).map((p) => ({
        id: p.id,
        statement: p.statement,
        confidence: p.confidence,
        relevantSenses: p.relevantSenses,
        supportingCount: p.supportingEvidence.length,
        contradictingCount: p.contradictingEvidence.length,
        active:
          p.confidence >= this.config.principleDeathThreshold &&
          !p.supersededBy,
      })),
    };
  }

  // ── Private: Sense-scoped potentiation ────────────────────────

  /**
   * Run sense-scoped potentiation across all projects and senses.
   *
   * For each project, for each sense with enough episodes, check if
   * a project-sense principle should be extracted. This is what
   * produces Feature #26's per-sense project summaries — each sense
   * builds its own understanding of each project it participates in.
   *
   * Returns the number of principles extracted.
   */
  private async potentiatePerSense(): Promise<number> {
    let extracted = 0;

    for (const [projectId, episodes] of this.episodes) {
      // Collect all sense names that appear in this project's episodes
      const senseNames = new Set<string>();
      for (const ep of episodes) {
        for (const sp of ep.senseParticipation) {
          senseNames.add(sp.senseName);
        }
      }

      for (const senseName of senseNames) {
        // Filter to episodes where this sense participated
        const senseEpisodes = episodes.filter((ep) =>
          ep.senseParticipation.some((sp) => sp.senseName === senseName),
        );

        // Need enough episodes to see a pattern
        if (senseEpisodes.length < this.config.minClusterSize) continue;

        // Check if unpotentiated sense episodes exist (any episode not
        // yet used for a project-sense principle for this sense)
        const existingSensePrinciples =
          this.getPrinciplesForSenseAndProject(senseName, projectId);
        const existingSensePrincipleEpisodeIds = new Set(
          existingSensePrinciples.flatMap(
            (p) => p.extractionContext.episodeIds,
          ),
        );

        const newSenseEpisodes = senseEpisodes.filter(
          (ep) => !existingSensePrincipleEpisodeIds.has(ep.id),
        );

        // Need new episodes that haven't been covered
        if (newSenseEpisodes.length < this.config.minClusterSize) continue;

        log.info("Sense-scoped potentiation candidate", {
          projectId,
          senseName,
          totalEpisodes: senseEpisodes.length,
          newEpisodes: newSenseEpisodes.length,
          existingPrinciples: existingSensePrinciples.length,
        });

        const principle = await this.extractSensePrinciple(
          senseName,
          projectId,
          senseEpisodes, // Full history for context
          existingSensePrinciples,
        );

        if (principle) {
          await this.verifyPrincipleWithSenses(principle, senseEpisodes);
          this.principles.push(principle);

          // Mark new episodes as potentiated by this principle
          for (const ep of newSenseEpisodes) {
            ep.potentiatedBy.push(principle.id);
          }

          extracted++;
        }
      }
    }

    if (extracted > 0) {
      log.info("Sense-scoped potentiation complete", {
        principlesExtracted: extracted,
      });
    }

    return extracted;
  }

  /**
   * Extract a sense-scoped principle via LLM.
   *
   * Uses the sense-specific prompt that asks "from this sense's
   * perspective, what has it learned about this project?"
   */
  private async extractSensePrinciple(
    senseName: string,
    projectId: string,
    episodes: Episode[],
    existingPrinciples: Principle[],
  ): Promise<Principle | null> {
    log.info("Extracting sense-scoped principle via LLM", {
      senseName,
      projectId,
      episodeCount: episodes.length,
    });

    try {
      const result = await callStructured(
        "potentiation",
        this.config.potentiationModel,
        potentiationSenseExtractSystem(),
        potentiationSenseExtractUser(
          senseName,
          projectId,
          episodes,
          existingPrinciples,
        ),
        PrincipleExtractionSchema,
      );

      if (!result.principle) {
        log.info("LLM declined sense-scoped extraction", {
          senseName,
          projectId,
          reasoning: result.reasoning,
        });
        return null;
      }

      const now = new Date();
      const principle: Principle = {
        id: newId(),
        statement: result.principle.statement,
        relevantSenses: result.principle.relevantSenses,
        domain: result.principle.domain,
        scope: "project-sense",
        confidence: result.principle.confidence,
        supportingEvidence: episodes.map((ep) => ({
          episodeId: ep.id,
          projectId: ep.projectId,
          taskId: ep.taskId,
          relevance: `${senseName} participation in project episode`,
          addedAt: now,
        })),
        contradictingEvidence: [],
        supersedes: result.principle.supersedes ?? undefined,
        extractedAt: now,
        lastUpdated: now,
        extractionContext: {
          episodeIds: episodes.map((ep) => ep.id),
          trigger: {
            type: "pattern-density",
            episodeCount: episodes.length,
            similarity: `${senseName}'s accumulated experience in project`,
          },
          projectId,
          senseId: senseName,
        },
      };

      // If superseding, mark the old principle
      if (principle.supersedes) {
        const old = this.principles.find(
          (p) => p.id === principle.supersedes,
        );
        if (old) {
          old.supersededBy = principle.id;
          old.lastUpdated = now;
        }
      }

      emit("hippocampus:principle-extracted", {
        principleId: principle.id,
        statement: principle.statement,
        confidence: principle.confidence,
        senses: principle.relevantSenses,
        episodeCount: episodes.length,
        trigger: "sense-scoped",
        supersedes: principle.supersedes,
        scope: "project-sense",
        projectId,
        senseName,
      });

      log.info("Sense-scoped principle extracted", {
        principleId: principle.id,
        senseName,
        projectId,
        statement: principle.statement.slice(0, 100),
        confidence: principle.confidence,
      });

      return principle;
    } catch (err) {
      log.error("Sense-scoped principle extraction failed", {
        senseName,
        projectId,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * After recording an episode, check if participating senses have
   * existing project-sense principles that this episode supports.
   *
   * When a sense scores acceptably on an episode and doesn't
   * contradict the principle, that's confirming evidence — the
   * principle's confidence gets a small bump.
   */
  private updateProjectSenseEvidence(
    projectId: string,
    episode: Episode,
  ): void {
    for (const sp of episode.senseParticipation) {
      const sensePrinciples = this.getPrinciplesForSenseAndProject(
        sp.senseName,
        projectId,
      );

      for (const principle of sensePrinciples) {
        // Skip if this episode already contradicts this principle
        if (episode.contradicts.includes(principle.id)) continue;

        if (sp.acceptable) {
          this.addSupportingEvidence(
            principle.id,
            episode,
            `${sp.senseName} scored ${sp.finalScore.toFixed(1)}/10 (acceptable) — consistent with project understanding`,
          );
        }
      }
    }
  }

  // ── Sense Verification ──────────────────────────────────────

  /**
   * Verify a principle with its relevant senses before storing.
   *
   * Resolves principle.relevantSenses to Sense objects, calls each
   * in parallel, computes mean agreement, adjusts confidence, and
   * stores verification results on the principle.
   *
   * No-op when library is not set or no senses resolve.
   */
  private async verifyPrincipleWithSenses(
    principle: Principle,
    episodes: Episode[],
  ): Promise<void> {
    if (!this.library) return;

    const senses = principle.relevantSenses
      .map((name) => resolveSenseByName(this.library!, name))
      .filter((s): s is import("../types/sense.js").Sense => s !== undefined);

    if (senses.length === 0) return;

    const episodeSummaries = episodes.map((ep) => ({
      taskDescription: ep.narrative.taskDescription,
      outcome: ep.narrative.outcome,
      cycles: ep.narrative.cycles,
    }));

    const results = await verifyWithSenses(
      "principle-verification",
      this.config.potentiationModel,
      senses,
      (sense) => ({
        system: principleVerificationSystem(sense),
        user: principleVerificationUser(
          {
            statement: principle.statement,
            domain: principle.domain,
            confidence: principle.confidence,
          },
          episodeSummaries,
        ),
      }),
    );

    if (results.size === 0) return;

    // Compute consensus (mean agreement)
    const verificationResults: Principle["senseVerification"] = {
      results: [],
      consensus: 0,
      verifiedAt: new Date(),
    };

    let totalAgreement = 0;
    for (const [senseId, result] of results) {
      const sense = senses.find((s) => s.id === senseId);
      verificationResults.results.push({
        senseId,
        senseName: sense?.name ?? senseId,
        agreement: result.agreement,
        assessment: result.assessment,
      });
      totalAgreement += result.agreement;
    }

    verificationResults.consensus = totalAgreement / results.size;

    // Modulate confidence by consensus
    principle.confidence *= verificationResults.consensus;
    principle.senseVerification = verificationResults;

    log.info("Principle verified with senses", {
      principleId: principle.id,
      sensesConsulted: results.size,
      consensus: verificationResults.consensus.toFixed(3),
      adjustedConfidence: principle.confidence.toFixed(3),
    });
  }

  // ── Private: Potentiation internals ───────────────────────────

  /**
   * Extract a principle from episodes via LLM.
   * Calls the potentiation extraction prompt with the episode
   * cluster and existing principles for deduplication.
   */
  private async extractPrinciple(
    episodes: Episode[],
    trigger: PotentiationTrigger,
  ): Promise<Principle | null> {
    log.info("Extracting principle via LLM", {
      episodeCount: episodes.length,
      trigger: trigger.type,
    });

    try {
      const result = await callStructured(
        "potentiation",
        this.config.potentiationModel,
        potentiationExtractSystem(),
        potentiationExtractUser(
          episodes,
          this.getActivePrinciples(),
          trigger,
        ),
        PrincipleExtractionSchema,
      );

      if (!result.principle) {
        log.info("LLM declined to extract principle", {
          reasoning: result.reasoning,
        });
        return null;
      }

      const now = new Date();
      const principle: Principle = {
        id: newId(),
        statement: result.principle.statement,
        relevantSenses: result.principle.relevantSenses,
        domain: result.principle.domain,
        scope: "cross-project",
        confidence: result.principle.confidence,
        supportingEvidence: episodes.map((ep) => ({
          episodeId: ep.id,
          projectId: ep.projectId,
          taskId: ep.taskId,
          relevance: "Source episode for principle extraction",
          addedAt: now,
        })),
        contradictingEvidence: [],
        supersedes: result.principle.supersedes ?? undefined,
        extractedAt: now,
        lastUpdated: now,
        extractionContext: {
          episodeIds: episodes.map((ep) => ep.id),
          trigger,
          projectId: episodes[0]?.projectId ?? "unknown",
        },
      };

      // If superseding, mark the old principle
      if (principle.supersedes) {
        const old = this.principles.find(
          (p) => p.id === principle.supersedes,
        );
        if (old) {
          old.supersededBy = principle.id;
          old.lastUpdated = now;
        }
      }

      emit("hippocampus:principle-extracted", {
        principleId: principle.id,
        statement: principle.statement,
        confidence: principle.confidence,
        senses: principle.relevantSenses,
        episodeCount: episodes.length,
        trigger: trigger.type,
        supersedes: principle.supersedes,
      });

      log.info("Principle extracted", {
        principleId: principle.id,
        statement: principle.statement.slice(0, 100),
        confidence: principle.confidence,
      });

      return principle;
    } catch (err) {
      log.error("Principle extraction failed", { error: String(err) });
      return null;
    }
  }

  /**
   * Refine a contradicted principle via LLM.
   * The LLM decides whether to refine, replace, or maintain.
   */
  private async refinePrinciple(
    principle: Principle,
    contradictingEpisode: Episode,
  ): Promise<Principle | null> {
    log.info("Refining principle via LLM", {
      principleId: principle.id,
      episodeId: contradictingEpisode.id,
    });

    try {
      const result = await callStructured(
        "potentiation",
        this.config.potentiationModel,
        potentiationRefineSystem(),
        potentiationRefineUser(principle, contradictingEpisode),
        PrincipleRefinementSchema,
      );

      const now = new Date();

      switch (result.action) {
        case "maintain":
          // Principle stands — just update confidence
          principle.confidence = result.revisedConfidence;
          principle.lastUpdated = now;
          log.info("Principle maintained after contradiction", {
            principleId: principle.id,
            reasoning: result.reasoning,
          });
          return principle;

        case "refine": {
          // Create refined version that supersedes the old one
          const refined: Principle = {
            ...principle,
            id: newId(),
            statement: result.revisedStatement ?? principle.statement,
            confidence: result.revisedConfidence,
            supersedes: principle.id,
            extractedAt: now,
            lastUpdated: now,
            extractionContext: {
              episodeIds: [contradictingEpisode.id],
              trigger: {
                type: "contradiction",
                principleId: principle.id,
                contradictingEpisodeId: contradictingEpisode.id,
              },
              projectId: contradictingEpisode.projectId,
            },
          };

          principle.supersededBy = refined.id;
          principle.lastUpdated = now;
          this.principles.push(refined);

          emit("hippocampus:principle-refined", {
            oldId: principle.id,
            newId: refined.id,
            statement: refined.statement,
            reasoning: result.reasoning,
          });

          log.info("Principle refined", {
            oldId: principle.id,
            newId: refined.id,
            statement: refined.statement.slice(0, 100),
          });

          return refined;
        }

        case "replace": {
          // Replace entirely — inherit scope from the principle being replaced
          const replacement: Principle = {
            id: newId(),
            statement: result.revisedStatement ?? principle.statement,
            relevantSenses: principle.relevantSenses,
            domain: principle.domain,
            scope: principle.scope,
            confidence: result.revisedConfidence,
            supportingEvidence: [
              {
                episodeId: contradictingEpisode.id,
                projectId: contradictingEpisode.projectId,
                taskId: contradictingEpisode.taskId,
                relevance: "Episode that prompted principle replacement",
                addedAt: now,
              },
            ],
            contradictingEvidence: [],
            supersedes: principle.id,
            extractedAt: now,
            lastUpdated: now,
            extractionContext: {
              episodeIds: [contradictingEpisode.id],
              trigger: {
                type: "contradiction",
                principleId: principle.id,
                contradictingEpisodeId: contradictingEpisode.id,
              },
              projectId: contradictingEpisode.projectId,
            },
          };

          principle.supersededBy = replacement.id;
          principle.lastUpdated = now;
          this.principles.push(replacement);

          emit("hippocampus:principle-replaced", {
            oldId: principle.id,
            newId: replacement.id,
            statement: replacement.statement,
            reasoning: result.reasoning,
          });

          log.info("Principle replaced", {
            oldId: principle.id,
            newId: replacement.id,
          });

          return replacement;
        }
      }
    } catch (err) {
      log.error("Principle refinement failed", { error: String(err) });
      return null;
    }
  }

  // ── Private: Contradiction detection ──────────────────────────

  /**
   * Check if a new episode contradicts any existing active principles.
   * Uses the pure functions from potentiation.ts.
   */
  private checkForContradictions(
    episode: Episode,
  ): PrincipleContradiction[] {
    const activePrinciples = this.getActivePrinciples();
    if (activePrinciples.length === 0) return [];

    return findContradictions([episode], activePrinciples);
  }

  // ── Private: Pruning ──────────────────────────────────────────

  /**
   * Prune a project's episodes if over limit.
   * Oldest faded episodes go first, then oldest unfaded.
   */
  private pruneProject(projectId: string): void {
    const episodes = this.episodes.get(projectId);
    if (!episodes || episodes.length <= this.config.maxEpisodesPerProject)
      return;

    const excess = episodes.length - this.config.maxEpisodesPerProject;

    // Sort: faded first (by sequence number asc), then unfaded by sequence asc
    const prunable = [...episodes].sort((a, b) => {
      if (a.faded && !b.faded) return -1;
      if (!a.faded && b.faded) return 1;
      return a.sequenceNumber - b.sequenceNumber;
    });

    const toRemove = new Set(
      prunable.slice(0, excess).map((e) => e.id),
    );

    const pruned = episodes.filter((e) => !toRemove.has(e.id));
    this.episodes.set(projectId, pruned);

    if (toRemove.size > 0) {
      log.debug("Pruned project episodes", {
        projectId,
        pruned: toRemove.size,
        remaining: pruned.length,
      });
    }
  }

  /** Prune globally if total exceeds maxTotalEpisodes. */
  private pruneGlobal(): void {
    const total = this.getEpisodeCount();
    if (total <= this.config.maxTotalEpisodes) return;

    const excess = total - this.config.maxTotalEpisodes;

    // Collect all episodes, sort by prunability
    const all = this.allEpisodesWithProject();
    all.sort((a, b) => {
      if (a.episode.faded && !b.episode.faded) return -1;
      if (!a.episode.faded && b.episode.faded) return 1;
      return a.episode.sequenceNumber - b.episode.sequenceNumber;
    });

    const toRemove = new Set(
      all.slice(0, excess).map((e) => e.episode.id),
    );

    for (const [projectId, episodes] of this.episodes) {
      const filtered = episodes.filter((e) => !toRemove.has(e.id));
      if (filtered.length !== episodes.length) {
        this.episodes.set(projectId, filtered);
      }
    }

    log.debug("Global prune", { pruned: toRemove.size });
  }

  // ── Private: Helpers ──────────────────────────────────────────

  /** Flat array of all episodes across projects. */
  private allEpisodes(): Episode[] {
    return [...this.episodes.values()].flat();
  }

  /** All episodes tagged with their project ID. */
  private allEpisodesWithProject(): {
    projectId: string;
    episode: Episode;
  }[] {
    const result: { projectId: string; episode: Episode }[] = [];
    for (const [projectId, episodes] of this.episodes) {
      for (const episode of episodes) {
        result.push({ projectId, episode });
      }
    }
    return result;
  }
}

// ─── Zod schemas for potentiation LLM output ────────────────────

const PrincipleExtractionSchema = z.object({
  principle: z
    .object({
      statement: z.string(),
      relevantSenses: z.array(z.string()),
      domain: z.string(),
      confidence: z.number().min(0).max(1),
      supersedes: z.string().nullable(),
    })
    .nullable(),
  reasoning: z.string(),
});

const PrincipleRefinementSchema = z.object({
  action: z.enum(["refine", "replace", "maintain"]),
  revisedStatement: z.string().optional(),
  revisedConfidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

// ─── Simulation helpers ─────────────────────────────────────────

/**
 * Resolve observation grounding from LLM-returned IDs.
 * Uses LLM-provided IDs when available (validated against actual observations),
 * falls back to all observation IDs when the LLM omits them.
 */
function resolveObservationGrounding(
  llmIds: string[] | undefined,
  observations: TerritoryObservation[],
): string[] {
  if (!llmIds || llmIds.length === 0) {
    // Fallback: all provided observations contributed
    return observations.map((o) => o.id);
  }
  // Validate returned IDs against actual observation set
  const validIds = new Set(observations.map((o) => o.id));
  return llmIds.filter((id) => validIds.has(id));
}

// ─── Zod schema for simulation LLM output ───────────────────────

const SimulationSchema = z.object({
  scenarios: z.array(z.object({
    narrative: z.string(),
    affectedTaskIds: z.array(z.string()),
    impact: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    suggestedResponse: z.string(),
    groundingPrinciples: z.array(z.string()),
    groundingEpisodes: z.array(z.string()),
    groundingMaxims: z.array(z.string()),
    groundingObservations: z.array(z.string()).optional(),
  })),
  reasoning: z.string(),
});
