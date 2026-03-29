/**
 * Trace stepper — step through trace entries at configurable granularity.
 * Supports replay mode (step through history) and live mode (pause on matching events).
 */

import type { TraceEntry, StepGranularity, StepperState } from "./types.js";
import { getTraceCollector } from "./collector.js";

export class TraceStepper {
  private mode: "off" | "replay" | "live" = "off";
  private granularity: StepGranularity = "event";
  private currentSeq = -1;
  private paused = true;
  private autoAdvanceMs: number | null = null;
  private autoAdvanceTimer: ReturnType<typeof setInterval> | null = null;
  private stateListeners: ((state: StepperState) => void)[] = [];
  private unsubCollector: (() => void) | null = null;

  // ── Enable / disable ──────────────────────────────────────────

  enableReplay(granularity: StepGranularity = "event"): void {
    this.disable();
    this.mode = "replay";
    this.granularity = granularity;
    this.currentSeq = -1;
    this.paused = true;
    this.notifyListeners();
  }

  enableLive(granularity: StepGranularity = "event"): void {
    this.disable();
    this.mode = "live";
    this.granularity = granularity;
    this.paused = false;

    const collector = getTraceCollector();
    // Start at the latest entry
    this.currentSeq = collector.size - 1;

    // Subscribe to new entries
    this.unsubCollector = collector.onEntry((entry) => {
      if (this.mode !== "live") return;
      if (this.shouldPause(entry, this.granularity)) {
        this.currentSeq = entry.seq;
        this.notifyListeners();
      }
    });

    this.notifyListeners();
  }

  disable(): void {
    this.stopAutoAdvance();
    this.mode = "off";
    this.currentSeq = -1;
    this.paused = true;

    if (this.unsubCollector) {
      this.unsubCollector();
      this.unsubCollector = null;
    }

    this.notifyListeners();
  }

  // ── Navigation ────────────────────────────────────────────────

  stepForward(): TraceEntry | null {
    if (this.mode === "off") return null;
    const collector = getTraceCollector();
    const all = collector.getAll();
    const maxSeq = all.length - 1;

    let next = this.currentSeq + 1;
    while (next <= maxSeq) {
      const entry = all[next];
      if (entry && this.shouldPause(entry, this.granularity)) {
        this.currentSeq = next;
        this.paused = true;
        this.notifyListeners();
        return entry;
      }
      next++;
    }

    // No matching entry found ahead
    return null;
  }

  stepBack(): TraceEntry | null {
    if (this.mode === "off") return null;
    const collector = getTraceCollector();
    const all = collector.getAll();

    let prev = this.currentSeq - 1;
    while (prev >= 0) {
      const entry = all[prev];
      if (entry && this.shouldPause(entry, this.granularity)) {
        this.currentSeq = prev;
        this.paused = true;
        this.notifyListeners();
        return entry;
      }
      prev--;
    }

    return null;
  }

  jumpTo(seq: number): TraceEntry | null {
    if (this.mode === "off") return null;
    const collector = getTraceCollector();
    const entry = collector.getEntry(seq);
    if (entry) {
      this.currentSeq = seq;
      this.paused = true;
      this.notifyListeners();
      return entry;
    }
    return null;
  }

  jumpToStart(): TraceEntry | null {
    this.currentSeq = -1;
    return this.stepForward();
  }

