/**
 * Drift Monitor — PFC Feature #6.
 *
 * Compares cumulative project trajectory against original intent.
 * Two modes:
 *   quickCheck()   — procedural, after every task. Three signals combined.
 *   deepAnalysis() — LLM-assisted, at phase gates. Full trajectory assessment.
 *
 * Stateful: maintains the current assessment and quick check history.
 * Methods receive sources per call (same pattern as WorldModel.rebuild).
 */

import { z } from "zod";
import type {
  DriftMonitorConfig,
  DriftMonitorSources,
  QuickCheckSignals,
  QuickCheckResult,
  DeepAnalysis,
  DriftAssessment,
  DriftMonitorState,
} from "../types/drift-monitor.js";
import { DEFAULT_DRIFT_MONITOR_CONFIG } from "../types/drift-monitor.js";
import type { PlasticitySource } from "../types/world-model.js";
import type { DriftAnalysisInputs } from "../llm/prompts.js";
import { driftAnalysisSystem, driftAnalysisUser } from "../llm/prompts.js";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("drift-monitor");

// ─── Zod schema for deep analysis LLM response ──────────────────

const DeepAnalysisSchema = z.object({
  intentAlignment: z.object({
    level: z.enum(["aligned", "drifting", "diverged"]),
    trajectory: z.enum(["improving", "stable", "worsening"]),
    description: z.string(),
    evidence: z.array(z.object({
      observation: z.string(),
      reference: z.string(),
      magnitude: z.number().min(0).max(1),
      valence: z.enum(["drift", "alignment"]),
    })),
  }),
  tasteDivergence: z.object({
    detected: z.boolean(),
    divergences: z.array(z.object({
      dimension: z.string(),
      stated: z.string(),
      demonstrated: z.string(),
      strength: z.number().min(0).max(1),
    })),
  }),
  conventionHealth: z.object({
    eroding: z.array(z.object({
      convention: z.string(),
      evidence: z.string(),
      confidence: z.number().min(0).max(1),
    })),
    emerging: z.array(z.object({
      convention: z.string(),
      evidence: z.string(),
      confidence: z.number().min(0).max(1),
    })),
  }),
  overallLevel: z.number().min(0).max(1),
  summary: z.string(),
  recommendations: z.array(z.string()),
});

// ─── Math helpers ────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Population standard deviation. Returns 0 for empty or single-element arrays. */
function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Simple OLS linear regression slope for evenly spaced data.
 * x values are implied as [0, 1, 2, ...]. Returns slope.
 */
function linearRegressionSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;

  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    numerator += dx * (ys[i] - yMean);
    denominator += dx * dx;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

/** Read drift-monitor.threshold.sensitivity from plasticity, or return default. */
function readSensitivity(plasticity?: PlasticitySource): number {
  if (!plasticity) return 0.5;
  const thresholds = plasticity.getByCategory("threshold");
  const weight = thresholds.find((w) => w.connectionId === "drift-monitor.threshold.sensitivity");
  return weight?.value ?? 0.5;
}

// ─── DriftMonitor ────────────────────────────────────────────────

export class DriftMonitor {
  private config: DriftMonitorConfig;
  private assessment: DriftAssessment;
  private quickCheckHistory: Array<{ taskId: string; result: QuickCheckResult }> = [];
  private previousDriftLevel: number = 0;

  constructor(config?: Partial<DriftMonitorConfig>) {
    this.config = { ...DEFAULT_DRIFT_MONITOR_CONFIG, ...config };
    this.assessment = {
      driftLevel: 0,
      driftSummary: "",
      quickCheck: null,
      deepAnalysis: null,
      deepAnalysisAt: null,
      deepAnalysisPhaseGroup: null,
      sensitivityWeight: null,
    };
  }

  // ── Quick Check (procedural, after every task) ──────────────────

