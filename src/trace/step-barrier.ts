/**
 * Step Barrier — async checkpoint for pause/step execution control.
 *
 * When enabled, every call to checkpoint() blocks until release() is called.
 * This lets the user advance the system one operation at a time from the
 * trace dashboard.
 *
 * Injected at two points:
 *   1. src/llm/client.ts — before each LLM call
 *   2. src/brainstem/runner.ts — after each phase transition
 */

import { emit } from "../events.js";

export type ExecMode = "live" | "paused" | "stepping" | "replaying";

export class StepBarrier {
  private enabled = false;
  private resolveWait: (() => void) | null = null;
  private _label = "";
  private _mode: ExecMode = "live";

  /** Listeners notified on mode/label changes. */
  private listeners: Set<(mode: ExecMode, label: string) => void> = new Set();

  /** Enable the barrier — next checkpoint() will block. */
  enable(): void {
    this.enabled = true;
    this._mode = "stepping";
    this.notify();
  }

  /** Disable the barrier — all checkpoints pass through. Also releases any current wait. */
  disable(): void {
    this.enabled = false;
    this._mode = "live";
    this.release();
    this.notify();
  }

  /**
   * Checkpoint — blocks if the barrier is enabled.
   * Called from LLM client and rhythm runner.
   * @param label Human-readable description of what we're about to do.
   */
  async checkpoint(label: string): Promise<void> {
    if (!this.enabled) return;

    this._label = label;
    this._mode = "paused";
    this.notify();

    emit("step:paused", { label });

    await new Promise<void>((resolve) => {
      this.resolveWait = resolve;
    });

    this.resolveWait = null;
    emit("step:resumed", { label });
  }

  /** Release one checkpoint — execution proceeds to the next checkpoint. */
  release(): void {
    if (this.resolveWait) {
      this.resolveWait();
    }
  }

  /** Whether the barrier is currently blocking. */
  get isPaused(): boolean {
    return this.resolveWait !== null;
  }

  /** The label of the current (or last) checkpoint. */
  get currentLabel(): string {
    return this._label;
  }

  /** Current execution mode. */
  get mode(): ExecMode {
    return this._mode;
  }

  /** Set mode directly (used by execution controller for replay mode). */
  setMode(mode: ExecMode): void {
    this._mode = mode;
    this.notify();
  }

  /** Subscribe to mode/label changes. Returns unsubscribe function. */
  onChange(listener: (mode: ExecMode, label: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(this._mode, this._label); } catch { /* never crash */ }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultBarrier: StepBarrier | null = null;

export function getStepBarrier(): StepBarrier {
  if (!defaultBarrier) {
    defaultBarrier = new StepBarrier();
  }
  return defaultBarrier;
}

export function resetStepBarrier(): void {
  defaultBarrier?.disable();
  defaultBarrier = null;
}
