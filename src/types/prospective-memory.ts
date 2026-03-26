/**
 * Prospective Memory — "remembering to remember."
 *
 * Future intentions attached to trigger conditions. The system holds
 * an intention ("enforce perf budget on image-heavy tasks") and fires
 * it when matching context arrives. Project-scoped, in-memory only.
 *
 * Sources: human directives, planner annotations, conviction loop,
 * hippocampus learning. Cross-project intent is carried by hippocampus
 * principles, not by PM triggers.
 *
 * Matching is hybrid:
 *   - Structural fast-path: matchAll, matchTaskIds (no LLM)
 *   - Semantic match: LLM evaluates trigger.condition.description
 *     against the task context (single call for all pending triggers)
 */

// ─── Trigger ─────────────────────────────────────────────────────

/** A future intention with a trigger condition. */
export interface ProspectiveTrigger {
  /** Unique identifier. */
  id: string;
  /** When this should fire. */
  condition: TriggerCondition;
  /** What to do when it fires. */
  action: TriggerAction;
  /**
   * How often this trigger fires.
   *   "once"      — fire once, then mark as fired/resolved
   *   "per-match"  — fire on every matching task, stay pending
   *
   * matchAll + "per-match" = fires on every task (blanket directive).
   */
  persistence: "once" | "per-match";
  /** Who created this trigger. */
  source: string;
  /** When this trigger was registered. */
  createdAt: Date;
  /** Current lifecycle state. */
  status: "pending" | "fired" | "resolved" | "expired";
  /** Task IDs where this trigger has fired. */
  firedOn: string[];
}

// ─── Condition ───────────────────────────────────────────────────

/**
 * When should this trigger fire?
 *
 * Always has a natural-language description (LLM-evaluated).
 * Optionally has structural fast-paths that skip the LLM call.
 */
export interface TriggerCondition {
  /** Natural language description. LLM evaluates match against task. */
  description: string;
  /** Fast-path: fire when any of these specific tasks arrive. */
  matchTaskIds?: string[];
  /** Fast-path: fire on every task. */
  matchAll?: boolean;
}

// ─── Action ──────────────────────────────────────────────────────

/**
 * What to do when the trigger fires.
 *
 * `directive` always flows into briefings via the Thalamus.
 * If `question` is present, the system escalates to the human
 * and waits for an answer before proceeding with the task.
 */
export interface TriggerAction {
  /** Context/constraint injected into the task's briefings. */
  directive: string;
  /** If present, escalate to human with this question before the task runs. */
  question?: string;
}

// ─── Fired Trigger ───────────────────────────────────────────────

/** A trigger that matched the current task context. */
export interface FiredTrigger {
  /** The trigger that fired. */
  trigger: ProspectiveTrigger;
  /** How confident the match is (1.0 for structural, 0-1 for LLM). */
  confidence: number;
  /** Why it matched. */
  reason: string;
  /** Which task it fired on. */
  taskId: string;
}

// ─── Config ──────────────────────────────────────────────────────

export interface ProspectiveMemoryConfig {
  /** Minimum LLM confidence to consider a trigger matched. */
  confidenceThreshold: number;
}

export const DEFAULT_PROSPECTIVE_MEMORY_CONFIG: ProspectiveMemoryConfig = {
  confidenceThreshold: 0.6,
};

// ─── State (dashboard/debugging) ─────────────────────────────────

export interface ProspectiveMemoryState {
  pendingCount: number;
  firedCount: number;
  resolvedCount: number;
  expiredCount: number;
  triggers: ProspectiveTrigger[];
}
