/**
 * Attention Scheduler — the PFC's decision function.
 *
 * Stateless. Reads a SchedulerSignals snapshot, returns one SchedulerAction.
 * Called by the task-dispatch rhythm's prepare phase each cycle.
 *
 * Priority cascade (first match wins):
 *   1. All tasks done → complete
 *   2. Perseveration detected → escalate
 *   3. Drift ≥ replan threshold → replan
 *   4. Drift ≥ escalate threshold → escalate
 *   5. Too many open questions → escalate
 *   6. Scores cratering → escalate
 *   7. Rest needed (and ≥1 task completed) → rest
 *   8. Ready tasks available → dispatch highest priority
 *   9. No ready tasks, graph not done → escalate (deadlock)
 */

import type {
  SchedulerAction,
  SchedulerSignals,
  SchedulerConfig,
  SchedulerDispatch,
  SchedulerEscalate,
} from "../types/attention-scheduler.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../types/attention-scheduler.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("attention-scheduler");

export class AttentionScheduler {
  private config: SchedulerConfig;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /**
   * The decision function. Called by task-dispatch.prepare() each cycle.
   * Reads all signals, returns exactly one action.
   */
  decide(signals: SchedulerSignals): SchedulerAction {
    // 1. All tasks done?
    if (this.isComplete(signals)) {
      this.emitDecision("complete", signals);
      return { action: "complete" };
    }

    // 2–6. Check escalation conditions
    const escalation = this.checkEscalationConditions(signals);
    if (escalation) {
      return escalation;
    }

    // 7. Rest needed?
    if (signals.needsRest && signals.completedTaskIds.size > 0) {
      const action: SchedulerAction = {
        action: "rest",
        reason: "Homeostasis indicates consolidation needed before next task",
      };
      this.emitDecision("rest", signals);
      return action;
    }

    // 8. Find ready tasks and dispatch
    const readyTasks = this.getReadyTasks(signals);

    if (readyTasks.length > 0) {
      const dispatch = this.selectAndDispatch(readyTasks, signals);
      this.emitDecision("dispatch-task", signals, dispatch.taskId);
      return dispatch;
    }

    // 9. Deadlock — tasks exist but none are ready
    const action: SchedulerEscalate = {
      action: "escalate",
      reason: "No tasks have satisfied dependencies but the graph is not complete. Possible circular dependency or all remaining tasks are blocked.",
      source: "attention-scheduler",
      questions: ["Are there circular dependencies in the task graph?", "Should any blocked tasks be unblocked manually?"],
    };
    emit("scheduler:escalation", { reason: action.reason, type: "deadlock" });
    this.emitDecision("escalate", signals);
    return action;
  }

  // ─── Private: Completion check ──────────────────────────────────

  private isComplete(signals: SchedulerSignals): boolean {
    const done = new Set([...signals.completedTaskIds, ...signals.escalatedTaskIds]);
    return signals.taskGraph.every((node) => done.has(node.task.id));
  }

  // ─── Private: Escalation conditions (priority 2–6) ─────────────

