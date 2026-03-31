import { z } from "zod";
import type { SensePerspective, SenseEvaluation } from "../types/sense.js";
import type { Sense } from "../types/sense.js";
import type { Consultation, EvaluationPlanEntry, StakeDistribution, ConsultationConditions } from "../types/consultation.js";
import type { Tension } from "../types/tension.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { ConsultationBriefing } from "../types/thalamus.js";
import type { WeightedEvaluation, WeightedComposite } from "./evaluation-weighter.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { consultationSystem, consultationUser, reconsultationSystem, reconsultationUser, inquirySystem, inquiryUser, followUpInquirySystem, followUpInquiryUser, inquirySynthesisSystem, inquirySynthesisUser, senseManifestSystem, senseManifestUser, visionSynthesisSystem, visionSynthesisUser, senseEvaluationSystem, senseEvaluationUser } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

const log = createLogger("consul");

const PerspectiveResult = z.object({
  perspective: z.string(),
  evaluators: z.array(z.string()),
  stake: z.number().min(0).max(1),
  ceiling: z.number().min(1).max(10),
  ceilingRationale: z.string(),
});

/** Conditions context passed by sensory-cortex to record in the consultation. */
export interface ConsultConditions {
  neLevel?: number;
  mode?: "explore" | "leverage";
  activeSenses: Sense[];
  inhibitedSenses: { senseId: string; reason: string }[];
}

export async function consult(
  briefing: ConsultationBriefing,
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  conditions: ConsultConditions,
): Promise<Consultation> {
  emit("consultation:start", {
    senseCount: senses.length,
    names: senses.map((g) => g.name),
  });

  log.info("Consulting senses", {
    count: senses.length,
    names: senses.map((g) => g.name),
  });

  const userPrompt = consultationUser(briefing);

  // Consult all senses in parallel
  const perspectivePromises = senses.map(async (sense) => {
    const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);

    try {
      const result = await callStructured(
        "consultation",
        config.models.consultation,
        consultationSystem(sense, subTree),
        userPrompt,
        PerspectiveResult
      );

      const perspective: SensePerspective = {
        senseId: sense.id,
        senseName: sense.name,
        perspective: result.perspective,
        evaluators: result.evaluators,
        stake: result.stake,
        ceiling: result.ceiling,
        ceilingRationale: result.ceilingRationale,
      };

      emit("consultation:perspective", {
        sense: sense.name,
        perspectiveLength: result.perspective.length,
        evaluatorCount: result.evaluators.length,
        evaluators: result.evaluators,
        stake: result.stake,
      });

      getContentStore().record({
        eventSeq: null, kind: "consultation", timestamp: new Date().toISOString(),
        component: "consultation", taskId: briefing.task.id,
        inputs: [
          contentBlock(`${sense.name} system prompt`, consultationSystem(sense, subTree)),
          contentBlock("Consultation briefing (user prompt)", userPrompt),
        ],
        outputs: [
          contentBlock(`${sense.name} perspective`, result.perspective),
          contentBlock("Evaluators selected", result.evaluators.join(", ")),
        ],
        routing: { destinations: ["evaluation-plan", "motor-cortex (via motor briefing)"] },
      });

      log.info(`${sense.name} perspective`, {
        words: result.perspective.split(/\s+/).length,
        evaluators: result.evaluators.length,
      });

      return perspective;
    } catch (err) {
      log.warn(`Consultation failed for ${sense.name}`, { error: String(err) });
      emitWarn(
        "consultation:fallback:sense-muted",
        {
          senseId: sense.id,
          senseName: sense.name,
          taskId: briefing.task.id,
          error: String(err),
        },
        {
          component: "consul",
          expected: "SensePerspective with stake > 0",
          received: "fallback perspective with stake=0, no evaluators",
        },
      );

      // Return a perspective noting the failure rather than silencing this sense
      return {
        senseId: sense.id,
        senseName: sense.name,
        perspective: `[Consultation failed: ${String(err)}]`,
        evaluators: [],
        stake: 0,
        ceiling: 10,
        ceilingRationale: "No ceiling estimate — consultation failed.",
      } satisfies SensePerspective;
    }
  });

  const perspectives = await Promise.all(perspectivePromises);

  // Derive evaluation plan: flatten receptor → parent sense relationships
  const evaluationPlan: EvaluationPlanEntry[] = [];
  for (const perspective of perspectives) {
    for (const receptorId of perspective.evaluators) {
      evaluationPlan.push({
        receptorId,
        parentSenseId: perspective.senseId,
        parentSenseName: perspective.senseName,
        parentStake: perspective.stake,
        parentPerspective: perspective.perspective,
      });
    }
  }

  // Derive stake distribution
  const stakeEntries = perspectives.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    stake: p.stake,
  }));
  const totalStake = stakeEntries.reduce((sum, e) => sum + e.stake, 0);
  const meanStake = stakeEntries.length > 0 ? totalStake / stakeEntries.length : 0;
  const maxEntry = stakeEntries.reduce(
    (max, e) => (e.stake > max.stake ? e : max),
    { senseId: "", senseName: "", stake: 0 },
  );

  const stakeDistribution: StakeDistribution = {
    entries: stakeEntries,
    totalStake,
    meanStake,
    max: maxEntry,
  };

  // Assemble conditions
  const consultationConditions: ConsultationConditions = {
    neLevel: conditions.neLevel,
    mode: conditions.mode,
    activeSenses: conditions.activeSenses.map((s) => ({ senseId: s.id, senseName: s.name })),
    inhibitedSenses: conditions.inhibitedSenses,
  };

  const consultation: Consultation = {
    taskId: briefing.task.id,
    producedAt: new Date(),
    perspectives,
    evaluationPlan,
    stakeDistribution,
    conditions: consultationConditions,
    generation: 0,
  };

  const totalEvaluators = evaluationPlan.length;

  emit("consultation:complete", {
    perspectives: perspectives.length,
    totalEvaluators,
    senses: perspectives.map((p) => ({
      name: p.senseName,
      words: p.perspective.split(/\s+/).length,
      evaluators: p.evaluators.length,
      stake: p.stake,
    })),
    stakeDistribution: {
      totalStake: stakeDistribution.totalStake,
      meanStake: stakeDistribution.meanStake,
      max: stakeDistribution.max.senseName,
    },
  });

  log.info("Consultation complete", {
    perspectives: perspectives.length,
    totalEvaluators,
    meanStake: stakeDistribution.meanStake.toFixed(2),
  });

  return consultation;
}

