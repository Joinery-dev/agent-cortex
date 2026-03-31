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
import type { EscalationResolution } from "../types/brainstem.js";
import type {
  Checkpoint,
  CheckpointConfig,
  CheckpointProvider,
} from "../types/checkpoint.js";
import { DEFAULT_CHECKPOINT_CONFIG } from "../types/checkpoint.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit, emitError, emitCritical, bus } from "../events.js";
import type { RhythmContext, EventDiagnosticContext } from "../events.js";
import { EscalationError, RhythmAbortedError } from "./errors.js";
import { getStepBarrier } from "../trace/step-barrier.js";
import { getContentStore } from "../trace/content-store.js";

const log = createLogger("rhythm-runner");

// ─── Internal state per running rhythm ──────────────────────────

interface RunningRhythm<TContext, TResult> {
  state: RhythmState<TContext, TResult>;
  definition: RhythmDefinition<TContext, TResult, unknown, unknown, unknown>;
  abortController: AbortController;
  /** Non-null when the rhythm is paused. Calling this resumes the loop. */
  pauseResolver?: (resolution: EscalationResolution) => void;
}

// ─── Runner implementation ──────────────────────────────────────

export class RhythmRunnerImpl implements RhythmRunner {
  private running = new Map<string, RunningRhythm<unknown, unknown>>();
  /** TTL for paused rhythms in milliseconds. Prevents infinite waits on Parsifal input. */
  private pauseTimeoutMs: number;
  private checkpointConfig: CheckpointConfig;
  private checkpointProvider: CheckpointProvider | null = null;

  constructor(opts?: { pauseTimeoutMs?: number; checkpointConfig?: Partial<CheckpointConfig> }) {
    this.pauseTimeoutMs = opts?.pauseTimeoutMs ?? 30 * 60 * 1000; // 30 minutes default
    this.checkpointConfig = { ...DEFAULT_CHECKPOINT_CONFIG, ...opts?.checkpointConfig };
  }

  /** Set the checkpoint provider (called by Brainstem after construction). */
  setCheckpointProvider(provider: CheckpointProvider): void {
    this.checkpointProvider = provider;
  }