  /**
   * Compute drift signals from WM data. No LLM calls.
   * Called from the between-tasks integrate phase after each task completes.
   *
   * @param sources — what the drift monitor reads from
   * @param taskId — ID of the just-completed task (for history tracking)
   */
  quickCheck(sources: DriftMonitorSources, taskId?: string): QuickCheckResult {
    const summaries = sources.wm.getCompletedSummaries();
    const taskCount = summaries.length;

    // Cold start guard
    if (taskCount < this.config.minTasksForQuickCheck) {
      log.debug("Quick check skipped — cold start", {
        taskCount,
        threshold: this.config.minTasksForQuickCheck,
      });

      const result: QuickCheckResult = {
        signals: { profileShift: 0, tensionEscalation: 0, convergenceDifficulty: 0 },
        driftLevel: 0,
        driftSummary: "",
        taskCount,
        computedAt: new Date(),
      };
      return result;
    }

    // Compute the three signals
    const profileShift = this.computeProfileShift(sources);
    const tensionEscalation = this.computeTensionEscalation(summaries);
    const convergenceDifficulty = this.computeConvergenceDifficulty(summaries);

    const signals: QuickCheckSignals = {
      profileShift,
      tensionEscalation,
      convergenceDifficulty,
    };

    // Weighted composite
    const rawDrift =
      profileShift * this.config.profileShiftWeight +
      tensionEscalation * this.config.tensionEscalationWeight +
      convergenceDifficulty * this.config.convergenceDifficultyWeight;

    // Sensitivity modulation
    const sensitivity = readSensitivity(sources.plasticity);
    const driftLevel = clamp(rawDrift * (1 + (sensitivity - 0.5)), 0, 1);

    // Summary
    const driftSummary = this.buildQuickCheckSummary(signals);

    const result: QuickCheckResult = {
      signals,
      driftLevel,
      driftSummary,
      taskCount,
      computedAt: new Date(),
    };

    // Update internal state
    this.assessment.driftLevel = driftLevel;
    this.assessment.driftSummary = driftSummary;
    this.assessment.quickCheck = result;
    this.assessment.sensitivityWeight = sensitivity;

    if (taskId) {
      this.quickCheckHistory.push({ taskId, result });
    }

    // Emit events
    emit("drift-monitor:quick-check", {
      driftLevel,
      profileShift,
      tensionEscalation,
      convergenceDifficulty,
      taskCount,
      sensitivity,
    });

    // Threshold crossing detection
    this.emitIfThresholdCrossed(driftLevel);
    this.previousDriftLevel = driftLevel;

    log.info("Quick check complete", {
      driftLevel: driftLevel.toFixed(3),
      profileShift: profileShift.toFixed(3),
      tensionEscalation: tensionEscalation.toFixed(3),
      convergenceDifficulty: convergenceDifficulty.toFixed(3),
      taskCount,
    });

    return result;
  }

  // ── Deep Analysis (LLM, at phase gates) ─────────────────────────

  /**
   * Full trajectory assessment against intent, taste, and conventions.
   * Called at phase gates when a phaseGroup completes.
   *
   * Returns null on failure (graceful degradation — assessment retains
   * quick check level).
   */
  async deepAnalysis(
    sources: DriftMonitorSources,
    phaseGroup: string,
  ): Promise<DeepAnalysis | null> {
    const summaries = sources.wm.getCompletedSummaries();

    if (summaries.length < this.config.minTasksForDeepAnalysis) {
      log.debug("Deep analysis skipped — insufficient tasks", {
        taskCount: summaries.length,
        threshold: this.config.minTasksForDeepAnalysis,
      });
      return null;
    }

    log.info("Running deep analysis", {
      phaseGroup,
      taskCount: summaries.length,
    });

    const inputs = this.assembleDeepAnalysisInputs(sources);

    try {
      const result = await callStructured<DeepAnalysis>(
        "drift-analysis",
        this.config.deepAnalysisModel,
        driftAnalysisSystem(),
        driftAnalysisUser(inputs),
        DeepAnalysisSchema,
      );

      // Update internal state
      this.assessment.deepAnalysis = result;
      this.assessment.deepAnalysisAt = new Date();
      this.assessment.deepAnalysisPhaseGroup = phaseGroup;
      this.assessment.driftLevel = result.overallLevel;
      this.assessment.driftSummary = result.summary;

      emit("drift-monitor:deep-analysis", {
        phaseGroup,
        overallLevel: result.overallLevel,
        intentAlignmentLevel: result.intentAlignment.level,
        intentTrajectory: result.intentAlignment.trajectory,
        tasteDivergenceDetected: result.tasteDivergence.detected,
        tasteDivergenceCount: result.tasteDivergence.divergences.length,
        erodingConventions: result.conventionHealth.eroding.length,
        emergingConventions: result.conventionHealth.emerging.length,
        recommendationCount: result.recommendations.length,
      });

      this.emitIfThresholdCrossed(result.overallLevel);
      this.previousDriftLevel = result.overallLevel;

      log.info("Deep analysis complete", {
        phaseGroup,
        overallLevel: result.overallLevel.toFixed(3),
        intentAlignment: result.intentAlignment.level,
        tasteDivergence: result.tasteDivergence.detected,
        summary: result.summary.slice(0, 200),
      });

      return result;
    } catch (err) {
      log.warn("Deep analysis failed — retaining quick check level", {
        phaseGroup,
        error: String(err),
      });
      return null;
    }
  }

