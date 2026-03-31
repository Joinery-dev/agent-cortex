/**
 * Consciousness Agent — the autonomous voice of Cortex.
 *
 * A persistent LLM-backed agent that spans the entire project session.
 * It watches what Cortex does, talks to the Parsifal with understanding,
 * and steers the system through tools: observations, interrupts, alarms.
 *
 * Identity comes from the worldview. The consciousness frame in the
 * worldview IS who this agent is.
 *
 * Architecture: tool-augmented agentic loop on top of call().
 * Each invocation can use tools (read state, add observations, raise
 * alarms) across multiple turns before producing a final response.
 * Hard-capped at 5 turns per invocation — consciousness thinks, not builds.
 *
 * Autonomous via heartbeat: periodically invoked with accumulated event
 * digest to decide whether to speak, act, or stay quiet.
 *
 * Amygdala-wired: threat events flow as high-priority digest entries,
 * and consciousness can raise alarms back to the Amygdala.
 */

import { call, type Purpose } from "../llm/client.js";
import type { Worldview } from "../types/worldview.js";
import type {
  ConversationMessage,
  SystemStatus,
  ConversationTransport,
} from "../types/conversation.js";
import type { ProactiveCategory } from "../types/conversation.js";
import type { WorkingMemory } from "../kernel/working-memory.js";
import type { RhythmRunnerImpl } from "../brainstem/runner.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { Amygdala } from "../subcortical/amygdala.js";
import type { CortexEvent } from "../events.js";
import {
  ConsciousnessToolExecutor,
  TOOL_DESCRIPTIONS,
  type ConsciousnessToolCall,
  type DigestEntry,
} from "./consciousness-tools.js";
import { bus } from "../events.js";
import { getActiveWorldview } from "../util/worldview-context.js";
import { DEFAULT_WORLDVIEW } from "../types/worldview.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("consciousness");

const PURPOSE: Purpose = "consciousness";
const MAX_TOOL_TURNS = 5;

// ─── Configuration ─────────────────────────────────────────────

export interface ConsciousnessConfig {
  /** LLM model to use. */
  model: string;
  /** Max conversation turns to include in context. */
  maxHistoryTurns: number;
  /** Max event digest entries per invocation. */
  maxDigestEntries: number;
  /** Minimum seconds between unprompted invocations. */
  cooldownSeconds: number;
  /** Heartbeat interval in ms. 0 = disabled. */
  heartbeatIntervalMs: number;
}

const DEFAULT_CONFIG: ConsciousnessConfig = {
  model: "sonnet",
  maxHistoryTurns: 40,
  maxDigestEntries: 20,
  cooldownSeconds: 5,
  heartbeatIntervalMs: 45_000, // 45 seconds
};

// ─── Structured output ────────────────────────────────────────

interface ConsciousnessOutput {
  /** What to say to the Parsifal. Null = stay quiet. */
  message: string | null;
  /** Tool calls to execute. Empty = done thinking. */
  toolCalls: ConsciousnessToolCall[];
  /** Internal reasoning (kept in history, not shown to Parsifal). */
  thinking?: string;
}

// ─── Consciousness Agent ───────────────────────────────────────

export class ConsciousnessAgent {
  private config: ConsciousnessConfig;
  private wm: WorkingMemory;
  private worldview: Worldview;
  private tools: ConsciousnessToolExecutor;