  jumpToEnd(): TraceEntry | null {
    if (this.mode === "off") return null;
    const collector = getTraceCollector();
    const all = collector.getAll();

    // Find the last matching entry
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i];
      if (entry && this.shouldPause(entry, this.granularity)) {
        this.currentSeq = i;
        this.paused = true;
        this.notifyListeners();
        return entry;
      }
    }

    return null;
  }

  // ── Auto-advance ──────────────────────────────────────────────

  startAutoAdvance(ms: number): void {
    this.stopAutoAdvance();
    this.autoAdvanceMs = ms;
    this.paused = false;

    this.autoAdvanceTimer = setInterval(() => {
      const result = this.stepForward();
      if (!result) {
        this.stopAutoAdvance();
      }
    }, ms);

    this.notifyListeners();
  }

  stopAutoAdvance(): void {
    if (this.autoAdvanceTimer) {
      clearInterval(this.autoAdvanceTimer);
      this.autoAdvanceTimer = null;
    }
    this.autoAdvanceMs = null;
    this.paused = true;
    this.notifyListeners();
  }

  // ── Granularity ───────────────────────────────────────────────

  setGranularity(granularity: StepGranularity): void {
    this.granularity = granularity;
    this.notifyListeners();
  }

  // ── State ─────────────────────────────────────────────────────

  getState(): StepperState {
    const collector = getTraceCollector();
    return {
      mode: this.mode,
      granularity: this.granularity,
      currentSeq: this.currentSeq,
      maxSeq: collector.size - 1,
      paused: this.paused,
      autoAdvanceMs: this.autoAdvanceMs,
    };
  }

  getWindow(
    before: number = 5,
    after: number = 5,
  ): { entries: TraceEntry[]; currentSeq: number } {
    const collector = getTraceCollector();
    const all = collector.getAll();
    const start = Math.max(0, this.currentSeq - before);
    const end = Math.min(all.length - 1, this.currentSeq + after);

    const entries: TraceEntry[] = [];
    for (let i = start; i <= end; i++) {
      if (all[i]) entries.push(all[i]);
    }

    return { entries, currentSeq: this.currentSeq };
  }

  // ── Listeners ─────────────────────────────────────────────────

  onStateChange(listener: (state: StepperState) => void): () => void {
    this.stateListeners.push(listener);
    return () => {
      const idx = this.stateListeners.indexOf(listener);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  // ── Granularity matching ──────────────────────────────────────

  shouldPause(entry: TraceEntry, granularity: StepGranularity): boolean {
    const type = entry.event.type;

    switch (granularity) {
      case "event":
        // Every event
        return true;

      case "phase":
        // Phase changes, rhythm start/complete, gate decisions
        return (
          type === "rhythm:phase-change" ||
          type === "rhythm:start" ||
          type === "rhythm:complete" ||
          type === "gate:decision"
        );

      case "cycle":
        // Build cycle boundaries
        return (
          type === "build-cycle:start" ||
          type === "build-cycle:complete" ||
          type === "build-cycle:iteration" ||
          type === "rhythm:start" ||
          type === "rhythm:complete"
        );

      case "task":
        // Task-level boundaries
        return (
          type === "task-dispatch:task-assigned" ||
          type === "task-dispatch:task-complete" ||
          type === "rhythm:start" ||
          type === "rhythm:complete" ||
          type === "project:start" ||
          type === "project:complete"
        );

      case "llm":
        // LLM calls only
        return (
          type.startsWith("llm:") ||
          type.startsWith("structured:")
        );

      case "rhythm":
        // Rhythm boundaries only
        return (
          type === "rhythm:start" ||
          type === "rhythm:complete" ||
          type === "rhythm:phase-change"
        );

      case "content":
        // Events that typically have associated content
        return (
          type.startsWith("llm:") ||
          type.startsWith("structured:") ||
          type.startsWith("thalamus:briefing") ||
          type.startsWith("sensory:consultation") ||
          type.startsWith("sensory:evaluation") ||
          type.startsWith("motor:") ||
          type.startsWith("tension:") ||
          type.startsWith("resolution:") ||
          type.startsWith("conviction:") ||
          type === "gate:decision"
        );

      default:
        return true;
    }
  }

  // ── Internal ──────────────────────────────────────────────────

  private notifyListeners(): void {
    const state = this.getState();
    for (const fn of this.stateListeners) {
      try {
        fn(state);
      } catch {
        // Don't let listener errors break stepper
      }
    }
  }
}
