/**
 * ExteroceptionSystem — external world perception.
 *
 * A generic monitoring infrastructure that watches external sources
 * (npm advisories, API changelogs, deploy status — anything) and
 * feeds signals into the system through two paths:
 *
 *   Urgent    → Amygdala alarm (immediate override)
 *   Non-urgent → in-memory store → batch-processed at between-tasks
 *
 * A mini cerebellum learns per-monitor polling cadence from whether
 * signals lead to actions. EMA-based — recent matters more.
 */

import type { Amygdala } from "./amygdala.js";
import type { Alarm } from "../types/amygdala.js";
import type {
  ExteroceptiveMonitor,
  ExteroceptiveSignal,
  ExteroceptiveBatch,
  ExteroceptionConfig,
  ExteroceptionState,
  BatchAction,
  MonitorCadence,
  MonitorSource,
  SentryResult,
  CadenceEpisode,
} from "../types/exteroception.js";
import { DEFAULT_EXTEROCEPTION_CONFIG } from "../types/exteroception.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit, emitInfo } from "../events.js";

const log = createLogger("exteroception");

export class ExteroceptionSystem {
  private monitors = new Map<string, ExteroceptiveMonitor>();
  private signals: ExteroceptiveSignal[] = [];
  private cadenceEpisodes = new Map<string, CadenceEpisode[]>();
  private config: ExteroceptionConfig;
  private sequenceCounter = 0;
  private totalProcessed = 0;

  // Sentry loop — per-monitor setTimeout chains
  private running = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Dependencies (optional — graceful degradation)
  private amygdala?: Amygdala;

  constructor(
    config?: Partial<ExteroceptionConfig>,
    amygdala?: Amygdala,
  ) {
    this.config = { ...DEFAULT_EXTEROCEPTION_CONFIG, ...config };
    this.amygdala = amygdala;
  }

  // ── Monitor Registry ────────────────────────────────────────────

  addMonitor(opts: {
    id: string;
    name: string;
    source: MonitorSource;
    poll: () => Promise<SentryResult>;
    enabled?: boolean;
  }): void {
    const cadence: MonitorCadence = {
      intervalMs: this.config.defaultIntervalMs,
      floorMs: this.config.globalFloorMs,
      ceilingMs: this.config.globalCeilingMs,
      actionRate: 0,
      totalPolls: 0,
      totalDetections: 0,
      totalActions: 0,
      lastPolledAt: null,
    };

    const monitor: ExteroceptiveMonitor = {
      id: opts.id,
      name: opts.name,
      source: opts.source,
      poll: opts.poll,
      cadence,
      enabled: opts.enabled ?? true,
      registeredAt: new Date(),
    };

    this.monitors.set(opts.id, monitor);

    emit("exteroception:monitor-registered", {
      id: opts.id,
      name: opts.name,
      sourceKind: opts.source.kind,
    });

    // If sentry is running, start polling this monitor
    if (this.running && monitor.enabled) {
      this.schedulePoll(opts.id);
    }
  }

  removeMonitor(id: string): boolean {
    const existed = this.monitors.has(id);
    if (existed) {
      this.clearTimer(id);
      this.monitors.delete(id);
      this.cadenceEpisodes.delete(id);
      emit("exteroception:monitor-removed", { id });
    }
    return existed;
  }

  getMonitors(): ExteroceptiveMonitor[] {
    return Array.from(this.monitors.values());
  }

  getMonitor(id: string): ExteroceptiveMonitor | undefined {
    return this.monitors.get(id);
  }

