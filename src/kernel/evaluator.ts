import { z } from "zod";
import type { Sense, SenseEvaluation, ObservationLevel } from "../types/sense.js";
import type { VisualCaptureResult } from "../types/visual-capture.js";
import type { Consultation, EvaluationPlanEntry } from "../types/consultation.js";
import type { Task } from "../types/task.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { Thalamus } from "./thalamus.js";
import type { PeripheralNervousSystem } from "./pns.js";
import { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { agenticCall } from "../llm/client.js";
import {
  evaluatorBundleSystem,
  evaluatorBundleUser,
  evaluatorAgenticBundleSystem,
  evaluatorAgenticBundleUser,
} from "../llm/prompts.js";
import type { BundledReceptorInfo } from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit, emitWarn } from "../events.js";
import { getContentStore, contentBlock } from "../trace/content-store.js";

const log = createLogger("evaluator");

// ── Schemas ─────────────────────────────────────────────────────

const EvaluationObservationSchema = z.object({
  kind: z.enum(["file-read", "search-result", "lint-output", "test-output", "runtime-check", "screenshot", "web-vitals", "other"]),
  target: z.string(),
  finding: z.string(),
  interpretation: z.string(),
});

/** Per-receptor result within a bundled sense evaluation. */
const BundledReceptorEval = z.object({
  receptorId: z.string(),
  score: z.number().min(1).max(10),
  acceptable: z.boolean(),
  assessment: z.string(),
});