  // ── Accessors ──────────────────────────────────────────────────

  /** The current unified assessment. Read by assembleSignals() in task-dispatch. */
  getAssessment(): DriftAssessment {
    return { ...this.assessment };
  }

  /** Dashboard/debugging snapshot. */
  getState(): DriftMonitorState {
    const da = this.assessment.deepAnalysis;
    return {
      driftLevel: this.assessment.driftLevel,
      driftSummary: this.assessment.driftSummary,
      completedTaskCount: this.assessment.quickCheck?.taskCount ?? 0,
      quickCheckActive: this.assessment.quickCheck !== null && this.assessment.quickCheck.driftLevel > 0,
      signals: this.assessment.quickCheck?.signals ?? null,
      hasDeepAnalysis: da !== null,
      lastDeepAnalysisPhaseGroup: this.assessment.deepAnalysisPhaseGroup,
      lastDeepAnalysisAt: this.assessment.deepAnalysisAt,
      deepAnalysisLevel: da?.overallLevel ?? null,
      sensitivityWeight: this.assessment.sensitivityWeight,
      tasteDivergenceCount: da?.tasteDivergence.divergences.length ?? 0,
      erodingConventionCount: da?.conventionHealth.eroding.length ?? 0,
      emergingConventionCount: da?.conventionHealth.emerging.length ?? 0,
    };
  }

  // ── Private: Signal computation ─────────────────────────────────

  /**
   * Score profile shift — how much the shape of quality across senses
   * has changed between the first and second halves of completed tasks.
   *
   * std(per-sense deltas) / 3.0, clamped to [0, 1].
   */
  private computeProfileShift(sources: DriftMonitorSources): number {
    const trends = sources.wm.getSenseTrends();
    if (trends.length < 2) return 0;

    const deltas = trends.map((t) => t.currentMean - t.previousMean);
    return clamp(std(deltas) / 3.0, 0, 1);
  }

  /**
   * Tension escalation — linear regression slope of highTensionCount
   * across tasks, normalized.
   */
  private computeTensionEscalation(
    summaries: Array<{ highTensionCount: number }>,
  ): number {
    const ys = summaries.map((s) => s.highTensionCount);
    const slope = linearRegressionSlope(ys);
    return clamp(Math.max(0, slope) / 2.0, 0, 1);
  }

  /**
   * Convergence difficulty — linear regression slope of cycles
   * across tasks, normalized.
   */
  private computeConvergenceDifficulty(
    summaries: Array<{ cycles: number }>,
  ): number {
    const ys = summaries.map((s) => s.cycles);
    const slope = linearRegressionSlope(ys);
    return clamp(Math.max(0, slope) / 3.0, 0, 1);
  }

  // ── Private: Summary generation ─────────────────────────────────

  private buildQuickCheckSummary(signals: QuickCheckSignals): string {
    const parts: string[] = [];
    const threshold = 0.2;

    if (signals.profileShift > threshold) {
      parts.push(`Score profile shifting (${signals.profileShift.toFixed(2)})`);
    }
    if (signals.tensionEscalation > threshold) {
      parts.push(`Tensions escalating (${signals.tensionEscalation.toFixed(2)})`);
    }
    if (signals.convergenceDifficulty > threshold) {
      parts.push(`Convergence difficulty increasing (${signals.convergenceDifficulty.toFixed(2)})`);
    }

    if (parts.length === 0) return "";
    return parts.join(". ") + ".";
  }

  // ── Private: Threshold crossing events ──────────────────────────

  private static THRESHOLDS = [0.3, 0.5, 0.8];

  private emitIfThresholdCrossed(newLevel: number): void {
    for (const threshold of DriftMonitor.THRESHOLDS) {
      const wasBelowOrAt = this.previousDriftLevel < threshold;
      const isAbove = newLevel >= threshold;
      const wasAboveOrAt = this.previousDriftLevel >= threshold;
      const isBelow = newLevel < threshold;

      if ((wasBelowOrAt && isAbove) || (wasAboveOrAt && isBelow)) {
        emit("drift-monitor:level-changed", {
          threshold,
          previousLevel: this.previousDriftLevel,
          newLevel,
          direction: isAbove ? "crossed-above" : "crossed-below",
        });
      }
    }
  }

