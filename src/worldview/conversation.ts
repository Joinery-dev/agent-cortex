/**
 * Worldview Conversation — LLM-driven worldview building with the Parsifal.
 *
 * Not an interview. A conversation. The LLM co-explores the Parsifal's
 * relationship to work, understanding, quality, tension, learning, and
 * collaboration — and when it thinks it has enough, proposes a seed.
 *
 * The Parsifal approves the seed, asks to go deeper, or gives feedback.
 * The conversation runs as long as the Parsifal needs. No artificial limits.
 *
 * Token management: the LLM maintains a running "understanding" summary
 * as part of each response. Only that summary + the last few exchanges
 * are sent each turn — older turns are compressed, not accumulated.
 */

import { callStructured } from "../llm/structured.js";
import { ConversationResponseSchema } from "./types.js";
import type { ConversationTurn, ConversationResponse, WorldviewSeed } from "./types.js";
import type { AskUserFn } from "./discovery.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("worldview-conversation");

/** Number of recent turns to keep verbatim (2 exchanges = 4 turns). */
const VERBATIM_WINDOW = 4;

const SYSTEM = `You are co-building a worldview with someone — the person who will work with an AI cognitive system called Cortex. This worldview will shape how Cortex thinks: how it plans, builds, evaluates, resolves tensions, and learns. You're not interviewing them. You're having a real conversation about how they see work.

YOUR GOAL: Understand six dimensions deeply enough to crystallize them into a worldview seed:
1. **Ontology** — What is the nature of work to them? (Questions? Forces? Craft? Exploration?)
2. **Epistemology** — What counts as understanding? When is something truly "done"?
3. **Axiology** — What do they value? What makes work "good" before analysis?
4. **Tension philosophy** — When two things they care about conflict, what's their instinct?
5. **Learning orientation** — How does doing the work change the doer?
6. **Collaboration model** — How should Cortex relate to them? Follow, push back, interpret?

HOW TO CONVERSE:
- Start by introducing what you're doing and asking something that opens up their relationship to work. Don't list the dimensions. Don't explain the process. Just start talking.
- Follow what's interesting. If they say something surprising about quality, go deeper on quality before moving to the next thing. The best worldviews come from threads, not checklists.
- Share observations. "It sounds like you see tension as a signal, not a problem" — reflecting back shows you're listening and invites correction.
- Be genuinely curious. You're trying to understand a person, not fill out a form.

WHEN TO PROPOSE:
- When you feel you have enough understanding across the six dimensions, propose a seed.
- Present it in human-readable form — not JSON, not field labels. Describe what you've understood about how they see work, what they value, how they handle tension, etc. Include the vocabulary you'd derive.
- Ask if this feels right, or if they want to go deeper or change anything.

AFTER A PROPOSAL:
- If the Parsifal approves (e.g. "yes", "looks good", "that's it"), finalize with the same seed.
- If they give feedback or want changes, incorporate it. You can continue the conversation to explore further, or propose a revised seed — whatever serves the understanding.
- If they want to go deeper on something, go deeper. Then propose again when ready.
- There is no limit. The conversation runs until they're satisfied.

VOCABULARY: When you produce the seed, derive vocabulary that feels native to their ontology. If they see work as exploration, the top unit might be "expedition" and the leaf "step." If they see work as craft, maybe "piece" and "stroke." The vocabulary should feel inevitable, not forced. Include vocabulary in the seed.

UNDERSTANDING FIELD (important for context management):
For "continue" and "propose" actions, you MUST include an "understanding" field — a running summary of what you've understood so far across the six dimensions. Write it as if briefing yourself for the next turn: what has the Parsifal revealed? What's clear, what's still fuzzy, what threads are worth pulling? This summary replaces older conversation history, so it must be complete enough to continue the conversation without seeing the earlier exchanges.

RESPONSE FORMAT (one of three actions):
- Continue the conversation: { "action": "continue", "message": "...", "understanding": "..." }
- Propose a seed for review: { "action": "propose", "message": "readable presentation + ask if it's right", "seed": { ... }, "understanding": "..." }
- Parsifal approved — finalize: { "action": "finalize", "message": "brief acknowledgment", "seed": { ... } }

The "message" in all cases is shown directly to the Parsifal. Make it human. No JSON in the message text.`;

function formatTranscript(
  turns: ConversationTurn[],
  understanding: string | null,
): string {
  if (turns.length === 0) {
    return "This is the start of the conversation. Introduce what you're doing and begin.";
  }

  const parts: string[] = [];

  // If we have an understanding summary and more turns than the window,
  // use the summary + recent window. Otherwise show all turns.
  if (understanding && turns.length > VERBATIM_WINDOW) {
    parts.push(`Your running understanding from earlier in the conversation:\n${understanding}`);
    parts.push("Recent exchanges:");
    const recent = turns.slice(-VERBATIM_WINDOW);
    for (const t of recent) {
      parts.push(t.role === "cortex" ? `You: ${t.message}` : `Parsifal: ${t.message}`);
    }
  } else {
    parts.push("Conversation so far:");
    for (const t of turns) {
      parts.push(t.role === "cortex" ? `You: ${t.message}` : `Parsifal: ${t.message}`);
    }
  }

  parts.push("Continue the conversation — ask more, propose a seed, or finalize if the Parsifal approved.");

  return parts.join("\n\n");
}

/**
 * Run the worldview-building conversation.
 * Runs until the Parsifal approves a proposed seed.
 *
 * @param askUser — callback that presents a message and returns the response
 * @param model — LLM model for conversation turns
 * @returns The Parsifal-approved WorldviewSeed
 */
export async function buildWorldviewConversation(
  askUser: AskUserFn,
  model: string = "opus",
): Promise<WorldviewSeed> {
  const turns: ConversationTurn[] = [];
  let understanding: string | null = null;

  for (;;) {
    const userMessage = formatTranscript(turns, understanding);
    const response: ConversationResponse = await callStructured(
      "worldview-seed",
      model,
      SYSTEM,
      userMessage,
      ConversationResponseSchema,
      4096,
    );

    // Update running understanding from the response
    if (response.action === "continue" || response.action === "propose") {
      understanding = response.understanding;
    }

    if (response.action === "finalize") {
      if (response.message) {
        await askUser(response.message);
      }
      log.info("Worldview conversation complete", { turns: turns.length });
      return response.seed;
    }

    // Both "continue" and "propose" — show message, get response
    turns.push({ role: "cortex", message: response.message });
    const parsifal = await askUser(response.message);
    turns.push({ role: "parsifal", message: parsifal });

    if (response.action === "propose") {
      log.info("Seed proposed, awaiting Parsifal verdict", { turns: turns.length });
    } else {
      log.debug("Conversation turn", { turns: turns.length });
    }
  }
}
