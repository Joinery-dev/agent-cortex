/**
 * Integration Checker — phase gate coherence verification.
 *
 * Detects when a phase group completes and evaluates whether the
 * collective output satisfies the gate condition from each sense's
 * perspective. Two layers:
 *
 *   Layer 1: Quantitative pre-check — fast, no LLM. Reads trends,
 *            conviction, drift. Green + low NE → skip LLM.
 *
 *   Layer 2: Per-sense LLM evaluation — senses judge collective
 *            coherence. One call per receptor. Reuses evaluation
 *            weighting + composite machinery.
 *
 * This is a detector, not a diagnoser. When integration fails,
 * the existing replan cascade handles granular fixes.
 */

import { z } from "zod";
import type { Sense } from "../types/sense.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { TaskGraphNode } from "../types/brainstem.js";
import type { OrchestratorResult, CortexConfig } from "../types/orchestrator.js";
import type {
  IntegrationCheckConfig,
  PreCheckSignals,
  PreCheckResult,
  PreCheckVerdict,
  IntegrationEvalEntry,
  PhaseGateResult,
} from "../types/integration-check.js";
import { DEFAULT_INTEGRATION_CHECK_CONFIG } from "../types/integration-check.js";
import type { WorkingMemory } from "./working-memory.js";
import type { Thalamus } from "./thalamus.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { weighEvaluationsWithStakes, computeComposite } from "./evaluation-weighter.js";
import { callStructured } from "../llm/structured.js";
import {
  integrationEvaluatorSystem,
  integrationEvaluatorUser,
} from "../llm/prompts.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("integration-check");

// ─── LLM response schema ────────────────────────────────────────

const IntegrationEvaluationResult = z.object({
  score: z.number().min(1).max(10),
  acceptable: z.boolean(),
  assessment: z.string(),
  tensions: z.array(
    z.object({
      withDimension: z.string(),
      description: z.string(),
    }),
  ),
  suggestions: z.array(z.string()),
  improvementPotential: z.object({
    level: z.enum(["significant", "moderate", "marginal", "none"]),
    description: z.string().optional(),
  }),
  discoveredProblems: z.array(z.string()).optional(),
});

// ─── IntegrationChecker ─────────────────────────────────────────

export class IntegrationChecker {
  private config: IntegrationCheckConfig;

  constructor(
    config: Partial<IntegrationCheckConfig> | undefined,
    private library: SensoryCortex,
    private wm: WorkingMemory,
    private thalamus: Thalamus,
    private cortexConfig: CortexConfig,
  ) {
    this.config = { ...DEFAULT_INTEGRATION_CHECK_CONFIG, ...config };
  }

  // ── Phase gate detection ─────────────────────────────────────

  /**
   * Check if all tasks in a phase group are completed or escalated.
   * Pure, stateless — reads the graph and accumulator sets.
   */
  detectPhaseGate(
    phaseGroup: string,
    graph: TaskGraphNode[],
    completedTasks: Set<string>,
    escalatedTasks: Set<string>,
  ): boolean {
    const phaseNodes = graph.filter((n) => n.phaseGroup === phaseGroup);
    if (phaseNodes.length === 0) return false;

    const done = new Set([...completedTasks, ...escalatedTasks]);
    return phaseNodes.every((n) => done.has(n.task.id));
  }

  // ── Full integration check ───────────────────────────────────