// ─── INQUIRY (Phase 1a) ────────────────────────────────────

export interface InquiryQuestion {
  question: string;
  why: string;
}

export interface SenseInquiry {
  senseId: string;
  senseName: string;
  questions: InquiryQuestion[];
  stake: number;
}

const InquiryResultSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    why: z.string(),
  })),
  stake: z.number().min(0).max(1),
});

/**
 * Run senses in inquiry mode — each sense asks clarifying questions
 * from its perspective before advising. Returns per-sense questions
 * with stakes indicating how much guidance depends on answers.
 */
export async function inquire(
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  intent: import("../types/intent.js").ProjectIntent,
  taste: import("../types/intent.js").TasteProfile,
): Promise<SenseInquiry[]> {
  emit("inquiry:start", {
    senseCount: senses.length,
    names: senses.map((s) => s.name),
  });

  log.info("Running inquiry", { count: senses.length });

  const userPrompt = inquiryUser(intent, taste);

  const results = await Promise.all(
    senses.map(async (sense) => {
      const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);
      try {
        const result = await callStructured(
          "inquiry",
          config.models.consultation,
          inquirySystem(sense, subTree),
          userPrompt,
          InquiryResultSchema,
        );

        emit("inquiry:sense-complete", {
          sense: sense.name,
          questionCount: result.questions.length,
          stake: result.stake,
        });

        log.info(`${sense.name} inquiry`, {
          questions: result.questions.length,
          stake: result.stake,
        });

        return {
          senseId: sense.id,
          senseName: sense.name,
          questions: result.questions,
          stake: result.stake,
        };
      } catch (err) {
        log.warn(`Inquiry failed for ${sense.name}`, { error: String(err) });
        return {
          senseId: sense.id,
          senseName: sense.name,
          questions: [],
          stake: 0,
        };
      }
    }),
  );

  const withQuestions = results.filter((r) => r.questions.length > 0);
  const totalQuestions = withQuestions.reduce((sum, r) => sum + r.questions.length, 0);

  emit("inquiry:complete", {
    sensesWithQuestions: withQuestions.length,
    totalQuestions,
  });

  log.info("Inquiry complete", {
    sensesWithQuestions: withQuestions.length,
    totalQuestions,
  });

  return results;
}

