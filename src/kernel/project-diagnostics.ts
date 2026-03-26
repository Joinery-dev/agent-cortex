/**
 * Project Diagnostics — project-level self-healing.
 *
 * Two modes of operation:
 *
 * 1. **Triage** (lightweight, every drift trigger) — rule-based routing
 *    that reads conviction trajectory, sense trends, drift level, and
 *    cerebellum accuracy to decide: replan | re-manifest | full-diagnostic
 *    | escalate. No LLM call. The starting heuristics are replaceable by
 *    Basal Ganglia learned routines over time.
 *
 * 2. **Diagnose** (heavy, when triage routes to full-diagnostic) — one
 *    LLM call over the full diagnostic corpus. Five diagnoses, four
 *    self-healable:
 *
 *      path-problem        → task decomposition was wrong
 *      vision-problem      → manifested future was wrong/incomplete
 *      calibration-problem → evaluation system is miscalibrated
 *      taste-problem       → taste profile doesn't match reality
 *      environmental       → external constraints block progress (→ human)
 *
 * This is the project-level analog of Cognitive Flexibility (Feature #5):
 *   CogFlex asks "why is this task stuck?"
 *   ProjectDiagnostics asks "why does this project keep drifting?"
 */

import { z } from "zod";
import type { CortexConfig } from "../types/orchestrator.js";
import type {
  DiagnosticContext,
  DiagnosticResult,
  SelfHealAction,
  TriageContext,
  TriageResult,
} from "../types/project-diagnostics.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import type { DiagnosticInputs } from "../llm/prompts.js";
import { callStructured } from "../llm/structured.js";
import {
  projectDiagnosticsSystem,
  projectDiagnosticsUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("project-diagnostics");

const DiagnosticSchema = z.object({
  diagnosis: z.enum([
    "path-problem",
    "vision-problem",
    "calibration-problem",
    "taste-problem",
    "environmental",
  ]),
  reasoning: z.string(),
  selfHealType: z.enum([
    "replan-with-directive",
    "re-manifest",
    "recalibrate-evaluation",
    "propose-taste-update",
    "escalate",
  ]),
  selfHealDirective: z.string().optional(),
  proposedTasteChanges: z.string().optional(),
  escalationContext: z.string().optional(),
});

export class ProjectDiagnostics {
  private config: CortexConfig;

  constructor(config: CortexConfig) {
    this.config = config;
  }

  // ── Triage (lightweight routing) ──────────────────────────────

  /**
   * Rule-based routing — decides which intervention to apply on each
   * drift trigger. No LLM call. Rules are evaluated in priority order;
   * the first match wins.
   *
   * Each rule's `firedRule` ID is a stable identifier for future
   * Basal Ganglia learning — the BG can learn which rules lead to
   * successful recovery and override the heuristics.
   */
  triage(ctx: TriageContext): TriageResult {
    const { convictionTrajectory: traj, senseTrends, driftAssessment, replanCount, maxReplans } = ctx;

    // R0: Safety valve — always honored
    if (replanCount >= maxReplans) {
      return {
        route: "escalate",
        reasoning: `Replan cascade exhausted (${replanCount}/${maxReplans}). Escalating to human.`,
        firedRule: "max-replans",
      };
    }

    // R1: Cross-generation decline — replanning isn't helping
    if (traj.generationCount >= 2) {
      const first = traj.generationMeans[0];
      const last = traj.generationMeans[traj.generationMeans.length - 1];
      if (first && last && first.meanLevel - last.meanLevel > 0.1) {
        return {
          route: "full-diagnostic",
          reasoning: `Conviction declining across replan generations (${first.meanLevel.toFixed(2)} → ${last.meanLevel.toFixed(2)}). Replanning isn't fixing the problem.`,
          firedRule: "cross-generation-decline",
        };
      }
    }

    // R2: Cerebellum was wrong — predicted improvement but conviction still declining
    if (replanCount >= 1 && ctx.cerebellumAccuracy > 0.6 && traj.direction === "down") {
      return {
        route: "full-diagnostic",
        reasoning: `Cerebellum accuracy is high (${ctx.cerebellumAccuracy.toFixed(2)}) but conviction is still declining after replan. The system's own model is wrong about what's wrong.`,
        firedRule: "cerebellum-wrong",
      };
    }

    // R3: All senses declining + conviction eroding — vision or calibration problem
    const downSenses = senseTrends.filter((t) => t.direction === "down");
    const allSensesDown = senseTrends.length > 0 && downSenses.length === senseTrends.length;
    if (allSensesDown && traj.direction === "down") {
      if (replanCount < 2) {
        return {
          route: "re-manifest",
          reasoning: `All ${senseTrends.length} senses declining + conviction eroding. Likely vision or calibration problem — re-manifesting first.`,
          firedRule: "all-senses-declining",
        };
      }
      return {
        route: "full-diagnostic",
        reasoning: `All senses declining + conviction eroding after ${replanCount} replans. Re-manifest already tried — need root cause diagnosis.`,
        firedRule: "all-senses-declining",
      };
    }

    // R4: Single sense diverging — likely path or taste issue for that dimension
    if (senseTrends.length >= 2 && downSenses.length === 1) {
      const otherTrends = senseTrends.filter((t) => t.direction !== "down");
      const majorityStableOrUp = otherTrends.length >= senseTrends.length - 1;
      if (majorityStableOrUp) {
        const struggling = downSenses[0];
        return {
          route: "replan",
          reasoning: `${struggling.label} is declining (${struggling.currentMean.toFixed(1)}) while other senses are stable/improving. Likely a path or taste issue for that dimension.`,
          firedRule: "single-sense-diverging",
          senseDirective: `Focus replan on addressing ${struggling.label} dimension — currently trending down while others are stable.`,
        };
      }
    }

    // R5: High drift + low conviction — something structural
    const driftLevel = driftAssessment?.driftLevel ?? 0;
    if (driftLevel > 0.7 && traj.currentLevel < 0.4) {
      return {
        route: "full-diagnostic",
        reasoning: `High drift (${driftLevel.toFixed(2)}) combined with low conviction (${traj.currentLevel.toFixed(2)}). Strong signal of structural misalignment.`,
        firedRule: "high-drift-low-conviction",
      };
    }

    // R6: Default — conservative re-pathing
    return {
      route: "replan",
      reasoning: `No strong diagnostic signal detected. Defaulting to replan (attempt ${replanCount + 1}).`,
      firedRule: "default-replan",
    };
  }

  // ── Diagnose (heavy LLM call) ───────────────────────────────

  /**
   * Diagnose why the project keeps drifting and prescribe a self-heal action.
   *
   * Called when triage routes to "full-diagnostic". Returns a diagnosis
   * that the rhythm acts on: re-manifest, recalibrate, propose taste
   * update, replan with a directive, or escalate to human.
   */
  async diagnose(context: DiagnosticContext): Promise<DiagnosticResult> {
    log.info("Diagnosing project-level drift", {
      replanCount: context.replanCount,
      taskResultCount: context.taskResults.size,
      driftLevel: context.driftAssessment?.driftLevel,
      convictionHistoryLength: context.convictionHistory.length,
    });

    emit("diagnostics:start", {
      replanCount: context.replanCount,
      taskResultCount: context.taskResults.size,
      driftLevel: context.driftAssessment?.driftLevel,
    });

    try {
      // Assemble prompt inputs from DiagnosticContext
      const taskResults = Array.from(context.taskResults.entries()).map(
        ([id, result]) => ({
          id,
          description: result.taskId,
          status: result.status === "complete" ? "accepted" : result.status,
          confidence: result.confidence,
          cycles: result.cycles,
        }),
      );

      // Compute graph diff between original and current task graphs
      const graphDiff = computeGraphDiff(context.originalGraph, context.currentGraph);

      const inputs = {
        intent: {
          summary: context.intent.summary,
          vision: context.intent.vision,
          audience: context.intent.audience,
          successCriteria: context.intent.successCriteria,
          constraints: context.intent.constraints,
        },
        taste: {
          visual: context.taste.visual,
          decisionStyle: context.taste.decisionStyle,
          patterns: context.taste.patterns,
        },
        manifestedFuture: context.manifestedFuture,
        taskResults,
        graphDiff,
        driftAssessment: context.driftAssessment
          ? {
              driftLevel: context.driftAssessment.driftLevel,
              driftSummary: context.driftAssessment.driftSummary,
              deepAnalysisSummary:
                context.driftAssessment.deepAnalysis?.summary,
              recommendations:
                context.driftAssessment.deepAnalysis?.recommendations,
            }
          : { driftLevel: 0, driftSummary: "No drift assessment available." },
        convictionHistory: context.convictionHistory.map((c) => ({
          verdict: c.verdict,
          level: c.level,
          decidingStep: c.decidingStep,
        })),
        senseTrends: context.senseTrends.map((t) => ({
          label: t.label,
          direction: t.direction,
          currentMean: t.currentMean,
        })),
        worldModelMaxims: context.worldModelMaxims,
        replanCount: context.replanCount,
      };

      const raw = await callStructured(
        "project-diagnostics",
        this.config.models.consultation,
        projectDiagnosticsSystem(),
        projectDiagnosticsUser(inputs),
        DiagnosticSchema,
      );

      // Map LLM output to DiagnosticResult
      let selfHealAction: SelfHealAction | null = null;

      if (raw.diagnosis !== "environmental") {
        switch (raw.selfHealType) {
          case "replan-with-directive":
            selfHealAction = {
              type: "replan-with-directive",
              directive: raw.selfHealDirective ?? "",
            };
            break;
          case "re-manifest":
            selfHealAction = { type: "re-manifest" };
            break;
          case "recalibrate-evaluation":
            selfHealAction = {
              type: "recalibrate-evaluation",
              directive: raw.selfHealDirective ?? "",
            };
            break;
          case "propose-taste-update":
            selfHealAction = {
              type: "propose-taste-update",
              proposedChanges: raw.proposedTasteChanges ?? "",
            };
            break;
        }
      }

      const result: DiagnosticResult = {
        diagnosis: raw.diagnosis,
        reasoning: raw.reasoning,
        selfHealAction,
        escalationContext:
          raw.diagnosis === "environmental"
            ? raw.escalationContext
            : undefined,
      };

      log.info("Project diagnostics result", {
        diagnosis: result.diagnosis,
        selfHealType: raw.selfHealType,
        shouldEscalate: raw.diagnosis === "environmental",
        reasoning: result.reasoning.slice(0, 200),
      });

      emit("diagnostics:result", {
        diagnosis: result.diagnosis,
        selfHealType: raw.selfHealType,
        shouldEscalate: result.diagnosis === "environmental",
      });

      return result;
    } catch (err) {
      log.warn("Diagnostics failed — falling through to replan-with-directive", {
        replanCount: context.replanCount,
        error: String(err),
      });

      return {
        diagnosis: "path-problem",
        reasoning: `Diagnostics failed: ${String(err)}. Falling through to replan with simpler decomposition.`,
        selfHealAction: {
          type: "replan-with-directive",
          directive:
            "Try a simpler task decomposition with fewer phases.",
        },
      };
    }
  }
}

// ─── Pure Helpers ──────────────────────────────────────────────

/**
 * Compute the structural delta between original and current task graphs.
 * Matches tasks by ID (stable across surgery amendments). Unmatched
 * originals are "removed", unmatched current are "added".
 */
function computeGraphDiff(
  original: TaskGraphNode[],
  current: TaskGraphNode[],
): DiagnosticInputs["graphDiff"] {
  const originalIds = new Set(original.map((n) => n.task.id));
  const currentIds = new Set(current.map((n) => n.task.id));
  const currentById = new Map(current.map((n) => [n.task.id, n]));
  const originalById = new Map(original.map((n) => [n.task.id, n]));

  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const id of originalIds) {
    if (currentIds.has(id)) {
      unchanged++;
    } else {
      const node = originalById.get(id);
      removed.push(node?.task.description ?? id);
    }
  }

  for (const id of currentIds) {
    if (!originalIds.has(id)) {
      const node = currentById.get(id);
      added.push(node?.task.description ?? id);
    }
  }

  // Only include diff if there are actual changes
  if (added.length === 0 && removed.length === 0) return undefined;

  return {
    originalTaskCount: original.length,
    currentTaskCount: current.length,
    addedTasks: added,
    removedTasks: removed,
    unchangedCount: unchanged,
  };
}
