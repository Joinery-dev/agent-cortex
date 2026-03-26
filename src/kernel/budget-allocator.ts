/**
 * Budget Allocator — distributes project budget across tasks.
 *
 * Pure function: given a task graph, a budget, and optional complexity
 * predictions from the Cerebellum, produces a per-task budget allocation.
 *
 * Allocation factors:
 *   - Base: allocable budget / task count (equal share)
 *   - Complexity: Cerebellum's predicted cycle count (more cycles = more budget)
 *   - Phase gate proximity: tasks near integration checks get a boost
 *
 * Allocations are normalized so they sum to the allocable budget
 * (total minus reserve fraction).
 *
 * Dynamic reallocation: after a task completes, call reallocate()
 * to redistribute unspent budget across remaining tasks.
 */

import type { TaskGraphNode } from "../types/brainstem.js";
import type { CostBudget } from "../types/cost.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("budget-allocator");

export interface AllocationFactors {
  /** Predicted cycle count per task. From Cerebellum. Absent = use default. */
  predictedCycles?: Map<string, number>;
  /** Default cycle count when Cerebellum has no prediction. */
  defaultCycles?: number;
}

/**
 * Distribute the project's allocable budget across tasks.
 * Returns a map of taskId → allocated dollars.
 */
export function allocateBudget(
  graph: TaskGraphNode[],
  budget: CostBudget,
  factors?: AllocationFactors,
): Map<string, number> {
  const allocable = budget.total * (1 - budget.reserveFraction);
  const taskCount = graph.length;

  if (taskCount === 0) return new Map();

  const defaultCycles = factors?.defaultCycles ?? 2;
  const predictedCycles = factors?.predictedCycles ?? new Map<string, number>();

  // Compute raw weight per task
  const weights = new Map<string, number>();
  let totalWeight = 0;

  // Identify phase groups for proximity boosting
  const phaseGroups = new Map<string, string[]>();
  for (const node of graph) {
    if (node.phaseGroup) {
      const group = phaseGroups.get(node.phaseGroup) ?? [];
      group.push(node.task.id);
      phaseGroups.set(node.phaseGroup, group);
    }
  }

  for (const node of graph) {
    const taskId = node.task.id;

    // Complexity factor: predicted cycles / default cycles
    const cycles = predictedCycles.get(taskId) ?? defaultCycles;
    const complexityFactor = cycles / defaultCycles;

    // Phase gate factor: tasks in small phase groups (near gate) get a boost
    let phaseGateFactor = 1.0;
    if (node.phaseGroup) {
      const groupSize = phaseGroups.get(node.phaseGroup)?.length ?? 1;
      // Smaller groups = closer to gate = higher factor
      if (groupSize <= 2) phaseGateFactor = 1.2;
    }

    const weight = complexityFactor * phaseGateFactor;
    weights.set(taskId, weight);
    totalWeight += weight;
  }

  // Normalize so allocations sum to allocable budget
  const allocations = new Map<string, number>();
  for (const [taskId, weight] of weights) {
    const allocation = (weight / totalWeight) * allocable;
    allocations.set(taskId, allocation);
  }

  log.info("Budget allocated", {
    taskCount,
    allocable: allocable.toFixed(2),
    reserve: (budget.total * budget.reserveFraction).toFixed(2),
  });

  return allocations;
}

/**
 * Reallocate remaining budget across incomplete tasks.
 * Called after each task completes — unspent budget from completed
 * tasks flows back into the pool for remaining tasks.
 */
export function reallocateBudget(
  remainingTaskIds: string[],
  availableBudget: number,
  factors?: AllocationFactors,
): Map<string, number> {
  if (remainingTaskIds.length === 0) return new Map();

  const defaultCycles = factors?.defaultCycles ?? 2;
  const predictedCycles = factors?.predictedCycles ?? new Map<string, number>();

  // Simple proportional allocation by predicted complexity
  let totalWeight = 0;
  const weights = new Map<string, number>();

  for (const taskId of remainingTaskIds) {
    const cycles = predictedCycles.get(taskId) ?? defaultCycles;
    const weight = cycles / defaultCycles;
    weights.set(taskId, weight);
    totalWeight += weight;
  }

  const allocations = new Map<string, number>();
  for (const [taskId, weight] of weights) {
    allocations.set(taskId, (weight / totalWeight) * availableBudget);
  }

  log.info("Budget reallocated", {
    remainingTasks: remainingTaskIds.length,
    available: availableBudget.toFixed(2),
  });

  return allocations;
}
