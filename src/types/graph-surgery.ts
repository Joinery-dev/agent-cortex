/**
 * Graph Surgery — typed operations for modifying a live task graph.
 *
 * Four atomic operations (insert, amend, rework, reorder) that the PFC
 * can apply to the running task graph without triggering a full replan.
 *
 * Proposals bundle operations with grounding (why) and blast radius
 * (how much of the plan is affected). The PFC synthesizes proposals;
 * graph-surgery.ts (kernel) executes them as pure functions.
 */

import type { TaskGraphNode } from "./brainstem.js";

// ─── Rework Directive ──────────────────────────────────────────

/**
 * Attached to a completed task when it's reopened for rework.
 * Constrains the rework to be backward-compatible with downstream
 * tasks that already built on the original output.
 */
export interface ReworkDirective {
  /** Which completed task to reopen. */
  taskId: string;
  /** Why this task is being reopened. */
  reason: string;
  /** Revised task description (replaces the original). */
  amendedDescription: string;
  /** Additional context merged into the task's context bag. */
  additionalContext: Record<string, unknown>;
  /** IDs of completed tasks that depend on this one — rework must be compatible. */
  downstreamDependents: string[];
}

// ─── Atomic Operations ─────────────────────────────────────────

export type GraphSurgeryOp =
  | GraphSurgeryInsert
  | GraphSurgeryAmend
  | GraphSurgeryRework
  | GraphSurgeryReorder;

/** Add a new task to the graph. */
export interface GraphSurgeryInsert {
  op: "insert";
  node: TaskGraphNode;
}

/** Modify the description/context of a not-yet-started task. */
export interface GraphSurgeryAmend {
  op: "amend";
  taskId: string;
  /** New description (replaces existing). */
  description: string;
  /** Additional context merged into existing context. */
  additionalContext?: Record<string, unknown>;
}

/** Reopen a completed task with a rework directive. */
export interface GraphSurgeryRework {
  op: "rework";
  directive: ReworkDirective;
}

/** Add a dependency edge (never remove). */
export interface GraphSurgeryReorder {
  op: "reorder";
  /** Task that gains a new dependency. */
  taskId: string;
  /** The task it must now wait for. */
  dependsOn: string;
}

// ─── Proposals ──────────────────────────────────────────────────

/** A plan-change proposal from PFC synthesis, pending conviction check. */
export interface SurgeryProposal {
  id: string;
  /** Where this proposal originated. */
  source: "quick-triage" | "deep-synthesis" | "nursery";
  /** Why this change is being proposed. */
  reasoning: string;
  /** The operations to apply. */
  operations: GraphSurgeryOp[];
  /** Fraction of remaining (non-completed) tasks affected (0-1). */
  blastRadius: number;
  /** IDs of observations/simulations that motivated this proposal. */
  grounding: string[];
  createdAt: Date;
  status: "pending" | "approved" | "rejected" | "executed";
}

// ─── Results ────────────────────────────────────────────────────

/** Result of applying surgery to a live graph. */
export interface SurgeryResult {
  proposalId: string;
  /** How many operations were applied successfully. */
  operationsApplied: number;
  /** How many operations failed (with reasons in events). */
  operationsFailed: number;
  /** The updated graph (new array — original not mutated). */
  graph: TaskGraphNode[];
  /** Task IDs that were reopened via rework. */
  reopenedTaskIds: string[];
  /** Task IDs that were inserted. */
  insertedTaskIds: string[];
  /** Task IDs that were amended. */
  amendedTaskIds: string[];
}

/** Validation result for a proposal before execution. */
export interface ValidationResult {
  valid: boolean;
  issues: string[];
}
