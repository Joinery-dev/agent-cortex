import { EventEmitter } from "node:events";
import type { RhythmPhase } from "./types/rhythm.js";

// ─── Severity ────────────────────────────────────────────────────

export type EventSeverity = "trace" | "info" | "warn" | "error" | "critical";

// ─── Rhythm context (auto-injected from context stack) ───────────

export interface RhythmContext {
  rhythmId: string;
  rhythmType: string;       // "build-cycle" | "sensory-cortex" | "task-dispatch" | "project"
  phase: RhythmPhase;       // "prepare" | "execute" | "integrate" | "gate"
  cycle: number;
  taskId?: string;
  parentRhythmId?: string;
}

// ─── Diagnostic context (required on warn/error/critical) ────────

/**
 * Captures the "what led to this" data for diagnostic events.
 * Named EventDiagnosticContext to avoid collision with the
 * project-level DiagnosticContext in types/project-diagnostics.ts.
 */
export interface EventDiagnosticContext {
  /** What component produced this diagnostic. */
  component: string;
  /** What was expected vs what was received. */
  expected?: string;
  received?: string;
  /** The prompt that was sent (for LLM failures). */
  prompt?: string;
  /** The raw LLM response (for parse failures). */
  rawResponse?: string;
  /** The Zod validation error (for schema failures). */
  validationError?: string;
  /** Retry count at time of failure. */
  retryCount?: number;
  /** Arbitrary structured context the component wants to capture. */
  snapshot?: Record<string, unknown>;
}

// ─── Enriched event ──────────────────────────────────────────────

export interface CortexEvent {
  type: string;
  timestamp: string;
  severity: EventSeverity;
  data: Record<string, unknown>;
  /** Auto-injected from the rhythm context stack. Null for events outside rhythms. */
  rhythmContext: RhythmContext | null;
  /** Present on warn/error/critical. The "what led to this" data. */
  diagnosticContext?: EventDiagnosticContext;
}

// ─── Event bus ───────────────────────────────────────────────────

class CortexEventBus extends EventEmitter {
  private contextStack: RhythmContext[] = [];

  // ── Context stack management ─────────────────────────────────

  /** Push a rhythm context onto the stack. Called by runner at rhythm start. */
  pushContext(ctx: RhythmContext): void {
    this.contextStack.push(ctx);
  }

  /** Pop the top rhythm context. Called by runner at rhythm end/cleanup. */
  popContext(): void {
    this.contextStack.pop();
  }

  /** Update the phase of the top context. Called by runner at phase transitions. */
  updatePhase(phase: RhythmPhase): void {
    const top = this.contextStack.at(-1);
    if (top) top.phase = phase;
  }

  /** Update the cycle count of the top context. Called by runner at cycle increment. */
  updateCycle(cycle: number): void {
    const top = this.contextStack.at(-1);
    if (top) top.cycle = cycle;
  }

  /** Get the current rhythm context (top of stack), or null if outside any rhythm. */
  getCurrentContext(): RhythmContext | null {
    return this.contextStack.at(-1) ?? null;
  }

  // ── Event emission ───────────────────────────────────────────

  emitCortex(payload: CortexEvent): boolean {
    return super.emit("cortex", payload);
  }

  onCortex(listener: (payload: CortexEvent) => void): this {
    return super.on("cortex", listener);
  }
}

export const bus = new CortexEventBus();

// ─── Emit functions ──────────────────────────────────────────────

/** Build a CortexEvent with auto-injected rhythm context. */
function buildEvent(
  type: string,
  severity: EventSeverity,
  data: Record<string, unknown>,
  diagnosticContext?: EventDiagnosticContext,
): CortexEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    severity,
    data,
    rhythmContext: bus.getCurrentContext(),
    diagnosticContext,
  };
}

/** Trace-level event. Existing emit() — backward compatible. */
export function emit(type: string, data: Record<string, unknown> = {}): void {
  bus.emitCortex(buildEvent(type, "trace", data));
}

/** Info-level event. Logged persistently but no diagnostic context required. */
export function emitInfo(type: string, data: Record<string, unknown> = {}): void {
  bus.emitCortex(buildEvent(type, "info", data));
}

/** Warn-level event. Diagnostic context required. */
export function emitWarn(
  type: string,
  data: Record<string, unknown>,
  diagnostic: EventDiagnosticContext,
): void {
  bus.emitCortex(buildEvent(type, "warn", data, diagnostic));
}

/** Error-level event. Diagnostic context required. */
export function emitError(
  type: string,
  data: Record<string, unknown>,
  diagnostic: EventDiagnosticContext,
): void {
  bus.emitCortex(buildEvent(type, "error", data, diagnostic));
}

/** Critical-level event. Diagnostic context required. Triggers homeostasis alert. */
export function emitCritical(
  type: string,
  data: Record<string, unknown>,
  diagnostic: EventDiagnosticContext,
): void {
  bus.emitCortex(buildEvent(type, "critical", data, diagnostic));
}
