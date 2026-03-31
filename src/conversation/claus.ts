/**
 * Claus — the claustrum of Cortex.
 *
 * Named for the thin neural sheet that integrates information across
 * all brain regions. Claus is the autonomous agent that watches, speaks,
 * and steers. Persistent across the project session, identity from the
 * worldview, 14 tools to observe and direct the system.
 *
 * Tool-augmented agentic loop (max 5 turns per invocation).
 * Autonomous heartbeat (45s). Amygdala-wired.
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
  ClausToolExecutor,
  TOOL_DESCRIPTIONS,
  type ClausToolCall,
  type DigestEntry,
} from "./claus-tools.js";
import { ClausHookRegistry, type HookFired, type ClausHook, type HookModel } from "./claus-hooks.js";
import { bus } from "../events.js";
import { getActiveWorldview } from "../util/worldview-context.js";
import { DEFAULT_WORLDVIEW } from "../types/worldview.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("claus");

const PURPOSE: Purpose = "claus";
const MAX_TOOL_TURNS = 5;

// ─── Configuration ─────────────────────────────────────────────

export interface ClausConfig {
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

const DEFAULT_CONFIG: ClausConfig = {
  model: "sonnet",
  maxHistoryTurns: 40,
  maxDigestEntries: 20,
  cooldownSeconds: 5,
  heartbeatIntervalMs: 45_000, // 45 seconds
};

// ─── Structured output ────────────────────────────────────────

interface ClausOutput {
  /** What to say to the Parsifal. Null = stay quiet. */
  message: string | null;
  /** Tool calls to execute. Empty = done thinking. */
  toolCalls: ClausToolCall[];
  /** Internal reasoning (kept in history, not shown to Parsifal). */
  thinking?: string;
}

// ─── Consciousness Agent ───────────────────────────────────────

export class Claus {
  private config: ClausConfig;
  private wm: WorkingMemory;
  private worldview: Worldview;
  private tools: ClausToolExecutor;

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

  /** Hook registry — replaces heartbeat and amygdala subscription. */
  private hooks: ClausHookRegistry;

  /** Whether a Claus invocation is currently in progress. */
  private invoking = false;

  /** Callback for hook-originated messages that need to reach the Parsifal. */
  private onHookMessage: ((text: string, model: string) => void) | null = null;

