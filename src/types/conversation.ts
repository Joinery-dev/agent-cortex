/**
 * Conversation types — the interface between Cortex and the Parsifal.
 *
 * Two channels flow through the conversation layer:
 *   - Narration (left pane): template-driven, phase-level activity feed
 *   - Conversation (right pane): LLM-backed consciousness + Parsifal chat
 *
 * Both channels share the same transport abstraction so terminal
 * and web clients implement a single interface.
 */

// ─── Message types ─────────────────────────────────────────────

export type ConversationRole = "parsifal" | "cortex";

/**
 * What kind of message this is:
 *   narration      — system activity digest (left pane)
 *   acknowledgment — cortex confirming it heard you
 *   proactive      — cortex surfacing something unprompted
 *   question       — cortex needs your input (escalation, inquiry, approval)
 *   response       — parsifal answering a question
 *   message        — parsifal sending unsolicited input
 */
export type MessageKind =
  | "narration"
  | "acknowledgment"
  | "proactive"
  | "question"
  | "response"
  | "message";

export type ProactiveCategory =
  | "confidence"
  | "tension"
  | "progress"
  | "budget"
  | "observation";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  kind: MessageKind;
  text: string;
  timestamp: Date;
  /** For proactive messages: what triggered this. */
  category?: ProactiveCategory;
  /** Rhythm context when this message was produced. */
  rhythmContext?: {
    rhythmType: string;
    phase: string;
    cycle: number;
    taskId?: string;
  };
  /** For acknowledgments/responses: which message this replies to. */
  inReplyTo?: string;
  /** For questions: the escalation or inquiry ID awaiting resolution. */
  pendingId?: string;
}

// ─── Narration types ───────────────────────────────────────────

/**
 * A narration item for the system activity feed.
 * Richer than a ConversationMessage — supports nesting and expandable detail.
 */
export interface NarrationItem {
  id: string;
  timestamp: Date;
  /** Short headline: "Consulting 4 senses" */
  headline: string;
  /** Optional children for expandable detail. */
  children?: NarrationChild[];
  /** Current phase context. */
  rhythmContext?: {
    rhythmType: string;
    phase: string;
    cycle: number;
    taskId?: string;
  };
  /** Visual emphasis level. */
  level: "major" | "normal" | "minor";
}

export interface NarrationChild {
  label: string;
  value: string;
  /** Optional severity for visual treatment. */
  severity?: "info" | "warn" | "success";
}

// ─── Transport ─────────────────────────────────────────────────

/**
 * Transport abstraction — how messages get to/from the Parsifal.
 *
 * Both terminal and WebSocket transports implement this.
 * Multiple transports can be active simultaneously.
 */
export interface ConversationTransport {
  /** Send a conversation message (right pane). */
  sendMessage(message: ConversationMessage): void;
  /** Send a narration item (left pane). */
  sendNarration(item: NarrationItem): void;
  /** Send a status update (bottom bar). */
  sendStatus(status: SystemStatus): void;
  /** Register handler for incoming Parsifal messages. */
  onReceive(handler: (text: string) => void): void;
  /** Clean shutdown. */
  close(): void;
}

// ─── System status ─────────────────────────────────────────────

export interface SystemStatus {
  /** Current task description. */
  task?: string;
  /** Task progress: "2/5" */
  taskProgress?: string;
  /** Current rhythm phase. */
  phase?: string;
  /** Current build cycle. */
  cycle?: number;
  /** Norepinephrine level (0-1). */
  ne?: number;
  /** Budget utilization (0-1). */
  budgetUsed?: number;
  /** Overall project state. */
  projectState?: "inquiry" | "planning" | "executing" | "complete";
}
