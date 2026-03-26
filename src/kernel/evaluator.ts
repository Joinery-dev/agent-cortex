import { z } from "zod";
import type { SenseEvaluation, ObservationLevel } from "../types/sense.js";
import type { Consultation } from "../types/consultation.js";
import type { Task } from "../types/task.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { Thalamus } from "./thalamus.js";
import type { PeripheralNervousSystem } from "./pns.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { agenticCall } from "../llm/client.js";
import {
  evaluatorSystem,
  evaluatorUser,
  evaluatorAgenticSystem,
  evaluatorAgenticUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";

const log = createLogger("evaluator");

const EvaluationObservationSchema = z.object({
  kind: z.enum(["file-read", "search-result", "lint-output", "test-output", "runtime-check", "other"]),
  target: z.string(),
  finding: z.string(),
  interpretation: z.string(),
});

const EvaluationResult = z.object({
  score: z.number().min(1).max(10),
  acceptable: z.boolean(),
  assessment: z.string(),
  tensions: z.array(
    z.object({
      withDimension: z.string(),
      description: z.string(),
    })
  ),
  suggestions: z.array(z.string()),
  improvementPotential: z.object({
    level: z.enum(["significant", "moderate", "marginal", "none"]),
    description: z.string().optional(),
  }),
  observations: z.array(EvaluationObservationSchema).optional(),
});

interface EvaluatorEntry {
  receptorId: string;
  parentPerspective: string;
}

/** Context for evaluating agentic builds — real files instead of a text blob. */
export interface EvaluationContext {
  /** Git diff of changes in the sandbox. */
  diff?: string;
  /** List of files changed. */
  changedFiles?: string[];
  /** Full content of key changed files (path → content). */
  fileContents?: Map<string, string>;
  /** Tool trace from the agentic session. */
  toolTrace?: import("../types/motor-cortex.js").ToolUseTrace[];
  /** Working directory for agentic evaluation (sandbox cwd). */
  sandboxCwd?: string;
  /** URL of running dev server, if available. */
  runtimeUrl?: string;
}

/**
 * What the evaluator actually produced — evaluations plus metadata about
 * what couldn't be evaluated. Downstream consumers use this to distinguish
 * "I evaluated and got a 5" from "I failed to evaluate."
 */
export interface EvaluationOutcome {
  evaluations: SenseEvaluation[];
  /** Senses that could not evaluate due to unmet observation levels or total failure. */
  skippedSenses: Array<{ senseId: string; reason: string }>;
  /** Count of evaluations produced by fallback paths (degraded). */
  degradedCount: number;
}

/** Options for enabling agentic evaluation (perception before judgment). */
export interface AgenticEvaluationOpts {
  pns: PeripheralNervousSystem;
  neLevel: number;
}

export async function evaluate(
  consultation: Consultation,
  task: Task,
  work: string,
  library: SensoryCortex,
  config: CortexConfig,
  thalamus?: Thalamus,
  evaluationContext?: EvaluationContext,
  agenticOpts?: AgenticEvaluationOpts,
): Promise<EvaluationOutcome> {
  // Read evaluator list from consultation's pre-computed evaluation plan
  const entries: EvaluatorEntry[] = consultation.evaluationPlan.map((entry) => ({
    receptorId: entry.receptorId,
    parentPerspective: entry.parentPerspective,
  }));

  emit("evaluation:start", {
    senseCount: entries.length,
    senses: entries.map((e) => e.receptorId),
  });

  log.info("Evaluating work", {
    senseCount: entries.length,
    receptors: entries.map((e) => e.receptorId),
  });

  // Track senses that couldn't evaluate — these feed the self-healing loop
  const skippedSenses: EvaluationOutcome["skippedSenses"] = [];

  // Run all evaluations in parallel
  const evaluationPromises = entries.map(async (entry) => {
    const sense = library.get(entry.receptorId);
    if (!sense) {
      log.warn(`Evaluator receptor not found: ${entry.receptorId}`);
      skippedSenses.push({ senseId: entry.receptorId, reason: "Receptor not found in library" });
      return null;
    }

    const activationPath = library.getAncestorPath(sense.id);

    // When thalamus is available, get per-receptor trend context + principles + prediction
    let trendContext: string | undefined;
    let predictionContext: string | undefined;
    if (thalamus) {
      // Derive from gestalt if available, fall back to direct read
      const hasGestalt = thalamus.getGestalt(task.id) !== null;
      const evalBriefing = hasGestalt
        ? thalamus.forEvaluationFromGestalt(task.id, sense.id, activationPath)
        : await thalamus.forEvaluation(task, sense.id, activationPath);
      const parts: string[] = [];
      if (evalBriefing.receptorTrends.length > 0) {
        const trend = evalBriefing.receptorTrends[0];
        parts.push(`YOUR RECENT TREND:\n- ${trend.direction} (current mean: ${trend.currentMean.toFixed(1)}, previous: ${trend.previousMean.toFixed(1)}, across ${trend.dataPoints} task(s))`);
      }
      if (evalBriefing.relevantPrinciples && evalBriefing.relevantPrinciples.length > 0) {
        parts.push(`PRINCIPLES FROM EXPERIENCE:\n${evalBriefing.relevantPrinciples.map((p) => `- (${p.confidence.toFixed(2)} confidence) ${p.statement}`).join("\n")}`);
      }
      if (parts.length > 0) trendContext = parts.join("\n\n");
      if (evalBriefing.prediction) {
        predictionContext = `PREDICTED SCORE FOR THIS RECEPTOR:\n- Predicted: ${evalBriefing.prediction.predicted.toFixed(1)} (confidence: ${evalBriefing.prediction.confidence.toFixed(2)}, based on ${evalBriefing.prediction.basedOnEpisodes} similar task(s))`;
      }
      if (evalBriefing.senseCeiling) {
        const sc = evalBriefing.senseCeiling;
        let ceilingStr = `THEORETICAL CEILING: The theoretical maximum for your dimension on this task is ${sc.ceiling}/10 because: ${sc.ceilingRationale}. Score relative to what's achievable, not against an abstract ideal.`;
        if (sc.bestAchieved !== null) {
          ceilingStr += ` Best achieved on similar tasks: ${sc.bestAchieved.toFixed(1)}/10.`;
        }
        // Append to trendContext since they're contextual enrichment
        trendContext = trendContext ? `${trendContext}\n\n${ceilingStr}` : ceilingStr;
      }
      if (evalBriefing.isBottleneck) {
        const bottleneckStr = `BOTTLENECK: Your dimension is currently the constraint on the composite score. Be especially rigorous — improvements here have the highest leverage.`;
        trendContext = trendContext ? `${trendContext}\n\n${bottleneckStr}` : bottleneckStr;
      }
    }

    // ── Check minimum observation level ──
    if (sense.minimumObservation) {
      const currentLevel = determineObservationLevel(agenticOpts?.neLevel ?? 0, evaluationContext);
      if (!meetsMinimum(currentLevel, sense.minimumObservation)) {
        const reason = `Requires ${sense.minimumObservation} observation, only ${currentLevel} available`;
        log.info(`Skipping evaluation: ${sense.id} — ${reason}`);
        emit("evaluation:skipped", {
          senseId: sense.id,
          path: activationPath.join(" > "),
          reason,
        });
        skippedSenses.push({ senseId: sense.id, reason });
        return null;
      }
    }

    try {
      // Decide: agentic (perception-based) or text-only evaluation
      const shouldBeAgentic = agenticOpts && agenticOpts.neLevel >= 0.3;

      let evaluation: SenseEvaluation;

      if (shouldBeAgentic) {
        // ── Agentic path: observe with real tools, then judge ──
        const toolSet = agenticOpts.pns.activateToolsForTask(
          task.description,
          agenticOpts.neLevel,
          "evaluator",
        );

        const maxTurns = agenticOpts.neLevel > 0.7 ? 10 : 6;

        const agenticResult = await agenticCall(
          "evaluation",
          config.models.evaluation,
          evaluatorAgenticSystem(sense, activationPath),
          evaluatorAgenticUser(task, work, entry.parentPerspective, trendContext, predictionContext, evaluationContext),
          toolSet,
          { maxTurns },
        );

        // Parse structured JSON from the agentic session's final text
        const parseResult = parseAgenticResult(agenticResult.summary);

        evaluation = {
          senseId: sense.id,
          activationPath,
          score: parseResult.result.score,
          acceptable: parseResult.result.acceptable,
          assessment: parseResult.result.assessment,
          tensions: parseResult.result.tensions,
          suggestions: parseResult.result.suggestions,
          improvementPotential: parseResult.result.improvementPotential,
          observations: parseResult.result.observations,
          // Mark as degraded if parsing fell back — score is not trustworthy
          degraded: parseResult.degraded
            ? { reason: "Agentic evaluation JSON parse failed", source: "agentic-parse-failure" as const }
            : undefined,
        };
      } else {
        // ── Text-only path: enriched text blob, structured call ──
        let evaluationWork = work;
        if (evaluationContext) {
          const sections: string[] = [work];
          if (evaluationContext.changedFiles && evaluationContext.changedFiles.length > 0) {
            sections.push(`\nFILES CHANGED:\n${evaluationContext.changedFiles.map((f) => `- ${f}`).join("\n")}`);
          }
          if (evaluationContext.fileContents && evaluationContext.fileContents.size > 0) {
            const fileEntries: string[] = [];
            for (const [path, content] of evaluationContext.fileContents) {
              fileEntries.push(`--- ${path} ---\n${content.slice(0, 3000)}`);
            }
            sections.push(`\nKEY FILE CONTENTS:\n${fileEntries.join("\n\n")}`);
          }
          if (evaluationContext.diff) {
            sections.push(`\nDIFF:\n${evaluationContext.diff.slice(0, 5000)}`);
          }
          evaluationWork = sections.join("\n");
        }

        const result = await callStructured(
          "evaluation",
          config.models.evaluation,
          evaluatorSystem(sense, activationPath),
          evaluatorUser(task, evaluationWork, entry.parentPerspective, trendContext, predictionContext),
          EvaluationResult
        );

        evaluation = {
          senseId: sense.id,
          activationPath,
          score: result.score,
          acceptable: result.acceptable,
          assessment: result.assessment,
          tensions: result.tensions,
          suggestions: result.suggestions,
          improvementPotential: result.improvementPotential,
          observations: result.observations,
        };
      }

      emit("evaluation:score", {
        path: evaluation.activationPath.join(" > "),
        score: evaluation.score,
        acceptable: evaluation.acceptable,
        assessment: evaluation.assessment,
        degraded: !!evaluation.degraded,
      });

      return evaluation;
    } catch (err) {
      log.warn(`Evaluation failed for ${activationPath.join(" > ")}`, {
        error: String(err),
      });
      emitWarn(
        "evaluation:fallback:sense-dropped",
        {
          senseId: sense.id,
          path: activationPath.join(" > "),
          taskId: task.id,
          error: String(err),
        },
        {
          component: "evaluator",
          expected: "SenseEvaluation",
          received: "null (sense excluded from composite)",
        },
      );
      skippedSenses.push({ senseId: sense.id, reason: `Evaluation threw: ${String(err).slice(0, 200)}` });
      return null;
    }
  });

  const results = await Promise.all(evaluationPromises);
  const evaluations = results.filter(
    (r): r is SenseEvaluation => r !== null
  );
  const degradedCount = evaluations.filter((e) => e.degraded).length;

  emit("evaluation:complete", {
    scores: evaluations.map((e) => ({
      path: e.activationPath.join(" > "),
      score: e.score,
      degraded: !!e.degraded,
    })),
    degradedCount,
    skippedCount: skippedSenses.length,
    totalSenses: entries.length,
  });

  log.info("Evaluations complete", {
    total: entries.length,
    evaluated: evaluations.length,
    degraded: degradedCount,
    skipped: skippedSenses.length,
  });

  return { evaluations, skippedSenses, degradedCount };
}

// ── Helpers ─────────────────────────────────────────────────────

/** Determine the current observation level from NE + runtime/sandbox availability. */
function determineObservationLevel(
  neLevel: number,
  evaluationContext?: EvaluationContext,
): ObservationLevel {
  if (neLevel > 0.7 && evaluationContext?.runtimeUrl) return "runtime";
  // Without sandbox, evaluators have no diff/file context — analysis-level
  // observation is meaningless. Return file-only so senses that need real
  // evidence skip rather than scoring blind.
  if (neLevel >= 0.3 && evaluationContext?.sandboxCwd) return "analysis";
  return "file-only";
}

/** Check if a current observation level meets a sense's minimum requirement. */
function meetsMinimum(current: ObservationLevel, minimum: ObservationLevel): boolean {
  const order: ObservationLevel[] = ["file-only", "analysis", "runtime"];
  return order.indexOf(current) >= order.indexOf(minimum);
}

interface AgenticParseResult {
  result: z.infer<typeof EvaluationResult>;
  /** True when the result came from the fallback path, not genuine parsing. */
  degraded: boolean;
}

/** Extract structured EvaluationResult JSON from an agentic session's final text. */
function parseAgenticResult(summary: string): AgenticParseResult {
  // Try to find a JSON block in the response
  const jsonMatch = summary.match(/\{[\s\S]*"score"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return { result: EvaluationResult.parse(parsed), degraded: false };
    } catch {
      // Fall through to degraded default
    }
  }

  // Fallback: return a conservative default but mark it as degraded.
  // The score is 5 because the type requires a number, but downstream
  // consumers MUST check the degraded flag before trusting it.
  log.warn("Failed to parse agentic evaluation result, returning degraded result", {
    summaryLength: summary.length,
  });
  emitWarn(
    "evaluation:fallback:agentic-parse",
    {
      summaryLength: summary.length,
      summarySnippet: summary.slice(0, 200),
    },
    {
      component: "evaluator",
      expected: "JSON with score field",
      received: "unparseable agentic summary",
      rawResponse: summary.slice(0, 1000),
    },
  );
  return {
    result: {
      score: 5,
      acceptable: false,
      assessment: summary.slice(0, 500),
      tensions: [],
      suggestions: ["Evaluation parsing failed — manual review recommended"],
      improvementPotential: { level: "significant" as const },
    },
    degraded: true,
  };
}