  private checkEscalationConditions(signals: SchedulerSignals): SchedulerAction | null {
    // 2. Perseveration
    if (signals.perseverating) {
      const action: SchedulerEscalate = {
        action: "escalate",
        reason: "Cognitive Flexibility detected perseveration — same approach failing repeatedly. Strategy reset needed.",
        source: "attention-scheduler",
        questions: ["Should we try a fundamentally different approach?"],
      };
      emit("scheduler:escalation", { reason: action.reason, type: "perseveration" });
      this.emitDecision("escalate", signals);
      return action;
    }

    // 3. Drift → replan
    if (signals.driftLevel !== undefined && signals.driftLevel >= this.config.driftReplanThreshold) {
      const action: SchedulerAction = {
        action: "replan",
        reason: `Drift level ${signals.driftLevel.toFixed(2)} exceeds replan threshold ${this.config.driftReplanThreshold}. Project trajectory has diverged significantly from original intent.`,
        driftSummary: signals.driftSummary ?? "Drift details unavailable",
      };
      emit("scheduler:escalation", { reason: action.reason, type: "replan", driftLevel: signals.driftLevel });
      this.emitDecision("replan", signals);
      return action;
    }

    // 4. Drift → escalate
    if (signals.driftLevel !== undefined && signals.driftLevel >= this.config.driftEscalateThreshold) {
      const action: SchedulerEscalate = {
        action: "escalate",
        reason: `Drift level ${signals.driftLevel.toFixed(2)} exceeds escalation threshold. Project may be diverging from intent.`,
        source: "attention-scheduler",
        questions: ["Is the current trajectory acceptable?", "Should we adjust the plan?"],
      };
      emit("scheduler:escalation", { reason: action.reason, type: "drift", driftLevel: signals.driftLevel });
      this.emitDecision("escalate", signals);
      return action;
    }

    // 5. Too many open questions
    const openQuestions = signals.wmSnapshot.openQuestions;
    if (openQuestions.length >= this.config.maxOpenQuestions) {
      const action: SchedulerEscalate = {
        action: "escalate",
        reason: `${openQuestions.length} unresolved questions — too much accumulated uncertainty to continue.`,
        source: "attention-scheduler",
        questions: openQuestions.map((q) => q.question),
      };
      emit("scheduler:escalation", { reason: action.reason, type: "open-questions", count: openQuestions.length });
      this.emitDecision("escalate", signals);
      return action;
    }

    // 6. Scores cratering
    const senseTrends = signals.wmSnapshot.senseTrends;
    if (senseTrends.length > 0) {
      const downCount = senseTrends.filter((t) => t.direction === "down").length;
      const downFraction = downCount / senseTrends.length;

      if (downFraction >= this.config.crateringThreshold) {
        const downNames = senseTrends
          .filter((t) => t.direction === "down")
          .map((t) => t.label);
        const action: SchedulerEscalate = {
          action: "escalate",
          reason: `Scores cratering: ${downCount}/${senseTrends.length} sense trends are declining (${downNames.join(", ")}). Quality trajectory is unsustainable.`,
          source: "attention-scheduler",
          questions: ["What's causing the quality decline?", "Should we pause and investigate?"],
        };
        emit("scheduler:escalation", { reason: action.reason, type: "cratering", downFraction, downNames });
        this.emitDecision("escalate", signals);
        return action;
      }
    }

    return null;
  }

  // ─── Private: Task selection ────────────────────────────────────

  private getReadyTasks(signals: SchedulerSignals): TaskGraphNode[] {
    const done = new Set([...signals.completedTaskIds, ...signals.escalatedTaskIds]);
    return signals.taskGraph.filter(
      (node) => !done.has(node.task.id) && node.dependsOn.every((dep) => done.has(dep)),
    );
  }

  private selectAndDispatch(readyTasks: TaskGraphNode[], signals: SchedulerSignals): SchedulerDispatch {
    if (readyTasks.length === 1) {
      const task = readyTasks[0];
      const neLevel = this.computeNE(task, signals);
      const mode = this.determineMode(task, signals);

      emit("scheduler:ne-computed", {
        taskId: task.task.id,
        baselineNE: this.config.baselineNE,
        finalNE: neLevel,
      });

      return {
        action: "dispatch-task",
        taskId: task.task.id,
        neLevel,
        mode,
        reasoning: "Only ready task",
      };
    }

    // Score each ready task
    const scored = readyTasks.map((node) => ({
      node,
      score: this.scoreTask(node, signals),
    }));

    // Sort descending by score (stable sort preserves graph order as tie-break)
    scored.sort((a, b) => b.score.total - a.score.total);

    const best = scored[0];
    const neLevel = this.computeNE(best.node, signals);
    const mode = this.determineMode(best.node, signals);

    // Emit scoring for all candidates
    for (const { node, score } of scored) {
      emit("scheduler:task-scored", {
        taskId: node.task.id,
        phaseGroupScore: score.phaseGroup,
        dependencyScore: score.dependency,
        trendResponseScore: score.trendResponse,
        totalScore: score.total,
        selected: node === best.node,
      });
    }

    emit("scheduler:ne-computed", {
      taskId: best.node.task.id,
      baselineNE: this.config.baselineNE,
      finalNE: neLevel,
    });

    return {
      action: "dispatch-task",
      taskId: best.node.task.id,
      neLevel,
      mode,
      reasoning: `Selected from ${readyTasks.length} ready tasks (score: ${best.score.total.toFixed(2)}). Factors: phase-group=${best.score.phaseGroup.toFixed(2)}, deps=${best.score.dependency.toFixed(2)}, trends=${best.score.trendResponse.toFixed(2)}`,
    };
  }

  private scoreTask(
    node: TaskGraphNode,
    signals: SchedulerSignals,
  ): { phaseGroup: number; dependency: number; trendResponse: number; total: number } {
    const phaseGroup = this.scorePhaseGroupCoherence(node, signals);
    const dependency = this.scoreDependencyUnblocking(node, signals);
    const trendResponse = this.scoreTrendResponse(node, signals);

    // Equal weights for now. Phase 3 (Plasticity) makes these plastic.
    const total = phaseGroup * 0.3 + dependency * 0.4 + trendResponse * 0.3;

    return { phaseGroup, dependency, trendResponse, total };
  }

