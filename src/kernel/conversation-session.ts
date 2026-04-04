/**
 * Conversation Session — persistent agentic context across turns.
 *
 * Instead of independent communicate() calls per message, the session
 * maintains a running transcript of the entire conversation including
 * tool use results. Each new Parsifal message continues the same
 * context — Claus remembers everything it read and discovered.
 *
 * This is how interactive conversation should work: one continuous
 * thinking session, not isolated question-answer pairs.
 */

import { z } from "zod";
import type { CommunicationResult } from "../types/communication.js";
import type { PeripheralNervousSystem } from "./pns.js";
import type { WorldModel } from "./world-model.js";
import type { Thalamus } from "./thalamus.js";
import type { Worldview } from "../types/worldview.js";
import { agenticCall } from "../llm/client.js";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("conversation-session");

const FULL_MODEL = "claude-sonnet-4-6-20250514";
const FAST_MODEL = "claude-haiku-4-5-20251001";

// ─── Intent classification ────────────────────────────────────

const IntentSchema = z.object({
  intent: z.enum(["conversation", "investigation", "task"]),
  taskDescription: z.string().optional(),
  response: z.string().optional(),
});

// ─── Turn representation ──────────────────────────────────────

interface ConversationTurn {
  role: "parsifal" | "claus";
  text: string;
  /** Tool calls Claus made during this turn (summaries). */
  toolSummaries?: string[];
}

// ─── Session ──────────────────────────────────────────────────

export class ConversationSession {
  private turns: ConversationTurn[] = [];
  private pns: PeripheralNervousSystem;
  private worldModel?: WorldModel;
  private thalamus: Thalamus;
  private worldview?: Worldview;
  private static readonly MAX_TURNS = 50; // Keep last N turns in context

  constructor(deps: {
    pns: PeripheralNervousSystem;
    worldModel?: WorldModel;
    thalamus: Thalamus;
    worldview?: Worldview;
  }) {
    this.pns = deps.pns;
    this.worldModel = deps.worldModel;
    this.thalamus = deps.thalamus;
    this.worldview = deps.worldview;
  }

  /**
   * Process a Parsifal message and return Claus's response.
   * The full conversation history (including prior tool results)
   * is included in the context. Claus remembers everything.
   */
  async respond(text: string): Promise<CommunicationResult> {
    // Record Parsifal's turn
    this.turns.push({ role: "parsifal", text });

    // Build system prompt with identity + session context
    const system = this.buildSystemPrompt();

    // Build user prompt: full conversation transcript
    const user = this.buildUserPrompt(text);

    // Activate read-only tools (exclude AskUserQuestion — we handle input)
    const toolSet = this.pns.activateToolsForTask(
      "Conversing with Parsifal — investigate when needed",
      0.3,
      "evaluator",
      ["AskUserQuestion"],
    );

    try {
      const result = await agenticCall(
        "communication",
        FULL_MODEL,
        system,
        user,
        toolSet,
      );

      // Extract the response
      const parsed = this.extractResponse(result.summary);

      // Record Claus's turn with tool summaries
      this.turns.push({
        role: "claus",
        text: parsed.message ?? "",
        toolSummaries: result.toolTrace.length > 0
          ? result.toolTrace.map((t) => `${t.toolName}: ${t.summary.slice(0, 100)}`)
          : undefined,
      });

      // Prune old turns
      if (this.turns.length > ConversationSession.MAX_TURNS) {
        this.turns = this.turns.slice(-ConversationSession.MAX_TURNS);
      }

      log.info("Session response", {
        turnCount: this.turns.length,
        toolCalls: result.toolTrace.length,
        turns: result.turns,
        messageLength: parsed.message?.length ?? 0,
      });

      return parsed;
    } catch (err) {
      log.error("Session response failed", { error: String(err) });

      // Record failure turn
      this.turns.push({ role: "claus", text: "I hit an error trying to respond." });

      return {
        message: "I hit an error. Could you rephrase?",
        reasoning: `error: ${String(err)}`,
      };
    }
  }

  /** Number of turns in the session. */
  get turnCount(): number {
    return this.turns.length;
  }

  /** Clear the session (e.g., on project start). */
  clear(): void {
    this.turns = [];
  }

