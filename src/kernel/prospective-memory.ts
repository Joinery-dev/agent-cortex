/**
 * Prospective Memory — "remembering to remember."
 *
 * Holds future intentions with trigger conditions. When a task is
 * about to be dispatched, PM checks pending triggers against the
 * task context. Matching triggers produce directives (flow into
 * briefings) and/or questions (escalate to Parsifal).
 *
 * Hybrid matching:
 *   - Structural fast-path: matchAll, matchTaskIds (no LLM)
 *   - Semantic match: single LLM call for all pending triggers
 *
 * Project-scoped, in-memory only. Cross-project intent is carried
 * by hippocampus principles, not PM triggers.
 */

import { z } from "zod";
import type {
  ProspectiveTrigger,
  TriggerCondition,
  TriggerAction,
  FiredTrigger,
  ProspectiveMemoryConfig,
  ProspectiveMemoryState,
} from "../types/prospective-memory.js";
import { DEFAULT_PROSPECTIVE_MEMORY_CONFIG } from "../types/prospective-memory.js";
import type { Task } from "../types/task.js";
import type { ProjectIntent } from "../types/intent.js";
import { callStructured } from "../llm/structured.js";
import {
  prospectiveMatchingSystem,
  prospectiveMatchingUser,
} from "../llm/prompts.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("prospective-memory");

// ─── Zod schema for LLM response ───────────────────────────────