  /**
   * Bonus for tasks in the same phase group as the last completed task.
   * Batching related work reduces context switching.
   */
  private scorePhaseGroupCoherence(node: TaskGraphNode, signals: SchedulerSignals): number {
    if (!node.phaseGroup) return 0;

    // Find the last completed task's phase group
    const completedIds = [...signals.completedTaskIds];
    if (completedIds.length === 0) return 0;

    const lastCompletedId = completedIds[completedIds.length - 1];
    const lastCompletedNode = signals.taskGraph.find((n) => n.task.id === lastCompletedId);

    if (!lastCompletedNode?.phaseGroup) return 0;

    return node.phaseGroup === lastCompletedNode.phaseGroup ? 1.0 : 0;
  }

  /**
   * Tasks that unblock more downstream tasks get priority (critical path).
   * Normalized to 0–1 by dividing by the max dependents count among ready tasks.
   */
  private scoreDependencyUnblocking(node: TaskGraphNode, signals: SchedulerSignals): number {
    const done = new Set([...signals.completedTaskIds, ...signals.escalatedTaskIds]);

    // Count how many not-done tasks depend on this one
    const dependents = signals.taskGraph.filter(
      (other) => !done.has(other.task.id) && other.dependsOn.includes(node.task.id),
    ).length;

    if (dependents === 0) return 0;

    // Normalize against the max dependents among all graph tasks
    const maxDependents = Math.max(
      ...signals.taskGraph.map((n) =>
        signals.taskGraph.filter(
          (other) => !done.has(other.task.id) && other.dependsOn.includes(n.task.id),
        ).length,
      ),
    );

    return maxDependents > 0 ? dependents / maxDependents : 0;
  }

  /**
   * Bonus for tasks that might address declining sense trends.
   * Simple heuristic: if any sense trend is "down", all tasks get
   * a boost proportional to how many senses are declining. This is
   * a blunt signal — future versions could match task descriptions
   * to specific senses.
   */
  private scoreTrendResponse(_node: TaskGraphNode, signals: SchedulerSignals): number {
    const senseTrends = signals.wmSnapshot.senseTrends;
    if (senseTrends.length === 0) return 0;

    const downCount = senseTrends.filter((t) => t.direction === "down").length;
    // Returns 0–1: higher when more trends are declining (urgency to address)
    return downCount / senseTrends.length;
  }

  // ─── Private: NE computation ────────────────────────────────────

  /**
   * Compute norepinephrine level for a task. Starts at baseline,
   * boosted by risk factors, capped at 1.0.
   */
  private computeNE(node: TaskGraphNode, signals: SchedulerSignals): number {
    let ne = this.config.baselineNE;
    const boost = this.config.neBoostPerRisk;

    // New phase group (context switch = higher risk)
    if (node.phaseGroup) {
      const completedIds = [...signals.completedTaskIds];
      if (completedIds.length > 0) {
        const lastId = completedIds[completedIds.length - 1];
        const lastNode = signals.taskGraph.find((n) => n.task.id === lastId);
        if (lastNode?.phaseGroup && lastNode.phaseGroup !== node.phaseGroup) {
          ne += boost;
        }
      }
    }

    // Sense trends declining
    const downCount = signals.wmSnapshot.senseTrends.filter((t) => t.direction === "down").length;
    if (downCount > 0) {
      ne += boost;
    }

    // High WM load
    if (signals.wmSnapshot.load > 0.6) {
      ne += boost;
    }

    // Low prediction accuracy
    if (signals.vitals.predictionAccuracy < 0.5) {
      ne += boost;
    }

    // High weight volatility
    if (signals.vitals.weightVolatility > 0.5) {
      ne += boost;
    }

    return Math.min(1.0, ne);
  }

  // ─── Private: Explore / exploit ─────────────────────────────────

  private determineMode(node: TaskGraphNode, signals: SchedulerSignals): "explore" | "exploit" {
    if (signals.routineMatches) {
      const match = signals.routineMatches.get(node.task.id);
      if (match && match.confidence > 0.7) {
        return "exploit";
      }
    }

    // Default to explore until Basal Ganglia exists
    return "explore";
  }

  // ─── Private: Event emission ────────────────────────────────────

  private emitDecision(action: string, signals: SchedulerSignals, taskId?: string): void {
    const readyCount = this.getReadyTasks(signals).length;
    emit("scheduler:decide", {
      action,
      taskId: taskId ?? null,
      readyTaskCount: readyCount,
      completedCount: signals.completedTaskIds.size,
      escalatedCount: signals.escalatedTaskIds.size,
      totalTasks: signals.taskGraph.length,
      wmLoad: signals.wmSnapshot.load,
    });
  }
}
