/**
 * Amygdala Types — priority override data shapes.
 *
 * The amygdala is three things:
 *   1. A detector registry — fast, synchronous threat detectors that scan
 *      motor cortex intentions before PNS execution.
 *   2. An alarm receiver — other components raise alarms when they detect
 *      asymmetric-risk situations in their own domain.
 *   3. A response protocol — how to stop the system safely: hard-interrupt
 *      the runner, override NE, inhibit senses, escalate to human.
 *
 * The amygdala doesn't learn. It gets updated. The hippocampus crystallizes
 * episodes into principles; those get installed as new detectors.
 *
 * The plasticity weight `amygdala.threshold.urgency` (default 0.8) modulates
 * response aggressiveness, not detection sensitivity. Detectors still fire;
 * the system just doesn't panic as hard when mature.
 */

import type { Intention } from "./pns.js";
import type { Interrupt } from "./rhythm.js";

// ─── Threat Detection ──────────────────────────────────────────

/**
 * A threat detector that scans motor cortex intentions.
 * Must be fast — synchronous pattern matching, no LLM calls.
 * Both built-in and learned detectors implement this shape.
 */
export interface ThreatDetector {
  id: string;
  name: string;
  /** Who installed this detector. */
  origin: "built-in" | "hippocampus";
  /** Which principle/episode installed this, if learned. */
  sourceId?: string;
  /** What this detector looks for — human-readable. */
  description: string;
  /** Fast synchronous scan. Returns threats found, or empty array. */
  scan: (intentions: Intention[]) => DetectedThreat[];
}

/**
 * What a detector produces when it fires.
 * Signal strength is raw (0–1), NOT modulated by plasticity — that's
 * the response protocol's job.
 */
export interface DetectedThreat {
  detectorId: string;
  intentionId: string;
  /** What the detector found. */
  description: string;
  /** Raw signal strength 0–1. */
  signalStrength: number;
  /** Category for response protocol selection. */
  category: ThreatCategory;
}

export type ThreatCategory =
  | "destructive-operation" // rm -rf, DROP TABLE, force push
  | "security-antipattern" // hardcoded secrets, eval(), disabled auth
  | "data-loss-risk" // overwrites without backup, irreversible mutations
  | "scope-violation" // modifying artifacts outside declared scope
  | "human-escalation"; // direct human input (highest priority)

// ─── Alarm ─────────────────────────────────────────────────────

/**
 * What other components send when they detect asymmetric risk in
 * their own domain. The amygdala doesn't evaluate whether they're
 * right — it trusts the source's domain expertise.
 */
export interface Alarm {
  source: string; // "cerebellum", "drift-monitor", etc.
  severity: "urgent" | "emergency";
  description: string;
  /** Structured context the PFC needs for deliberate response. */
  context: Record<string, unknown>;
  /** Specific rhythm to interrupt, if known. */
  rhythmId?: string;
}

// ─── Threat Assessment ─────────────────────────────────────────

/**
 * What the amygdala produces when it fires — a complete picture
 * for the response protocol.
 */
export interface ThreatAssessment {
  id: string;
  trigger: "pre-action-gate" | "alarm" | "human-escalation";
  threats: DetectedThreat[];
  alarm?: Alarm;
  /** Effective severity after plasticity modulation. */
  effectiveSeverity: "urgent" | "emergency";
  /** Response aggressiveness 0–1, modulated by plasticity weight. */
  responseLevel: number;
  /** Intentions that were blocked (for pre-action gate). */
  blockedIntentionIds: string[];
  assessedAt: Date;
}

// ─── Response Protocol ─────────────────────────────────────────

export type ResponseAction =
  | { kind: "block-intentions"; intentionIds: string[] }
  | { kind: "interrupt-rhythm"; rhythmId: string; mode: "hard" }
  | { kind: "override-ne" }
  | { kind: "inhibit-sense"; senseId: string; reason: string }
  | { kind: "add-open-question"; question: string; context: string };

export interface ResponseProtocolResult {
  assessment: ThreatAssessment;
  actions: ResponseAction[];
  /** Duration of the full response protocol in ms. */
  duration: number;
}

/**
 * Dependencies the amygdala needs to execute its response protocol.
 * Passed at response time, not held as references — avoids circular deps.
 */
export interface ResponseDeps {
  runner: {
    interrupt: (rhythmId: string, interrupt: Interrupt) => void;
  };
  wm: {
    inhibitSense: (
      senseId: string,
      reason: string,
      source: string,
      scope?: string,
    ) => void;
    addQuestion: (
      question: string,
      context: string,
    ) => { id: string; question: string; context: string; askedAt: Date };
  };
  /** Active rhythm IDs that can be interrupted. */
  activeRhythmIds: string[];
}

// ─── Config ────────────────────────────────────────────────────

export interface AmygdalaConfig {
  /** Enable the pre-action gate (intention scanning). */
  preActionGateEnabled: boolean;
  /** Enable alarm receiving from other components. */
  alarmReceiverEnabled: boolean;
  /** Max assessments to keep in history. */
  maxAssessmentHistory: number;
}

export const DEFAULT_AMYGDALA_CONFIG: AmygdalaConfig = {
  preActionGateEnabled: true,
  alarmReceiverEnabled: true,
  maxAssessmentHistory: 50,
};

// ─── State (serialization / dashboard) ─────────────────────────

export interface AmygdalaState {
  detectorCount: number;
  builtInDetectors: number;
  learnedDetectors: number;
  assessments: ThreatAssessment[];
  lastAssessment: ThreatAssessment | null;
}
