/**
 * Checkpoint — state snapshot at a rhythm phase boundary.
 *
 * Captures everything needed to resume a build-cycle from a specific point
 * (e.g., right before evaluation) without replaying earlier phases. The
 * resume process constructs fresh services from current code, restores
 * ambient state from the checkpoint, and continues from the captured phase.
 *
 * This replaces content-hash replay for resumption. Content-hash replay
 * is preserved for dashboard narrative stepping (read-only visualization).
 */

import type { CheckpointStore } from "../trace/checkpoint-store.js";

// ─── Checkpoint kinds ──────────────────────────────────────────

/** Where in the rhythm lifecycle the checkpoint was captured. */
export type CheckpointKind =
  | "pre-integrate"   // After execute, before integrate (pre-evaluation)
  | "post-gate"       // After gate decision (between cycles)
  | "post-task";      // After sensory-cortex completes a task

// ─── Core checkpoint type ──────────────────────────────────────

export interface Checkpoint {
  /** Unique ID for this checkpoint. */
  id: string;
  /** Human-readable label (e.g., "pre-eval plan-manifest cycle-0"). */
  label: string;
  /** What kind of boundary this captures. */
  kind: CheckpointKind;
  /** When the checkpoint was created (ISO string). */
  createdAt: string;

  // ── Rhythm identity ──
  /** Which rhythm type this captures (e.g., "build-cycle"). */
  rhythmType: string;
  /** Cycle number at checkpoint time. */
  cycle: number;
  /** Task being worked on. */
  taskId: string;
  /** Short description of the task. */
  taskDescription: string;

  // ── Serialized rhythm state ──
  /** The rhythm's accumulator at checkpoint time. */
  accumulator: Record<string, unknown>;
  /** Output of the last completed phase (e.g., ExecutedBuild for pre-integrate). */
  phaseOutput: Record<string, unknown>;
  /** The initial context the rhythm was started with (e.g., BuildCycleContext). */
  initialContext: Record<string, unknown>;
  /** Number of completed cycles at checkpoint time. */
  completedCycles: number;

  // ── Ambient state snapshots ──
  /** WorkingMemoryState from wm.snapshot(). */
  workingMemory: unknown;
  /** ConnectionSnapshot from plasticityStore.snapshot(). */
  plasticity: unknown;
  /** TaskGestalt for this task from thalamus. */
  gestalt: unknown;

  // ── Metadata ──
  /** Git commit hash at checkpoint time (for correlating code version). */
  gitCommit?: string;
  /** Content store entry count at checkpoint time (for trace continuity). */
  contentStoreSize: number;
  /** Serialized size in bytes. */
  sizeBytes?: number;
}

// ─── Lightweight index entry ───────────────────────────────────

/** For listing checkpoints without loading the full payload. */
export interface CheckpointIndex {
  id: string;
  label: string;
  kind: CheckpointKind;
  createdAt: string;
  taskId: string;
  taskDescription: string;
  cycle: number;
  rhythmType: string;
  sizeBytes: number;
}

// ─── Checkpoint config ─────────────────────────────────────────

export interface CheckpointConfig {
  /** Whether checkpointing is enabled. Default: true. */
  enabled: boolean;
  /** Which phase boundaries to capture. Default: ["pre-integrate"]. */
  kinds: CheckpointKind[];
  /** Only checkpoint these rhythm types. Default: ["build-cycle"]. */
  rhythmTypes: string[];
  /** Max checkpoints to retain. Oldest pruned on save. Default: 10. */
  maxCheckpoints: number;
}

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  kinds: ["pre-integrate"],
  rhythmTypes: ["build-cycle"],
  maxCheckpoints: 10,
};

// ─── Checkpoint provider ───────────────────────────────────────

/**
 * Callback interface set on the rhythm runner by the Brainstem.
 * Lets the runner capture ambient state without holding service references.
 */
export interface CheckpointProvider {
  /** Capture ambient state from services at this moment. */
  captureAmbient(taskId: string): CheckpointAmbientState;
  /** The checkpoint store for persistence. */
  store: CheckpointStore;
}

/** Ambient state captured from services at checkpoint time. */
export interface CheckpointAmbientState {
  workingMemory: unknown;
  plasticity: unknown;
  gestalt: unknown;
}
