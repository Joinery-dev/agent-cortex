/**
 * Rhythm Runner — the engine that drives all rhythms.
 *
 * Implements the RhythmRunner interface from types/rhythm.ts.
 * Creates RhythmState instances, drives the four-phase loop
 * (prepare → execute → integrate → gate), handles nesting,
 * manages interrupts, and emits events for observability.
 */

import type {
  RhythmDefinition,
  RhythmRunner,
  RhythmState,
  RhythmPhase,
  GateDecision,
  Interrupt,
  SoftInterrupt,
  HardInterrupt,
} from "../types/rhythm.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { EscalationError, RhythmAbortedError } from "./errors.js";

const log = createLogger("rhythm-runner");

// ─── Internal state per running rhythm ──────────────────────────

interface RunningRhythm<TContext, TResult> {
  state: RhythmState<TContext, TResult>;
  definition: RhythmDefinition<TContext, TResult, unknown, unknown, unknown>;
  abortController: AbortController;
}

// ─── Runner implementation ──────────────────────────────────────

export class RhythmRunnerImpl implements RhythmRunner {
  private running = new Map<string, RunningRhythm<unknown, unknown>>();

  /** Get current state of a running rhythm (for observability). */
  getState<TCtx, TRes>(rhythmId: string): RhythmState<TCtx, TRes> | undefined {
    const entry = this.running.get(rhythmId);
    return entry?.state as RhythmState<TCtx, TRes> | undefined;
  }

