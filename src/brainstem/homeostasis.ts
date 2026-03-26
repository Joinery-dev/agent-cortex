/**
 * Homeostasis Monitor — vital signs tracking and reflex responses.
 *
 * The brainstem continuously monitors vital signs and takes
 * corrective action below the level of executive function:
 *
 *   workingMemoryLoad high   → trigger rest cycle
 *   predictionAccuracy low   → trigger rest cycle
 *   contextCapacity critical → evict context (breathing reflex)
 *   learningSignalHealth low → flag for PFC
 *   weightVolatility high    → trigger rest cycle
 *   diagnosticLoad elevated  → spike NE
 *   diagnosticLoad critical  → trigger rest or escalate
 *
 * Initially all vitals are at healthy defaults — no learning systems
 * to drive them yet. The wiring exists so Phase 3 components can
 * call update().
 */

import type {
  VitalSigns,
  VitalSignThresholds,
  ConsolidationLoad,
} from "../types/brainstem.js";
import { DEFAULT_VITAL_THRESHOLDS } from "../types/brainstem.js";
import { createLogger } from "../util/logger.js";
import { emit, bus } from "../events.js";
import type { CortexEvent, EventSeverity } from "../events.js";

const log = createLogger("homeostasis");

// ─── Reflex actions ─────────────────────────────────────────────

export type ReflexAction =
  | { type: "trigger-rest"; reason: string }
  | { type: "compress-briefing"; reason: string }
  | { type: "tighten-budget"; reason: string }
  | { type: "flag-pfc"; reason: string }
  | { type: "spike-ne"; reason: string };

// ─── Diagnostic load tracker ────────────────────────────────────

/** Severities that count toward diagnostic load. */
const DIAGNOSTIC_SEVERITIES: Set<EventSeverity> = new Set([
  "warn",
  "error",
  "critical",
]);

/** Rolling window size in milliseconds (1 minute). */
const WINDOW_MS = 60_000;

/**
 * Tracks the rolling rate of warn+ events per minute, normalized to 0–1.
 *
 * The normalization uses a soft ceiling: at 20 events/min the load is ~0.73
 * (elevated), at 50 events/min it's ~0.92 (critical). This avoids a
 * hardcoded "max events" that would need tuning — the tanh curve
 * naturally saturates toward 1.
 */
class DiagnosticLoadTracker {
  private timestamps: number[] = [];
  /** Scale factor for tanh normalization. 30 events/min ≈ 0.8. */
  private readonly scale = 30;

  /** Record a diagnostic event. */
  record(): void {
    this.timestamps.push(Date.now());
  }

  /** Get the current diagnostic load (0–1). */
  getLoad(): number {
    this.prune();
    const rate = this.timestamps.length; // events in last minute
    return Math.tanh(rate / this.scale);
  }

  /** Remove timestamps outside the rolling window. */
  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    // timestamps are in order, so find the first one that's in-window
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) {
      i++;
    }
    if (i > 0) {
      this.timestamps.splice(0, i);
    }
  }
}

// ─── Monitor ────────────────────────────────────────────────────

export class HomeostasisMonitor {
  private vitals: VitalSigns;
  private thresholds: VitalSignThresholds;
  /** Episode density from hippocampus — not a vital sign, but drives rest triggers. */
  private episodeDensity = 0;
  /** Rolling diagnostic event rate tracker. */
  private diagnosticTracker = new DiagnosticLoadTracker();
  /** Cleanup function for the event bus listener. */
  private stopListening: (() => void) | null = null;
  /** Configurable diagnostic load thresholds. */
  private diagnosticLoadCritical: number;
  private diagnosticLoadElevated: number;

  constructor(
    thresholds?: Partial<VitalSignThresholds>,
    diagnosticLoadThresholds?: { critical?: number; elevated?: number },
  ) {
    this.thresholds = { ...DEFAULT_VITAL_THRESHOLDS, ...thresholds };
    this.diagnosticLoadCritical = diagnosticLoadThresholds?.critical ?? 0.7;
    this.diagnosticLoadElevated = diagnosticLoadThresholds?.elevated ?? 0.3;

    // Healthy defaults — nothing is stressed
    this.vitals = {
      workingMemoryLoad: 0.1,
      predictionAccuracy: 0.8,
      contextCapacity: 0.2,
      budgetUtilization: 0.0, // No spend yet
      learningSignalHealth: 0.9,
      weightVolatility: 0.1,
      tonicDopamine: 0.5, // Neutral — no data yet
    };

    // Listen for diagnostic events on the bus
    this.startListening();
  }

  /** Start listening for warn+ events to track diagnostic load. */
  private startListening(): void {
    const listener = (event: CortexEvent) => {
      if (DIAGNOSTIC_SEVERITIES.has(event.severity)) {
        this.diagnosticTracker.record();
      }
    };
    bus.onCortex(listener);
    this.stopListening = () => bus.removeListener("cortex", listener);
  }