/**
 * Follow-up inquiry — senses review previous Q&A and ask follow-ups
 * or declare they understand enough. Convergence = no senses have questions.
 */
export async function followUpInquire(
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  intent: import("../types/intent.js").ProjectIntent,
  taste: import("../types/intent.js").TasteProfile,
  previousQA: string,
  round: number,
): Promise<SenseInquiry[]> {
  emit("inquiry:follow-up-start", {
    round,
    senseCount: senses.length,
    names: senses.map((s) => s.name),
  });

  log.info("Running follow-up inquiry", { round, count: senses.length });

  const userPrompt = followUpInquiryUser(intent, taste, previousQA);

  const results = await Promise.all(
    senses.map(async (sense) => {
      const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);
      try {
        const result = await callStructured(
          "inquiry",
          config.models.consultation,
          followUpInquirySystem(sense, subTree, round),
          userPrompt,
          InquiryResultSchema,
        );

        emit("inquiry:sense-complete", {
          sense: sense.name,
          round,
          questionCount: result.questions.length,
          stake: result.stake,
        });

        log.info(`${sense.name} follow-up inquiry`, {
          round,
          questions: result.questions.length,
          stake: result.stake,
        });

        return {
          senseId: sense.id,
          senseName: sense.name,
          questions: result.questions,
          stake: result.stake,
        };
      } catch (err) {
        log.warn(`Follow-up inquiry failed for ${sense.name}`, { error: String(err) });
        return {
          senseId: sense.id,
          senseName: sense.name,
          questions: [],
          stake: 0,
        };
      }
    }),
  );

  const withQuestions = results.filter((r) => r.questions.length > 0);
  const totalQuestions = withQuestions.reduce((sum, r) => sum + r.questions.length, 0);

  emit("inquiry:follow-up-complete", {
    round,
    sensesWithQuestions: withQuestions.length,
    totalQuestions,
    converged: withQuestions.length === 0,
  });

  log.info("Follow-up inquiry complete", {
    round,
    sensesWithQuestions: withQuestions.length,
    totalQuestions,
    converged: withQuestions.length === 0,
  });

  return results;
}

// ─── INQUIRY SYNTHESIS ──────────────────────────────────────

export interface SynthesizedQuestion {
  question: string;
  senseIds: string[];
  senseNames: string[];
  maxStake: number;
  cluster: string;
}

export interface SynthesizedInquiry {
  essential: SynthesizedQuestion[];
  helpful: SynthesizedQuestion[];
  optional: SynthesizedQuestion[];
  droppedCount: number;
  /** Original per-sense inquiries preserved for downstream routing. */
  sources: SenseInquiry[];
}

const SynthesizedQuestionSchema = z.object({
  question: z.string(),
  senseIds: z.array(z.string()),
  senseNames: z.array(z.string()),
  maxStake: z.number().min(0).max(1),
  cluster: z.string(),
});

const InquirySynthesisResultSchema = z.object({
  essential: z.array(SynthesizedQuestionSchema).max(7),
  helpful: z.array(SynthesizedQuestionSchema),
  optional: z.array(SynthesizedQuestionSchema),
  droppedCount: z.number().min(0),
});

/**
 * Synthesize raw per-sense inquiries into a merged, deduplicated, tiered set.
 * One LLM call that clusters by topic, picks the sharpest phrasing, and tiers
 * by aggregate stake.
 */
