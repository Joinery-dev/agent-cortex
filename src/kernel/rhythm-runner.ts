/**
 * Rhythm Runner — the generic engine that executes rhythm definitions.
 *
 * This is the brainstem's heartbeat driver. It takes any RhythmDefinition
 * and runs it through the four-phase cycle: prepare → execute → integrate → gate.
 *
 * The runner is separate from the Attention Scheduler. The scheduler decides
 * WHAT to run; the runner drives HOW it runs. Rest cycles, sub-rhythms,
 * and future rhythm levels all use the same runner.
 *
 * Nesting: a rhythm's execute phase receives the runner as a parameter
 * and can call runner.run() to spawn child rhythms. This is how
 * project → task-dispatch → sensory-cortex → build-cycle nesting works.
 */

import type {
  RhythmDefinition,
  RhythmState,
  RhythmRunner,
  Interrupt,
  RhythmPhase,
} from "../types/rhythm.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("rhythm-runner");

// ─── Error types for non-normal exits ───────────────────────────

/**
 * Thrown when a rhythm's gate decides to escalate.
 * The parent rhythm's execute phase can catch this and handle it.
 */
export class RhythmEscalation extends Error {
  constructor(
    public readonly rhythmId: string,
    public readonly severity: "low" | "medium" | "high" | "critical",
    public readonly reason: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(`Rhythm escalation (${severity}): ${reason}`);
    this.name = "RhythmEscalation";
  }
}

/**
 * Thrown when a rhythm is paused awaiting external input.
 * Phase 5 will add proper pause/resume via stored resolvers.
 */
export class RhythmPaused extends Error {
  constructor(
    public readonly rhythmId: string,
    public readonly reason: string,
  ) {
    super(`Rhythm paused: ${reason}`);
    this.name = "RhythmPaused";
  }
}

/**
 * Thrown when a hard interrupt freezes a rhythm mid-execution.
 */
export class RhythmInterrupted extends Error {
  constructor(
    public readonly rhythmId: string,
    public readonly source: string,
    public readonly reason: string,
  ) {
    super(`Rhythm interrupted by ${source}: ${reason}`);
    this.name = "RhythmInterrupted";
  }
}

// ─── Runner implementation ──────────────────────────────────────

export class RhythmRunnerImpl implements RhythmRunner {
  private rhythms = new Map<string, RhythmState<unknown, unknown>>();

  /** All active rhythm states. For observability / dashboard. */
  getActiveRhythms(): ReadonlyMap<string, RhythmState<unknown, unknown>> {
    return this.rhythms;
  }

  getRhythm(id: string): RhythmState<unknown, unknown> | undefined {
    return this.rhythms.get(id);
  }

  // ── RhythmRunner interface ──────────────────────────────────