  // ── Sentry Loop ─────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const monitor of this.monitors.values()) {
      if (monitor.enabled) {
        this.schedulePoll(monitor.id);
      }
    }

    emitInfo("exteroception:started", {
      monitorCount: this.monitors.size,
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }

    emitInfo("exteroception:stopped", {
      pendingSignals: this.getPendingCount(),
    });
  }

  private schedulePoll(monitorId: string): void {
    const monitor = this.monitors.get(monitorId);
    if (!monitor || !this.running || !monitor.enabled) return;

    const timer = setTimeout(
      () => void this.pollMonitor(monitorId),
      monitor.cadence.intervalMs,
    );
    this.timers.set(monitorId, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer != null) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async pollMonitor(monitorId: string): Promise<void> {
    const monitor = this.monitors.get(monitorId);
    if (!monitor || !this.running) return;

    try {
      const result = await monitor.poll();

      // Update counters
      monitor.cadence.totalPolls++;
      monitor.cadence.lastPolledAt = new Date();

      if (!result.detected) {
        // Nothing found — schedule next poll and move on
        this.schedulePoll(monitorId);
        return;
      }

      monitor.cadence.totalDetections++;

      if (result.urgency === "urgent") {
        // ── Urgent path: bypass store, go directly to Amygdala ──
        const alarm: Alarm = {
          source: "exteroception",
          severity: "urgent",
          description: result.summary,
          context: {
            monitorId,
            monitorName: monitor.name,
            sourceKind: monitor.source.kind,
            payload: result.payload,
          },
        };

        if (this.amygdala) {
          this.amygdala.receiveAlarm(alarm);
        } else {
          log.warn("Urgent signal but no amygdala wired — storing instead", {
            monitorId,
            summary: result.summary,
          });
          this.storeSignal(monitorId, result.summary, result.payload, "high");
        }

        emitInfo("exteroception:urgent-signal", {
          monitorId,
          summary: result.summary,
          amygdalaWired: !!this.amygdala,
        });
      } else if (result.urgency === "low" || result.urgency === "high") {
        // ── Normal path: store for batch processing ──
        this.storeSignal(monitorId, result.summary, result.payload, result.urgency);
      }
      // urgency === "none" with detected === true: odd, but ignore
    } catch (err) {
      log.warn("Monitor poll failed", {
        monitorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Schedule next poll regardless of outcome
    this.schedulePoll(monitorId);
  }

  // ── Signal Storage ──────────────────────────────────────────────

  private storeSignal(
    monitorId: string,
    summary: string,
    payload: Record<string, unknown>,
    urgency: "low" | "high",
  ): ExteroceptiveSignal {
    const signal: ExteroceptiveSignal = {
      id: newId(),
      monitorId,
      summary,
      payload,
      urgency,
      actedUpon: null,
      detectedAt: new Date(),
      processedAt: null,
    };

    this.signals.push(signal);
    this.pruneSignals();

    emit("exteroception:signal-stored", {
      signalId: signal.id,
      monitorId,
      urgency,
      pendingCount: this.getPendingCount(),
    });

    return signal;
  }

  private pruneSignals(): void {
    if (this.signals.length > this.config.maxStoredSignals) {
      // Remove oldest first (already-processed signals are most expendable)
      const excess = this.signals.length - this.config.maxStoredSignals;
      this.signals.splice(0, excess);
    }
  }

  getPendingSignals(): ExteroceptiveSignal[] {
    return this.signals.filter((s) => s.processedAt === null);
  }

  private getPendingCount(): number {
    return this.signals.filter((s) => s.processedAt === null).length;
  }

  // ── Batch Processing (called from between-tasks) ────────────────

  assembleBatch(): ExteroceptiveBatch | null {
    const pending = this.getPendingSignals();
    if (pending.length === 0) return null;

    const byMonitor = new Map<string, ExteroceptiveSignal[]>();
    for (const signal of pending) {
      const existing = byMonitor.get(signal.monitorId);
      if (existing) {
        existing.push(signal);
      } else {
        byMonitor.set(signal.monitorId, [signal]);
      }
    }

    return {
      signals: pending,
      byMonitor,
      assembledAt: new Date(),
    };
  }

  recordBatchOutcome(actions: BatchAction[]): void {
    const now = new Date();
    let actionCount = 0;

    for (const action of actions) {
      const signal = this.signals.find((s) => s.id === action.signalId);
      if (!signal) continue;

      signal.processedAt = now;
      const acted = action.kind !== "dismissed" && action.kind !== "noted";
      signal.actedUpon = acted;

      if (acted) {
        actionCount++;
        const monitor = this.monitors.get(signal.monitorId);
        if (monitor) monitor.cadence.totalActions++;
      }

      // Record cadence episode (mini cerebellum feedback)
      this.recordCadenceEpisode(signal.monitorId, signal.id, acted);
    }

    this.totalProcessed += actions.length;

    emitInfo("exteroception:batch-processed", {
      signalCount: actions.length,
      actionCount,
      totalProcessed: this.totalProcessed,
    });
  }

  // ── Mini Cerebellum (Cadence Learning) ──────────────────────────

  private recordCadenceEpisode(
    monitorId: string,
    signalId: string,
    ledToAction: boolean,
  ): void {
    const episodes = this.cadenceEpisodes.get(monitorId) ?? [];

    episodes.push({
      monitorId,
      signalId,
      ledToAction,
      sequenceNumber: this.sequenceCounter++,
      recordedAt: new Date(),
    });

    // Prune oldest episodes per monitor
    if (episodes.length > this.config.maxCadenceEpisodes) {
      episodes.splice(0, episodes.length - this.config.maxCadenceEpisodes);
    }

    this.cadenceEpisodes.set(monitorId, episodes);

    emit("exteroception:cadence-episode", {
      monitorId,
      signalId,
      ledToAction,
    });

    // Update cadence based on new evidence
    this.updateCadence(monitorId);
  }

  private updateCadence(monitorId: string): void {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) return;

    const episodes = this.cadenceEpisodes.get(monitorId);
    if (!episodes || episodes.length === 0) return;

    // EMA: newRate = alpha * latest + (1 - alpha) * oldRate
    const latest = episodes[episodes.length - 1];
    const alpha = this.config.emaAlpha;
    const oldRate = monitor.cadence.actionRate;
    const newRate = alpha * (latest.ledToAction ? 1 : 0) + (1 - alpha) * oldRate;
    monitor.cadence.actionRate = newRate;

    const oldInterval = monitor.cadence.intervalMs;
    let newInterval = oldInterval;

    if (newRate < this.config.cooldownThreshold) {
      // Low action rate → poll less often
      newInterval = oldInterval * this.config.cooldownFactor;
    } else if (newRate > this.config.warmupThreshold) {
      // High action rate → poll more often
      newInterval = oldInterval * this.config.warmupFactor;
    }

    // Clamp to floor/ceiling
    newInterval = Math.max(
      monitor.cadence.floorMs,
      Math.min(monitor.cadence.ceilingMs, newInterval),
    );

    monitor.cadence.intervalMs = newInterval;

    if (newInterval !== oldInterval) {
      // Reschedule: clear existing timer, the next schedulePoll picks up new interval
      this.clearTimer(monitorId);
      if (this.running && monitor.enabled) {
        this.schedulePoll(monitorId);
      }

      emitInfo("exteroception:cadence-adjusted", {
        monitorId,
        oldIntervalMs: oldInterval,
        newIntervalMs: newInterval,
        actionRate: newRate,
      });
    }
  }

  // ── NE Integration ──────────────────────────────────────────────

  /**
   * Signal pressure for NE risk computation (0–1).
   * High = many unprocessed signals piling up.
   */
  getSignalPressure(): number {
    const pending = this.getPendingCount();
    return Math.min(1, pending / 20);
  }

  // ── Observability ───────────────────────────────────────────────

  getState(): ExteroceptionState {
    const monitors = Array.from(this.monitors.values());
    return {
      enabled: this.config.enabled,
      running: this.running,
      monitorCount: monitors.length,
      activeMonitors: monitors.filter((m) => m.enabled).length,
      pendingSignals: this.getPendingCount(),
      totalSignalsProcessed: this.totalProcessed,
      monitors: monitors.map((m) => ({
        id: m.id,
        name: m.name,
        sourceKind: m.source.kind,
        enabled: m.enabled,
        intervalMs: m.cadence.intervalMs,
        actionRate: m.cadence.actionRate,
        totalPolls: m.cadence.totalPolls,
        lastPolledAt: m.cadence.lastPolledAt?.toISOString() ?? null,
      })),
    };
  }
}