export async function synthesizeInquiry(
  inquiries: SenseInquiry[],
  config: CortexConfig,
  intent: import("../types/intent.js").ProjectIntent,
): Promise<SynthesizedInquiry> {
  const withQuestions = inquiries.filter((r) => r.questions.length > 0);
  const totalQuestions = withQuestions.reduce((sum, r) => sum + r.questions.length, 0);

  emit("inquiry-synthesis:start", {
    senseCount: withQuestions.length,
    totalQuestions,
  });

  log.info("Synthesizing inquiry", { senses: withQuestions.length, questions: totalQuestions });

  const result = await callStructured(
    "inquiry-synthesis",
    config.models.consultation,
    inquirySynthesisSystem(),
    inquirySynthesisUser(withQuestions, intent),
    InquirySynthesisResultSchema,
  );

  const synthesized: SynthesizedInquiry = {
    ...result,
    sources: inquiries,
  };

  const totalSynthesized = result.essential.length + result.helpful.length + result.optional.length;

  emit("inquiry-synthesis:complete", {
    essential: result.essential.length,
    helpful: result.helpful.length,
    optional: result.optional.length,
    droppedCount: result.droppedCount,
    totalOriginal: totalQuestions,
    totalSynthesized,
  });

  getContentStore().record({
    eventSeq: null,
    kind: "inquiry-synthesis",
    timestamp: new Date().toISOString(),
    component: "inquiry-synthesis",
    taskId: null,
    inputs: [contentBlock("Synthesis input", inquirySynthesisUser(withQuestions, intent))],
    outputs: [contentBlock("Synthesized inquiry", JSON.stringify(result, null, 2))],
  });

  log.info("Inquiry synthesized", {
    essential: result.essential.length,
    helpful: result.helpful.length,
    optional: result.optional.length,
    dropped: result.droppedCount,
    reduction: `${totalQuestions} → ${totalSynthesized}`,
  });

  return synthesized;
}

/**
 * Format synthesized inquiry into a tiered, numbered message for the Parsifal.
 */
