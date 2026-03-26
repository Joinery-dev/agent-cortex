/**
 * Sense Questioner — lightweight mid-build question answering.
 *
 * When the Motor Cortex hits an ambiguity mid-build, the Thalamus routes
 * the question to the most relevant sense. This module calls that sense
 * via callStructured() to get a targeted answer.
 *
 * Pattern follows consul.ts but lighter — a single structured call,
 * not a full consultation cycle.
 */

import { z } from "zod";
import type { Sense } from "../types/sense.js";
import type { SenseQuestionBriefing } from "../types/thalamus.js";
import type { BuildAnswer } from "../types/motor-cortex.js";
import { callStructured } from "../llm/structured.js";
import { senseQuestionSystem, senseQuestionUser } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("sense-questioner");

const SenseAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

/**
 * Ask a sense to answer a mid-build question.
 * Returns a BuildAnswer with source pointing to the sense.
 */
export async function askSense(
  briefing: SenseQuestionBriefing,
  sense: Sense,
  model: string,
): Promise<BuildAnswer> {
  log.info("Asking sense a mid-build question", {
    senseId: sense.id,
    senseName: sense.name,
    questionId: briefing.question.id,
    taskId: briefing.question.taskId,
  });

  const result = await callStructured(
    "consultation",
    model,
    senseQuestionSystem(sense),
    senseQuestionUser(briefing),
    SenseAnswerSchema,
  );

  emit("sense-questioner:answered", {
    senseId: sense.id,
    senseName: sense.name,
    questionId: briefing.question.id,
    confidence: result.confidence,
  });

  log.info("Sense answered mid-build question", {
    senseId: sense.id,
    questionId: briefing.question.id,
    confidence: result.confidence,
  });

  return {
    questionId: briefing.question.id,
    source: { type: "sense", senseId: sense.id },
    answer: result.answer,
    confidence: result.confidence,
    rationale: result.rationale,
  };
}