  /** Get all running rhythm IDs. */
  getActiveRhythms(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Start a rhythm and drive it to completion.
   *
   * Creates a RhythmState, runs the four-phase loop, and returns
   * the result when the gate decides "complete". Nested rhythms
   * are spawned by the execute phase calling runner.run() — the
   * child runs inside the parent's execute phase.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async run<TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, any, any, any>,
    context: TCtx,
    parentId?: string,
  ): Promise<TRes> {
    const rhythmId = newId();

    const state: RhythmState<TCtx, TRes> = {
      id: rhythmId,
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

    const abortController = new AbortController();

    const entry: RunningRhythm<TCtx, TRes> = {
      state,
      definition: definition as RhythmDefinition<TCtx, TRes, unknown, unknown, unknown>,
      abortController,
    };

    this.running.set(rhythmId, entry as RunningRhythm<unknown, unknown>);

    // Track as child of parent
    if (parentId) {
      const parent = this.running.get(parentId);
      if (parent) {
        parent.state.activeChildren.push(rhythmId);
      }
    }

    emit("rhythm:start", {
      rhythmId,
      rhythmType: definition.name,
      parentId: parentId ?? null,
    });

    log.info(`Starting rhythm ${definition.name}`, { rhythmId, parentId });

    try {
      const result = await this.driveLoop(entry);
      return result;
    } finally {
      // Clean up
      this.running.delete(rhythmId);
      if (parentId) {
        const parent = this.running.get(parentId);
        if (parent) {
          parent.state.activeChildren = parent.state.activeChildren.filter(
            (id) => id !== rhythmId,
          );
        }
      }
    }
  }

  /**
   * Send an interrupt to a running rhythm.
   *
   * Soft: queued in pendingInterrupts, checked at the next gate.
   * Hard: aborts the rhythm's AbortController, freezing it mid-phase.
   */
  interrupt(rhythmId: string, interrupt: Interrupt): void {
    const entry = this.running.get(rhythmId);
    if (!entry) {
      log.warn(`Interrupt for unknown rhythm ${rhythmId}`, { interrupt });
      return;
    }

    emit("rhythm:interrupt", {
      rhythmId,
      rhythmType: entry.state.rhythmType,
      mode: interrupt.mode,
      source: interrupt.source,
      reason: interrupt.reason,
    });

    if (interrupt.mode === "soft") {
      entry.state.pendingInterrupts.push(interrupt as SoftInterrupt);
      log.info(`Soft interrupt queued for ${entry.state.rhythmType}`, {
        rhythmId,
        source: interrupt.source,
      });
    } else {
      // Hard interrupt — snapshot state and abort
      log.warn(`Hard interrupt for ${entry.state.rhythmType}`, {
        rhythmId,
        source: interrupt.source,
        reason: interrupt.reason,
      });

      entry.state.pausedAt = {
        phase: entry.state.phase,
        timestamp: new Date(),
        reason: interrupt.reason,
        snapshot: { ...entry.state.accumulator },
      };

      entry.abortController.abort();
    }
  }

  // ─── Internal loop driver ───────────────────────────────────

  private async driveLoop<TCtx, TRes>(
    entry: RunningRhythm<TCtx, TRes>,
  ): Promise<TRes> {
    const { state, definition, abortController } = entry;
    const signal = abortController.signal;

    while (true) {
      // ── Prepare ─────────────────────────────────────────
      this.checkAbort(signal, state);
      this.transitionPhase(state, "prepare");

      const prepared = await definition.prepare(
        state.initialContext,
        state,
      );

      // ── Execute ─────────────────────────────────────────
      this.checkAbort(signal, state);
      this.transitionPhase(state, "execute");

      const executed = await definition.execute(prepared, state, this);

      // ── Integrate ───────────────────────────────────────
      this.checkAbort(signal, state);
      this.transitionPhase(state, "integrate");

      const integrated = await definition.integrate(executed, state);

      // ── Gate ────────────────────────────────────────────
      this.transitionPhase(state, "gate");

      const decision: GateDecision<TRes> = await definition.gate(
        integrated,
        state,
      );

      emit("rhythm:gate-decision", {
        rhythmId: state.id,
        rhythmType: state.rhythmType,
        action: decision.action,
        cycle: state.completedCycles,
        reason: "reason" in decision ? decision.reason : undefined,
      });

      log.info(`Gate decision for ${state.rhythmType}`, {
        rhythmId: state.id,
        action: decision.action,
        cycle: state.completedCycles,
      });

      switch (decision.action) {
        case "continue":
          state.completedCycles++;

          // Enforce max cycles
          if (
            definition.maxCycles > 0 &&
            state.completedCycles >= definition.maxCycles
          ) {
            log.warn(
              `${state.rhythmType} reached maxCycles (${definition.maxCycles}), forcing completion`,
              { rhythmId: state.id },
            );

            // Ask gate one more time with a forced-completion hint
            // in the accumulator so it can produce a best-effort result
            state.accumulator.__maxCyclesReached = true;
            const forcedDecision = await definition.gate(integrated, state);

            if (forcedDecision.action === "complete") {
              return this.completeRhythm(state, forcedDecision.result);
            }

            // If gate still won't complete, escalate
            throw new EscalationError(state.id, {
              action: "escalate",
              severity: "medium",
              reason: `${state.rhythmType} reached max cycles (${definition.maxCycles}) without completion`,
              context: { cycles: state.completedCycles },
            });
          }
          break;

        case "complete":
          return this.completeRhythm(state, decision.result);

        case "escalate":
          throw new EscalationError(state.id, decision);

        case "pause": {
          state.pausedAt = {
            phase: "gate",
            timestamp: new Date(),
            reason: decision.reason,
            snapshot: { ...state.accumulator },
          };

          emit("rhythm:paused", {
            rhythmId: state.id,
            rhythmType: state.rhythmType,
            reason: decision.reason,
          });

          // For now, paused rhythms throw — resume support comes later
          // when we have the external signal infrastructure
          throw new EscalationError(state.id, {
            action: "escalate",
            severity: "medium",
            reason: `Rhythm paused: ${decision.reason}`,
            context: { pausedAt: state.pausedAt },
          });
        }
      }
    }
  }

  private checkAbort<TCtx, TRes>(
    signal: AbortSignal,
    state: RhythmState<TCtx, TRes>,
  ): void {
    if (signal.aborted) {
      const source = state.pausedAt?.reason ?? "unknown";
      throw new RhythmAbortedError(state.id, source, "Hard interrupt");
    }
  }

  private transitionPhase<TCtx, TRes>(
    state: RhythmState<TCtx, TRes>,
    to: RhythmPhase,
  ): void {
    const from = state.phase;
    state.phase = to;
    state.lastPhaseTransition = new Date();

    emit("rhythm:phase-change", {
      rhythmId: state.id,
      rhythmType: state.rhythmType,
      from,
      to,
      cycle: state.completedCycles,
    });
  }

  private completeRhythm<TCtx, TRes>(
    state: RhythmState<TCtx, TRes>,
    result: TRes,
  ): TRes {
    state.result = result;

    emit("rhythm:complete", {
      rhythmId: state.id,
      rhythmType: state.rhythmType,
      cycles: state.completedCycles,
    });

    log.info(`Rhythm ${state.rhythmType} complete`, {
      rhythmId: state.id,
      cycles: state.completedCycles,
    });

    return result;
  }
}