  /**
   * Run the integration check for a completed phase.
   *
   * 1. Quantitative pre-check (Layer 1)
   * 2. If green + low NE → return early (passed)
   * 3. Build synthetic eval plan from WM score history
   * 4. Assemble briefing via Thalamus
   * 5. Per-receptor LLM calls in parallel
   * 6. Weigh + composite
   * 7. Determine pass/fail, collect issues + discovered problems
   */
  async check(
    phaseGroup: string,
    gateCondition: string,
    graph: TaskGraphNode[],
    taskResults: Map<string, OrchestratorResult>,
    neLevel: number,
    driftLevel: number,
  ): Promise<PhaseGateResult> {
    const start = Date.now();

    // Phase task IDs
    const phaseTaskIds = graph
      .filter((n) => n.phaseGroup === phaseGroup)
      .map((n) => n.task.id);

    // ── Layer 1: Quantitative pre-check ──────────────────────
    const preCheck = this.preCheck(phaseTaskIds, neLevel, driftLevel);

    emit("integration-check:pre-check", {
      phaseGroup,
      verdict: preCheck.verdict,
      skipLLM: preCheck.skipLLM,
      signals: preCheck.signals,
    });

    if (preCheck.skipLLM) {
      log.info("Phase gate pre-check green, skipping LLM", {
        phaseGroup,
        neLevel,
      });

      return {
        phaseGroup,
        gateCondition,
        preCheck,
        evaluations: null,
        compositeScore: null,
        passed: true,
        integrationIssues: [],
        discoveredProblems: [],
        durationMs: Date.now() - start,
      };
    }

    // ── Layer 2: LLM integration evaluation ──────────────────

    // Build synthetic evaluation plan
    const evalPlan = this.buildEvalPlan(phaseTaskIds);

    if (evalPlan.length === 0) {
      log.warn("No receptors found for integration check", { phaseGroup });
      return {
        phaseGroup,
        gateCondition,
        preCheck,
        evaluations: null,
        compositeScore: null,
        passed: true,
        integrationIssues: [],
        discoveredProblems: [],
        durationMs: Date.now() - start,
      };
    }

    // Assemble briefing via Thalamus
    const briefing = this.thalamus.forIntegrationCheck(
      phaseGroup,
      gateCondition,
      graph,
      taskResults,
    );

    emit("integration-check:evaluation-start", {
      phaseGroup,
      senseCount: evalPlan.length,
      receptors: evalPlan.map((e) => e.receptorId),
    });

    // Build trend context for evaluators
    const trendContext = this.buildTrendContext(briefing.enrichment.senseTrends);

    // Run per-receptor LLM evaluations in parallel
    const model = this.cortexConfig.models.integrationCheck ?? this.cortexConfig.models.evaluation;
    const evaluations = await this.runEvaluations(evalPlan, briefing, trendContext, model);

    // Weigh and compute composite
    const stakeMap = new Map<string, number>();
    for (const entry of evalPlan) {
      stakeMap.set(entry.senseName, entry.stake);
    }
    const weighted = weighEvaluationsWithStakes(evaluations, stakeMap);
    const composite = computeComposite(weighted);

    // Determine pass/fail
    const passed = composite.weightedMean >= this.config.failureThreshold;

    // Collect integration issues from failed evaluations
    const integrationIssues: string[] = [];
    for (const evaluation of evaluations) {
      if (!evaluation.acceptable) {
        integrationIssues.push(
          `${evaluation.activationPath.join(" > ")}: ${evaluation.assessment}`,
        );
      }
    }

    // Collect discovered problems
    const discoveredProblems: string[] = [];
    for (const evaluation of evaluations) {
      const problems = (evaluation as { discoveredProblems?: string[] }).discoveredProblems;
      if (problems) {
        discoveredProblems.push(...problems);
      }
    }

    emit("integration-check:complete", {
      phaseGroup,
      passed,
      compositeScore: composite.weightedMean,
      confidence: composite.confidence,
      issueCount: integrationIssues.length,
      discoveredProblemCount: discoveredProblems.length,
      evaluationCount: evaluations.length,
    });

    log.info("Integration check complete", {
      phaseGroup,
      passed,
      compositeScore: composite.weightedMean.toFixed(2),
      issues: integrationIssues.length,
      discoveredProblems: discoveredProblems.length,
    });

    return {
      phaseGroup,
      gateCondition,
      preCheck,
      evaluations,
      compositeScore: composite.weightedMean,
      passed,
      integrationIssues,
      discoveredProblems,
      durationMs: Date.now() - start,
    };
  }

  // ── Pre-check (Layer 1) ──────────────────────────────────────