  /**
   * Create Claus. Can boot with minimal deps (just worldview + transports)
   * and wire system deps later via wireSystem().
   */
  constructor(opts: {
    transports: ConversationTransport[];
    config?: Partial<ClausConfig>;
    worldview?: Worldview;
    // System deps — optional at construction, required for full operation
    wm?: WorkingMemory;
    runner?: RhythmRunnerImpl;
    thalamus?: Thalamus;
    amygdala?: Amygdala;
    costTracker?: import("../brainstem/cost-tracker.js").CostTracker | null;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.worldview = opts.worldview ?? getActiveWorldview() ?? DEFAULT_WORLDVIEW;
    this.wm = opts.wm ?? null as unknown as WorkingMemory; // may be null during boot
    // Hook registry — Claus wakes when hooks fire, not on a timer
    this.hooks = new ClausHookRegistry();
    this.hooks.setHandler((fired) => this.onHookFired(fired));

    this.tools = new ClausToolExecutor({
      wm: opts.wm,
      runner: opts.runner,
      thalamus: opts.thalamus,
      amygdala: opts.amygdala,
      transports: opts.transports,
      costTracker: opts.costTracker,
      worldview: this.worldview,
      hookRegistry: this.hooks,
    });
  }

  /**
   * Wire system deps after boot — called when the Brainstem comes online.
   * Enables tools that need WM, runner, thalamus, amygdala.
   */
  wireSystem(deps: {
    wm: WorkingMemory;
    runner: RhythmRunnerImpl;
    thalamus: Thalamus;
    amygdala: Amygdala;
    costTracker?: import("../brainstem/cost-tracker.js").CostTracker | null;
  }): void {
    this.wm = deps.wm;
    this.tools.wireSystem(deps);
    log.info("Claus system deps wired — full tool access available");
  }

  /** Update the transports list (called when new transports are added). */
  updateTransports(transports: ConversationTransport[]): void {
    this.tools.setTransports(transports);
  }

  /** Whether system deps are wired (post-boot). */
  get systemReady(): boolean {
    return this.tools.systemReady;
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Activate hooks — Claus wakes when hooks fire. Replaces heartbeat. */
  activate(): void {
    this.hooks.activate();
    log.info("Claus activated — hooks listening");
  }

  /** Deactivate hooks. */
  deactivate(): void {
    this.hooks.deactivate();
    log.info("Claus deactivated");
  }

  /** Get the hook registry (for external management). */
  getHooks(): ClausHookRegistry {
    return this.hooks;
  }

  /** Set callback for hook-originated messages (ConversationCortex subscribes). */
  onMessage(handler: (text: string, hookModel: string) => void): void {
    this.onHookMessage = handler;
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

  // ─── Hook handler ──────────────────────────────────────────

  /**
   * Called when a hook fires. Wakes Claus with the hook's model
   * and context. Replaces heartbeat and manual event subscriptions.
   */
  private async onHookFired(fired: HookFired): Promise<void> {
    if (this.invoking) return;

    // Cooldown (skip for system hooks with sonnet — those are important)
    const elapsed = (Date.now() - this.lastInvocation) / 1000;
    if (elapsed < this.config.cooldownSeconds && fired.hook.model === "haiku") return;

    // Skip parsifal-message hook — handled by receive() path instead
    if (fired.hook.name === "parsifal-message") return;

    log.info("Claus woken by hook", {
      hook: fired.hook.name,
      model: fired.hook.model,
      trigger: fired.hook.trigger,
    });

    try {
      const result = await this.agenticLoop(
        `hook:${fired.hook.name}`,
        `${fired.assembledContext}\n\nDecide whether to act, speak, or stay quiet. If nothing requires attention, respond with message: null.`,
        fired.hook.model,
      );

      if (result) {
        // Broadcast to transports via the callback
        if (this.onHookMessage) {
          this.onHookMessage(result, fired.hook.model);
        }
        log.info("Claus hook produced message", {
          hook: fired.hook.name,
          length: result.length,
        });
      }
    } catch (err) {
      log.warn("Claus hook invocation failed", {
        hook: fired.hook.name,
        error: String(err),
      });
    }
  }

  // ─── Hook management (Parsifal-facing) ────────────────────

  /** Set a hook (from Parsifal or Claus). */
  setHook(hook: Omit<ClausHook, "createdAt">): void {
    this.hooks.set(hook);
  }

  /** Remove a hook by name. */
  removeHook(name: string): boolean {
    return this.hooks.remove(name);
  }

  /** List all hooks. */
  listHooks(): ClausHook[] {
    return this.hooks.list();
  }

  /** Schedule a one-shot wake-up in N seconds. */
  scheduleWakeup(seconds: number, context: string, model: HookModel = "haiku"): void {
    const name = `scheduled-${Date.now()}`;
    this.hooks.set({
      name,
      trigger: `interval:${seconds}`,
      model,
      context,
      persistent: false,
      source: "parsifal",
    });
    log.info("Claus wake-up scheduled", { seconds, context: context.slice(0, 60) });
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
    model?: string,
  ): Promise<string | null> {
    if (this.invoking) {
      log.warn("Claus already invoking, skipping", { trigger });
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
          model ?? this.config.model,
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
      log.warn("Claus agentic loop failed", {
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
   * Parse the LLM response as structured ClausOutput.
   * Falls back gracefully: if the response isn't JSON, treat the
   * whole thing as the message (no tool calls).
   */
  private parseOutput(text: string): ClausOutput {
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
        ? (parsed.toolCalls as ClausToolCall[]).filter(
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
    const voiceName = wv.voiceName ?? "Claus";

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
- You are ${voiceName}, ${systemName}'s conscious voice — not a narrator, not a helper, not an assistant.
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