  async run<TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, unknown, unknown, unknown>,
    context: TCtx,
    parentId: string,
  ): Promise<TRes> {
    return this.executeRhythm(definition, context, parentId);
  }

  interrupt(rhythmId: string, interrupt: Interrupt): void {
    const state = this.rhythms.get(rhythmId);
    if (!state) {
      log.warn("Interrupt for unknown rhythm", {
        rhythmId,
        source: interrupt.source,
      });
      return;
    }

    if (interrupt.mode === "soft") {
      state.pendingInterrupts.push(interrupt);

      emit("rhythm:soft-interrupt", {
        rhythmId,
        source: interrupt.source,
        reason: interrupt.reason,
        pendingCount: state.pendingInterrupts.length,
      });

      log.info("Soft interrupt queued", {
        rhythmId,
        type: state.rhythmType,
        source: interrupt.source,
      });
    } else {
      // Hard interrupt: freeze the rhythm at its current phase.
      // We can't abort a running Promise, so we mark it and the
      // phase loop checks between transitions.
      state.pausedAt = {
        phase: state.phase,
        timestamp: new Date(),
        reason: `Hard interrupt from ${interrupt.source}: ${interrupt.reason}`,
        snapshot: { ...state.accumulator },
      };

      emit("rhythm:hard-interrupt", {
        rhythmId,
        phase: state.phase,
        source: interrupt.source,
        reason: interrupt.reason,
      });

      log.warn("Hard interrupt — rhythm frozen", {
        rhythmId,
        type: state.rhythmType,
        phase: state.phase,
        source: interrupt.source,
      });
    }
  }

  // ── Top-level entry point (no parent) ─────────────────────

  /**
   * Start a rhythm as a root (no parent). Used by Attention Scheduler
   * to kick off the project-level rhythm.
   */
  async start<TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, unknown, unknown, unknown>,
    context: TCtx,
  ): Promise<TRes> {
    return this.executeRhythm(definition, context);
  }

  // ── Core execution loop ───────────────────────────────────

  private async executeRhythm<TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, unknown, unknown, unknown>,
    context: TCtx,
    parentId?: string,
  ): Promise<TRes> {
    const state = this.createState(definition, context, parentId);

    // Register as child of parent
    if (parentId) {
      const parent = this.rhythms.get(parentId);
      if (parent) parent.activeChildren.push(state.id);
    }

    emit("rhythm:start", {
      id: state.id,
      type: state.rhythmType,
      parentId: parentId ?? null,
      maxCycles: definition.maxCycles,
    });

    log.info("Rhythm started", {
      id: state.id,
      type: state.rhythmType,
      parentId: parentId ?? "root",
    });

    try {
      while (true) {
        // Check for hard interrupt before each cycle
        this.checkHardInterrupt(state);

        // ── Prepare ──
        this.transitionPhase(state, "prepare");
        const prepared = await definition.prepare(
          context,
          state as RhythmState<TCtx, TRes>,
        );
        this.checkHardInterrupt(state);

        // ── Execute ──
        this.transitionPhase(state, "execute");
        const executed = await definition.execute(
          prepared,
          state as RhythmState<TCtx, TRes>,
          this,
        );
        this.checkHardInterrupt(state);

        // ── Integrate ──
        this.transitionPhase(state, "integrate");
        const integrated = await definition.integrate(
          executed,
          state as RhythmState<TCtx, TRes>,
        );
        this.checkHardInterrupt(state);

        // ── Gate ──
        // Soft interrupts are visible on state.pendingInterrupts.
        // The gate function decides how to handle them.
        this.transitionPhase(state, "gate");
        const decision = await definition.gate(
          integrated,
          state as RhythmState<TCtx, TRes>,
        );

        state.completedCycles++;

        // Handle the gate decision
        switch (decision.action) {
          case "continue": {
            // Check max cycles
            if (
              definition.maxCycles > 0 &&
              state.completedCycles >= definition.maxCycles
            ) {
              emit("rhythm:max-cycles", {
                id: state.id,
                type: state.rhythmType,
                maxCycles: definition.maxCycles,
              });
              log.warn("Max cycles reached", {
                id: state.id,
                type: state.rhythmType,
                cycles: state.completedCycles,
              });
              throw new RhythmEscalation(
                state.id,
                "medium",
                `Rhythm ${state.rhythmType} reached max cycles (${definition.maxCycles})`,
                { completedCycles: state.completedCycles },
              );
            }

            emit("rhythm:cycle-complete", {
              id: state.id,
              type: state.rhythmType,
              cycle: state.completedCycles,
              reason: decision.reason,
            });
            log.info("Cycle complete, continuing", {
              id: state.id,
              type: state.rhythmType,
              cycle: state.completedCycles,
            });

            // Loop continues
            break;
          }

          case "complete": {
            state.result = decision.result as TRes;

            emit("rhythm:complete", {
              id: state.id,
              type: state.rhythmType,
              cycles: state.completedCycles,
            });
            log.info("Rhythm complete", {
              id: state.id,
              type: state.rhythmType,
              cycles: state.completedCycles,
            });

            return decision.result;
          }

          case "escalate": {
            emit("rhythm:escalate", {
              id: state.id,
              type: state.rhythmType,
              severity: decision.severity,
              reason: decision.reason,
            });
            log.warn("Rhythm escalating", {
              id: state.id,
              type: state.rhythmType,
              severity: decision.severity,
              reason: decision.reason,
            });

            throw new RhythmEscalation(
              state.id,
              decision.severity,
              decision.reason,
              decision.context,
            );
          }

          case "pause": {
            state.pausedAt = {
              phase: "gate",
              timestamp: new Date(),
              reason: decision.reason,
              snapshot: { ...state.accumulator },
            };

            emit("rhythm:paused", {
              id: state.id,
              type: state.rhythmType,
              reason: decision.reason,
            });
            log.info("Rhythm paused", {
              id: state.id,
              type: state.rhythmType,
              reason: decision.reason,
            });

            throw new RhythmPaused(state.id, decision.reason);
          }
        }
      }
    } finally {
      this.cleanup(state.id);
    }
  }

  // ── State management ──────────────────────────────────────

  private createState<TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, unknown, unknown, unknown>,
    context: TCtx,
    parentId?: string,
  ): RhythmState<TCtx, TRes> {
    const state: RhythmState<TCtx, TRes> = {
      id: newId(),
      rhythmType: definition.name,
      phase: "prepare",
      completedCycles: 0,
      initialContext: context,
      accumulator: {},
      parentId,
      activeChildren: [],
      pendingInterrupts: [],
      startedAt: new Date(),
      lastPhaseTransition: new Date(),
    };

    this.rhythms.set(state.id, state as RhythmState<unknown, unknown>);
    return state;
  }

  private transitionPhase(
    state: RhythmState<unknown, unknown>,
    phase: RhythmPhase,
  ): void {
    state.phase = phase;
    state.lastPhaseTransition = new Date();

    emit("rhythm:phase", {
      id: state.id,
      type: state.rhythmType,
      phase,
      cycle: state.completedCycles,
    });
  }

  /**
   * Check if a hard interrupt has frozen this rhythm.
   * Called between each phase transition.
   */
  private checkHardInterrupt(state: RhythmState<unknown, unknown>): void {
    if (state.pausedAt) {
      throw new RhythmInterrupted(
        state.id,
        "hard-interrupt",
        state.pausedAt.reason,
      );
    }
  }

  private cleanup(rhythmId: string): void {
    const state = this.rhythms.get(rhythmId);
    if (!state) return;

    // Remove from parent's active children
    if (state.parentId) {
      const parent = this.rhythms.get(state.parentId);
      if (parent) {
        parent.activeChildren = parent.activeChildren.filter(
          (id) => id !== rhythmId,
        );
      }
    }

    this.rhythms.delete(rhythmId);
  }
}