  /** Stop listening. For cleanup/tests. */
  dispose(): void {
    this.stopListening?.();
    this.stopListening = null;
  }

  /** Update episode density from hippocampus. Drives rest-cycle triggers. */
  setEpisodeDensity(value: number): void {
    this.episodeDensity = Math.max(0, Math.min(1, value));
  }

  /** Update a specific vital sign. Called by brain components. */
  update(sign: keyof VitalSigns, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.vitals[sign] = clamped;

    emit("vitals:update", { sign, value: clamped });
  }

  /** Get current vital signs snapshot. */
  getVitals(): VitalSigns {
    return { ...this.vitals };
  }

  /** Get current diagnostic load (0–1). */
  getDiagnosticLoad(): number {
    return this.diagnosticTracker.getLoad();
  }

  /** Get thresholds. */
  getThresholds(): VitalSignThresholds {
    return { ...this.thresholds };
  }

  /**
   * Check all vital signs against thresholds. Returns any reflex
   * actions that should fire. Called by the runner after each phase
   * transition or at task boundaries.
   */
  check(): ReflexAction[] {
    const actions: ReflexAction[] = [];

    if (this.vitals.workingMemoryLoad > this.thresholds.workingMemoryLoad) {
      actions.push({
        type: "trigger-rest",
        reason: `Working memory load ${this.vitals.workingMemoryLoad.toFixed(2)} exceeds threshold ${this.thresholds.workingMemoryLoad}`,
      });
    }

    if (this.vitals.predictionAccuracy < this.thresholds.predictionAccuracy) {
      actions.push({
        type: "trigger-rest",
        reason: `Prediction accuracy ${this.vitals.predictionAccuracy.toFixed(2)} below threshold ${this.thresholds.predictionAccuracy}`,
      });
    }

    if (this.vitals.contextCapacity > this.thresholds.contextCapacity) {
      actions.push({
        type: "compress-briefing",
        reason: `Context capacity ${this.vitals.contextCapacity.toFixed(2)} exceeds threshold ${this.thresholds.contextCapacity}`,
      });
    }

    if (this.vitals.budgetUtilization > this.thresholds.budgetUtilization) {
      actions.push({
        type: "tighten-budget",
        reason: `Budget utilization ${this.vitals.budgetUtilization.toFixed(2)} exceeds threshold ${this.thresholds.budgetUtilization}`,
      });
    }

    if (this.vitals.learningSignalHealth < this.thresholds.learningSignalHealth) {
      actions.push({
        type: "flag-pfc",
        reason: `Learning signal health ${this.vitals.learningSignalHealth.toFixed(2)} below threshold ${this.thresholds.learningSignalHealth}`,
      });
    }

    if (this.vitals.weightVolatility > this.thresholds.weightVolatility) {
      actions.push({
        type: "trigger-rest",
        reason: `Weight volatility ${this.vitals.weightVolatility.toFixed(2)} exceeds threshold ${this.thresholds.weightVolatility}`,
      });
    }

    if (this.vitals.tonicDopamine < this.thresholds.tonicDopamine) {
      actions.push({
        type: "flag-pfc",
        reason: `Tonic dopamine ${this.vitals.tonicDopamine.toFixed(2)} below threshold ${this.thresholds.tonicDopamine} — project persistently disappointing`,
      });
    }

    // ── Diagnostic load ───────────────────────────────────────
    const diagnosticLoad = this.diagnosticTracker.getLoad();
    if (diagnosticLoad > this.diagnosticLoadCritical) {
      actions.push({
        type: "trigger-rest",
        reason: `Diagnostic load ${diagnosticLoad.toFixed(2)} exceeds critical threshold ${this.diagnosticLoadCritical} — system failing frequently`,
      });
    } else if (diagnosticLoad > this.diagnosticLoadElevated) {
      actions.push({
        type: "spike-ne",
        reason: `Diagnostic load ${diagnosticLoad.toFixed(2)} exceeds elevated threshold ${this.diagnosticLoadElevated} — something systematically off`,
      });
    }

    if (actions.length > 0) {
      emit("vitals:reflex", {
        actions: actions.map((a) => ({ type: a.type, reason: a.reason })),
        diagnosticLoad,
      });

      for (const action of actions) {
        log.info(`Reflex: ${action.type}`, { reason: action.reason });
      }
    }

    return actions;
  }

  /** Should we insert a rest cycle before the next task? */
  needsRest(): boolean {
    const actions = this.check();
    return actions.some((a) => a.type === "trigger-rest");
  }

  /**
   * Compute consolidation load from current vitals.
   * Each signal is 0–1. Higher = more pressure to rest.
   */
  getConsolidationLoad(): ConsolidationLoad {
    return {
      episodeDensity: this.episodeDensity,
      memoryPressure: this.vitals.workingMemoryLoad,
      predictionDrift: 1 - this.vitals.predictionAccuracy,
      weightInstability: this.vitals.weightVolatility,
      deferredProcessing: 0, // No deferred work yet
    };
  }
}
