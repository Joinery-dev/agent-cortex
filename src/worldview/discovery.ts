/**
 * Worldview Discovery — 7-question interactive flow.
 *
 * Pure askUser interaction, no LLM calls. Gathers the raw material
 * that synthesis distills into a WorldviewSeed.
 *
 * Each question probes a philosophical or relational dimension.
 * Conditional follow-ups deepen short or ambiguous responses.
 */

import type { DiscoveryQuestion, DiscoveryAnswer } from "./types.js";

// ─── Questionnaire ──────────────────────────────────────────────

const OPENING = `I would like to begin by understanding the worldview you would like me to have. How I see the work shapes everything — how I plan, how I build, how I judge quality, how I learn. These questions help me understand how you see it, so I can see it the same way.`;

const QUESTIONS: DiscoveryQuestion[] = [
  {
    number: 1,
    dimension: "ontology",
    question: "When you look at a new project — before any planning, before any code — what do you see in front of you?",
  },
  {
    number: 2,
    dimension: "epistemology",
    question: "Think of a piece of work you're genuinely proud of. What made it *done* — not shipped, not delivered, but done in the way that satisfies?",
  },
  {
    number: 3,
    dimension: "axiology",
    question: "When you encounter excellent work, what quality hits you first? What makes you think 'this is right' before you've analyzed why?",
    options: ["Depth", "Economy", "Clarity", "Surprise", "Other"],
  },
  {
    number: 4,
    dimension: "tension",
    question: "Two things you care about pull in opposite directions. Not a trivial trade-off — a real tension where both sides are right. What's your instinct?",
    options: ["Go deeper", "Find structure", "Hold both", "Choose and move"],
  },
  {
    number: 5,
    dimension: "learning",
    question: "After a project is done, what's different about you? Not what you learned — what shifted in how you see?",
  },
  {
    number: 6,
    dimension: "relationship",
    question: "As we work together, how should I relate to what you tell me? When you give me direction, what's the right balance between following it and questioning it?",
    options: ["Follow + surface", "Push back as equal", "Interpret don't obey", "Depends on stakes"],
  },
  {
    number: 7,
    dimension: "identity",
    question: "Last question. Forget the technical details — what do you want working with me to *feel like*?",
  },
];

// ─── Follow-up logic ────────────────────────────────────────────

const SHORT_THRESHOLD = 20; // words

function isShort(response: string): boolean {
  return response.trim().split(/\s+/).length < SHORT_THRESHOLD;
}

/**
 * Determine follow-up question for a given question + response.
 * Returns null if no follow-up is warranted.
 */
function getFollowUp(q: DiscoveryQuestion, response: string): string | null {
  // Universal: very short responses get a nudge
  if (isShort(response)) {
    return "Can you say more about that?";
  }

  // Question-specific follow-ups
  switch (q.number) {
    case 1: {
      // Extract a key word from their response to reflect back
      const words = response.trim().split(/\s+/);
      const substantive = words.filter((w) => w.length > 4);
      const echoWord = substantive[0] ?? "that";
      return `What makes it feel like ${echoWord} rather than, say, just a list of things to build?`;
    }
    case 2:
      return "Was there a moment where it shifted from 'almost' to 'done'? What happened at that boundary?";
    case 3:
      return "Is there a tension between what you *notice* first and what you think *matters* most?";
    case 4: {
      const normalized = response.trim().toLowerCase();
      if (normalized.includes("depend") || normalized.includes("it depends")) {
        return "What does it depend on?";
      }
      return null;
    }
    case 5:
      return "How would you know if that shift was wrong — if the lesson you took was the wrong one?";
    case 6: {
      const normalized = response.trim().toLowerCase();
      if (normalized.includes("push back") || normalized.includes("equal")) {
        return "When we disagree and neither of us is clearly right, who should win?";
      }
      return null;
    }
    default:
      return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────

export type AskUserFn = (question: string) => Promise<string>;

/**
 * Run the 7-question discovery flow.
 *
 * @param askUser — callback that presents a question and returns the response
 * @returns All answers, including any follow-up responses
 */
export async function runDiscovery(askUser: AskUserFn): Promise<DiscoveryAnswer[]> {
  // Opening message
  await askUser(OPENING + "\n\nPress enter when you're ready to begin, or type anything to start.");

  const answers: DiscoveryAnswer[] = [];

  for (const q of QUESTIONS) {
    // Format the question
    let questionText = `**Question ${q.number} of 7** — *${q.dimension}*\n\n${q.question}`;
    if (q.options) {
      questionText += "\n\n" + q.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
      questionText += "\n\n(Choose a number, or write your own answer)";
    }

    const response = await askUser(questionText);

    // Resolve option selection if applicable
    let resolvedResponse = response;
    if (q.options) {
      const num = parseInt(response.trim(), 10);
      if (num >= 1 && num <= q.options.length) {
        resolvedResponse = q.options[num - 1];
      }
    }

    const answer: DiscoveryAnswer = {
      number: q.number,
      dimension: q.dimension,
      response: resolvedResponse,
    };

    // Check for follow-up
    const followUp = getFollowUp(q, resolvedResponse);
    if (followUp) {
      const followUpResponse = await askUser(followUp);
      answer.followUpResponse = followUpResponse;
    }

    answers.push(answer);
  }

  return answers;
}

/** Exported for testing. */
export { QUESTIONS, OPENING };
