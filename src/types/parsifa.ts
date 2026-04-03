/**
 * ParsifaInterface — the contract between a Cortex and whatever entity directs it.
 *
 * The Parsifal is a role, not a species. A human, a parent Cortex, or
 * a bounded heuristic can all fill it. This interface decouples the
 * Cortex from assuming any particular implementation.
 *
 * Three interaction patterns:
 *   1. ask()         — synchronous Q&A (inquiry, approval, escalation)
 *   2. notify()      — one-way notification (narration, awareness)
 *   3. onDirection() — unsolicited input from the Parsifal
 *
 * Implementations:
 *   HumanParsifal      — ConversationCortex + transports (current behavior)
 *   CortexParsifal     — parent Cortex reasons from its own cognition
 *   AutonomousParsifal — bounded self-resolution, no external entity
 */

import type { Escalation, EscalationResolution } from "./brainstem.js";
import type { EscalationBriefing } from "./thalamus.js";
import type { TasteProposal } from "./taste-feedback.js";
import type { SatisfactionResponse } from "./satisfaction-signal.js";

// ─── Core Interface ─────────────────────────────────────────────

export interface ParsifaInterface {
  /**
   * Ask the Parsifal a question and wait for an answer.
   * Used by: inquiry loop, vision approval, escalation delivery.
   *
   * The question is natural language. The answer is natural language.
   * The implementation decides how to produce the answer:
   *   - Human: display question, wait for typing
   *   - Parent Cortex: reason about the question using own context
   *   - Autonomous: apply heuristics or return a bounded default
   */
  ask(question: string, context?: AskContext): Promise<string>;

  /**
   * Deliver a notification that doesn't require a response.
   * Used by: proactive awareness surfacing, status updates, narration.
   *
   * The Parsifal MAY choose to respond (via onDirection callback),
   * but the system doesn't block.
   */
  notify(message: string, category: NotifyCategory): void;

  /**
   * Register handler for unsolicited Parsifal direction.
   * Used by: ConversationCortex.receive() routing.
   *
   * Direction can arrive at any time — mid-task, between tasks, idle.
   */
  onDirection(handler: (text: string) => void): void;

  /**
   * Present a taste proposal and receive structured feedback.
   * Used by: TasteFeedbackLoop when divergence is detected.
   *
   * Returns null if the Parsifal defers or doesn't support taste feedback.
   */
  proposeTaste?(proposal: TasteProposal): Promise<SatisfactionResponse | null>;

  /**
   * Parsifal capabilities — what this implementation supports.
   * The system adapts behavior based on what's available.
   */
  capabilities: ParsifaCapabilities;
}

// ─── Capabilities ───────────────────────────────────────────────

export interface ParsifaCapabilities {
  /** Can answer open-ended questions (inquiry, approval). */
  canInquire: boolean;
  /** Can approve/reject vision proposals. */
  canApprove: boolean;
  /** Can provide taste feedback (update/keep/nuanced/deferred). */
  canFeedbackTaste: boolean;
  /** Can receive and act on escalations. */
  canEscalate: boolean;
  /** Can receive notifications (narration, awareness surfacing). */
  canNotify: boolean;
  /** Autonomy budget — escalations to self-resolve before requiring external help. Undefined = unlimited. */
  autonomyBudget?: number;
}

// ─── Ask Context ────────────────────────────────────────────────

export interface AskContext {
  /** What kind of question this is — shapes how implementations handle it. */
  kind: "inquiry" | "approval" | "escalation" | "clarification";
  /** Structured escalation data, if this is an escalation. */
  escalation?: Escalation;
  /** Escalation briefing, if available. */
  briefing?: EscalationBriefing;
  /** For approval: the proposal being approved. */
  proposal?: string;
  /** Severity hint — autonomous implementations use this to decide self-resolve vs escalate. */
  severity?: "low" | "medium" | "high" | "critical";
}

// ─── Notification Categories ────────────────────────────────────

export type NotifyCategory =
  | "narration"          // Phase-level event narration
  | "awareness"          // Proactive awareness surfacing
  | "status"             // Status bar update
  | "progress"           // Task/project progress
  | "communication";     // Gate communication message
