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
} from "../llm/prompts.js";
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
  private store: HippocampusStore;
  private loaded = false;

  constructor(config?: Partial<HippocampusConfig>) {
    this.config = { ...DEFAULT_HIPPOCAMPUS_CONFIG, ...config };
    this.store = new HippocampusStore(
      this.config.storageDir || undefined,
    );
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
