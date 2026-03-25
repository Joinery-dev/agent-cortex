/**
 * Tonic Dopamine Tracker — per-project exponential moving average.
 *
 * Tonic dopamine reflects the overall reward environment for a project:
 * "How is this going relative to expectations?"
 *
 * Updated after each phasic signal (task completion). The tonic level
 * modulates per-consumer projections — e.g., negative tonic biases
 * the basal ganglia toward exploration.
 *
 * Stateful but lightweight. One Map of per-project EMA state.
 * Serializable for cross-session persistence.
 */

import type {
  TonicDopamine,
  TonicConfig,
  TonicSnapshot,
  TonicTrackerSnapshot,
} from "../types/dopamine.js";
import { DEFAULT_TONIC_CONFIG } from "../types/dopamine.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("tonic");

/** Internal state for one project's tonic tracking. */
interface ProjectTonicState {
  level: number;
  sampleCount: number;
  /** Recent levels for trend detection (ring buffer). */
  recentLevels: number[];
  lastUpdated: Date;
}

export class TonicTracker {
  private projects: Map<string, ProjectTonicState> = new Map();
  private config: TonicConfig;

  constructor(config?: Partial<TonicConfig>) {
    this.config = { ...DEFAULT_TONIC_CONFIG, ...config };
  }

  // ── Core ──────────────────────────────────────────────────────

  /**
   * Update tonic level with a new phasic aggregate.
   * Called after each dopamine computation (between-tasks processing).
   *
   * EMA: level = α × phasic + (1 - α) × level
   */
  update(projectId: string, phasicAggregate: number): TonicDopamine {
    let state = this.projects.get(projectId);

    if (!state) {
      state = {
        level: 0,
        sampleCount: 0,
        recentLevels: [],
        lastUpdated: new Date(),
      };
      this.projects.set(projectId, state);
    }

    // Snapshot level before update for trend detection
    const previousLevel = state.level;

    // EMA update
    state.level =
      this.config.alpha * phasicAggregate +
      (1 - this.config.alpha) * state.level;
    state.sampleCount++;
    state.lastUpdated = new Date();

    // Track recent levels for trend detection (ring buffer)
    state.recentLevels.push(previousLevel);
    if (state.recentLevels.length > this.config.trendWindow) {
      state.recentLevels.shift();
    }

    const tonic = this.toTonicDopamine(projectId, state);

    log.debug("Tonic updated", {
      projectId,
      phasicAggregate: phasicAggregate.toFixed(3),
      tonicLevel: tonic.level.toFixed(3),
      trend: tonic.trend,
      sampleCount: tonic.sampleCount,
    });

    emit("dopamine:tonic-update", {
      projectId,
      level: tonic.level,
      trend: tonic.trend,
      sampleCount: tonic.sampleCount,
      phasicAggregate,
    });

    return tonic;
  }

  /**
   * Get current tonic state for a project.
   * Returns neutral state (level 0) for unknown projects.
   */
  get(projectId: string): TonicDopamine {
    const state = this.projects.get(projectId);

    if (!state) {
      return {
        level: 0,
        trend: "stable",
        sampleCount: 0,
        projectId,
        lastUpdated: new Date(),
      };
    }

    return this.toTonicDopamine(projectId, state);
  }

  // ── Trend Detection ───────────────────────────────────────────

  /**
   * Detect trend by comparing current level to the oldest entry
   * in the recent-levels window. If the difference exceeds
   * trendThreshold, the trend is rising or falling.
   */
  private detectTrend(state: ProjectTonicState): "rising" | "falling" | "stable" {
    if (state.recentLevels.length < this.config.trendWindow) {
      return "stable"; // Not enough data for trend
    }

    const oldest = state.recentLevels[0];
    const delta = state.level - oldest;

    if (delta > this.config.trendThreshold) return "rising";
    if (delta < -this.config.trendThreshold) return "falling";
    return "stable";
  }

  // ── Snapshot / Dashboard ──────────────────────────────────────

  /** Serializable state for dashboard/debugging. */
  getState(): {
    projects: Array<{
      projectId: string;
      level: number;
      trend: string;
      sampleCount: number;
    }>;
    config: TonicConfig;
  } {
    const projects: Array<{
      projectId: string;
      level: number;
      trend: string;
      sampleCount: number;
    }> = [];

    for (const [projectId, state] of this.projects) {
      projects.push({
        projectId,
        level: state.level,
        trend: this.detectTrend(state),
        sampleCount: state.sampleCount,
      });
    }

    return { projects, config: this.config };
  }

  // ── Persistence ───────────────────────────────────────────────

  /** Serialize to a JSON-safe snapshot. */
  serialize(): TonicTrackerSnapshot {
    const projects: TonicSnapshot[] = [];

    for (const [projectId, state] of this.projects) {
      projects.push({
        projectId,
        level: state.level,
        trend: this.detectTrend(state),
        sampleCount: state.sampleCount,
        lastUpdated: state.lastUpdated.toISOString(),
      });
    }

    return { projects, config: this.config };
  }

  /**
   * Restore from a persisted snapshot.
   * Merges with any existing state (snapshot wins on conflict).
   */
  restore(snapshot: TonicTrackerSnapshot): void {
    for (const proj of snapshot.projects) {
      this.projects.set(proj.projectId, {
        level: proj.level,
        sampleCount: proj.sampleCount,
        recentLevels: [], // Trend history lost on restore — rebuilds from new signals
        lastUpdated: new Date(proj.lastUpdated),
      });
    }

    log.info("Tonic state restored", {
      projects: snapshot.projects.length,
    });
  }

  // ── Private helpers ───────────────────────────────────────────

  private toTonicDopamine(
    projectId: string,
    state: ProjectTonicState,
  ): TonicDopamine {
    return {
      level: state.level,
      trend: this.detectTrend(state),
      sampleCount: state.sampleCount,
      projectId,
      lastUpdated: state.lastUpdated,
    };
  }
}