export function formatSynthesizedForParsifal(
  synthesis: SynthesizedInquiry,
  intent: import("../types/intent.js").ProjectIntent,
): string {
  const sections: string[] = [];
  sections.push(`Before I build a vision for "${intent.summary}", a few questions:\n`);

  let questionNum = 1;

  if (synthesis.essential.length > 0) {
    sections.push("**Essential** (these shape the approach):");
    for (const q of synthesis.essential) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  if (synthesis.helpful.length > 0) {
    sections.push("**If you have time** (these refine details):");
    for (const q of synthesis.helpful) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  if (synthesis.optional.length > 0) {
    sections.push("**Optional** (I can decide these myself):");
    for (const q of synthesis.optional) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  sections.push("For anything you'd rather leave to my judgment, just say so.");

  return sections.join("\n");
}

/**
 * Format synthesized follow-up inquiry for the Parsifal.
 * Same tiering as the initial round, different framing.
 */
export function formatSynthesizedFollowUpForParsifal(
  synthesis: SynthesizedInquiry,
  intent: import("../types/intent.js").ProjectIntent,
): string {
  const sections: string[] = [];
  sections.push(`Based on your answers, a few follow-up questions:\n`);

  let questionNum = 1;

  if (synthesis.essential.length > 0) {
    sections.push("**Essential** (these shape the approach):");
    for (const q of synthesis.essential) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  if (synthesis.helpful.length > 0) {
    sections.push("**If you have time** (these refine details):");
    for (const q of synthesis.helpful) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  if (synthesis.optional.length > 0) {
    sections.push("**Optional** (I can decide these myself):");
    for (const q of synthesis.optional) {
      sections.push(`${questionNum}. ${q.question}`);
      questionNum++;
    }
    sections.push("");
  }

  sections.push("For anything you'd rather leave to my judgment, just say so.");

  return sections.join("\n");
}

/**
 * Build the downstream inquiry context string from synthesized questions + answers.
 * Preserves sense attribution so manifestation knows which senses each answer feeds.
 */
export function buildSynthesizedInquiryContext(
  synthesis: SynthesizedInquiry,
  answers: string,
): string {
  const allQuestions = [
    ...synthesis.essential,
    ...synthesis.helpful,
    ...synthesis.optional,
  ];

  const sourceSenseCount = synthesis.sources.filter((s) => s.questions.length > 0).length;

  const qaParts: string[] = [];
  for (let i = 0; i < allQuestions.length; i++) {
    const q = allQuestions[i];
    const senseTag = q.senseNames.join(", ");
    qaParts.push(`${i + 1}. [${senseTag}] ${q.question}`);
  }

  return [
    `Questions asked (synthesized from ${sourceSenseCount} senses):`,
    ...qaParts,
    ``,
    `Parsifal's answers:`,
    answers,
  ].join("\n");
}

/**
 * Format inquiry results into a human-readable message.
 * Groups questions by sense with context on why each matters.
 */
export function formatInquiryForParsifal(
  inquiries: SenseInquiry[],
  intent: import("../types/intent.js").ProjectIntent,
  round?: number,
): string {
  const sections: string[] = [];

  if (!round || round === 1) {
    sections.push(`Before I build a vision for "${intent.summary}", I have some questions from different perspectives:\n`);
  } else {
    sections.push(`Based on your answers, some perspectives have follow-up questions:\n`);
  }

  for (const inquiry of inquiries) {
    if (inquiry.questions.length === 0) continue;
    sections.push(`**${inquiry.senseName}:**`);
    for (const q of inquiry.questions) {
      sections.push(`- ${q.question}`);
    }
    sections.push("");
  }

  sections.push("Please answer what you can. For anything you'd rather leave to my judgment, just say so.");

  return sections.join("\n");
}

/**
 * Format the manifested future for Parsifal approval.
 */
export function formatApprovalForParsifal(
  future: import("../types/planner.js").ManifestedFuture,
): string {
  const sections: string[] = [];
  sections.push("Here's the concrete vision for this project:\n");
  sections.push(future.vision);

  const contributions = Object.entries(future.senseContributions);
  if (contributions.length > 0) {
    sections.push("\n**Per-dimension assessments:**");
    for (const [sense, contribution] of contributions) {
      sections.push(`- **${sense}:** ${contribution}`);
    }
  }

  sections.push(`\nConfidence: ${(future.confidence * 100).toFixed(0)}%`);
  sections.push("\nIs this what you see? Confirm to proceed, or tell me what's different.");

  return sections.join("\n");
}

// ─── RE-CONSULTATION ────────────────────────────────────────

/** Input for selective re-consultation after the senses have seen actual work. */
export interface ReconsultInput {
  previousConsultation: Consultation;
  work: string;
  evaluations: SenseEvaluation[];
  weighted: WeightedEvaluation[];
  composite: WeightedComposite;
  tensions: Tension[];
}

/**
 * Selective re-consultation: only senses with improvement potential or
 * tension involvement re-engage. Others keep their previous perspective.
 *
 * Returns a new Consultation with updated perspectives merged with preserved ones.
 */
export async function reconsult(
  input: ReconsultInput,
  sensesToReconsult: string[],
  briefing: ConsultationBriefing,
  library: SensoryCortex,
  config: CortexConfig,
  conditions: ConsultConditions,
): Promise<Consultation> {
  const reconsultSet = new Set(sensesToReconsult);
  const previousByIds = new Map(
    input.previousConsultation.perspectives.map((p) => [p.senseId, p]),
  );

  // Partition senses into re-consult vs preserve
  const preservedPerspectives: SensePerspective[] = [];
  const sensesToCall: { sense: Sense; previous: SensePerspective }[] = [];

  for (const perspective of input.previousConsultation.perspectives) {
    if (reconsultSet.has(perspective.senseId)) {
      const sense = library.get(perspective.senseId);
      if (sense) {
        sensesToCall.push({ sense, previous: perspective });
      } else {
        preservedPerspectives.push(perspective);
      }
    } else {
      preservedPerspectives.push(perspective);
    }
  }

  emit("reconsultation:start", {
    taskId: input.previousConsultation.taskId,
    generation: input.previousConsultation.generation + 1,
    reconsultingSenses: sensesToCall.map((s) => s.sense.name),
    preservedSenses: preservedPerspectives.map((p) => p.senseName),
  });

  log.info("Re-consulting senses", {
    reconsulting: sensesToCall.map((s) => s.sense.name),
    preserved: preservedPerspectives.length,
  });

  // Build summaries of other senses' evaluations for context
  const buildOtherSummaries = (excludeSenseId: string) => {
    const others: { senseName: string; score: number; assessment: string }[] = [];
    for (const w of input.weighted) {
      const rootSenseName = w.activationPath[0];
      const rootSense = input.previousConsultation.perspectives.find(
        (p) => p.senseName === rootSenseName,
      );
      if (rootSense && rootSense.senseId !== excludeSenseId) {
        others.push({
          senseName: w.activationPath.join(" > "),
          score: w.score,
          assessment: w.assessment,
        });
      }
    }
    return others;
  };

  // Re-consult selected senses in parallel
  const updatedPromises = sensesToCall.map(async ({ sense, previous }) => {
    const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);

    // Gather this sense's own receptor evaluations
    const ownEvals = input.evaluations.filter((e) => {
      const rootName = e.activationPath[0];
      return rootName === sense.name;
    });

    // Gather tensions involving this sense
    const relevantTensions = input.tensions.filter(
      (t) => t.senseA.path[0] === sense.name || t.senseB.path[0] === sense.name,
    );

    try {
      const result = await callStructured(
        "reconsultation",
        config.models.consultation,
        reconsultationSystem(sense, subTree),
        reconsultationUser({
          briefing,
          work: input.work,
          previousPerspective: previous,
          ownEvaluations: ownEvals,
          otherEvaluationSummaries: buildOtherSummaries(sense.id),
          tensions: relevantTensions,
        }),
        PerspectiveResult,
      );

      const updated: SensePerspective = {
        senseId: sense.id,
        senseName: sense.name,
        perspective: result.perspective,
        evaluators: result.evaluators,
        stake: result.stake,
        ceiling: result.ceiling,
        ceilingRationale: result.ceilingRationale,
      };

      emit("reconsultation:perspective", {
        sense: sense.name,
        stakeChange: updated.stake - previous.stake,
        perspectiveLength: updated.perspective.length,
        evaluatorChange: JSON.stringify(updated.evaluators) !== JSON.stringify(previous.evaluators),
      });

      log.info(`${sense.name} re-consulted`, {
        stakeChange: (updated.stake - previous.stake).toFixed(2),
        newEvaluators: updated.evaluators.length,
      });

      return updated;
    } catch (err) {
      log.warn(`Re-consultation failed for ${sense.name}, preserving previous`, {
        error: String(err),
      });
      emitWarn(
        "reconsultation:fallback:preserved-previous",
        {
          senseId: sense.id,
          senseName: sense.name,
          taskId: input.previousConsultation.taskId,
          generation: input.previousConsultation.generation + 1,
          error: String(err),
        },
        {
          component: "consul",
          expected: "updated perspective from re-consultation",
          received: "preserved previous perspective (stale)",
        },
      );
      return previous;
    }
  });

  const updatedPerspectives = await Promise.all(updatedPromises);

  // Merge: updated perspectives + preserved perspectives
  const mergedPerspectives = [...preservedPerspectives, ...updatedPerspectives];

  // Recompute evaluation plan from merged perspectives
  const evaluationPlan: EvaluationPlanEntry[] = [];
  for (const perspective of mergedPerspectives) {
    for (const receptorId of perspective.evaluators) {
      evaluationPlan.push({
        receptorId,
        parentSenseId: perspective.senseId,
        parentSenseName: perspective.senseName,
        parentStake: perspective.stake,
        parentPerspective: perspective.perspective,
      });
    }
  }

  // Recompute stake distribution
  const stakeEntries = mergedPerspectives.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    stake: p.stake,
  }));
  const totalStake = stakeEntries.reduce((sum, e) => sum + e.stake, 0);
  const meanStake = stakeEntries.length > 0 ? totalStake / stakeEntries.length : 0;
  const maxEntry = stakeEntries.reduce(
    (max, e) => (e.stake > max.stake ? e : max),
    { senseId: "", senseName: "", stake: 0 },
  );

  const stakeDistribution: StakeDistribution = {
    entries: stakeEntries,
    totalStake,
    meanStake,
    max: maxEntry,
  };

  const consultationConditions: ConsultationConditions = {
    neLevel: conditions.neLevel,
    mode: conditions.mode,
    activeSenses: conditions.activeSenses.map((s) => ({ senseId: s.id, senseName: s.name })),
    inhibitedSenses: conditions.inhibitedSenses,
  };

  const newGeneration = input.previousConsultation.generation + 1;
  const preservedSenseIds = preservedPerspectives.map((p) => p.senseId);

  const consultation: Consultation = {
    taskId: input.previousConsultation.taskId,
    producedAt: new Date(),
    perspectives: mergedPerspectives,
    evaluationPlan,
    stakeDistribution,
    conditions: consultationConditions,
    generation: newGeneration,
    preservedSenseIds,
  };

  emit("reconsultation:complete", {
    taskId: consultation.taskId,
    generation: newGeneration,
    reconsultedCount: updatedPerspectives.length,
    preservedCount: preservedPerspectives.length,
    stakeDistribution: {
      totalStake: stakeDistribution.totalStake,
      meanStake: stakeDistribution.meanStake,
      max: stakeDistribution.max.senseName,
    },
  });

  log.info("Re-consultation complete", {
    generation: newGeneration,
    reconsulted: updatedPerspectives.length,
    preserved: preservedPerspectives.length,
    meanStake: stakeDistribution.meanStake.toFixed(2),
  });

  return consultation;
}

// ─── MANIFESTATION SYNTHESIS ──────────────────────────────────
// Phase 1b replacement: sense perspectives → synthesis → sense evaluation → convergence.

export interface SenseManifestPerspective {
  senseId: string;
  senseName: string;
  perspective: string;
  tensions: string[];
  confidence: number;
}

export interface SenseEvalResult {
  senseId: string;
  senseName: string;
  satisfied: boolean;
  assessment: string;
  feedback: string;
  confidence: number;
}

export interface VisionSynthesis {
  vision: string;
  senseContributions: Record<string, string>;
  tensionResolutions: Array<{ tension: string; resolution: string }>;
  confidence: number;
}

const ManifestResultSchema = z.object({
  perspective: z.string(),
  tensions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const VisionSynthesisSchema = z.object({
  vision: z.string(),
  senseContributions: z.record(z.string(), z.string()),
  tensionResolutions: z.array(z.object({
    tension: z.string(),
    resolution: z.string(),
  })),
  confidence: z.number().min(0).max(1),
});

const SenseEvalSchema = z.object({
  satisfied: z.boolean(),
  assessment: z.string(),
  feedback: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * Step 1: Each sense describes what the finished product looks like
 * from its perspective. Parallel structured calls.
 */
export async function manifestSenses(
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  intent: import("../types/intent.js").ProjectIntent,
  taste: import("../types/intent.js").TasteProfile,
  inquiryContext?: string,
): Promise<SenseManifestPerspective[]> {
  emit("manifestation-synthesis:sense-manifest-start", {
    senseCount: senses.length,
    names: senses.map((s) => s.name),
  });

  log.info("Senses manifesting perspectives", { count: senses.length });

  const userPrompt = senseManifestUser(intent, taste, inquiryContext);

  const results = await Promise.all(
    senses.map(async (sense) => {
      const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);
      try {
        const result = await callStructured(
          "manifestation-sense",
          config.models.consultation,
          senseManifestSystem(sense, subTree),
          userPrompt,
          ManifestResultSchema,
        );

        emit("manifestation-synthesis:sense-manifest-complete", {
          sense: sense.name,
          tensionCount: result.tensions.length,
          confidence: result.confidence,
        });

        log.info(`${sense.name} manifested`, {
          tensionCount: result.tensions.length,
          confidence: result.confidence,
        });

        return {
          senseId: sense.id,
          senseName: sense.name,
          perspective: result.perspective,
          tensions: result.tensions,
          confidence: result.confidence,
        };
      } catch (err) {
        log.warn(`Manifestation failed for ${sense.name}`, { error: String(err) });
        return {
          senseId: sense.id,
          senseName: sense.name,
          perspective: "",
          tensions: [],
          confidence: 0,
        };
      }
    }),
  );

  const store = getContentStore();
  store.record({
    eventSeq: null, kind: "manifestation", timestamp: new Date().toISOString(),
    component: "consul", taskId: "manifestation-synthesis",
    inputs: [contentBlock("Sense count", String(senses.length))],
    outputs: [contentBlock("Sense perspectives", JSON.stringify(results.map((r) => ({ sense: r.senseName, perspective: r.perspective.slice(0, 200), tensions: r.tensions })), null, 2))],
  });

  emit("manifestation-synthesis:sense-manifest-done", {
    total: results.length,
    withPerspectives: results.filter((r) => r.perspective.length > 0).length,
  });

  log.info("Sense manifestation complete", {
    total: results.length,
    withPerspectives: results.filter((r) => r.perspective.length > 0).length,
  });

  return results;
}

/**
 * Step 2: Synthesize sense perspectives into a unified vision.
 * Single structured call.
 */
export async function synthesizeVision(
  perspectives: SenseManifestPerspective[],
  config: CortexConfig,
  intent: import("../types/intent.js").ProjectIntent,
  taste: import("../types/intent.js").TasteProfile,
  inquiryContext?: string,
  feedback?: string,
): Promise<VisionSynthesis> {
  emit("manifestation-synthesis:synthesize-start", {
    perspectiveCount: perspectives.length,
    hasFeedback: !!feedback,
  });

  log.info("Synthesizing vision", {
    perspectiveCount: perspectives.length,
    hasFeedback: !!feedback,
  });

  const result = await callStructured(
    "manifestation-synthesis",
    config.models.consultation,
    visionSynthesisSystem(),
    visionSynthesisUser(perspectives, intent, taste, inquiryContext, feedback),
    VisionSynthesisSchema,
  );

  const store = getContentStore();
  store.record({
    eventSeq: null, kind: "manifestation", timestamp: new Date().toISOString(),
    component: "consul", taskId: "manifestation-synthesis",
    inputs: [contentBlock("Perspectives", String(perspectives.length))],
    outputs: [contentBlock("Synthesized vision", result.vision.slice(0, 500))],
  });

  emit("manifestation-synthesis:synthesize-complete", {
    visionLength: result.vision.length,
    tensionResolutions: result.tensionResolutions.length,
    confidence: result.confidence,
  });

  log.info("Vision synthesized", {
    visionLength: result.vision.length,
    tensionResolutions: result.tensionResolutions.length,
    confidence: result.confidence,
  });

  return result;
}

/**
 * Step 3: Each sense evaluates the synthesized vision.
 * Parallel structured calls. Returns satisfaction signals + feedback.
 */
export async function evaluateVision(
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
  vision: string,
  senseContributions: Record<string, string>,
  tensionResolutions: Array<{ tension: string; resolution: string }>,
): Promise<SenseEvalResult[]> {
  emit("manifestation-synthesis:sense-eval-start", {
    senseCount: senses.length,
  });

  log.info("Senses evaluating vision", { count: senses.length });

  const userPrompt = senseEvaluationUser(vision, senseContributions, tensionResolutions);

  const results = await Promise.all(
    senses.map(async (sense) => {
      const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);
      try {
        const result = await callStructured(
          "manifestation-eval",
          config.models.consultation,
          senseEvaluationSystem(sense, subTree),
          userPrompt,
          SenseEvalSchema,
        );

        emit("manifestation-synthesis:sense-eval-complete", {
          sense: sense.name,
          satisfied: result.satisfied,
          confidence: result.confidence,
        });

        log.info(`${sense.name} evaluation`, {
          satisfied: result.satisfied,
          confidence: result.confidence,
        });

        return {
          senseId: sense.id,
          senseName: sense.name,
          satisfied: result.satisfied,
          assessment: result.assessment,
          feedback: result.feedback,
          confidence: result.confidence,
        };
      } catch (err) {
        log.warn(`Vision evaluation failed for ${sense.name}`, { error: String(err) });
        return {
          senseId: sense.id,
          senseName: sense.name,
          satisfied: true,
          assessment: "[Evaluation failed]",
          feedback: "",
          confidence: 0,
        };
      }
    }),
  );

  const satisfied = results.filter((r) => r.satisfied).length;
  const unsatisfied = results.filter((r) => !r.satisfied).length;

  const store = getContentStore();
  store.record({
    eventSeq: null, kind: "manifestation", timestamp: new Date().toISOString(),
    component: "consul", taskId: "manifestation-synthesis",
    inputs: [contentBlock("Vision length", String(vision.length))],
    outputs: [contentBlock("Evaluation results", JSON.stringify({ satisfied, unsatisfied, feedback: results.filter((r) => !r.satisfied).map((r) => `[${r.senseName}] ${r.feedback.slice(0, 200)}`) }, null, 2))],
  });

  emit("manifestation-synthesis:sense-eval-done", {
    satisfied,
    unsatisfied,
  });

  log.info("Vision evaluation complete", { satisfied, unsatisfied });

  return results;
}
