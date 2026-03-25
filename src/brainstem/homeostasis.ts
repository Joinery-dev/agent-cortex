/**
 * Homeostasis Monitor — vital signs tracking and reflex responses.
 *
 * The brainstem continuously monitors five vital signs and takes
 * corrective action below the level of executive function:
 *
 *   workingMemoryLoad high   → trigger rest cycle
 *   predictionAccuracy low   → trigger rest cycle
 *   contextCapacity critical → evict context (breathing reflex)
 *   learningSignalHealth low → flag for PFC
 *   weightVolatility high    → trigger rest cycle
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
import { emit } from "../events.js";

const log = createLogger("homeostasis");

// ─── Reflex actions ─────────────────────────────────────────────

export type ReflexAction =
  | { type: "trigger-rest"; reason: string }
  | { type: "evict-context"; reason: string }
  | { type: "flag-pfc"; reason: string };

// ─── Monitor ────────────────────────────────────────────────────

export class HomeostasisMonitor {
  private vitals: VitalSigns;
  private thresholds: VitalSignThresholds;
  /** Episode density from hippocampus — not a vital sign, but drives rest triggers. */
  private episodeDensity = 0;

  constructor(thresholds?: Partial<VitalSignThresholds>) {
    this.thresholds = { ...DEFAULT_VITAL_THRESHOLDS, ...thresholds };

    // Healthy defaults — nothing is stressed
    this.vitals = {
      workingMemoryLoad: 0.1,
      predictionAccuracy: 0.8,
      contextCapacity: 0.2,
      learningSignalHealth: 0.9,
      weightVolatility: 0.1,
      tonicDopamine: 0.5, // Neutral — no data yet
    };
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
        type: "evict-context",
        reason: `Context capacity ${this.vitals.contextCapacity.toFixed(2)} exceeds threshold ${this.thresholds.contextCapacity}`,
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

    if (actions.length > 0) {
      emit("vitals:reflex", {
        actions: actions.map((a) => ({ type: a.type, reason: a.reason })),
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