  private preCheck(
    phaseTaskIds: string[],
    neLevel: number,
    driftLevel: number,
  ): PreCheckResult {
    // Read sense trends
    const senseTrends = this.wm.getSenseTrends();
    const worstTrendDirection = senseTrends.length === 0
      ? "stable" as const
      : senseTrends.some((t) => t.direction === "down")
        ? "down" as const
        : senseTrends.some((t) => t.direction === "up")
          ? "up" as const
          : "stable" as const;

    const lowestSenseMean = senseTrends.length === 0
      ? 10
      : Math.min(...senseTrends.map((t) => t.currentMean));

    // Read conviction trajectory
    const conviction = this.wm.getConvictionTrajectory();

    // Count high tensions across phase tasks
    const completedSummaries = this.wm.getCompletedSummaries();
    const phaseTaskSet = new Set(phaseTaskIds);
    let highTensionCount = 0;
    // Completed summaries don't carry taskId directly, so count from task results
    // stored in WM. Use the tasks' summaries instead.
    const phaseSummaries = this.wm.getTasks()
      .filter((t) => phaseTaskSet.has(t.taskId) && t.summary)
      .map((t) => t.summary!);
    for (const summary of phaseSummaries) {
      highTensionCount += summary.highTensionCount;
    }

    const signals: PreCheckSignals = {
      worstTrendDirection,
      lowestSenseMean,
      convictionDirection: conviction.direction,
      convictionLevel: conviction.currentLevel,
      highTensionCount,
      driftLevel,
      neLevel,
    };

    // Verdict logic
    let verdict: PreCheckVerdict = "green";
    const reasons: string[] = [];

    // Red conditions
    if (conviction.direction === "down" && conviction.currentLevel < 0.4) {
      verdict = "red";
      reasons.push(`conviction declining (${conviction.currentLevel.toFixed(2)})`);
    }
    if (driftLevel > 0.7) {
      verdict = "red";
      reasons.push(`drift level ${driftLevel.toFixed(2)} > 0.7`);
    }
    if (lowestSenseMean < 4.0) {
      verdict = "red";
      reasons.push(`sense mean ${lowestSenseMean.toFixed(1)} < 4.0`);
    }

    // Yellow conditions (only if not already red)
    if (verdict !== "red") {
      if (worstTrendDirection === "down") {
        verdict = "yellow";
        reasons.push("declining sense trend");
      }
      if (highTensionCount > 0) {
        verdict = "yellow";
        reasons.push(`${highTensionCount} high-severity tension(s)`);
      }
      if (driftLevel > 0.4) {
        verdict = "yellow";
        reasons.push(`drift level ${driftLevel.toFixed(2)} > 0.4`);
      }
      if (conviction.currentLevel < 0.5) {
        verdict = "yellow";
        reasons.push(`conviction ${conviction.currentLevel.toFixed(2)} < 0.5`);
      }
    }

    // Skip LLM decision
    const skipLLM = verdict === "green" && neLevel < 0.3
      && neLevel < this.config.neOverrideThreshold;

    // NE override — high NE forces LLM even if green
    const neOverride = neLevel >= this.config.neOverrideThreshold;

    const reasoning = reasons.length === 0
      ? `All signals green${neOverride ? " but NE override forces LLM evaluation" : ""}`
      : reasons.join("; ");

    return {
      signals,
      verdict,
      skipLLM: skipLLM && !neOverride,
      reasoning,
    };
  }

  // ── Synthetic evaluation plan ────────────────────────────────

