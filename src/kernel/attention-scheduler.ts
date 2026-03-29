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
 *   7. Budget exhausted → complete
 *   8. Rest needed (and ≥1 task completed) → rest
 *   9. Observation pressure exceeds NE-modulated threshold → observe
 *  10. Ready tasks available → dispatch highest priority
 *  11. No ready tasks, graph not done → escalate (deadlock)
 */

import type {
  SchedulerAction,
  SchedulerSignals,
  SchedulerConfig,
  SchedulerDispatch,
  SchedulerEscalate,
} from "../types/attention-scheduler.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import type { NEWeights, NEResult, RiskFactors } from "../types/norepinephrine.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../types/attention-scheduler.js";
import { computeNE, DEFAULT_NE_WEIGHTS, extractRiskFromSchedulerSignals } from "./norepinephrine.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("attention-scheduler");

export class AttentionScheduler {
  private config: SchedulerConfig;
  private neWeights: NEWeights;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.neWeights = { ...DEFAULT_NE_WEIGHTS, ...config?.neWeights };
  }

  /**
   * The decision function. Called by task-dispatch.prepare() each cycle.
   * Reads all signals, returns exactly one action.
   */
  decide(signals: SchedulerSignals): SchedulerAction {
    // 1. All tasks done?
    if (this.isComplete(signals)) {
      // 1a. Nursery check: any phases awaiting graduation?
      const pendingNursery = this.getNextNurseryPhase(signals);
      if (pendingNursery) {
        this.emitDecision("dispatch-gestate", signals);
        return {
          action: "dispatch-gestate",
          phaseGroup: pendingNursery,
          reason: `Phase "${pendingNursery}" artifacts require runtime stress-testing before completion`,
        };
      }

      this.emitDecision("complete", signals);
      return { action: "complete" };
    }

    // 2–6. Check escalation conditions
    const escalation = this.checkEscalationConditions(signals);
    if (escalation) {
      return escalation;
    }

    // 7. Budget exhausted?
    if (signals.budgetExhausted) {
      // Hard enforcement: stop immediately, deliver what's done
      this.emitDecision("complete", signals);
      emit("scheduler:budget-exhausted", {
        utilization: signals.budgetUtilization,
        completedTasks: signals.completedTaskIds.size,
        remainingTasks: signals.taskGraph.length - signals.completedTaskIds.size - signals.escalatedTaskIds.size,
      });
      return { action: "complete" };
    }

    // 8. Rest needed?
    if (signals.needsRest && signals.completedTaskIds.size > 0) {
      const action: SchedulerAction = {
        action: "rest",
        reason: "Homeostasis indicates consolidation needed before next task",
      };
      this.emitDecision("rest", signals);
      return action;
    }

    // 9. Observation pressure → observe
    if (signals.observationPressure !== undefined && signals.observationPressure > 0) {
      const neLevel = signals.lastNELevel ?? 0.5;
      const observeThreshold = 0.9 - 0.5 * neLevel;
      if (signals.observationPressure >= observeThreshold) {
        this.emitDecision("observe", signals);
        return {
          action: "observe",
          reason: `Observation pressure ${signals.observationPressure.toFixed(2)} ≥ NE-modulated threshold ${observeThreshold.toFixed(2)} (NE=${neLevel.toFixed(2)})`,
          neLevel,
        };
      }
    }

    // 10. Find ready tasks and dispatch
    const readyTasks = this.getReadyTasks(signals);

    if (readyTasks.length > 0) {
      const dispatch = this.selectAndDispatch(readyTasks, signals);
      this.emitDecision("dispatch-task", signals, dispatch.taskId);
      return dispatch;
    }

    // 11. Deadlock — tasks exist but none are ready
    const action: SchedulerEscalate = {
      action: "escalate",
      reason: "No tasks have satisfied dependencies but the graph is not complete. Possible circular dependency or all remaining tasks are blocked.",
      source: "attention-scheduler",
      questions: ["Are there circular dependencies in the task graph?", "Should any blocked tasks be unblocked manually?"],
      escalationType: "deadlock",
    };
    emit("scheduler:escalation", { reason: action.reason, type: "deadlock" });
    this.emitDecision("escalate", signals);
    return action;
  }

  // ─── Private: Nursery check ────────────────────────────────────

  /**
   * Returns the first phase group that needs nursery graduation, or null.
   * A phase needs nursery if it's in pendingPhases but not in graduatedPhases.
   */
  private getNextNurseryPhase(signals: SchedulerSignals): string | null {
    if (!signals.nurseryPendingPhases || signals.nurseryPendingPhases.size === 0) {
      return null;
    }
    const graduated = signals.nurseryGraduatedPhases ?? new Set<string>();
    for (const phase of signals.nurseryPendingPhases) {
      if (!graduated.has(phase)) return phase;
    }
    return null;
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
        escalationType: "perseveration",
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
        escalationType: "drift",
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
        escalationType: "open-questions",
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
          escalationType: "cratering",
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
      const { ne: neResult, riskSnapshot } = this.computeDispatchNE(task, signals);
      const mode = this.determineMode(task, signals);

      emit("scheduler:ne-computed", {
        taskId: task.task.id,
        finalNE: neResult.ne,
        components: neResult.components,
      });

      return {
        action: "dispatch-task",
        taskId: task.task.id,
        neLevel: neResult.ne,
        mode,
        reasoning: "Only ready task",
        taskBudget: signals.taskBudgets?.get(task.task.id)?.allocated,
        riskSnapshot,
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
    const { ne: neResult, riskSnapshot } = this.computeDispatchNE(best.node, signals);
    const mode = this.determineMode(best.node, signals);

    // Emit scoring for all candidates
    for (const { node, score } of scored) {
      emit("scheduler:task-scored", {
        taskId: node.task.id,
        phaseGroupScore: score.phaseGroup,
        dependencyScore: score.dependency,
        trendResponseScore: score.trendResponse,
        prospectiveScore: score.prospective,
        affinityScore: score.affinity,
        totalScore: score.total,
        selected: node === best.node,
      });
    }

    emit("scheduler:ne-computed", {
      taskId: best.node.task.id,
      finalNE: neResult.ne,
      components: neResult.components,
    });

    return {
      action: "dispatch-task",
      taskId: best.node.task.id,
      neLevel: neResult.ne,
      mode,
      reasoning: `Selected from ${readyTasks.length} ready tasks (score: ${best.score.total.toFixed(2)}). Factors: phase-group=${best.score.phaseGroup.toFixed(2)}, deps=${best.score.dependency.toFixed(2)}, trends=${best.score.trendResponse.toFixed(2)}${best.score.prospective > 0 ? `, pm=${best.score.prospective.toFixed(2)}` : ""}${best.score.affinity > 0 ? `, affinity=${best.score.affinity.toFixed(2)}` : ""}`,
      taskBudget: signals.taskBudgets?.get(best.node.task.id)?.allocated,
      riskSnapshot,
    };
  }

  private scoreTask(
    node: TaskGraphNode,
    signals: SchedulerSignals,
  ): { phaseGroup: number; dependency: number; trendResponse: number; prospective: number; affinity: number; total: number } {
    const phaseGroup = this.scorePhaseGroupCoherence(node, signals);
    const dependency = this.scoreDependencyUnblocking(node, signals);
    const trendResponse = this.scoreTrendResponse(node, signals);
    const prospective = this.scoreProspectiveTriggers(node, signals);
    const affinity = this.scoreAffinityCoherence(node, signals);

    // Base weights unchanged. Phase 3 (Plasticity) makes these plastic.
    // PM bonus is additive — nudges priority without rebalancing existing weights.
    // Affinity bonus is small (0.1) — tiebreaker for co-design cluster coherence.
    const base = phaseGroup * 0.3 + dependency * 0.4 + trendResponse * 0.3;
    const total = base + prospective * 0.15 + affinity * 0.1;

    return { phaseGroup, dependency, trendResponse, prospective, affinity, total };
  }

  /**
   * Bonus for tasks with matching Prospective Memory triggers.
   * Fast-path triggers (matchAll, matchTaskIds) are checked in
   * assembleSignals() and populated on SchedulerSignals.
   */
  private scoreProspectiveTriggers(node: TaskGraphNode, signals: SchedulerSignals): number {
    if (!signals.prospectiveTriggers) return 0;
    const triggers = signals.prospectiveTriggers.get(node.task.id);
    if (!triggers || triggers.length === 0) return 0;
    // Any match gives a boost. Multiple triggers give more, capped at 1.0.
    return Math.min(1.0, triggers.length * 0.5);
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
   * Bonus for tasks in the same affinity group as the last completed task.
   * Affinity groups are co-design clusters from the Graph Builder —
   * tasks that share interfaces and should be built with mutual awareness.
   * Falls back to 0 when affinityGroupId is absent (all pre-hierarchical plans).
   */
  private scoreAffinityCoherence(node: TaskGraphNode, signals: SchedulerSignals): number {
    if (!node.affinityGroupId) return 0;

    const completedIds = [...signals.completedTaskIds];
    if (completedIds.length === 0) return 0;

    const lastCompletedId = completedIds[completedIds.length - 1];
    const lastCompletedNode = signals.taskGraph.find((n) => n.task.id === lastCompletedId);

    if (!lastCompletedNode?.affinityGroupId) return 0;

    return node.affinityGroupId === lastCompletedNode.affinityGroupId ? 1.0 : 0;
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
   * Compute dispatch-time NE for a task.
   * Uses the standalone computeNE() with maturity + risk only.
   * Novelty (from Cerebellum prediction) and conviction are not
   * available at dispatch time — they're added later by
   * sensory-cortex and build-cycle respectively.
   */
  private computeDispatchNE(node: TaskGraphNode, signals: SchedulerSignals): { ne: NEResult; riskSnapshot: RiskFactors } {
    // Count tasks that depend on this one (for fan-out risk)
    const done = new Set([...signals.completedTaskIds, ...signals.escalatedTaskIds]);
    const dependsOnThisTask = signals.taskGraph.filter(
      (n) => !done.has(n.task.id) && n.dependsOn.includes(node.task.id),
    ).length;

    const risk = extractRiskFromSchedulerSignals(
      node.task.id,
      node.phaseGroup,
      dependsOnThisTask,
      signals,
      {
        dependencyCount: node.dependsOn.length,
        descriptionLength: node.task.description.length,
        highStakeSenseCount: 0, // Not available at dispatch time — enriched later by sensory-cortex
        totalSenseCount: 0,
      },
    );

    // Budget pressure: utilization^2 (quadratic — gentle at 50%, sharp at 80%+)
    if (signals.budgetUtilization !== undefined) {
      risk.budgetPressure = signals.budgetUtilization * signals.budgetUtilization;
    }

    // Wave 13 activation point: when Amygdala (#17) is wired, pass
    // amygdalaOverride here to short-circuit NE to near-ceiling on urgency.
    const ne = computeNE(
      {
        cerebellumAccuracy: signals.cerebellumAccuracy,
        // bestSimilarity: not available at dispatch time
        // convictionLevel: not available at dispatch time
        risk,
        humanUrgency: signals.humanUrgency,
      },
      this.neWeights,
    );

    // Freeze risk factors — enrichment sites (sensory-cortex, build-cycle)
    // reuse this snapshot instead of re-deriving from potentially shifted sources.
    return { ne, riskSnapshot: { ...risk } };
  }

  // ─── Private: Explore / leverage ─────────────────────────────────

  private determineMode(node: TaskGraphNode, signals: SchedulerSignals): "explore" | "leverage" {
    if (signals.routineMatches) {
      const match = signals.routineMatches.get(node.task.id);
      if (match && match.confidence > 0.7) {
        return "leverage";
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
