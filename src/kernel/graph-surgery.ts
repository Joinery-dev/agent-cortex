/**
 * Graph Surgery — pure functions for modifying a live task graph.
 *
 * Four atomic operations:
 *   insert  — add a new TaskGraphNode
 *   amend   — modify description/context of a not-yet-started task
 *   rework  — reopen a completed task with a ReworkDirective
 *   reorder — add a dependency edge (never remove)
 *
 * All functions are pure: they return new arrays, never mutate inputs.
 * The completedTaskIds Set IS mutated by rework (it removes the task
 * from the set) — this is intentional since the Set is the accumulator's
 * live state.
 */

import type { TaskGraphNode } from "../types/brainstem.js";
import type {
  GraphSurgeryOp,
  SurgeryProposal,
  SurgeryResult,
  ValidationResult,
} from "../types/graph-surgery.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("graph-surgery");

// ─── ID Generation ──────────────────────────────────────────────

/** Generate a discoverable ID for an inserted task. */
export function discoveryId(n: number, slug: string): string {
  // Sanitize slug: lowercase, replace non-alphanumeric with hyphens, trim
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `discovery-${n}-${sanitized}`;
}

// ─── Blast Radius ───────────────────────────────────────────────

/**
 * Compute blast radius: fraction of remaining (non-completed) tasks
 * that would be affected by a set of operations.
 *
 * "Affected" means directly targeted by an operation, or downstream
 * of a reworked task (since rework may invalidate dependents).
 */
export function computeBlastRadius(
  ops: GraphSurgeryOp[],
  graph: TaskGraphNode[],
  completedTaskIds: Set<string>,
): number {
  const remaining = graph.filter((n) => !completedTaskIds.has(n.task.id));
  if (remaining.length === 0) return 0;

  const affected = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case "insert":
        // Inserted task itself doesn't affect existing tasks,
        // but tasks it depends on or that depend on it are affected
        affected.add(op.node.task.id);
        break;

      case "amend":
        affected.add(op.taskId);
        break;

      case "rework": {
        const taskId = op.directive.taskId;
        affected.add(taskId);
        // Downstream dependents of a reworked task are also affected
        for (const node of remaining) {
          if (node.dependsOn.includes(taskId)) {
            affected.add(node.task.id);
          }
        }
        break;
      }

      case "reorder":
        affected.add(op.taskId);
        break;
    }
  }

  // Only count remaining (non-completed) tasks in the denominator
  const affectedRemaining = [...affected].filter(
    (id) => !completedTaskIds.has(id),
  ).length;

  return affectedRemaining / remaining.length;
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate that a proposal can be applied safely.
 *
 * Checks:
 * - Referenced tasks exist in the graph
 * - Amend targets are not currently executing
 * - Rework targets are actually completed
 * - Reorder doesn't create circular dependencies
 * - Insert IDs don't collide with existing tasks
 */
