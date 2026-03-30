/**
 * Rhythm — the recursive heartbeat pattern.
 *
 * Every loop in Cortex follows the same four-phase cycle:
 *   prepare → execute → integrate → gate
 *
 * Each phase maps to a brain region:
 *   prepare   → Thalamus      (context assembly)
 *   execute   → Motor/Sensory  (doing — may spawn child rhythms)
 *   integrate → Subcortical    (learning — hippocampus, cerebellum, dopamine)
 *   gate      → Prefrontal     (executive decision — continue, complete, escalate)
 *
 * Rhythms nest: a project rhythm's execute phase contains a task-dispatch
 * rhythm, whose execute phase contains a sensory-cortex rhythm, whose execute
 * phase contains a build cycle rhythm. New levels can emerge without new
 * architecture — just instantiate another rhythm.
 */

// ─── Phase ──────────────────────────────────────────────────────

export type RhythmPhase = "prepare" | "execute" | "integrate" | "gate";

// ─── Gate decisions ─────────────────────────────────────────────

/** Continue the loop — go back to prepare for the next iteration. */
export interface GateContinue {
  action: "continue";
  reason: string;
}

/** This rhythm is done. Return result to parent. */
export interface GateComplete<TResult> {
  action: "complete";
  result: TResult;
}

/**
 * This rhythm can't resolve something at its level.
 * Bubble up to the parent rhythm's gate.
 */
export interface GateEscalate {
  action: "escalate";
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  /** What the parent needs to know to handle this. */
  context: Record<string, unknown>;
}

/**
 * Rhythm is paused — can be resumed later.
 * Used when a soft interrupt arrives at the gate, or when
 * awaiting external input (Parsifal response to escalation).
 */
export interface GatePause {
  action: "pause";
  reason: string;
  resumable: true;
  /** Present when the pause is due to an escalation that needs Parsifal input. */
  escalationContext?: {
    source: import("./brainstem.js").EscalationSource;
    severity: import("./brainstem.js").Escalation["severity"];
    detail: string;
    question?: string;
    proposedActions?: string[];
  };
}

export type GateDecision<TResult> =
  | GateContinue
  | GateComplete<TResult>
  | GateEscalate
  | GatePause;

// ─── Interrupts ─────────────────────────────────────────────────

/**
 * Soft interrupt — cooperative. The rhythm sees it at its next gate.
 * Sources: Drift Monitor, Cognitive Flexibility.
 */
export interface SoftInterrupt {
  mode: "soft";
  source: string;
  reason: string;
  context: Record<string, unknown>;
}

/**
 * Hard interrupt — preemptive. Freezes the rhythm mid-phase.
 * Sources: Amygdala, Parsifal emergency.
 * Requires state snapshot for later resumption.
 */
export interface HardInterrupt {
  mode: "hard";
  source: string;
  reason: string;
  context: Record<string, unknown>;
}

export type Interrupt = SoftInterrupt | HardInterrupt;

// ─── Rhythm instance state ──────────────────────────────────────

export interface RhythmState<TContext, TResult> {
  /** Unique ID for this rhythm instance. */
  id: string;

  /** Which rhythm definition this instantiates (e.g. "project", "task-dispatch"). */
  rhythmType: string;

  /** Current phase within the cycle. */
  phase: RhythmPhase;

  /** How many full cycles (prepare→gate) this instance has completed. */
  completedCycles: number;

  /** The context this rhythm was started with. */
  initialContext: TContext;

  /**
   * Accumulated state across cycles. Each phase can read and append.
   * This is the rhythm's "working memory" — scoped to this instance.
   */
  accumulator: Record<string, unknown>;

  /** Parent rhythm, if nested. */
  parentId?: string;

  /** Active child rhythm IDs (execute phase may spawn children). */
  activeChildren: string[];

  /** Pending soft interrupts — checked at gate phase. */
  pendingInterrupts: SoftInterrupt[];

  /**
   * AbortSignal from the rhythm's AbortController.
   * Rhythm definitions can thread this to cancellable operations
   * (e.g., PNS.execute(), LLM calls) so hard interrupts propagate.
   */
  signal?: AbortSignal;