  /** Update checkpoint config at runtime. */
  setCheckpointConfig(config: Partial<CheckpointConfig>): void {
    this.checkpointConfig = { ...this.checkpointConfig, ...config };
  }

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
    initialAccumulator?: Record<string, unknown>,
  ): Promise<TRes> {
    const rhythmId = newId();
    const abortController = new AbortController();

    const state: RhythmState<TCtx, TRes> = {
      id: rhythmId,
      rhythmType: definition.name,
      phase: "prepare",
      completedCycles: 0,
      initialContext: context,
      accumulator: initialAccumulator ?? {},
      parentId,
      activeChildren: [],
      pendingInterrupts: [],
      signal: abortController.signal,
      startedAt: new Date(),
      lastPhaseTransition: new Date(),
    };

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

    // Push rhythm context onto the event bus stack so all events
    // emitted during this rhythm automatically inherit it.
    const rhythmContext: RhythmContext = {
      rhythmId,
      rhythmType: definition.name,
      phase: "prepare",
      cycle: 0,
      parentRhythmId: parentId,
    };
    bus.pushContext(rhythmContext);

    try {
      const result = await this.driveLoop(entry);
      return result;
    } catch (err) {
      // Call cleanup on abnormal exit — stop runtimes, discard sandbox, etc.
      // On normal exit the rhythm's own gate phase handles cleanup.
      if (definition.cleanup) {
        await definition.cleanup(state).catch((cleanupErr) => {
          log.warn("Rhythm cleanup failed", {
            rhythmId,
            rhythmType: definition.name,
            error: String(cleanupErr),
          });
        });
      }
      throw err;
    } finally {
      // Pop rhythm context before cleanup
      bus.popContext();

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
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:prepare`);

      const prepared = await this.runPhase(
        "prepare", state, undefined,
        () => definition.prepare(state.initialContext, state),
      );

      // ── Execute ─────────────────────────────────────────
      this.checkAbort(signal, state);
      this.transitionPhase(state, "execute");
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:execute`);

      const executed = await this.runPhase(
        "execute", state, prepared,
        () => definition.execute(prepared, state, this),
      );

      // ── Checkpoint: pre-integrate ─────────────────────
      if (this.shouldCheckpoint("pre-integrate", state)) {
        await this.captureCheckpoint("pre-integrate", state, executed);
      }

      // ── Integrate ───────────────────────────────────────
      this.checkAbort(signal, state);
      this.transitionPhase(state, "integrate");
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:integrate`);

      const integrated = await this.runPhase(
        "integrate", state, executed,
        () => definition.integrate(executed, state),
      );

      // ── Gate ────────────────────────────────────────────
      this.transitionPhase(state, "gate");
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:gate`);

      const decision: GateDecision<TRes> = await this.runPhase(
        "gate", state, integrated,
        () => definition.gate(integrated, state),
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
          bus.updateCycle(state.completedCycles);
          // No hardcoded cycle limit. Convergence is governed by the gate
          // strategy, collapse detection (Basal Ganglia), cognitive flexibility
          // (Phase 4), and drift monitoring (Phase 4). If Cortex can't
          // converge, those diagnostic systems should detect why and either
          // change strategy or escalate — not silently return "best effort."
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
            escalationContext: decision.escalationContext,
          });

          log.info(`Rhythm ${state.rhythmType} paused, awaiting resume`, {
            rhythmId: state.id,
            reason: decision.reason,
          });

          // Await external resume signal with TTL. The Promise resolves when
          // resume() is called, rejects on hard interrupt or timeout.
          const pauseTimeoutMs = this.pauseTimeoutMs;
          const resolution = await Promise.race([
            new Promise<EscalationResolution>(
              (resolve, reject) => {
                entry.pauseResolver = resolve;

                // If a hard interrupt arrives while paused, abort the wait
                if (signal.aborted) {
                  reject(new RhythmAbortedError(state.id, "hard-interrupt", "Aborted while paused"));
                  return;
                }
                signal.addEventListener("abort", () => {
                  entry.pauseResolver = undefined;
                  reject(new RhythmAbortedError(state.id, "hard-interrupt", "Aborted while paused"));
                }, { once: true });
              },
            ),
            // TTL: prevent infinite waits on Parsifal input
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                entry.pauseResolver = undefined;
                emitCritical(
                  "rhythm:pause-timeout",
                  {
                    rhythmId: state.id,
                    rhythmType: state.rhythmType,
                    pausedForMs: pauseTimeoutMs,
                    reason: decision.reason,
                  },
                  {
                    component: "runner",
                    expected: `resume within ${pauseTimeoutMs}ms`,
                    received: "timeout — no Parsifal response",
                  },
                );
                reject(new RhythmAbortedError(
                  state.id,
                  "pause-timeout",
                  `Pause TTL expired after ${pauseTimeoutMs}ms — no Parsifal response`,
                ));
              }, pauseTimeoutMs);
            }),
          ]);

          // Resumed — clear pause state
          entry.pauseResolver = undefined;
          state.pausedAt = undefined;

          // Store the resolution on the accumulator so the next cycle can see it
          state.accumulator.__escalationResolution = resolution;

          emit("rhythm:resumed", {
            rhythmId: state.id,
            rhythmType: state.rhythmType,
            answer: resolution.answer.slice(0, 200),
          });

          log.info(`Rhythm ${state.rhythmType} resumed`, {
            rhythmId: state.id,
          });

          // Continue the loop — next iteration starts at prepare
          state.completedCycles++;
          bus.updateCycle(state.completedCycles);
          break;
        }
      }
    }
  }

  /**
   * Resume a paused rhythm with a resolution payload.
   * The rhythm continues from where it paused (the gate phase)
   * and enters its next cycle with the resolution available
   * on state.accumulator.__escalationResolution.
   */
  resume(rhythmId: string, resolution: EscalationResolution): void {
    const entry = this.running.get(rhythmId);
    if (!entry) {
      log.warn(`Resume for unknown rhythm ${rhythmId}`);
      return;
    }
    if (!entry.pauseResolver) {
      log.warn(`Rhythm ${rhythmId} is not paused`);
      return;
    }

    log.info(`Resuming rhythm ${entry.state.rhythmType}`, {
      rhythmId,
      answer: resolution.answer.slice(0, 100),
    });

    entry.pauseResolver(resolution);
  }

  /**
   * Run a rhythm's integrate → gate from a serialized checkpoint.
   *
   * This is the core of checkpoint resume: skips prepare + execute
   * (whose output is captured in the checkpoint), runs integrate with
   * fresh code (the whole point — evaluator changes take effect), then
   * runs gate to produce a decision.
   *
   * Does NOT loop on "continue" decisions — v1 is single-pass.
   * The caller gets the gate decision and can decide what to do.
   */
  async runFromCheckpoint<TCtx, TRes>(
    checkpoint: Checkpoint,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    definition: RhythmDefinition<TCtx, TRes, any, any, any>,
  ): Promise<{ integrated: unknown; gateDecision: GateDecision<TRes> }> {
    const rhythmId = newId();
    const abortController = new AbortController();

    const state: RhythmState<TCtx, TRes> = {
      id: rhythmId,
      rhythmType: checkpoint.rhythmType,
      phase: "integrate",
      completedCycles: checkpoint.completedCycles,
      initialContext: checkpoint.initialContext as TCtx,
      accumulator: checkpoint.accumulator,
      parentId: undefined,
      activeChildren: [],
      pendingInterrupts: [],
      signal: abortController.signal,
      startedAt: new Date(),
      lastPhaseTransition: new Date(),
    };

    const rhythmContext: RhythmContext = {
      rhythmId,
      rhythmType: checkpoint.rhythmType,
      phase: "integrate",
      cycle: checkpoint.completedCycles,
      parentRhythmId: undefined,
    };

    emit("rhythm:start", {
      rhythmId,
      rhythmType: checkpoint.rhythmType,
      parentId: null,
      resumedFromCheckpoint: checkpoint.id,
    });

    log.info("Running from checkpoint", {
      rhythmId,
      checkpointId: checkpoint.id,
      kind: checkpoint.kind,
      cycle: checkpoint.completedCycles,
    });

    bus.pushContext(rhythmContext);

    try {
      // ── Integrate (evaluation with current code) ──────────
      this.transitionPhase(state, "integrate");
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:integrate`);

      const integrated = await this.runPhase(
        "integrate", state, checkpoint.phaseOutput,
        () => definition.integrate(checkpoint.phaseOutput as never, state),
      );

      // ── Gate (conviction + decision) ──────────────────────
      this.transitionPhase(state, "gate");
      await getStepBarrier().checkpoint(`phase:${state.rhythmType}:gate`);

      const gateDecision = await this.runPhase(
        "gate", state, integrated,
        () => definition.gate(integrated as never, state),
      );

      emit("rhythm:gate-decision", {
        rhythmId: state.id,
        rhythmType: state.rhythmType,
        action: gateDecision.action,
        cycle: state.completedCycles,
        reason: "reason" in gateDecision ? gateDecision.reason : undefined,
        resumedFromCheckpoint: checkpoint.id,
      });

      log.info("Checkpoint resume complete", {
        rhythmId,
        action: gateDecision.action,
        checkpointId: checkpoint.id,
      });

      return { integrated, gateDecision };
    } finally {
      bus.popContext();
    }
  }

  /**
   * Run a single rhythm phase with error context capture.
   * On failure, emits a diagnostic event with the phase name,
   * phase input snapshot, and accumulator state, then re-throws.
   */
  private async runPhase<TCtx, TRes, TOut>(
    phaseName: RhythmPhase,
    state: RhythmState<TCtx, TRes>,
    phaseInput: unknown,
    fn: () => Promise<TOut>,
  ): Promise<TOut> {
    try {
      return await fn();
    } catch (err) {
      // Don't wrap abort/escalation errors — they're control flow, not failures
      if (err instanceof RhythmAbortedError || err instanceof EscalationError) {
        throw err;
      }

      const snapshot: Record<string, unknown> = {
        phase: phaseName,
        rhythmType: state.rhythmType,
        cycle: state.completedCycles,
        accumulator: Object.keys(state.accumulator),
      };

      // Capture a safe summary of the phase input (keys only to avoid huge payloads)
      if (phaseInput != null && typeof phaseInput === "object") {
        snapshot.phaseInputKeys = Object.keys(phaseInput as Record<string, unknown>);
      }

      emitError(
        `rhythm:phase-error:${phaseName}`,
        {
          rhythmId: state.id,
          rhythmType: state.rhythmType,
          phase: phaseName,
          cycle: state.completedCycles,
          error: String(err),
        },
        {
          component: "rhythm-runner",
          expected: `${phaseName} phase to complete`,
          received: String(err),
          snapshot,
        },
      );

      throw err;
    }
  }

  // ─── Checkpoint helpers ──────────────────────────────────────

  private shouldCheckpoint<TCtx, TRes>(
    kind: Checkpoint["kind"],
    state: RhythmState<TCtx, TRes>,
  ): boolean {
    if (!this.checkpointConfig.enabled) return false;
    if (!this.checkpointProvider) return false;
    if (!this.checkpointConfig.kinds.includes(kind)) return false;
    if (!this.checkpointConfig.rhythmTypes.includes(state.rhythmType)) return false;
    return true;
  }

  private async captureCheckpoint<TCtx, TRes>(
    kind: Checkpoint["kind"],
    state: RhythmState<TCtx, TRes>,
    phaseOutput: unknown,
  ): Promise<void> {
    const provider = this.checkpointProvider;
    if (!provider) return;

    try {
      // Extract task identity from the context
      const ctx = state.initialContext as Record<string, unknown>;
      const task = ctx.task as { id?: string; description?: string } | undefined;
      const taskId = task?.id ?? state.id;
      const taskDescription = task?.description ?? state.rhythmType;

      // Capture ambient state from services
      const ambient = provider.captureAmbient(taskId);

      // Get git commit hash (best-effort, non-blocking)
      let gitCommit: string | undefined;
      try {
        const { execSync } = await import("node:child_process");
        gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8", timeout: 2000 }).trim();
      } catch {
        // Not in a git repo or git not available — fine
      }

      const checkpoint: Checkpoint = {
        id: newId(),
        label: `${kind} ${taskId.slice(-12)} cycle-${state.completedCycles}`,
        kind,
        createdAt: new Date().toISOString(),
        rhythmType: state.rhythmType,
        cycle: state.completedCycles,
        taskId,
        taskDescription,
        accumulator: { ...state.accumulator },
        phaseOutput: phaseOutput as Record<string, unknown>,
        initialContext: ctx,
        completedCycles: state.completedCycles,
        workingMemory: ambient.workingMemory,
        plasticity: ambient.plasticity,
        gestalt: ambient.gestalt,
        gitCommit,
        contentStoreSize: getContentStore().size,
      };

      await provider.store.save(checkpoint);
      await provider.store.prune(this.checkpointConfig.maxCheckpoints);

      // Also persist plasticity to disk as a side effect
      emit("checkpoint:created", {
        checkpointId: checkpoint.id,
        kind,
        rhythmType: state.rhythmType,
        taskId,
        cycle: state.completedCycles,
      });

      log.info("Checkpoint captured", {
        id: checkpoint.id,
        kind,
        taskId: taskId.slice(-12),
        cycle: state.completedCycles,
      });
    } catch (err) {
      // Checkpoint failure should not abort the rhythm
      log.warn("Checkpoint capture failed", { kind, error: String(err) });
    }
  }

  // ─── Public checkpoint (arbitrary, non-rhythm-bound) ──────────

  /**
   * Capture a checkpoint at an arbitrary point — not tied to a rhythm phase boundary.
   * Used by the project rhythm to checkpoint after inquiry, vision approval, and planning.
   */
  async checkpoint(
    kind: Checkpoint["kind"],
    label: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.checkpointConfig.enabled) return;
    if (!this.checkpointProvider) return;
    if (!this.checkpointConfig.kinds.includes(kind)) return;

    const provider = this.checkpointProvider;

    try {
      const taskId = (data.taskId as string) ?? "project";
      const taskDescription = (data.taskDescription as string) ?? label;
      const ambient = provider.captureAmbient(taskId);

      let gitCommit: string | undefined;
      try {
        const { execSync } = await import("node:child_process");
        gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8", timeout: 2000 }).trim();
      } catch {
        // Not in a git repo or git not available
      }

      const checkpoint: Checkpoint = {
        id: newId(),
        label,
        kind,
        createdAt: new Date().toISOString(),
        rhythmType: "project",
        cycle: 0,
        taskId,
        taskDescription,
        accumulator: data,
        phaseOutput: {},
        initialContext: data.initialContext as Record<string, unknown> ?? {},
        completedCycles: 0,
        workingMemory: ambient.workingMemory,
        plasticity: ambient.plasticity,
        gestalt: ambient.gestalt,
        gitCommit,
        contentStoreSize: getContentStore().size,
      };

      await provider.store.save(checkpoint);
      await provider.store.prune(this.checkpointConfig.maxCheckpoints);

      emit("checkpoint:created", {
        checkpointId: checkpoint.id,
        kind,
        rhythmType: "project",
        taskId,
        cycle: 0,
      });

      log.info("Checkpoint captured", { id: checkpoint.id, kind, label });
    } catch (err) {
      log.warn("Checkpoint capture failed", { kind, error: String(err) });
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
    bus.updatePhase(to);

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