/** One LLM call per sense — scores all its receptors at once. */
const BundledEvaluationResult = z.object({
  receptorEvaluations: z.array(BundledReceptorEval),
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

// ── Public types ────────────────────────────────────────────────

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
  /** Visual captures from Playwright (screenshots + Web Vitals). */
  visualCaptures?: VisualCaptureResult;
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

// ── Internal types ──────────────────────────────────────────────

/** A receptor that passed observation checks and is ready for evaluation. */
interface ValidReceptor {
  sense: Sense;
  activationPath: string[];
  trendContext?: string;
  predictionContext?: string;
}

// ── Main entry point ────────────────────────────────────────────

/**
 * Evaluate work by consulting all active senses. Makes one LLM call per
 * sense (not per receptor), with each call scoring all of that sense's
 * nominated receptors. Returns individual SenseEvaluation objects — the
 * downstream interface is unchanged.
 */
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
  // Group evaluation plan entries by parent sense — each group becomes one LLM call
  const senseGroupMap = new Map<string, EvaluationPlanEntry[]>();
  for (const entry of consultation.evaluationPlan) {
    const group = senseGroupMap.get(entry.parentSenseId) ?? [];
    group.push(entry);
    senseGroupMap.set(entry.parentSenseId, group);
  }

  const totalReceptors = consultation.evaluationPlan.length;

  emit("evaluation:start", {
    senseCount: totalReceptors,
    senses: consultation.evaluationPlan.map((e) => e.receptorId),
    bundledGroups: senseGroupMap.size,
  });

  log.info("Evaluating work (bundled per-sense)", {
    receptorCount: totalReceptors,
    senseGroups: senseGroupMap.size,
    senses: Array.from(senseGroupMap.keys()),
  });

  const skippedSenses: EvaluationOutcome["skippedSenses"] = [];

  // Run one evaluation call per sense group — concurrency is bounded
  // by the LLM client semaphore, so groups queue naturally.
  const groupPromises = Array.from(senseGroupMap.entries()).map(
    async ([senseId, entries]) => {
      const parentPerspective = entries[0].parentPerspective;

      // ── Collect valid receptors (library lookup + observation check) ──
      const validReceptors: ValidReceptor[] = [];
      let sharedSenseEnrichment: string | undefined;

      for (const entry of entries) {
        const receptor = library.get(entry.receptorId);
        if (!receptor) {
          log.warn(`Evaluator receptor not found: ${entry.receptorId}`);
          skippedSenses.push({ senseId: entry.receptorId, reason: "Receptor not found in library" });
          continue;
        }

        const activationPath = library.getAncestorPath(receptor.id);

        // Check minimum observation level
        if (receptor.minimumObservation) {
          const currentLevel = determineObservationLevel(agenticOpts?.neLevel ?? 0, evaluationContext);
          if (!meetsMinimum(currentLevel, receptor.minimumObservation)) {
            const reason = `Requires ${receptor.minimumObservation} observation, only ${currentLevel} available`;
            log.info(`Skipping evaluation: ${receptor.id} — ${reason}`);
            emit("evaluation:skipped", { senseId: receptor.id, path: activationPath.join(" > "), reason });
            skippedSenses.push({ senseId: receptor.id, reason });
            continue;
          }
        }

        // Fetch per-receptor enrichment from thalamus
        let trendContext: string | undefined;
        let predictionContext: string | undefined;
        if (thalamus) {
          const hasGestalt = thalamus.getGestalt(task.id) !== null;
          const evalBriefing = hasGestalt
            ? thalamus.forEvaluationFromGestalt(task.id, receptor.id, activationPath)
            : await thalamus.forEvaluation(task, receptor.id, activationPath);

          const parts: string[] = [];
          if (evalBriefing.receptorTrends.length > 0) {
            const trend = evalBriefing.receptorTrends[0];
            parts.push(`TREND: ${trend.direction} (current mean: ${trend.currentMean.toFixed(1)}, previous: ${trend.previousMean.toFixed(1)}, across ${trend.dataPoints} task(s))`);
          }
          if (evalBriefing.relevantPrinciples && evalBriefing.relevantPrinciples.length > 0) {
            parts.push(`PRINCIPLES:\n${evalBriefing.relevantPrinciples.map((p) => `- (${p.confidence.toFixed(2)}) ${p.statement}`).join("\n")}`);
          }
          if (parts.length > 0) trendContext = parts.join("\n");

          if (evalBriefing.prediction) {
            predictionContext = `PREDICTED: ${evalBriefing.prediction.predicted.toFixed(1)} (confidence: ${evalBriefing.prediction.confidence.toFixed(2)}, based on ${evalBriefing.prediction.basedOnEpisodes} similar task(s))`;
          }

          // Sense-level enrichment — shared across all receptors in the group, computed once
          if (sharedSenseEnrichment === undefined) {
            const senseParts: string[] = [];
            if (evalBriefing.senseCeiling) {
              const sc = evalBriefing.senseCeiling;
              let ceilingStr = `THEORETICAL CEILING: The theoretical maximum for your dimension on this task is ${sc.ceiling}/10 because: ${sc.ceilingRationale}. Score relative to what's achievable, not against an abstract ideal.`;
              if (sc.bestAchieved !== null) {
                ceilingStr += ` Best achieved on similar tasks: ${sc.bestAchieved.toFixed(1)}/10.`;
              }
              senseParts.push(ceilingStr);
            }
            if (evalBriefing.isBottleneck) {
              senseParts.push(`BOTTLENECK: Your dimension is currently the constraint on the composite score. Be especially rigorous — improvements here have the highest leverage.`);
            }
            sharedSenseEnrichment = senseParts.length > 0 ? senseParts.join("\n\n") : "";
          }
        }

        validReceptors.push({ sense: receptor, activationPath, trendContext, predictionContext });
      }

      if (validReceptors.length === 0) return [];

      // Get the parent sense for the system prompt identity
      const parentSense = library.get(senseId);
      if (!parentSense) {
        log.warn(`Parent sense not found: ${senseId}`);
        return [];
      }

      try {
        const shouldBeAgentic = agenticOpts && agenticOpts.neLevel >= 0.3;

        // Build receptor info for the prompt
        const receptorsForPrompt: BundledReceptorInfo[] = validReceptors.map((r) => ({
          id: r.sense.id,
          name: r.sense.name,
          sensitivity: r.sense.sensitivity,
          activationPath: r.activationPath,
        }));

        // Build per-receptor enrichment for the user prompt
        const receptorEnrichments = validReceptors
          .map((r) => {
            const parts: string[] = [];
            if (r.trendContext) parts.push(r.trendContext);
            if (r.predictionContext) parts.push(r.predictionContext);
            return parts.length > 0 ? { receptorId: r.sense.id, context: parts.join("\n") } : null;
          })
          .filter((r): r is { receptorId: string; context: string } => r !== null);

        const senseEnrichment = sharedSenseEnrichment || undefined;

        let bundledResult: z.infer<typeof BundledEvaluationResult>;
        let degraded = false;

        if (shouldBeAgentic) {
          // ── Agentic bundled path: observe with tools, then judge all receptors ──
          const toolSet = agenticOpts.pns.activateToolsForTask(
            task.description,
            agenticOpts.neLevel,
            "evaluator",
          );
          const agenticResult = await agenticCall(
            "evaluation",
            config.models.evaluation,
            evaluatorAgenticBundleSystem(parentSense, receptorsForPrompt),
            evaluatorAgenticBundleUser(
              task, work, parentPerspective,
              receptorEnrichments.length > 0 ? receptorEnrichments : undefined,
              senseEnrichment,
              evaluationContext,
            ),
            toolSet,
          );

          const parseResult = parseAgenticBundleResult(agenticResult.summary);
          bundledResult = parseResult.result;
          degraded = parseResult.degraded;
        } else {
          // ── Text-only bundled path: enriched work blob, one structured call ──
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

          bundledResult = await callStructured(
            "evaluation",
            config.models.evaluation,
            evaluatorBundleSystem(parentSense, receptorsForPrompt),
            evaluatorBundleUser(
              task, evaluationWork, parentPerspective,
              receptorEnrichments.length > 0 ? receptorEnrichments : undefined,
              senseEnrichment,
            ),
            BundledEvaluationResult,
          );
        }

        // ── Unpack bundled result into individual SenseEvaluation objects ──
        return unpackBundledResult(
          bundledResult, validReceptors, parentPerspective, task.id, degraded,
        );
      } catch (err) {
        log.warn(`Bundled evaluation failed for sense ${parentSense.name}`, { error: String(err) });
        for (const receptor of validReceptors) {
          emitWarn(
            "evaluation:fallback:sense-dropped",
            {
              senseId: receptor.sense.id,
              path: receptor.activationPath.join(" > "),
              taskId: task.id,
              error: String(err),
            },
            {
              component: "evaluator",
              expected: "SenseEvaluation",
              received: "null (sense excluded from composite)",
            },
          );
          skippedSenses.push({
            senseId: receptor.sense.id,
            reason: `Bundled evaluation threw: ${String(err).slice(0, 200)}`,
          });
        }
        return [];
      }
    },
  );

  const groupResults = await Promise.all(groupPromises);
  const evaluations = groupResults.flat();
  const degradedCount = evaluations.filter((e) => e.degraded).length;

  emit("evaluation:complete", {
    scores: evaluations.map((e) => ({
      path: e.activationPath.join(" > "),
      score: e.score,
      degraded: !!e.degraded,
    })),
    degradedCount,
    skippedCount: skippedSenses.length,
    totalSenses: totalReceptors,
    bundledCalls: senseGroupMap.size,
  });

  log.info("Evaluations complete", {
    total: totalReceptors,
    evaluated: evaluations.length,
    degraded: degradedCount,
    skipped: skippedSenses.length,
    bundledCalls: senseGroupMap.size,
  });

  return { evaluations, skippedSenses, degradedCount };
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Unpack a bundled evaluation result into individual SenseEvaluation objects.
 * Shared fields (tensions, suggestions, improvementPotential) are copied to
 * each receptor. Missing receptors are marked as degraded.
 */
function unpackBundledResult(
  bundled: z.infer<typeof BundledEvaluationResult>,
  receptors: ValidReceptor[],
  parentPerspective: string,
  taskId: string,
  degraded: boolean,
): SenseEvaluation[] {
  const evaluations: SenseEvaluation[] = [];

  for (const receptor of receptors) {
    const receptorResult = bundled.receptorEvaluations.find(
      (r) => r.receptorId === receptor.sense.id,
    );

    const evaluation: SenseEvaluation = receptorResult
      ? {
          senseId: receptor.sense.id,
          activationPath: receptor.activationPath,
          score: receptorResult.score,
          acceptable: receptorResult.acceptable,
          assessment: receptorResult.assessment,
          tensions: bundled.tensions,
          suggestions: bundled.suggestions,
          improvementPotential: bundled.improvementPotential,
          observations: bundled.observations,
          degraded: degraded
            ? { reason: "Agentic evaluation JSON parse failed", source: "agentic-parse-failure" as const }
            : undefined,
        }
      : {
          senseId: receptor.sense.id,
          activationPath: receptor.activationPath,
          score: 5,
          acceptable: false,
          assessment: `[Receptor ${receptor.sense.id} not included in bundled evaluation response]`,
          tensions: bundled.tensions,
          suggestions: bundled.suggestions,
          improvementPotential: bundled.improvementPotential,
          degraded: {
            reason: "Missing from bundled evaluation response",
            source: "llm-failure" as const,
          },
        };

    emit("evaluation:score", {
      path: evaluation.activationPath.join(" > "),
      score: evaluation.score,
      acceptable: evaluation.acceptable,
      assessment: evaluation.assessment,
      degraded: !!evaluation.degraded,
    });

    // Record content trace
    const contentOutputs: import("../trace/types.js").ContentBlock[] = [
      contentBlock(`Assessment (${evaluation.score}/10)`, evaluation.assessment),
    ];
    if (evaluation.suggestions?.length) {
      contentOutputs.push(contentBlock("Suggestions", evaluation.suggestions.join("\n")));
    }
    if (evaluation.improvementPotential) {
      const ip = evaluation.improvementPotential;
      contentOutputs.push(contentBlock("Improvement potential", `${ip.level}: ${ip.description}`));
    }
    getContentStore().record({
      eventSeq: null, kind: "evaluation", timestamp: new Date().toISOString(),
      component: "evaluator", taskId,
      inputs: [
        contentBlock("Activation path", evaluation.activationPath.join(" > ")),
        contentBlock("Parent perspective", parentPerspective),
      ],
      outputs: contentOutputs,
      routing: { destinations: ["gate (composite score)", "tension-detection", "working-memory"] },
    });

    evaluations.push(evaluation);
  }

  return evaluations;
}

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

interface AgenticBundleParseResult {
  result: z.infer<typeof BundledEvaluationResult>;
  degraded: boolean;
}

/** Extract bundled EvaluationResult JSON from an agentic session's final text. */
function parseAgenticBundleResult(summary: string): AgenticBundleParseResult {
  const jsonMatch = summary.match(/\{[\s\S]*"receptorEvaluations"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return { result: BundledEvaluationResult.parse(parsed), degraded: false };
    } catch {
      // Fall through to degraded default
    }
  }

  log.warn("Failed to parse agentic bundled evaluation result", {
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
      expected: "JSON with receptorEvaluations field",
      received: "unparseable agentic summary",
      rawResponse: summary.slice(0, 1000),
    },
  );
  return {
    result: {
      receptorEvaluations: [],
      tensions: [],
      suggestions: ["Bundled evaluation parsing failed — manual review recommended"],
      improvementPotential: { level: "significant" as const },
    },
    degraded: true,
  };
}
