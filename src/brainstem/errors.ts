import type { GateEscalate } from "../types/rhythm.js";

/**
 * Thrown when a rhythm's gate returns "escalate" and no parent
 * rhythm catches it. Wraps the gate decision so the caller
 * can inspect severity, reason, and context.
 */
export class EscalationError extends Error {
  public readonly decision: GateEscalate;
  public readonly rhythmId: string;

  constructor(rhythmId: string, decision: GateEscalate) {
    super(`Rhythm ${rhythmId} escalated: ${decision.reason}`);
    this.name = "EscalationError";
    this.rhythmId = rhythmId;
    this.decision = decision;
  }
}

/**
 * Thrown when a hard interrupt aborts a rhythm mid-phase.
 * The rhythm's state has been snapshotted in pausedAt before this fires.
 */
export class RhythmAbortedError extends Error {
  public readonly rhythmId: string;
  public readonly source: string;

  constructor(rhythmId: string, source: string, reason: string) {
    super(`Rhythm ${rhythmId} aborted by ${source}: ${reason}`);
    this.name = "RhythmAbortedError";
    this.rhythmId = rhythmId;
    this.source = source;
  }
}
