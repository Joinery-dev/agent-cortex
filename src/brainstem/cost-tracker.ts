/**
 * Cost Tracker — the project-level cost ledger.
 *
 * A brainstem-level service: monitors + accumulates, doesn't deliberate.
 * Sits alongside HomeostasisMonitor as a vital-sign producer. Created by
 * the Brainstem constructor, registered as a callback on the LLM client.
 *
 * Tracks dollar cost of every LLM call, accumulates per-task and
 * per-project totals, and emits events for observability. Feeds the
 * budgetUtilization vital sign to HomeostasisMonitor.
 *
 * The budget is the metabolic constraint — like the brain's metabolic
 * budget forcing efficient neural representations, it forces Cortex
 * to prioritize cognitive spending.
 */

import type {
  CostBudget,
  CostRecord,
  TaskCostSummary,
  ProjectCostSummary,
} from "../types/cost.js";
import { computeCallCost } from "../types/cost.js";
import type { Purpose } from "../llm/client.js";
import { createLogger } from "../util/logger.js";
import { emit, emitInfo, emitWarn, emitError } from "../events.js";

const log = createLogger("cost-tracker");

export class CostTracker {
  private budget: CostBudget;
  private projectSpent = 0;
  private planningCost = 0;
  private totalCalls = 0;
  private currentTaskId: string | null = null;
  private taskAllocations = new Map<string, number>();
  private taskSpent = new Map<string, number>();
  private taskCalls = new Map<string, number>();
  private taskByPurpose = new Map<string, Partial<Record<Purpose, number>>>();
  private taskModelsByPurpose = new Map<string, Partial<Record<Purpose, string>>>();
  private ledger: CostRecord[] = [];

  /** Milestone tracking — emit once per threshold per task. */
  private taskMilestones = new Map<string, Set<number>>();

  /** Project-level milestone tracking. */
  private projectMilestones = new Set<number>();

  constructor(budget: CostBudget) {
    this.budget = budget;
    log.info("CostTracker initialized", {
      total: budget.total,
      enforcement: budget.enforcement,
      reserveFraction: budget.reserveFraction,
    });
  }

  // ── Task scoping ──────────────────────────────────────────────

  /** Set the current task context. Subsequent calls are attributed here. */
  setCurrentTask(taskId: string | null): void {
    this.currentTaskId = taskId;
  }

  /** Get the current task ID (for callers that need to check). */
  getCurrentTask(): string | null {
    return this.currentTaskId;
  }

  // ── Budget allocation ─────────────────────────────────────────

  /** Allocate a budget amount to a specific task. */
  allocateTaskBudget(taskId: string, amount: number): void {
    this.taskAllocations.set(taskId, amount);

    emit("cost:budget-allocated", {
      taskId,
      amount,
      totalAllocated: this.getTotalAllocated(),
      allocableTotal: this.getAllocableBudget(),
    });

    log.info("Task budget allocated", { taskId, amount: amount.toFixed(4) });
  }

  /** Get a task's budget status. */
  getTaskBudget(taskId: string): TaskCostSummary {
    const allocated = this.taskAllocations.get(taskId) ?? 0;
    const spent = this.taskSpent.get(taskId) ?? 0;
    return {
      taskId,
      allocated,
      spent,
      remaining: Math.max(0, allocated - spent),
      callCount: this.taskCalls.get(taskId) ?? 0,
      byPurpose: this.taskByPurpose.get(taskId) ?? {},
    };
  }

  /** Reallocate unspent budget from a completed task back to the pool. */
  returnUnspent(taskId: string): number {
    const allocated = this.taskAllocations.get(taskId) ?? 0;
    const spent = this.taskSpent.get(taskId) ?? 0;
    const unspent = Math.max(0, allocated - spent);

    if (unspent > 0) {
      log.info("Returning unspent budget", {
        taskId,
        unspent: unspent.toFixed(4),
      });
    }

    return unspent;
  }

  // ── Recording ─────────────────────────────────────────────────

  /**
   * Record an LLM call's cost. Called by the LLM client callback.
   * This is the hot path — every LLM call flows through here.
   */
  recordCall(record: CostRecord): void {
    this.ledger.push(record);
    this.projectSpent += record.cost;
    this.totalCalls++;

    const taskId = record.taskId ?? this.currentTaskId;

    if (taskId) {
      const prev = this.taskSpent.get(taskId) ?? 0;
      this.taskSpent.set(taskId, prev + record.cost);
      this.taskCalls.set(taskId, (this.taskCalls.get(taskId) ?? 0) + 1);

      // Update per-purpose breakdown
      const byPurpose = this.taskByPurpose.get(taskId) ?? {};
      byPurpose[record.purpose] = (byPurpose[record.purpose] ?? 0) + record.cost;
      this.taskByPurpose.set(taskId, byPurpose);

      // Track which model was used for each purpose (for Cerebellum learning)
      const models = this.taskModelsByPurpose.get(taskId) ?? {};
      models[record.purpose] = record.model;
      this.taskModelsByPurpose.set(taskId, models);
    } else {
      // No task context — attribute to planning cost
      this.planningCost += record.cost;
    }

    emit("cost:call-recorded", {
      purpose: record.purpose,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cost: record.cost,
      taskId,
      projectSpent: this.projectSpent,
      projectUtilization: this.getUtilization(),
    });

    // Check milestones
    if (taskId) {
      this.checkTaskMilestones(taskId);
    }
    this.checkProjectMilestones();
  }