  /** Non-null if this rhythm has been paused. */
  pausedAt?: {
    phase: RhythmPhase;
    timestamp: Date;
    reason: string;
    snapshot: Record<string, unknown>;
  };

  /** Final result, set when gate returns GateComplete. */
  result?: TResult;

  /** Timestamps for observability. */
  startedAt: Date;
  lastPhaseTransition: Date;
}

// ─── Rhythm definition ──────────────────────────────────────────

/**
 * A rhythm definition is a template — it describes the four phases
 * for a particular level of Cortex. The brainstem instantiates
 * these into RhythmState objects when the rhythm starts.
 *
 * TContext: what the rhythm needs to start (e.g., ProjectIntent for project level)
 * TResult:  what the rhythm produces when complete (e.g., OrchestratorResult)
 * TPrepared: output of prepare, input to execute
 * TExecuted: output of execute, input to integrate
 * TIntegrated: output of integrate, input to gate
 */
export interface RhythmDefinition<
  TContext,
  TResult,
  TPrepared = unknown,
  TExecuted = unknown,
  TIntegrated = unknown,
> {
  /** Unique name for this rhythm type. */
  name: string;

  /**
   * Advisory cycle count. Not enforced by the runner — convergence is
   * governed by gate strategies and diagnostic systems (collapse detection,
   * cognitive flexibility, drift monitoring). Retained for observability
   * and for rhythm definitions that are structurally single-pass (e.g.
   * project rhythm sets 1 because it doesn't loop).
   */
  maxCycles: number;

  /**
   * Prepare — Thalamus role.
   * Assemble context for whoever's about to act.
   */
  prepare: (
    context: TContext,
    state: RhythmState<TContext, TResult>,
  ) => Promise<TPrepared>;

  /**
   * Execute — Motor/Sensory role.
   * Do the work. May spawn child rhythms via the runner.
   */
  execute: (
    prepared: TPrepared,
    state: RhythmState<TContext, TResult>,
    runner: RhythmRunner,
  ) => Promise<TExecuted>;

  /**
   * Integrate — Subcortical role.
   * Process what happened. Update learning systems.
   */
  integrate: (
    executed: TExecuted,
    state: RhythmState<TContext, TResult>,
  ) => Promise<TIntegrated>;

  /**
   * Gate — Prefrontal role.
   * Decide: continue the loop, complete, escalate, or pause.
   * Soft interrupts are available on state.pendingInterrupts.
   */
  gate: (
    integrated: TIntegrated,
    state: RhythmState<TContext, TResult>,
  ) => Promise<GateDecision<TResult>>;

  /** Called when the rhythm exits abnormally (error/abort). For resource cleanup
   *  (stop runtimes, discard sandbox). Not called on normal completion — the
   *  rhythm's own gate phase handles cleanup in the happy path. */
  cleanup?: (state: RhythmState<TContext, TResult>) => Promise<void>;
}

// ─── Rhythm runner ──────────────────────────────────────────────

/**
 * The runner is how a rhythm's execute phase spawns child rhythms.
 * Passed into execute() so rhythms can nest without knowing the
 * runtime implementation.
 */
export interface RhythmRunner {
  /**
   * Start a child rhythm and await its completion.
   * The child's result becomes part of the parent's execute output.
   *
   * The intermediate types (TPrepared, TExecuted, TIntegrated) use `any`
   * here because the runner doesn't inspect them — it just calls the
   * phases in sequence. Type safety lives at the definition site.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: <TCtx, TRes>(
    definition: RhythmDefinition<TCtx, TRes, any, any, any>,
    context: TCtx,
    parentId: string,
  ) => Promise<TRes>;

  /**
   * Send an interrupt to a running rhythm.
   * Soft interrupts queue for the next gate. Hard interrupts freeze immediately.
   */
  interrupt: (rhythmId: string, interrupt: Interrupt) => void;

  /**
   * Resume a paused rhythm with a resolution payload.
   * The rhythm continues from where it paused (the gate phase)
   * and enters its next cycle with the resolution available.
   */
  resume: (
    rhythmId: string,
    resolution: import("./brainstem.js").EscalationResolution,
  ) => void;
}