export function validateProposal(
  proposal: SurgeryProposal,
  graph: TaskGraphNode[],
  completedTaskIds: Set<string>,
  activeTaskId: string | null,
): ValidationResult {
  const issues: string[] = [];
  const taskIds = new Set(graph.map((n) => n.task.id));

  for (const op of proposal.operations) {
    switch (op.op) {
      case "insert":
        if (taskIds.has(op.node.task.id)) {
          issues.push(`Insert: task ID "${op.node.task.id}" already exists in graph`);
        }
        for (const dep of op.node.dependsOn) {
          if (!taskIds.has(dep) && dep !== op.node.task.id) {
            issues.push(`Insert: dependency "${dep}" not found in graph`);
          }
        }
        break;

      case "amend":
        if (!taskIds.has(op.taskId)) {
          issues.push(`Amend: task "${op.taskId}" not found in graph`);
        }
        if (op.taskId === activeTaskId) {
          issues.push(`Amend: task "${op.taskId}" is currently executing`);
        }
        if (completedTaskIds.has(op.taskId)) {
          issues.push(`Amend: task "${op.taskId}" is already completed — use rework instead`);
        }
        break;

      case "rework":
        if (!completedTaskIds.has(op.directive.taskId)) {
          issues.push(`Rework: task "${op.directive.taskId}" is not completed`);
        }
        if (!taskIds.has(op.directive.taskId)) {
          issues.push(`Rework: task "${op.directive.taskId}" not found in graph`);
        }
        break;

      case "reorder": {
        if (!taskIds.has(op.taskId)) {
          issues.push(`Reorder: task "${op.taskId}" not found in graph`);
        }
        if (!taskIds.has(op.dependsOn)) {
          issues.push(`Reorder: dependency "${op.dependsOn}" not found in graph`);
        }
        // Check for circular dependency
        if (op.taskId === op.dependsOn) {
          issues.push(`Reorder: task "${op.taskId}" cannot depend on itself`);
        }
        if (wouldCreateCycle(op.taskId, op.dependsOn, graph)) {
          issues.push(`Reorder: adding "${op.taskId}" → "${op.dependsOn}" creates a cycle`);
        }
        break;
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ─── Apply Surgery ──────────────────────────────────────────────

/**
 * Apply a set of surgery operations to a graph.
 *
 * Returns a new graph array (original not mutated).
 * The completedTaskIds Set IS mutated by rework operations
 * (removes the task from completed so it can re-execute).
 */
export function applySurgery(
  proposalId: string,
  ops: GraphSurgeryOp[],
  graph: TaskGraphNode[],
  completedTaskIds: Set<string>,
): SurgeryResult {
  // Work on a shallow copy — nodes themselves are cloned only when modified
  let working = [...graph];
  let applied = 0;
  let failed = 0;
  const reopened: string[] = [];
  const inserted: string[] = [];
  const amended: string[] = [];

  for (const op of ops) {
    try {
      switch (op.op) {
        case "insert":
          working.push(op.node);
          inserted.push(op.node.task.id);
          applied++;

          emit("surgery:insert", {
            proposalId,
            taskId: op.node.task.id,
            description: op.node.task.description,
            dependsOn: op.node.dependsOn,
            phaseGroup: op.node.phaseGroup,
          });
          log.info("Task inserted", { taskId: op.node.task.id });
          break;

        case "amend": {
          const idx = working.findIndex((n) => n.task.id === op.taskId);
          if (idx === -1) {
            log.warn("Amend target not found", { taskId: op.taskId });
            failed++;
            continue;
          }

          // Clone the node to avoid mutating the original
          const node = working[idx];
          const amendedTask = {
            ...node.task,
            description: op.description,
            context: {
              ...node.task.context,
              ...op.additionalContext,
            },
          };
          working[idx] = { ...node, task: amendedTask };
          amended.push(op.taskId);
          applied++;

          emit("surgery:amend", {
            proposalId,
            taskId: op.taskId,
            newDescription: op.description,
          });
          log.info("Task amended", { taskId: op.taskId });
          break;
        }

        case "rework": {
          const taskId = op.directive.taskId;
          if (!completedTaskIds.has(taskId)) {
            log.warn("Rework target not completed", { taskId });
            failed++;
            continue;
          }

          // Remove from completed set (mutates the accumulator's live state)
          completedTaskIds.delete(taskId);

          // Clone the node and attach the rework directive
          const reworkIdx = working.findIndex((n) => n.task.id === taskId);
          if (reworkIdx === -1) {
            log.warn("Rework target not in graph", { taskId });
            failed++;
            continue;
          }

          const reworkNode = working[reworkIdx];
          const reworkedTask = {
            ...reworkNode.task,
            description: op.directive.amendedDescription,
            context: {
              ...reworkNode.task.context,
              ...op.directive.additionalContext,
              reworkDirective: {
                reason: op.directive.reason,
                downstreamDependents: op.directive.downstreamDependents,
              },
            },
            status: "pending" as const,
          };
          working[reworkIdx] = { ...reworkNode, task: reworkedTask };
          reopened.push(taskId);
          applied++;

          emit("surgery:rework", {
            proposalId,
            taskId,
            reason: op.directive.reason,
            downstreamDependents: op.directive.downstreamDependents,
          });
          log.info("Task reopened for rework", { taskId, reason: op.directive.reason });
          break;
        }

        case "reorder": {
          const reorderIdx = working.findIndex((n) => n.task.id === op.taskId);
          if (reorderIdx === -1) {
            log.warn("Reorder target not found", { taskId: op.taskId });
            failed++;
            continue;
          }

          const reorderNode = working[reorderIdx];
          // Only add, never remove dependencies
          if (!reorderNode.dependsOn.includes(op.dependsOn)) {
            working[reorderIdx] = {
              ...reorderNode,
              dependsOn: [...reorderNode.dependsOn, op.dependsOn],
            };
          }
          applied++;

          emit("surgery:reorder", {
            proposalId,
            taskId: op.taskId,
            newDependency: op.dependsOn,
          });
          log.info("Dependency added", { taskId: op.taskId, dependsOn: op.dependsOn });
          break;
        }
      }
    } catch (err) {
      log.warn("Surgery operation failed", { op: op.op, error: String(err) });
      failed++;
    }
  }

  emit("surgery:complete", {
    proposalId,
    applied,
    failed,
    inserted: inserted.length,
    reopened: reopened.length,
    amended: amended.length,
  });

  return {
    proposalId,
    operationsApplied: applied,
    operationsFailed: failed,
    graph: working,
    reopenedTaskIds: reopened,
    insertedTaskIds: inserted,
    amendedTaskIds: amended,
  };
}

// ─── Cycle Detection ────────────────────────────────────────────

/**
 * Check if adding an edge from `from` → `to` (meaning `from` depends on `to`)
 * would create a cycle. A cycle exists if `from` is reachable from `to`
 * via the existing dependency edges.
 */
function wouldCreateCycle(
  from: string,
  to: string,
  graph: TaskGraphNode[],
): boolean {
  // Build adjacency: task → tasks it depends on
  const deps = new Map<string, string[]>();
  for (const node of graph) {
    deps.set(node.task.id, [...node.dependsOn]);
  }

  // Add the proposed edge
  const fromDeps = deps.get(from) ?? [];
  fromDeps.push(to);
  deps.set(from, fromDeps);

  // BFS from `to` following dependency edges — if we reach `from`, there's a cycle
  // (because `from` depends on `to`, and `to` transitively depends on `from`)
  // Actually we need: does `to` depend (transitively) on `from`?
  // If `to` → ... → `from` exists, then adding `from` → `to` creates a cycle.
  const visited = new Set<string>();
  const queue = [to];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const currentDeps = deps.get(current) ?? [];
    for (const dep of currentDeps) {
      if (!visited.has(dep)) {
        queue.push(dep);
      }
    }
  }

  return false;
}
