// @ts-nocheck — This file is deprecated and not compiled/used.
/**
 * @deprecated — Replaced by the brainstem rhythm system.
 * The logic in this file has been lifted into:
 *   - src/brainstem/rhythms/build-cycle.ts (inner loop)
 *   - src/brainstem/rhythms/sensory-cortex.ts (outer function)
 *
 * The Cortex class now uses Brainstem.runTask() instead of runTask().
 * This file is kept temporarily for reference/comparison.
 */

import type { ProjectIntent, TasteProfile, DecisionRecord } from "../types/intent.js";
import type { Task } from "../types/task.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { OrchestratorResult, CortexConfig } from "../types/orchestrator.js";
import type { Tension, TensionResolution } from "../types/tension.js";
import { SensoryCortex } from "../senses/cortex.js";
import { consult } from "./consul.js";
import { build } from "./motor-cortex.js";
import { evaluate } from "./evaluator.js";
import { detectTensions, resolve } from "./resolver.js";
import { assembleMotorPrompt, revisionPrompt } from "../llm/prompts.js";
import { addEvent } from "../types/task.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("orchestrator");

export async function runTask(
  task: Task,
  intent: ProjectIntent,
  taste: TasteProfile,
  library: SensoryCortex,
  config: CortexConfig
): Promise<OrchestratorResult> {
  const decisionLog: DecisionRecord[] = [];
  let cycles = 0;
  let allTensions: Tension[] = [];
  let allResolutions: TensionResolution[] = [];
  let lastEvaluations: SenseEvaluation[] = [];

  emit("task:start", {
    id: task.id,
    description: task.description,
    maxCycles: config.maxCycles,
  });

  log.info("Starting task", {
    id: task.id,
    description: task.description,
    maxCycles: config.maxCycles,
  });

  // ─── Step 1: Consultation ────────────────────────────────────
  task.status = "consulting";
  addEvent(task, "status_change", { status: "consulting" });

  const consultation = await consult(task, intent, taste, library, config);
  const totalEvaluators = consultation.perspectives.reduce(
    (sum, p) => sum + p.evaluators.length,
    0
  );
  addEvent(task, "consultation_result", {
    perspectives: consultation.perspectives.length,
    totalEvaluators,
    senses: consultation.perspectives.map((p) => p.senseName),
  });

  logDecision(
    decisionLog,
    "consultation",
    `Consulted ${consultation.perspectives.length} senses, ${totalEvaluators} receptors selected for evaluation`,
    0.9
  );

  if (totalEvaluators === 0) {
    log.warn("No evaluators selected — senses had nothing to evaluate");
  }

  // ─── Step 2: Build-Evaluate-Resolve Loop ───────────────────
  const basePrompt = assembleMotorPrompt(task, intent, taste, consultation);
  let currentPrompt = basePrompt;
  let work: string | null = null;

  while (cycles < config.maxCycles) {
    cycles++;
    emit("cycle:start", { cycle: cycles, maxCycles: config.maxCycles });
    log.info(`Cycle ${cycles}/${config.maxCycles}`);

    // Build
    task.status = "producing";
    addEvent(task, "status_change", { status: "producing", cycle: cycles });

    work = await build(currentPrompt, config, work ?? undefined);
    addEvent(task, "work_produced", { cycle: cycles, length: work.length });

    // Evaluate
    task.status = "evaluating";
    addEvent(task, "status_change", { status: "evaluating", cycle: cycles });

    lastEvaluations = await evaluate(consultation, task, work, library, config);
    addEvent(task, "evaluation", {
      cycle: cycles,
      scores: lastEvaluations.map((e) => ({
        path: e.activationPath.join(" > "),
        score: e.score,
      })),
    });

    // Detect tensions
    const tensions = detectTensions(lastEvaluations, task.id);
    allTensions = [...allTensions, ...tensions];

    emit("tension:detection-complete", {
      count: tensions.length,
      tensions: tensions.map((t) => ({
        severity: t.severity,
        senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score },
        senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score },
      })),
    });

    if (tensions.length > 0) {
      addEvent(task, "tension_detected", {
        cycle: cycles,
        tensions: tensions.map((t) => ({
          description: t.description,
          severity: t.severity,
        })),
      });
    }

    // Check if we're done
    const minScore = Math.min(...lastEvaluations.map((e) => e.score));
    const highTensions = tensions.filter((t) => t.severity === "high");

    log.info("Cycle result", {
      cycle: cycles,
      minScore,
      highTensions: highTensions.length,
      allScores: lastEvaluations.map((e) => e.score),
    });

    if (minScore >= config.acceptableMinScore && highTensions.length === 0) {
      task.status = "complete";
      addEvent(task, "status_change", { status: "complete" });

      logDecision(
        decisionLog,
        "completion",
        `Task completed in ${cycles} cycle(s). Min score: ${minScore}. No high-severity tensions.`,
        computeConfidence(lastEvaluations)
      );

      const result = {
        taskId: task.id,
        status: "complete" as const,
        work,
        evaluations: lastEvaluations,
        tensions: allTensions,
        resolutions: allResolutions,
        cycles,
        confidence: computeConfidence(lastEvaluations),
        decisionLog,
      };

      emit("task:complete", {
        status: "complete",
        cycles,
        confidence: result.confidence,
      });

      return result;
    }

    // Can we cycle again?
    if (cycles >= config.maxCycles) break;

    // Resolve tensions
    task.status = "resolving";
    addEvent(task, "status_change", { status: "resolving", cycle: cycles });

    const resolutions = await resolve(tensions, work, config);
    allResolutions = [...allResolutions, ...resolutions];

    addEvent(task, "resolution", {
      cycle: cycles,
      resolutions: resolutions.map((r) => r.strategy),
    });

    logDecision(
      decisionLog,
      "revision",
      `Cycle ${cycles}: resolved ${resolutions.length} tension(s), requesting revision`,
      0.7
    );

    // Prepare revision prompt
    currentPrompt = revisionPrompt(
      basePrompt,
      lastEvaluations,
      resolutions
    );

    addEvent(task, "cycle_back", { cycle: cycles });
  }

  // Max cycles reached
  task.status = "complete";
  const confidence = computeConfidence(lastEvaluations);

  logDecision(
    decisionLog,
    "max_cycles",
    `Reached max cycles (${config.maxCycles}). Returning best effort. Confidence: ${confidence.toFixed(2)}`,
    confidence
  );

  log.warn("Max cycles reached", {
    cycles,
    confidence,
    unresolved: allTensions.filter((t) => !t.resolution).length,
  });

  const finalStatus = confidence >= 0.6 ? "complete" : "needs_human";

  emit("task:complete", {
    status: finalStatus,
    cycles,
    confidence,
    maxCyclesReached: true,
  });

  return {
    taskId: task.id,
    status: finalStatus,
    work: work!,
    evaluations: lastEvaluations,
    tensions: allTensions,
    resolutions: allResolutions,
    cycles,
    confidence,
    decisionLog,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function computeConfidence(evaluations: SenseEvaluation[]): number {
  if (evaluations.length === 0) return 0;
  const total = evaluations.reduce((sum, e) => sum + e.score, 0);
  return total / (evaluations.length * 10);
}

function logDecision(
  log: DecisionRecord[],
  description: string,
  reasoning: string,
  confidence: number
): void {
  log.push({
    id: newId(),
    timestamp: new Date(),
    description,
    reasoning,
    confidence,
    requiresHumanReview: confidence < 0.5,
  });
}
