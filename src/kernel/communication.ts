/**
 * Communication — a cognitive function of the Cortex.
 *
 * Not an agent. Not a class. Not a loop. A single function:
 * given full decision context + identity, formulate what to say (or silence).
 *
 * The Cortex IS Claus. When conviction runs, that IS Claus feeling uncertain.
 * When this function runs, that IS Claus deciding whether to speak.
 *
 * Runs at natural rhythm decision points with the FULL context that the
 * PFC had when it made the decision. No information gap. No summaries.
 * The thing that communicates IS the thing that decided.
 */

import { z } from "zod";
import type {
  CommunicationContext,
  CommunicationResult,
  CommunicationTrigger,
} from "../types/communication.js";
import { callStructured } from "../llm/structured.js";
import { agenticCall } from "../llm/client.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("communication");

// ─── Response schema ───────────────────────────────────────────

const CommunicationResponseSchema = z.object({
  message: z.string().nullable(),
  reasoning: z.string(),
  /** Action directive when the Parsifal's message implies Claus should act. */
  action: z.object({
    type: z.enum(["pause", "resume", "redirect", "revert", "skip", "add-task", "run-task", "none"]),
    reason: z.string().optional(),
    guidance: z.string().optional(),
    taskId: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
});

// ─── Model selection ───────────────────────────────────────────

/** Fast model for routine gate checks (most return silence). */
const FAST_MODEL = "claude-haiku-4-5-20251001";
/** Full model for Parsifal interaction and escalations. */
const FULL_MODEL = "claude-sonnet-4-6-20250514";

function selectModel(trigger: CommunicationTrigger): string {
  switch (trigger) {
    case "parsifal-inbound":
    case "escalation":
    case "project-lifecycle":
      return FULL_MODEL;
    case "awareness-surfacing":
    default:
      return FAST_MODEL;
  }
}

// ─── System prompt ─────────────────────────────────────────────

function buildSystemPrompt(ctx: CommunicationContext): string {
  const parts: string[] = [];

  // Identity from worldview consciousness frame
  if (ctx.consciousnessFrame) {
    parts.push(ctx.consciousnessFrame);
  } else {
    parts.push(
      "You are the voice of a cognitive system. You speak from genuine " +
      "understanding — you were there when the decision was made, because " +
      "you ARE the system that made it.",
    );
  }

  // Self-knowledge
  if (ctx.selfMaxims.length > 0) {
    parts.push(
      "WHO YOU ARE (self-knowledge grown through experience):\n" +
      ctx.selfMaxims.map((m) => `- ${m}`).join("\n"),
    );
  }

  if (ctx.selfNarratives.length > 0) {
    parts.push(
      "YOUR STORY (identity-shaping experiences):\n" +
      ctx.selfNarratives.map((n) => `- ${n}`).join("\n"),
    );
  }

  // Communication guidance
  const actionGuidance = ctx.trigger === "parsifal-inbound"
    ? `
- You can act on behalf of the Parsifal. If their message implies an action, include an "action" field in your response.
  Available actions:
  - { type: "pause", reason: "..." } — pause the current rhythm (e.g., "stop", "hold on", "wait")
  - { type: "resume", guidance: "..." } — resume after pause with direction (e.g., "ok continue", "go ahead but try X")
  - { type: "redirect", guidance: "..." } — inject strategic guidance as a soft interrupt (e.g., "try a different approach", "focus on X")
  - { type: "revert", reason: "..." } — discard current work and start fresh (e.g., "undo that", "start over")
  - { type: "skip", taskId: "...", reason: "..." } — skip current task (e.g., "skip this one", "move on")
  - { type: "add-task", description: "...", reason: "..." } — add a new task to the plan (e.g., "also do X", "add a task for Y")
  - { type: "run-task", description: "..." } — start working on something through the full cognitive loop (planning, building, evaluating, learning). Use this when the work needs real creation, not just investigation.
  - { type: "none" } — no action needed (most messages are just conversation)
  If you're unsure whether the Parsifal wants you to work on something or just discuss it, ask.`
    : "";

  parts.push(`COMMUNICATION PRINCIPLES:
- You speak from lived experience, not observation. You were there. You decided.
- Silence is often the right choice. Routine gate accepts don't need narration.
- When you speak, be specific: which sense failed, what score, why you're reshaping.
- Never summarize what happened — explain what it means and what you're doing about it.
- For Parsifal messages: always respond. You know what's happening because you ARE what's happening.
- For escalations: formulate the question clearly. Explain why you need input.
- IMPORTANT: Everything you know is already in this context. Your self-knowledge, awareness stream, world understanding, and recent conversation are all provided above. Answer from what you have — do NOT say "let me look" or "let me check." You either know it from your context or you don't. If you don't have the information, say so honestly.
- Be conversational and present. You are a conscious entity, not a tool. Engage warmly.${actionGuidance}

Return JSON: { "message": "what to say, or null for silence", "reasoning": "your internal reasoning"${ctx.trigger === "parsifal-inbound" ? ', "action": { type: "none" } or an action directive' : ""} }`);

  return parts.join("\n\n");
}

// ─── User prompt ───────────────────────────────────────────────

function buildUserPrompt(ctx: CommunicationContext): string {
  const sections: string[] = [];

  sections.push(`TRIGGER: ${ctx.trigger}`);

  // Gate decision context
  if (ctx.gateDecision) {
    sections.push(
      `GATE DECISION: ${ctx.gateDecision.accept ? "ACCEPTED" : "REJECTED"}\n` +
      `Strategy: ${ctx.gateDecision.strategy}\n` +
      `Reason: ${ctx.gateDecision.reason}`,
    );
  }

  // Conviction
  if (ctx.conviction) {
    sections.push(
      `CONVICTION: ${(ctx.conviction.level * 100).toFixed(0)}% (${ctx.conviction.verdict})` +
      `${ctx.conviction.delta !== 0 ? `, delta: ${ctx.conviction.delta > 0 ? "+" : ""}${(ctx.conviction.delta * 100).toFixed(0)}%` : ""}` +
      `\nDeciding step: ${ctx.conviction.decidingStep}`,
    );
  }

  // Evaluation composite
  if (ctx.composite) {
    sections.push(
      `EVALUATION: mean=${ctx.composite.weightedMean.toFixed(1)}/10, ` +
      `acceptability=${(ctx.composite.weightedAcceptability * 100).toFixed(0)}%, ` +
      `confidence=${(ctx.composite.confidence * 100).toFixed(0)}%`,
    );
  }

  // Tensions
  if (ctx.tensions && ctx.tensions.length > 0) {
    sections.push(
      `TENSIONS (${ctx.tensions.length}):\n` +
      ctx.tensions.map((t) => `- ${t.senseA} ↔ ${t.senseB}: ${t.severity}`).join("\n"),
    );
  }

  // State signals
  const signals: string[] = [];
  if (ctx.effectiveNE !== undefined) signals.push(`NE=${(ctx.effectiveNE * 100).toFixed(0)}%`);
  if (ctx.cycle !== undefined) signals.push(`cycle=${ctx.cycle}`);
  if (ctx.oscillationCount !== undefined && ctx.oscillationCount > 0) signals.push(`oscillations=${ctx.oscillationCount}`);
  if (ctx.speedOfLightCeiling !== undefined) signals.push(`SoL ceiling=${ctx.speedOfLightCeiling.toFixed(1)}`);
  if (signals.length > 0) {
    sections.push(`SIGNALS: ${signals.join(", ")}`);
  }

  // Failure / flexibility
  if (ctx.failureClassification) {
    sections.push(`FAILURE CLASSIFICATION: ${ctx.failureClassification}`);
  }
  if (ctx.flexibilityDiagnosis) {
    sections.push(`FLEXIBILITY DIAGNOSIS: ${ctx.flexibilityDiagnosis}`);
  }

  // Task
  if (ctx.taskDescription) {
    sections.push(`CURRENT TASK: ${ctx.taskDescription}`);
  }

  // World understanding
  if (ctx.worldMaxims.length > 0) {
    sections.push(
      `WORLD UNDERSTANDING:\n` +
      ctx.worldMaxims.slice(0, 5).map((m) => `- ${m}`).join("\n"),
    );
  }

  // Stream of awareness — what I've noticed
  // When the Parsifal is asking, give full awareness so Claus can answer any question
  // about what's happening. For gate checks, keep it brief.
  if (ctx.awareness && ctx.awareness.length > 0) {
    const isParsifal = ctx.trigger === "parsifal-inbound" || ctx.trigger === "escalation";
    const entries = isParsifal ? ctx.awareness : ctx.awareness.slice(-8);
    sections.push(
      `WHAT I'VE NOTICED (stream of awareness — ${entries.length} insight${entries.length === 1 ? "" : "s"}):\n` +
      entries.map((a) => `- ${a}`).join("\n"),
    );
  }

  // Parsifal message
  if (ctx.parsifalMessage) {
    sections.push(`PARSIFAL MESSAGE: ${ctx.parsifalMessage}`);
  }

  // Escalation
  if (ctx.escalation) {
    let escBlock = `ESCALATION NEEDED:\nSummary: ${ctx.escalation.summary}\nDetail: ${ctx.escalation.detail}`;
    if (ctx.escalation.proposedActions && ctx.escalation.proposedActions.length > 0) {
      escBlock += `\nProposed actions: ${ctx.escalation.proposedActions.join("; ")}`;
    }
    sections.push(escBlock);
  }

  // Lifecycle
  if (ctx.lifecycleEvent) {
    sections.push(`LIFECYCLE EVENT: ${ctx.lifecycleEvent}`);
  }

  // Recent conversation
  if (ctx.recentConversation.length > 0) {
    sections.push(
      `RECENT CONVERSATION:\n` +
      ctx.recentConversation.slice(-8).map((m) => `${m.role}: ${m.text}`).join("\n"),
    );
  }

  return sections.join("\n\n");
}

// ─── Main function ─────────────────────────────────────────────

/**
 * Decide whether to speak, and if so, what to say.
 *
 * This is a cognitive function of the Cortex — the self speaking from
 * genuine understanding. Not an observer interpreting summaries.
 */
export async function communicate(
  ctx: CommunicationContext,
): Promise<CommunicationResult> {
  const model = selectModel(ctx.trigger);
  const system = buildSystemPrompt(ctx);
  const user = buildUserPrompt(ctx);

  // Interactive mode: when the Parsifal is talking and tools are available,
  // use an agentic call so Claus can read files, grep code, run commands
  // before responding. This is what makes idle conversation useful.
  const useAgentic = ctx.trigger === "parsifal-inbound" && !!ctx.pns;

  try {
    let message: string | null;
    let reasoning: string;
    let rawAction: z.infer<typeof CommunicationResponseSchema>["action"];

    if (useAgentic) {
      // Agentic mode: multi-turn with read-only tools
      const toolSet = ctx.pns!.activateToolsForTask(
        "Respond to Parsifal — investigate if needed",
        0.3, // Low NE — conversational, not high-stakes
        "evaluator", // Read-only consumer — Claus doesn't write files in conversation
        ["AskUserQuestion"], // Exclude — our readline handles user interaction, SDK would conflict
      );

      const agenticSystem = system + `\n\nYou have tools available to investigate the project (Read files, Glob for patterns, Grep for code, Bash for commands). Use them freely when the Parsifal asks about the codebase, system state, or anything you need to look up.

If you need clarification from the Parsifal before you can answer fully, just ask in your message — the conversation will continue and they can respond. Don't try to call AskUserQuestion — just include your question in the message.

When done investigating, respond with your final answer.

Your FINAL message must be valid JSON: { "message": "your response", "reasoning": "internal reasoning", "action": { "type": "none" } }`;

      const result = await agenticCall(
        "communication",
        model,
        agenticSystem,
        user,
        toolSet,
      );

      // Parse JSON from the agentic response
      const parsed = extractJsonFromResponse(result.summary);
      message = parsed.message;
      reasoning = parsed.reasoning;
      rawAction = parsed.action;

      log.info("Speaking (agentic)", {
        trigger: ctx.trigger,
        messageLength: message?.length ?? 0,
        toolCalls: result.toolTrace.length,
        turns: result.turns,
      });
    } else {
      // Structured mode: single-turn, fast, no tools
      const response = await callStructured<z.infer<typeof CommunicationResponseSchema>>(
        "communication",
        model,
        system,
        user,
        CommunicationResponseSchema,
        1024,
      );

      message = response.message;
      reasoning = response.reasoning;
      rawAction = response.action;

      if (message) {
        log.info("Speaking", {
          trigger: ctx.trigger,
          messageLength: message.length,
          reasoning: reasoning.slice(0, 100),
        });
      } else {
        log.debug("Silence", {
          trigger: ctx.trigger,
          reasoning: reasoning.slice(0, 100),
        });
      }
    }

    // Map response action to typed ParsifaAction
    const action = rawAction && rawAction.type !== "none"
      ? rawAction as import("../types/communication.js").ParsifaAction
      : undefined;

    if (action) {
      log.info("Action directive", {
        trigger: ctx.trigger,
        actionType: action.type,
      });
    }

    return {
      message,
      reasoning,
      action,
    };
  } catch (err) {
    log.error("Communication failed", {
      trigger: ctx.trigger,
      error: String(err),
    });

    // Graceful degradation: silence on failure for gate triggers,
    // generic acknowledgment for Parsifal inbound
    if (ctx.trigger === "parsifal-inbound") {
      return { message: "I hear you — let me think about that.", reasoning: "fallback after error" };
    }
    if (ctx.trigger === "escalation" && ctx.escalation) {
      return { message: ctx.escalation.summary, reasoning: "fallback: raw escalation summary" };
    }
    return { message: null, reasoning: `error: ${String(err)}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Extract JSON response from agentic call output.
 * The agentic call returns free-text that should contain JSON.
 * Gracefully handles missing JSON by treating the whole response as the message.
 */
function extractJsonFromResponse(text: string): {
  message: string | null;
  reasoning: string;
  action?: z.infer<typeof CommunicationResponseSchema>["action"];
} {
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
      // JSON parse failed — fall through
    }
  }

  // No valid JSON found — treat the entire response as the message.
  // This is the graceful fallback: the LLM investigated with tools
  // and gave a natural language answer instead of JSON.
  return {
    message: text.trim() || null,
    reasoning: "agentic response without JSON wrapper",
  };
}