const TriggerMatchSchema = z.object({
  matches: z.array(z.object({
    triggerId: z.string(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })),
});

type TriggerMatchResponse = z.infer<typeof TriggerMatchSchema>;

// ─── ProspectiveMemory ──────────────────────────────────────────

export class ProspectiveMemory {
  private triggers = new Map<string, ProspectiveTrigger>();
  private config: ProspectiveMemoryConfig;

  constructor(config?: Partial<ProspectiveMemoryConfig>) {
    this.config = { ...DEFAULT_PROSPECTIVE_MEMORY_CONFIG, ...config };
  }

  // ── Registration ────────────────────────────────────────────

  /**
   * Register a new trigger. Returns the generated ID.
   */
  register(opts: {
    condition: TriggerCondition;
    action: TriggerAction;
    persistence: "once" | "per-match";
    source: string;
  }): string {
    const id = newId();
    const trigger: ProspectiveTrigger = {
      id,
      condition: opts.condition,
      action: opts.action,
      persistence: opts.persistence,
      source: opts.source,
      createdAt: new Date(),
      status: "pending",
      firedOn: [],
    };

    this.triggers.set(id, trigger);

    emit("prospective-memory:registered", {
      id,
      source: opts.source,
      persistence: opts.persistence,
      hasQuestion: !!opts.action.question,
      matchAll: !!opts.condition.matchAll,
      matchTaskIds: opts.condition.matchTaskIds?.length ?? 0,
    });

    log.info("Trigger registered", {
      id,
      source: opts.source,
      condition: opts.condition.description,
    });

    return id;
  }

  // ── Fast-Path Check (structural only) ───────────────────────

  /**
   * Check pending triggers using structural fast-paths only.
   * No LLM call. Used by assembleSignals() for task scoring.
   *
   * Does NOT update trigger status — that happens in check().
   */
  checkFastPath(taskId: string): FiredTrigger[] {
    const fired: FiredTrigger[] = [];

    for (const trigger of this.triggers.values()) {
      if (!this.isCheckable(trigger, taskId)) continue;

      if (trigger.condition.matchAll) {
        fired.push({
          trigger,
          confidence: 1.0,
          reason: "matchAll: fires on every task",
          taskId,
        });
        continue;
      }

      if (trigger.condition.matchTaskIds?.includes(taskId)) {
        fired.push({
          trigger,
          confidence: 1.0,
          reason: `matchTaskIds: task ${taskId} is in the explicit match list`,
          taskId,
        });
      }
    }

    return fired;
  }

  // ── Full LLM Check ─────────────────────────────────────────

  /**
   * Full trigger evaluation against a task. Includes fast-path
   * matches AND LLM-based semantic matching.
   *
   * Single LLM call evaluates all pending triggers at once.
   * Updates trigger state: firedOn, status for once-triggers.
   */
  async check(
    task: Task,
    intent: ProjectIntent,
    model: string,
  ): Promise<FiredTrigger[]> {
    const allFired: FiredTrigger[] = [];

    // Collect pending triggers
    const pending = [...this.triggers.values()].filter(
      (t) => this.isCheckable(t, task.id),
    );

    if (pending.length === 0) return [];

    // ── Fast-path matches ──────────────────────────────
    const fastPathIds = new Set<string>();
    for (const trigger of pending) {
      if (trigger.condition.matchAll || trigger.condition.matchTaskIds?.includes(task.id)) {
        allFired.push({
          trigger,
          confidence: 1.0,
          reason: trigger.condition.matchAll
            ? "matchAll: fires on every task"
            : `matchTaskIds: task ${task.id} is in the explicit match list`,
          taskId: task.id,
        });
        fastPathIds.add(trigger.id);
      }
    }

    // ── LLM semantic matching ──────────────────────────
    const needsLLM = pending.filter((t) => !fastPathIds.has(t.id));

    if (needsLLM.length > 0) {
      const llmMatches = await this.evaluateWithLLM(
        task,
        intent,
        needsLLM,
        model,
      );
      allFired.push(...llmMatches);
    }

    // ── Update trigger state ───────────────────────────
    for (const fired of allFired) {
      const trigger = this.triggers.get(fired.trigger.id);
      if (!trigger) continue;

      trigger.firedOn.push(task.id);

      if (trigger.persistence === "once") {
        trigger.status = "fired";
      }

      emit("prospective-memory:fired", {
        triggerId: trigger.id,
        taskId: task.id,
        confidence: fired.confidence,
        persistence: trigger.persistence,
        hasQuestion: !!trigger.action.question,
      });

      log.info("Trigger fired", {
        triggerId: trigger.id,
        taskId: task.id,
        confidence: fired.confidence,
        reason: fired.reason,
      });
    }

    emit("prospective-memory:checked", {
      taskId: task.id,
      pendingCount: pending.length,
      firedCount: allFired.length,
      fastPathCount: fastPathIds.size,
      llmCount: allFired.length - fastPathIds.size,
    });

    return allFired;
  }

  // ── Resolution ──────────────────────────────────────────────

  /** Mark a trigger as resolved (e.g., after its task completes). */
  resolve(triggerId: string): void {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return;

    trigger.status = "resolved";

    emit("prospective-memory:resolved", { triggerId });
    log.info("Trigger resolved", { triggerId });
  }

  /** Mark a trigger as expired (e.g., project ending). */
  expire(triggerId: string): void {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return;

    trigger.status = "expired";

    emit("prospective-memory:expired", { triggerId });
    log.info("Trigger expired", { triggerId });
  }

  // ── Accessors ───────────────────────────────────────────────

  getPending(): ProspectiveTrigger[] {
    return [...this.triggers.values()].filter((t) => t.status === "pending");
  }

  getFired(): ProspectiveTrigger[] {
    return [...this.triggers.values()].filter((t) => t.status === "fired");
  }

  getAll(): ProspectiveTrigger[] {
    return [...this.triggers.values()];
  }

  getState(): ProspectiveMemoryState {
    const all = [...this.triggers.values()];
    return {
      pendingCount: all.filter((t) => t.status === "pending").length,
      firedCount: all.filter((t) => t.status === "fired").length,
      resolvedCount: all.filter((t) => t.status === "resolved").length,
      expiredCount: all.filter((t) => t.status === "expired").length,
      triggers: all,
    };
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Whether a trigger should be evaluated for a given task.
   * Filters out non-pending triggers and once-triggers that
   * already fired on this task.
   */
  private isCheckable(trigger: ProspectiveTrigger, taskId: string): boolean {
    if (trigger.status !== "pending") return false;

    // Per-match triggers can fire on the same task only once
    if (trigger.firedOn.includes(taskId)) return false;

    return true;
  }

  /**
   * Evaluate triggers via LLM. Single call for all triggers.
   */
  private async evaluateWithLLM(
    task: Task,
    intent: ProjectIntent,
    triggers: ProspectiveTrigger[],
    model: string,
  ): Promise<FiredTrigger[]> {
    const system = prospectiveMatchingSystem();
    const user = prospectiveMatchingUser(task, intent.summary, triggers);

    let response: TriggerMatchResponse;
    try {
      response = await callStructured<TriggerMatchResponse>(
        "prospective-matching",
        model,
        system,
        user,
        TriggerMatchSchema,
      );
    } catch (err) {
      log.error("PM trigger matching failed", {
        taskId: task.id,
        triggerCount: triggers.length,
        error: String(err),
      });
      // Graceful degradation: no matches on failure
      return [];
    }

    const fired: FiredTrigger[] = [];
    const triggerMap = new Map(triggers.map((t) => [t.id, t]));

    for (const match of response.matches) {
      if (match.confidence < this.config.confidenceThreshold) continue;

      const trigger = triggerMap.get(match.triggerId);
      if (!trigger) {
        log.warn("LLM returned unknown trigger ID", {
          triggerId: match.triggerId,
          taskId: task.id,
        });
        continue;
      }

      fired.push({
        trigger,
        confidence: match.confidence,
        reason: match.reason,
        taskId: task.id,
      });
    }

    log.info("LLM trigger matching complete", {
      taskId: task.id,
      evaluated: triggers.length,
      matched: fired.length,
    });

    return fired;
  }
}