  /**
   * Build the evaluation plan from WM score history.
   *
   * Union of all receptors that evaluated any task in the phase,
   * with mean stake across appearances. Falls back to active senses
   * with uniform stake on cold start.
   */
  private buildEvalPlan(phaseTaskIds: string[]): IntegrationEvalEntry[] {
    const phaseTaskSet = new Set(phaseTaskIds);
    const scoreHistory = this.wm.getScoreHistory();

    // Filter to scores from phase tasks
    const phaseScores = scoreHistory.filter((s) => phaseTaskSet.has(s.taskId));

    if (phaseScores.length === 0) {
      // Cold start: use active senses with uniform stakes
      const activeSenses = this.thalamus.getActiveSenses(this.library);
      return activeSenses.map((sense) => ({
        receptorId: sense.id,
        senseId: sense.id,
        senseName: sense.name,
        stake: 0.5,
        activationPath: this.library.getAncestorPath(sense.id),
      }));
    }

    // Union of receptors with mean stake
    const receptorData = new Map<string, {
      stakes: number[];
      activationPath: string[];
      senseId: string;
      senseName: string;
    }>();

    for (const snapshot of phaseScores) {
      for (const entry of snapshot.scores) {
        let data = receptorData.get(entry.receptorId);
        if (!data) {
          data = {
            stakes: [],
            activationPath: entry.activationPath,
            senseId: entry.receptorId,
            senseName: entry.activationPath[0] ?? entry.receptorId,
          };
          receptorData.set(entry.receptorId, data);
        }
        data.stakes.push(entry.stake);
      }
    }

    const entries: IntegrationEvalEntry[] = [];
    for (const [receptorId, data] of receptorData) {
      const meanStake = data.stakes.reduce((a, b) => a + b, 0) / data.stakes.length;
      if (meanStake < 0.1) continue; // Filter low-stake receptors

      // Verify receptor still exists in library
      const sense = this.library.get(receptorId);
      if (!sense) continue;

      entries.push({
        receptorId,
        senseId: data.senseId,
        senseName: data.senseName,
        stake: meanStake,
        activationPath: data.activationPath,
      });
    }

    return entries;
  }

  // ── LLM evaluations ─────────────────────────────────────────

  private async runEvaluations(
    evalPlan: IntegrationEvalEntry[],
    briefing: ReturnType<Thalamus["forIntegrationCheck"]>,
    trendContext: string | undefined,
    model: string,
  ): Promise<SenseEvaluation[]> {
    const promises = evalPlan.map(async (entry) => {
      const sense = this.library.get(entry.receptorId);
      if (!sense) return null;

      try {
        const result = await callStructured(
          "integration-check",
          model,
          integrationEvaluatorSystem(sense, entry.activationPath),
          integrationEvaluatorUser({
            gateCondition: briefing.gateCondition,
            manifestedFuture: briefing.manifestedFuture,
            phaseWork: briefing.phaseWork,
            trendContext,
          }),
          IntegrationEvaluationResult,
          this.config.maxTokens,
        );

        const evaluation: SenseEvaluation & { discoveredProblems?: string[] } = {
          senseId: sense.id,
          activationPath: entry.activationPath,
          score: result.score,
          acceptable: result.acceptable,
          assessment: result.assessment,
          tensions: result.tensions,
          suggestions: result.suggestions,
          improvementPotential: result.improvementPotential,
          discoveredProblems: result.discoveredProblems,
        };

        emit("integration-check:evaluation-score", {
          path: entry.activationPath.join(" > "),
          score: result.score,
          acceptable: result.acceptable,
          discoveredProblems: result.discoveredProblems?.length ?? 0,
        });

        return evaluation;
      } catch (err) {
        log.warn(`Integration evaluation failed for ${entry.activationPath.join(" > ")}`, {
          error: String(err),
        });
        return null;
      }
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is SenseEvaluation => r !== null);
  }

  // ── Helpers ──────────────────────────────────────────────────

  private buildTrendContext(senseTrends: Array<{ label?: string; direction: string; currentMean: number; previousMean: number; dataPoints: number }>): string | undefined {
    if (senseTrends.length === 0) return undefined;

    const lines = senseTrends.map((t) => {
      const label = t.label ?? "Unknown";
      return `- ${label}: ${t.direction} (current: ${t.currentMean.toFixed(1)}, previous: ${t.previousMean.toFixed(1)}, ${t.dataPoints} task(s))`;
    });

    return `SENSE TRENDS ACROSS THIS PHASE:\n${lines.join("\n")}`;
  }
}