  // ── Private: Deep analysis input assembly ───────────────────────

  private assembleDeepAnalysisInputs(sources: DriftMonitorSources): DriftAnalysisInputs {
    const summaries = sources.wm.getCompletedSummaries();
    const scoreHistory = sources.wm.getScoreHistory();
    const senseTrends = sources.wm.getSenseTrends();

    // Build per-task sense means from score history
    // Use the last snapshot per task (same dedup as WM.getSenseTrends)
    const lastPerTask = new Map<string, typeof scoreHistory[0]>();
    for (const snapshot of scoreHistory) {
      lastPerTask.set(snapshot.taskId, snapshot);
    }

    const taskTrajectory: DriftAnalysisInputs["taskTrajectory"] = [];
    const tasks = sources.wm.getCompletedSummaries();

    // We need task descriptions — but TaskSummary doesn't carry them.
    // Use a generic description. The deep analysis still has the score
    // data and trends, which carry the trajectory signal.
    for (let i = 0; i < tasks.length; i++) {
      const summary = tasks[i];
      // Find score snapshot for this task (by index position since
      // TaskSummary doesn't carry taskId directly — use ordering)
      const snapshots = [...lastPerTask.values()];
      const snapshot = i < snapshots.length ? snapshots[i] : undefined;

      const senseMeans: Array<{ sense: string; mean: number }> = [];
      if (snapshot) {
        const senseGroups = new Map<string, number[]>();
        for (const entry of snapshot.scores) {
          const sense = entry.activationPath[0] ?? "unknown";
          let group = senseGroups.get(sense);
          if (!group) {
            group = [];
            senseGroups.set(sense, group);
          }
          group.push(entry.score);
        }
        for (const [sense, scores] of senseGroups) {
          senseMeans.push({
            sense,
            mean: scores.reduce((a, b) => a + b, 0) / scores.length,
          });
        }
      }

      taskTrajectory.push({
        description: `Task ${i + 1}`,
        weightedMean: summary.weightedMean,
        cycles: summary.cycles,
        highTensionCount: summary.highTensionCount,
        confidence: summary.confidence,
        senseMeans,
      });
    }

    const inputs: DriftAnalysisInputs = {
      intent: {
        summary: sources.intent.summary,
        vision: sources.intent.vision,
        audience: sources.intent.audience,
        successCriteria: sources.intent.successCriteria,
        constraints: sources.intent.constraints,
      },
      taste: {
        visual: sources.taste.visual,
        decisionStyle: sources.taste.decisionStyle,
        patterns: sources.taste.patterns,
      },
      taskTrajectory,
      senseTrends: senseTrends.map((t) => ({
        sense: t.label,
        direction: t.direction,
        previousMean: t.previousMean,
        currentMean: t.currentMean,
      })),
    };

    // Optional sources
    if (sources.worldModel) {
      const maxims = sources.worldModel.getMaximsForBriefing();
      if (maxims.length > 0) inputs.maxims = maxims;
    }

    if (sources.manifestedFuture) {
      inputs.manifestedFuture = sources.manifestedFuture;
    }

    const patterns = sources.wm.getPatterns();
    if (patterns.length > 0) {
      inputs.patterns = patterns.map((p) => ({
        description: p.description,
        confidence: p.confidence,
      }));
    }

    const decisions = sources.wm.getDecisions();
    if (decisions.length > 0) {
      inputs.decisions = decisions.slice(-10).map((d) => ({
        description: d.description,
        confidence: d.confidence,
      }));
    }

    const driftLog = sources.intent.driftLog;
    if (driftLog.length > 0) {
      inputs.previousDriftLog = driftLog.map((d) => ({
        timestamp: d.timestamp.toISOString(),
        delta: d.delta,
        acknowledged: d.acknowledged,
      }));
    }

    if (this.quickCheckHistory.length > 0) {
      inputs.quickCheckHistory = this.quickCheckHistory.map((h) => ({
        taskId: h.taskId,
        profileShift: h.result.signals.profileShift,
        tensionEscalation: h.result.signals.tensionEscalation,
        convergenceDifficulty: h.result.signals.convergenceDifficulty,
        level: h.result.driftLevel,
      }));
    }

    return inputs;
  }
}