  /**
   * Record a cost that happened outside the normal call() path.
   * For planning phase costs or external tool costs.
   */
  recordExternalCost(amount: number, description: string): void {
    this.projectSpent += amount;
    this.planningCost += amount;

    emitInfo("cost:external-recorded", {
      amount,
      description,
      projectSpent: this.projectSpent,
    });
  }

  // ── Queries ───────────────────────────────────────────────────

  /** Project-level budget utilization (0–1). */
  getUtilization(): number {
    if (this.budget.total <= 0) return 0;
    return Math.min(1, this.projectSpent / this.budget.total);
  }

  /** Task-level budget utilization (0–1). */
  getTaskUtilization(taskId: string): number {
    const allocated = this.taskAllocations.get(taskId) ?? 0;
    if (allocated <= 0) return 0;
    const spent = this.taskSpent.get(taskId) ?? 0;
    return Math.min(1, spent / allocated);
  }

  /** Which model tier was used for each purpose during this task. */
  getTaskModelsByPurpose(taskId: string): Partial<Record<Purpose, string>> {
    return this.taskModelsByPurpose.get(taskId) ?? {};
  }

  /** Budget pressure: utilization^2 (quadratic — gentle at 50%, sharp at 80%+). */
  getBudgetPressure(): number {
    const u = this.getUtilization();
    return u * u;
  }

  /** Is the project budget exhausted? */
  isExhausted(): boolean {
    if (this.budget.enforcement === "hard") {
      return this.projectSpent >= this.budget.total;
    }
    // Soft enforcement: exhausted when we've consumed total - reserve
    return this.projectSpent >= this.getAllocableBudget();
  }

  /** How much budget is allocable (total minus reserve). */
  getAllocableBudget(): number {
    return this.budget.total * (1 - this.budget.reserveFraction);
  }

  /** How much of the allocable budget has been allocated to tasks. */
  private getTotalAllocated(): number {
    let total = 0;
    for (const amount of this.taskAllocations.values()) {
      total += amount;
    }
    return total;
  }

  /** Remaining project budget. */
  getRemaining(): number {
    return Math.max(0, this.budget.total - this.projectSpent);
  }

  /** Total project spend so far. */
  getSpent(): number {
    return this.projectSpent;
  }

  /** Get the budget configuration. */
  getBudget(): CostBudget {
    return { ...this.budget };
  }

  /** Full project cost summary. */
  getProjectSummary(): ProjectCostSummary {
    const taskSummaries = new Map<string, TaskCostSummary>();
    for (const taskId of new Set([
      ...this.taskAllocations.keys(),
      ...this.taskSpent.keys(),
    ])) {
      taskSummaries.set(taskId, this.getTaskBudget(taskId));
    }

    return {
      budget: { ...this.budget },
      spent: this.projectSpent,
      remaining: this.getRemaining(),
      utilization: this.getUtilization(),
      reserveRemaining: Math.max(
        0,
        this.budget.total * this.budget.reserveFraction -
          Math.max(0, this.projectSpent - this.getAllocableBudget()),
      ),
      planningCost: this.planningCost,
      taskSummaries,
      totalCalls: this.totalCalls,
    };
  }

  /**
   * Estimate the cost of a call before making it.
   * Used by the gate to assess whether another cycle is affordable.
   */
  estimateCallCost(
    model: string,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
  ): number {
    return computeCallCost(model, estimatedInputTokens, estimatedOutputTokens);
  }

  // ── Milestone checks ──────────────────────────────────────────

  private checkTaskMilestones(taskId: string): void {
    const allocated = this.taskAllocations.get(taskId);
    if (!allocated || allocated <= 0) return;

    const utilization = this.getTaskUtilization(taskId);
    const milestones = this.taskMilestones.get(taskId) ?? new Set();

    for (const threshold of [0.5, 0.75, 0.9]) {
      if (utilization >= threshold && !milestones.has(threshold)) {
        milestones.add(threshold);
        emitInfo("cost:task-milestone", {
          taskId,
          utilization,
          milestone: threshold * 100,
          spent: this.taskSpent.get(taskId) ?? 0,
          allocated,
        });
      }
    }

    this.taskMilestones.set(taskId, milestones);
  }

  private checkProjectMilestones(): void {
    const utilization = this.getUtilization();

    if (utilization >= 0.8 && !this.projectMilestones.has(0.8)) {
      this.projectMilestones.add(0.8);
      emitWarn("cost:budget-warning", {
        utilization,
        remaining: this.getRemaining(),
        threshold: 0.8,
      }, {
        component: "cost-tracker",
        snapshot: { spent: this.projectSpent, budget: this.budget.total },
      });
    }

    if (utilization >= 1.0 && !this.projectMilestones.has(1.0)) {
      this.projectMilestones.add(1.0);
      emitError("cost:budget-exhausted", {
        spent: this.projectSpent,
        budget: this.budget.total,
        enforcement: this.budget.enforcement,
      }, {
        component: "cost-tracker",
        snapshot: { totalCalls: this.totalCalls },
      });
    }
  }
}