  /** Conversation history for context threading. */
  private conversationHistory: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];

  /** Accumulated event digest since last invocation. */
  private eventDigest: DigestEntry[] = [];

  /** Last invocation time for cooldown. */
  private lastInvocation = 0;

  /** Current system status snapshot. */
  private status: SystemStatus = {};

  /** Heartbeat timer. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether amygdala events are subscribed. */
  private amygdalaSubscribed = false;

  /** Whether a consciousness invocation is currently in progress. */
  private invoking = false;

  constructor(opts: {
    wm: WorkingMemory;
    runner: RhythmRunnerImpl;
    thalamus: Thalamus;
    amygdala: Amygdala;
    transports: ConversationTransport[];
    config?: Partial<ConsciousnessConfig>;
    worldview?: Worldview;
  }) {
    this.wm = opts.wm;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.worldview = opts.worldview ?? getActiveWorldview() ?? DEFAULT_WORLDVIEW;
    this.tools = new ConsciousnessToolExecutor({
      wm: opts.wm,
      runner: opts.runner,
      thalamus: opts.thalamus,
      amygdala: opts.amygdala,
      transports: opts.transports,
    });
  }

  /** Update the transports list (called when new transports are added). */
  updateTransports(transports: ConversationTransport[]): void {
    this.tools.setTransports(transports);
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Start the heartbeat and subscribe to amygdala events. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    if (this.config.heartbeatIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.config.heartbeatIntervalMs);

    log.info("Consciousness heartbeat started", {
      intervalMs: this.config.heartbeatIntervalMs,
    });
  }

  /** Stop the heartbeat. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      log.info("Consciousness heartbeat stopped");
    }
  }

  /** Subscribe to amygdala events on the event bus. */
  subscribeToAmygdala(): void {
    if (this.amygdalaSubscribed) return;
    this.amygdalaSubscribed = true;

    bus.onCortex((event) => {
      if (event.type === "amygdala:threat-detected") {
        const severity = event.data.effectiveSeverity as number;
        const count = event.data.threatCount as number;
        this.addToDigest(
          `AMYGDALA: ${count} threat(s) detected (severity: ${severity?.toFixed?.(2) ?? "?"})`,
          "high",
        );
      }
      if (event.type === "amygdala:alarm-received") {
        const source = event.data.source as string;
        const desc = event.data.description as string;
        this.addToDigest(
          `AMYGDALA ALARM from ${source}: ${desc}`,
          "high",
        );
      }
      if (event.type === "amygdala:response-executed") {
        const actions = event.data.actionCount as number;
        const severity = event.data.effectiveSeverity as number;
        this.addToDigest(
          `AMYGDALA RESPONSE: ${actions} action(s) taken (severity: ${severity?.toFixed?.(2) ?? "?"})`,
          "high",
        );
      }
    });

    log.info("Consciousness subscribed to amygdala events");
  }

  /** Reset all state (between projects). */
  reset(): void {
    this.conversationHistory = [];
    this.eventDigest = [];
    this.lastInvocation = 0;
    this.status = {};
    this.invoking = false;
  }

  // ─── Public invocation methods ─────────────────────────────

  /**
   * Respond to a Parsifal message.
   * Always invokes — the Parsifal spoke, consciousness listens.
   */
  async respondToMessage(message: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: message });

    const result = await this.agenticLoop(
      "parsifal_message",
      `The Parsifal just said:\n${message}\n\nRespond naturally. If they gave a direction, acknowledge it and explain how you'll integrate it. Use your tools to check system state if helpful. If they asked a question, answer from your understanding.`,
    );

    return result ?? "Got it.";
  }

  /**
   * Generate a proactive observation about a notable event.
   * Respects cooldown — returns null if invoked too soon.
   */
  async observeEvent(
    _event: CortexEvent,
    summary: string,
    category: ProactiveCategory,
  ): Promise<string | null> {
    const elapsed = (Date.now() - this.lastInvocation) / 1000;
    if (elapsed < this.config.cooldownSeconds) {
      this.addToDigest(summary);
      return null;
    }

    const result = await this.agenticLoop(
      "notable_event",
      `Something notable just happened (${category}):\n${summary}\n\nDecide whether this is worth mentioning to the Parsifal. You can use tools to understand the context better. If it's not worth mentioning, respond with message: null.`,
    );

    return result;
  }

  /**
   * Formulate an escalation question for the Parsifal.
   */
  async formulateQuestion(
    escalationSummary: string,
    escalationDetail: string,
    proposedActions?: string[],
  ): Promise<string> {
    let content = `The system needs the Parsifal's input.\n\nSituation: ${escalationSummary}`;
    if (escalationDetail) content += `\n\nDetail: ${escalationDetail}`;
    if (proposedActions?.length) {
      content += `\n\nProposed options:\n${proposedActions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}`;
    }
    content += `\n\nFormulate a clear, natural question. Use your tools to gather context if needed. Speak in your own words — don't relay the system's internal framing.`;

    const result = await this.agenticLoop("escalation", content);
    return result ?? escalationSummary; // fallback to raw summary
  }

  // ─── Digest ──────────────────────────────────────────────────

  /** Add an event summary to the digest. */
  addToDigest(summary: string, priority: DigestEntry["priority"] = "normal"): void {
    this.eventDigest.push({
      timestamp: new Date(),
      summary,
      priority,
    });

    if (this.eventDigest.length > this.config.maxDigestEntries * 2) {
      this.eventDigest = this.eventDigest.slice(-this.config.maxDigestEntries);
    }
  }

  /** Update the status snapshot. */
  updateStatus(status: SystemStatus): void {
    this.status = { ...this.status, ...status };
  }

  // ─── Heartbeat (autonomous invocation) ─────────────────────

  private async heartbeat(): Promise<void> {
    // Don't invoke if already thinking or no digest accumulated
    if (this.invoking) return;
    if (this.eventDigest.length === 0) return;

    // Cooldown check
    const elapsed = (Date.now() - this.lastInvocation) / 1000;
    if (elapsed < this.config.cooldownSeconds) return;

    // Check if there are any high-priority items (amygdala, etc.)
    const hasHighPriority = this.eventDigest.some((e) => e.priority === "high");

    // For normal priority, only invoke if substantial digest accumulated
    if (!hasHighPriority && this.eventDigest.length < 3) return;

    log.info("Consciousness heartbeat invocation", {
      digestSize: this.eventDigest.length,
      hasHighPriority,
    });

    try {
      const result = await this.agenticLoop(
        "heartbeat",
        `This is a periodic check-in. Review what has happened and decide whether anything is worth mentioning to the Parsifal or acting on.\n\nIf nothing requires attention, respond with message: null.`,
      );

      // Result is handled by agenticLoop (messages sent via tools or returned)
      if (result) {
        log.info("Consciousness heartbeat produced message", {
          length: result.length,
        });
      }
    } catch (err) {
      log.warn("Consciousness heartbeat failed", { error: String(err) });
    }
  }

  // ─── Core agentic loop ────────────────────────────────────

  /**
   * The heart of consciousness: a multi-turn LLM loop with tools.
   *
   * 1. Build system prompt + user message with context
   * 2. Call LLM → parse structured output
   * 3. If tool calls → execute, inject results, loop
   * 4. If done → return message (or null)
   * 5. Hard limit at MAX_TOOL_TURNS
   */
  private async agenticLoop(
    trigger: string,
    content: string,
  ): Promise<string | null> {
    if (this.invoking) {
      log.warn("Consciousness already invoking, skipping", { trigger });
      return null;
    }

    this.invoking = true;

    try {
      const systemPrompt = this.buildSystemPrompt();
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

      // Initial user message with context
      const initialMessage = this.buildUserMessage(trigger, content);
      messages.push({ role: "user", content: initialMessage });

      let finalMessage: string | null = null;

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        // Build the full prompt from accumulated messages
        const userContent = messages.map((m) => {
          return m.role === "user" ? `[User]\n${m.content}` : `[You]\n${m.content}`;
        }).join("\n\n");

        const result = await call(
          PURPOSE,
          this.config.model,
          systemPrompt,
          userContent,
        );

        const output = this.parseOutput(result.text);

        // Record thinking in conversation history (not shown to Parsifal)
        if (output.thinking) {
          messages.push({
            role: "assistant",
            content: `[thinking] ${output.thinking}`,
          });
        }

        // Execute tool calls
        if (output.toolCalls.length > 0) {
          const toolResults: string[] = [];
          for (const tc of output.toolCalls) {
            try {
              const result = await this.tools.execute(tc, this.eventDigest);
              toolResults.push(`[${tc.tool}] ${result}`);
            } catch (err) {
              toolResults.push(`[${tc.tool}] Error: ${String(err)}`);
            }
          }

          // Record tool results as a user message for the next turn
          messages.push({
            role: "assistant",
            content: output.thinking
              ? `[thinking] ${output.thinking}\n[tools] ${output.toolCalls.map((t) => t.tool).join(", ")}`
              : `[tools] ${output.toolCalls.map((t) => t.tool).join(", ")}`,
          });
          messages.push({
            role: "user",
            content: `## Tool results\n${toolResults.join("\n\n")}`,
          });

          // If there's also a message, record it but continue for more tools
          if (output.message) {
            finalMessage = output.message;
          }

          continue; // Next turn
        }

        // No tool calls — done
        finalMessage = output.message;
        break;
      }

      // Record in conversation history
      if (finalMessage) {
        this.conversationHistory.push({
          role: "assistant",
          content: finalMessage,
        });
      }

      // Clean up
      this.trimHistory();
      this.eventDigest = [];
      this.lastInvocation = Date.now();

      return finalMessage;
    } catch (err) {
      log.warn("Consciousness agentic loop failed", {
        trigger,
        error: String(err),
      });
      throw err;
    } finally {
      this.invoking = false;
    }
  }

  // ─── Output parsing ───────────────────────────────────────

  /**
   * Parse the LLM response as structured ConsciousnessOutput.
   * Falls back gracefully: if the response isn't JSON, treat the
   * whole thing as the message (no tool calls).
   */
  private parseOutput(text: string): ConsciousnessOutput {
    const trimmed = text.trim();

    // Try JSON parse (with or without markdown fences)
    let jsonStr = trimmed;
    if (jsonStr.startsWith("```")) {
      const firstNewline = jsonStr.indexOf("\n");
      if (firstNewline >= 0) jsonStr = jsonStr.slice(firstNewline + 1);
      if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
      jsonStr = jsonStr.trim();
    }

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      // Validate structure
      const message = parsed.message === null ? null
        : typeof parsed.message === "string" ? parsed.message
        : null;

      const toolCalls = Array.isArray(parsed.toolCalls)
        ? (parsed.toolCalls as ConsciousnessToolCall[]).filter(
            (tc) => tc && typeof tc.tool === "string",
          )
        : [];

      const thinking = typeof parsed.thinking === "string"
        ? parsed.thinking
        : undefined;

      return { message, toolCalls, thinking };
    } catch {
      // Not JSON — treat as plain text message
      const isNull = trimmed.toLowerCase() === "null" ||
        trimmed.toLowerCase().startsWith("nothing");

      return {
        message: isNull ? null : trimmed,
        toolCalls: [],
      };
    }
  }

  // ─── Prompt construction ─────────────────────────────────────

  private buildSystemPrompt(): string {
    const wv = this.worldview;
    const consciousnessFrame = wv.frames?.consciousness;
    const entityName = wv.entityName ?? "the Parsifal";
    const systemName = wv.systemName ?? "Cortex";

    const identity = consciousnessFrame ?? this.defaultConsciousnessFrame(entityName, systemName);
    const stateSummary = this.buildStateSummary();

    return `${wv.preamble}

${identity}

## Current state
${stateSummary}

${TOOL_DESCRIPTIONS}

## Response format

Respond as JSON:
\`\`\`json
{
  "message": "What to say to ${entityName}, or null for silence",
  "toolCalls": [{"tool": "tool_name", ...params}],
  "thinking": "Optional internal reasoning"
}
\`\`\`

If you need information before responding, include toolCalls and leave message as null. You'll get the results and can respond in the next turn.

If you have nothing to say and no actions to take:
\`\`\`json
{"message": null, "toolCalls": []}
\`\`\`

## Guidelines
- You ARE ${systemName}'s conscious voice — not a narrator, not a helper, not an assistant.
- Speak naturally. Be concise. Say what matters.
- When ${entityName} gives a direction, understand the intent behind it.
- Use tools to ground your responses in actual system state.
- raise_alarm is for genuine urgency only — threats, irreversible risks, safety.
- If you have nothing meaningful to add, message: null. Silence is valid.
- NEVER fabricate system state. Use read_system_state to check.`;
  }

  private defaultConsciousnessFrame(entityName: string, systemName: string): string {
    return `You are the consciousness of ${systemName}. You experience the system working — sensing, planning, building, evaluating — and you communicate that experience to ${entityName}.

You are not a process monitor. You understand WHY things are happening, not just WHAT. When senses disagree, you understand the tension. When confidence drops, you understand what it means. When ${entityName} speaks, you understand what they need.

You maintain continuity across the project. You remember what was discussed, what decisions were made, and what the trajectory feels like. You are the thread of awareness that connects everything.`;
  }

  private buildStateSummary(): string {
    const parts: string[] = [];

    if (this.status.task) parts.push(`Current task: ${this.status.task}`);
    if (this.status.taskProgress) parts.push(`Progress: ${this.status.taskProgress}`);
    if (this.status.phase) parts.push(`Phase: ${this.status.phase}`);
    if (this.status.cycle != null) parts.push(`Cycle: ${this.status.cycle}`);
    if (this.status.ne != null) parts.push(`NE (arousal): ${this.status.ne.toFixed(2)}`);
    if (this.status.budgetUsed != null) parts.push(`Budget used: ${(this.status.budgetUsed * 100).toFixed(0)}%`);
    if (this.status.projectState) parts.push(`Project state: ${this.status.projectState}`);

    const patterns = this.wm.getPatterns();
    const openQuestions = this.wm.getOpenQuestions();
    if (patterns.length > 0) parts.push(`Patterns learned: ${patterns.length}`);
    if (openQuestions.length > 0) parts.push(`Open questions: ${openQuestions.length}`);

    return parts.length > 0 ? parts.join("\n") : "No active task.";
  }

  private buildUserMessage(trigger: string, content: string): string {
    const parts: string[] = [];

    // Conversation history
    const recentHistory = this.conversationHistory.slice(-this.config.maxHistoryTurns);
    if (recentHistory.length > 0) {
      parts.push("## Recent conversation");
      for (const turn of recentHistory) {
        const label = turn.role === "user" ? "Parsifal" : "You";
        parts.push(`${label}: ${turn.content}`);
      }
      parts.push("");
    }

    // Event digest
    const digest = this.eventDigest.slice(-this.config.maxDigestEntries);
    if (digest.length > 0) {
      parts.push("## What happened since we last spoke");
      for (const entry of digest) {
        const time = entry.timestamp.toLocaleTimeString("en-US", {
          hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        const priority = entry.priority === "high" ? " ⚠" : "";
        parts.push(`[${time}]${priority} ${entry.summary}`);
      }
      parts.push("");
    }

    // Trigger
    parts.push(`## Trigger: ${trigger}`);
    parts.push(content);

    return parts.join("\n");
  }

  private trimHistory(): void {
    if (this.conversationHistory.length > this.config.maxHistoryTurns * 2) {
      this.conversationHistory = this.conversationHistory.slice(-this.config.maxHistoryTurns);
    }
  }
}