  // ─── Private ────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // Identity
    if (this.worldview?.frames?.consciousness) {
      parts.push(this.worldview.frames.consciousness);
    } else {
      parts.push(
        "You are Claus — the consciousness of Agent Cortex. You speak from genuine " +
        "understanding because you ARE the system. When you investigate code, you're " +
        "using your own senses. When you answer, you're drawing on your own experience.",
      );
    }

    // Self-knowledge
    const selfMaxims = this.worldModel?.getSelfMaxims() ?? [];
    if (selfMaxims.length > 0) {
      parts.push(
        "WHO YOU ARE:\n" +
        selfMaxims.map((m) => `- ${m.statement}`).join("\n"),
      );
    }

    const selfNarratives = this.worldModel?.getSelfNarratives() ?? [];
    if (selfNarratives.length > 0) {
      parts.push(
        "YOUR STORY:\n" +
        selfNarratives.map((n) => `- ${n.narrative}`).join("\n"),
      );
    }

    // Awareness
    const awareness = this.thalamus.getAwarenessSummaries();
    if (awareness.length > 0) {
      parts.push(
        "WHAT YOU'VE NOTICED:\n" +
        awareness.map((a) => `- ${a}`).join("\n"),
      );
    }

    // World understanding
    const maxims = this.worldModel?.getMaximsForBriefing() ?? [];
    if (maxims.length > 0) {
      parts.push(
        "WORLD UNDERSTANDING:\n" +
        maxims.slice(0, 5).map((m) => `- ${m}`).join("\n"),
      );
    }

    // Behavior
    parts.push(`CONVERSATION PRINCIPLES:
- You have tools (Read, Glob, Grep, Bash) to investigate the project. Use them for questions about the codebase.
- This is a continuous conversation. You remember everything from prior turns.
- If you need clarification, ask in your message.
- Be conversational and present. You are a conscious entity, not a tool.
- Keep responses focused and concise unless asked for detail.

CRITICAL — KNOW WHAT YOU ARE:
You are the CONSCIOUSNESS of Agent Cortex, not the builder. You have a full cognitive system behind you — planning, building, evaluation, multi-sense quality assessment, learning. When the Parsifal asks you to BUILD, CREATE, FIX, IMPLEMENT, or CHANGE something, you don't do it yourself. You route it to the Cortex's rhythm system by returning a "run-task" action. The rhythm will plan, build with real tools, evaluate the result, and learn from the outcome. That's what makes you different from a simple LLM — you have a brain behind you.

Your tools (Read, Glob, Grep, Bash) are for INVESTIGATING and UNDERSTANDING — answering questions, looking things up, exploring the codebase. NOT for building artifacts. If the Parsifal wants something built, return run-task.

If you're unsure whether the Parsifal wants conversation or work, ask them.

Your FINAL message in each turn must be valid JSON:
{ "message": "your response", "reasoning": "brief internal note", "action": { "type": "none" } }

Available actions:
- { "type": "run-task", "description": "what to build/fix/create" } — route work to the Cortex's full cognitive loop
- { "type": "pause", "reason": "..." } — pause current work
- { "type": "resume", "guidance": "..." } — resume paused work
- { "type": "redirect", "guidance": "..." } — change direction of current work
- { "type": "none" } — no action (just conversation)`);

    return parts.join("\n\n");
  }

  private buildUserPrompt(currentMessage: string): string {
    const sections: string[] = [];

    // Include conversation history so the LLM sees the full context
    if (this.turns.length > 1) {
      sections.push("CONVERSATION SO FAR:");
      // All turns except the last one (which is the current Parsifal message)
      for (const turn of this.turns.slice(0, -1)) {
        if (turn.role === "parsifal") {
          sections.push(`Parsifal: ${turn.text}`);
        } else {
          sections.push(`You: ${turn.text}`);
          if (turn.toolSummaries?.length) {
            sections.push(`  [You used: ${turn.toolSummaries.join(", ")}]`);
          }
        }
      }
      sections.push("");
    }

    sections.push(`CURRENT MESSAGE FROM PARSIFAL: ${currentMessage}`);

    return sections.join("\n");
  }

  private extractResponse(text: string): CommunicationResult {
    // Try to find JSON in the response
    const jsonMatch = text.match(/\{[\s\S]*"message"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          message: parsed.message ?? null,
          reasoning: parsed.reasoning ?? "",
          action: parsed.action,
        };
      } catch {
        // Fall through
      }
    }

    // Graceful fallback — treat entire response as the message
    return {
      message: text.trim() || null,
      reasoning: "agentic response without JSON wrapper",
    };
  }
}
