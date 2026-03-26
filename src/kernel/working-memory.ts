/**
 * Working Memory — the active scratchpad.
 *
 * Holds all state that persists across tasks within a project session:
 * score history, patterns, decisions, inhibitions, open questions.
 *
 * Not a database. Not long-term memory. This is what's "in mind" right now.
 * The brainstem monitors `getLoad()` as a vital sign. When load is high,
 * items get promoted to Hippocampus or pruned during rest cycles.
 *
 * Scores are tracked at the receptor level (ground truth) and aggregated
 * to the sense level on demand. Each ScoreEntry carries its activationPath
 * so WM never depends on SensoryCortex — the data is self-describing.
 */

import type {
  WorkingMemoryState,
  WMTask,
  ScoreSnapshot,
  ScoreEntry,
  ScoreTrend,
  TrendDirection,
  EstablishedPattern,
  OpenQuestion,
  InhibitedSense,
  TaskSummary,
  OscillationSignal,
  ConvictionEntry,
  ConvictionTrajectory,
} from "../types/working-memory.js";
import type {
  TerritoryObservation,
  ObservationStatus,
} from "../types/territory-observation.js";
import { observationPressure } from "../types/territory-observation.js";
import type { ConvictionResult } from "../types/conviction.js";
import type { SenseEvaluation } from "../types/sense.js";
import type { DecisionRecord } from "../types/intent.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { WeightedEvaluation } from "./evaluation-weighter.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("working-memory");

/** Threshold on the 10-point scale for trending up/down. */
const DIRECTION_THRESHOLD = 0.5;

/** Conviction direction threshold — 5% of 0-1 range (proportional to score threshold). */
const CONVICTION_DIRECTION_THRESHOLD = 0.05;

export class WorkingMemory {
  private state: WorkingMemoryState;

  /**
   * Single-writer guard. Detects if two mutation contexts overlap.
   * All mutations are synchronous today — this assertion ensures that
   * invariant is never silently violated if parallelism is added later.
   */
  private activeWriter: string | null = null;

  constructor(projectId: string) {
    this.state = {
      projectId,
      tasks: [],
      currentTaskId: null,
      scoreHistory: [],
      decisions: [],
      patterns: [],
      inhibitedSenses: [],
      openQuestions: [],
      convictionLedger: [],
      observations: [],
      lastUpdated: new Date(),
    };
  }

  // ── Task Lifecycle ──────────────────────────────────────────────

  addTask(taskId: string, description: string): void {
    if (this.state.tasks.some((t) => t.taskId === taskId)) {
      throw new Error(`Task ${taskId} already exists in working memory`);
    }

    const task: WMTask = {
      taskId,
      description,
      status: "pending",
    };

    this.state.tasks.push(task);
    this.touch();

    emit("wm:task-added", { taskId, description });
    log.info("Task added", { taskId, description });
  }

  startTask(taskId: string): void {
    const task = this.findTask(taskId);
    if (task.status !== "pending") {
      throw new Error(
        `Cannot start task ${taskId}: status is "${task.status}", expected "pending"`,
      );
    }

    task.status = "active";
    task.startedAt = new Date();
    this.state.currentTaskId = taskId;
    this.touch();

    emit("wm:task-started", { taskId });
    log.info("Task started", { taskId });
  }

  /**
   * Record task completion. Extracts summary + scores from the
   * OrchestratorResult and stores the compressed representation.
   */
  completeTask(taskId: string, result: OrchestratorResult): void {
    const task = this.findTask(taskId);
    if (task.status !== "active") {
      throw new Error(
        `Cannot complete task ${taskId}: status is "${task.status}", expected "active"`,
      );
    }

    // Extract TaskSummary
    // When driven by the rhythm system, confidence comes from the weighted
    // composite. For the fallback path, we compute a raw mean.
    const scores = result.evaluations.map((e) => e.score);
    const weightedMean =
      scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    task.summary = {
      cycles: result.cycles,
      confidence: result.confidence,
      weightedMean,
      highTensionCount: result.tensions.filter((t) => t.severity === "high")
        .length,
      completedAt: new Date(),
    };
    task.status = "complete";

    // Record scores only if build-cycle didn't already record them.
    // When driven by the rhythm system, build-cycle.integrate calls
    // recordScores() each cycle, so scores already exist for this task.
    // Standalone callers (tests, old orchestrator) still get scores recorded here.
    const hasScores = this.state.scoreHistory.some((s) => s.taskId === taskId);
    if (!hasScores && result.evaluations.length > 0) {
      const snapshot: ScoreSnapshot = {
        taskId,
        scores: result.evaluations.map(
          (evaluation): ScoreEntry => ({
            receptorId: evaluation.senseId,
            activationPath: evaluation.activationPath,
            score: evaluation.score,
            stake: 1.0, // fallback path — no weighted evaluations available
          }),
        ),
        recordedAt: new Date(),
      };
      this.state.scoreHistory.push(snapshot);
    }

    // Absorb decisions
    for (const decision of result.decisionLog) {
      this.state.decisions.push(decision);
    }

    // Clear current task
    this.state.currentTaskId = null;
    this.touch();

    emit("wm:task-completed", {
      taskId,
      cycles: result.cycles,
      confidence: result.confidence,
      weightedMean,
      evaluationCount: result.evaluations.length,
      decisionCount: result.decisionLog.length,
    });

    log.info("Task completed", {
      taskId,
      cycles: result.cycles,
      confidence: result.confidence,
      weightedMean: weightedMean.toFixed(2),
    });
  }

  /**
   * Reopen a completed task for rework. Resets status to "pending"
   * and clears the summary so it can re-execute through the normal
   * lifecycle. Called by graph surgery rework operations.
   */
  reopenTask(taskId: string, reason: string): void {
    const task = this.findTask(taskId);
    if (task.status !== "complete") {
      throw new Error(
        `Cannot reopen task ${taskId}: status is "${task.status}", expected "complete"`,
      );
    }

    task.status = "pending";
    task.summary = undefined;
    this.touch();

    emit("wm:task-reopened", { taskId, reason });
    log.info("Task reopened for rework", { taskId, reason });
  }

  failTask(taskId: string, reason?: string): void {
    const task = this.findTask(taskId);
    task.status = "failed";

    if (this.state.currentTaskId === taskId) {
      this.state.currentTaskId = null;
    }
    this.touch();

    emit("wm:task-failed", { taskId, reason });
    log.warn("Task failed", { taskId, reason });
  }

  // ── Score Recording ─────────────────────────────────────────────

  /**
   * Record scores outside of the completeTask flow.
   * Useful for intermediate cycle evaluations or external scoring.
   */
  recordScores(taskId: string, evaluations: WeightedEvaluation[]): void {
    if (evaluations.length === 0) return;

    const snapshot: ScoreSnapshot = {
      taskId,
      scores: evaluations.map(
        (evaluation): ScoreEntry => ({
          receptorId: evaluation.senseId,
          activationPath: evaluation.activationPath,
          score: evaluation.score,
          stake: evaluation.adjustedStake,
        }),
      ),
      recordedAt: new Date(),
    };
    this.state.scoreHistory.push(snapshot);
    this.touch();

    emit("wm:scores-recorded", {
      taskId,
      evaluationCount: evaluations.length,
    });
  }

  // ── Oscillation Detection ──────────────────────────────────────

  /** Swing threshold: score change of 3+ points between consecutive cycles. */
  private static OSCILLATION_THRESHOLD = 3;

  /**
   * Detect receptors whose scores oscillated significantly across
   * build cycles within a single task. Indicates thrashing or
   * collateral damage from revisions targeting other dimensions.
   */
  detectOscillations(taskId: string): OscillationSignal[] {
    const snapshots = this.state.scoreHistory.filter((s) => s.taskId === taskId);
    if (snapshots.length < 2) return [];

    // Group scores by receptor across snapshots
    const byReceptor = new Map<string, { scores: number[]; path: string[] }>();
    for (const snapshot of snapshots) {
      for (const entry of snapshot.scores) {
        let record = byReceptor.get(entry.receptorId);
        if (!record) {
          record = { scores: [], path: entry.activationPath };
          byReceptor.set(entry.receptorId, record);
        }
        record.scores.push(entry.score);
      }
    }

    const signals: OscillationSignal[] = [];
    for (const [receptorId, record] of byReceptor) {
      if (record.scores.length < 2) continue;

      // Find max swing between consecutive scores
      let maxSwing = 0;
      for (let i = 1; i < record.scores.length; i++) {
        const swing = Math.abs(record.scores[i] - record.scores[i - 1]);
        if (swing > maxSwing) maxSwing = swing;
      }

      if (maxSwing >= WorkingMemory.OSCILLATION_THRESHOLD) {
        signals.push({
          receptorId,
          activationPath: record.path,
          recentScores: record.scores,
          swingMagnitude: maxSwing,
        });
      }
    }

    if (signals.length > 0) {
      emit("stability:oscillation", {
        taskId,
        count: signals.length,
        receptors: signals.map((s) => ({
          path: s.activationPath.join(" > "),
          scores: s.recentScores,
          swing: s.swingMagnitude,
        })),
      });
    }

    return signals;
  }

  // ── Score Trends (computed on demand) ───────────────────────────

  /**
   * Per-receptor trends — ground truth for actionable signals.
   * "Typography is trending down" → fix typography specifically.
   */
  getReceptorTrends(): ScoreTrend[] {
    // Use only the last snapshot per task — intermediate build-cycle
    // evaluations are revision attempts, not final outcomes.
    const snapshots = this.lastSnapshotPerTask();

    const receptors = new Map<
      string,
      { scores: number[]; label: string; activationPath: string[] }
    >();

    for (const snapshot of snapshots) {
      for (const entry of snapshot.scores) {
        let rec = receptors.get(entry.receptorId);
        if (!rec) {
          rec = {
            scores: [],
            label: entry.activationPath[entry.activationPath.length - 1] ?? entry.receptorId,
            activationPath: entry.activationPath,
          };
          receptors.set(entry.receptorId, rec);
        }
        rec.scores.push(entry.score);
      }
    }

    const trends: ScoreTrend[] = [];
    for (const [receptorId, data] of receptors) {
      const { firstMean, secondMean } = splitMeans(data.scores);
      trends.push({
        id: receptorId,
        label: data.label,
        level: "receptor",
        direction: computeDirection(data.scores),
        currentMean: secondMean,
        previousMean: firstMean,
        dataPoints: data.scores.length,
      });
    }

    return trends;
  }

  /**
   * Per-sense trends — meta-interpretation for high-level signals.
   * "Design is struggling across the board" → investigate deeper.
   *
   * Key: sense-level trends operate on per-task sense MEANS,
   * not raw receptor scores. This prevents a sense with many
   * receptors from dominating one with few.
   */
  getSenseTrends(): ScoreTrend[] {
    // Use only the last snapshot per task (same dedup as receptor trends)
    const snapshots = this.lastSnapshotPerTask();

    const senses = new Map<string, number[]>();

    for (const snapshot of snapshots) {
      // Group this snapshot's scores by sense (activationPath[0])
      const senseGroups = new Map<string, number[]>();
      for (const entry of snapshot.scores) {
        const senseName = entry.activationPath[0] ?? "unknown";
        let group = senseGroups.get(senseName);
        if (!group) {
          group = [];
          senseGroups.set(senseName, group);
        }
        group.push(entry.score);
      }

      // Compute per-sense mean for this task and accumulate
      for (const [senseName, scores] of senseGroups) {
        const taskMean = scores.reduce((a, b) => a + b, 0) / scores.length;
        let accumulated = senses.get(senseName);
        if (!accumulated) {
          accumulated = [];
          senses.set(senseName, accumulated);
        }
        accumulated.push(taskMean);
      }
    }

    const trends: ScoreTrend[] = [];
    for (const [senseName, taskMeans] of senses) {
      const { firstMean, secondMean } = splitMeans(taskMeans);
      trends.push({
        id: senseName,
        label: senseName,
        level: "sense",
        direction: computeDirection(taskMeans),
        currentMean: secondMean,
        previousMean: firstMean,
        dataPoints: taskMeans.length,
      });
    }

    return trends;
  }

  // ── Patterns ────────────────────────────────────────────────────

  recordPattern(description: string, confidence = 0.5): EstablishedPattern {
    const pattern: EstablishedPattern = {
      id: newId(),
      description,
      establishedAt: new Date(),
      confidence,
    };

    this.state.patterns.push(pattern);
    this.touch();

    emit("wm:pattern-recorded", { id: pattern.id, description, confidence });
    log.info("Pattern recorded", { id: pattern.id, description });
    return pattern;
  }

  getPatterns(): EstablishedPattern[] {
    return [...this.state.patterns];
  }

  // ── Decisions ───────────────────────────────────────────────────

  recordDecision(decision: DecisionRecord): void {
    this.state.decisions.push(decision);
    this.touch();

    emit("wm:decision-recorded", {
      id: decision.id,
      description: decision.description,
    });
  }

  getDecisions(): DecisionRecord[] {
    return [...this.state.decisions];
  }

  // ── Inhibition ──────────────────────────────────────────────────

  /**
   * Suppress a sense. Idempotent: if already inhibited, updates
   * the reason and source (Amygdala overrides Basal Ganglia, etc.).
   */
  inhibitSense(senseId: string, reason: string, source: string, scope?: string): void {
    const existing = this.state.inhibitedSenses.find(
      (s) => s.senseId === senseId,
    );
    if (existing) {
      existing.reason = reason;
      existing.source = source;
      existing.scope = scope;
      existing.inhibitedAt = new Date();
    } else {
      this.state.inhibitedSenses.push({
        senseId,
        reason,
        source,
        scope,
        inhibitedAt: new Date(),
      });
    }
    this.touch();

    emit("wm:sense-inhibited", { senseId, reason, source, scope });
    log.info("Sense inhibited", { senseId, reason, source, scope });
  }

  /**
   * Clear all inhibitions at the given scope and narrower scopes.
   * Scope hierarchy: project > phase > subphase > task.
   * Only clears inhibitions that have a scope — scopeless inhibitions
   * (e.g. from Amygdala) are left untouched.
   */
  clearInhibitionsByScope(scope: string): string[] {
    const hierarchy = ["project", "phase", "subphase", "task"];
    const scopeIdx = hierarchy.indexOf(scope);
    if (scopeIdx === -1) return [];

    const scopesToClear = new Set(hierarchy.slice(scopeIdx));
    const cleared: string[] = [];

    this.state.inhibitedSenses = this.state.inhibitedSenses.filter((s) => {
      if (s.scope && scopesToClear.has(s.scope)) {
        cleared.push(s.senseId);
        return false;
      }
      return true;
    });

    if (cleared.length > 0) {
      this.touch();
      emit("wm:inhibitions-cleared", { scope, cleared });
      log.info("Inhibitions cleared by scope", { scope, cleared });
    }

    return cleared;
  }

  uninhibitSense(senseId: string): boolean {
    const idx = this.state.inhibitedSenses.findIndex(
      (s) => s.senseId === senseId,
    );
    if (idx === -1) return false;

    this.state.inhibitedSenses.splice(idx, 1);
    this.touch();

    emit("wm:sense-uninhibited", { senseId });
    return true;
  }

  isInhibited(senseId: string): boolean {
    return this.state.inhibitedSenses.some((s) => s.senseId === senseId);
  }

  getInhibitedSenses(): InhibitedSense[] {
    return [...this.state.inhibitedSenses];
  }

  // ── Open Questions ──────────────────────────────────────────────

  addQuestion(question: string, context: string): OpenQuestion {
    const entry: OpenQuestion = {
      id: newId(),
      question,
      context,
      askedAt: new Date(),
    };

    this.state.openQuestions.push(entry);
    this.touch();

    emit("wm:question-added", { id: entry.id, question });
    log.info("Question added", { id: entry.id, question });
    return entry;
  }

  resolveQuestion(questionId: string, answer: string): void {
    const question = this.state.openQuestions.find(
      (q) => q.id === questionId,
    );
    if (!question) {
      throw new Error(`Question ${questionId} not found in working memory`);
    }

    question.resolvedAt = new Date();
    question.answer = answer;
    this.touch();

    emit("wm:question-resolved", { id: questionId, answer });
    log.info("Question resolved", { id: questionId });
  }

  /** Returns only unresolved questions. */
  getOpenQuestions(): OpenQuestion[] {
    return this.state.openQuestions.filter((q) => q.resolvedAt === undefined);
  }

  // ── Conviction Ledger ──────────────────────────────────────────

  /**
   * Record a conviction result from a task-dispatch gate.
   * Builds the trajectory that triage and diagnostics read.
   */
  recordConviction(
    result: ConvictionResult,
    taskId: string | null,
    replanGeneration: number,
  ): void {
    const entry: ConvictionEntry = {
      verdict: result.verdict,
      level: result.level,
      delta: result.delta,
      decidingStep: result.decidingStep,
      taskId,
      replanGeneration,
      recordedAt: new Date(),
    };

    this.state.convictionLedger.push(entry);
    this.touch();

    emit("wm:conviction-recorded", {
      verdict: entry.verdict,
      level: entry.level,
      delta: entry.delta,
      taskId,
      replanGeneration,
    });
    log.info("Conviction recorded", {
      verdict: entry.verdict,
      level: entry.level.toFixed(2),
      delta: entry.delta.toFixed(2),
      taskId,
      replanGeneration,
    });
  }

  /** All conviction entries in chronological order. */
  getConvictionHistory(): ConvictionEntry[] {
    return [...this.state.convictionLedger];
  }

  /**
   * Computed trajectory over the conviction ledger.
   * Direction uses a conviction-scale threshold (0.05 on 0-1),
   * not the score-scale threshold (0.5 on 1-10).
   */
  getConvictionTrajectory(): ConvictionTrajectory {
    const entries = this.state.convictionLedger;

    if (entries.length === 0) {
      return {
        levels: [],
        direction: "stable",
        currentLevel: 0.5,
        generationCount: 0,
        generationMeans: [],
      };
    }

    const levels = entries.map((e) => e.level);

    // Group by generation
    const byGeneration = new Map<number, number[]>();
    for (const entry of entries) {
      let group = byGeneration.get(entry.replanGeneration);
      if (!group) {
        group = [];
        byGeneration.set(entry.replanGeneration, group);
      }
      group.push(entry.level);
    }

    const generationMeans = [...byGeneration.entries()]
      .sort(([a], [b]) => a - b)
      .map(([generation, genLevels]) => ({
        generation,
        meanLevel: mean(genLevels),
        entryCount: genLevels.length,
      }));

    return {
      levels,
      direction: computeConvictionDirection(levels),
      currentLevel: levels[levels.length - 1],
      generationCount: byGeneration.size,
      generationMeans,
    };
  }

  // ── Territory Observations ─────────────────────────────────────

  /**
   * Store a territory observation. Does NOT affect WM load / homeostasis.
   * Observations have their own pressure metric via getObservationPressure().
   */
  addObservation(obs: TerritoryObservation): void {
    this.state.observations.push(obs);
    this.touch();

    emit("wm:observation-added", {
      id: obs.id,
      fact: obs.fact,
      source: obs.source,
      relevance: obs.relevance,
    });
    log.info("Observation added", {
      id: obs.id,
      component: obs.source.component,
      relevance: obs.relevance.toFixed(2),
    });
  }

  /** Get observations, optionally filtered by status. */
  getObservations(status?: ObservationStatus): TerritoryObservation[] {
    if (status) {
      return this.state.observations.filter((o) => o.status === status);
    }
    return [...this.state.observations];
  }

  /** Shorthand for observations with status "new". */
  getNewObservations(): TerritoryObservation[] {
    return this.getObservations("new");
  }

  /** Mark an observation as triaged by quick triage. */
  markObservationTriaged(id: string): void {
    const obs = this.state.observations.find((o) => o.id === id);
    if (obs) {
      obs.status = "triaged";
      this.touch();
    }
  }

  /** Restore an observation to "new" status. Used when a quick-triage proposal
   *  that consumed this observation is later dropped (validation failure). The
   *  observation should re-enter the pool so deep synthesis can pick it up. */
  unmarkObservationTriaged(id: string): void {
    const obs = this.state.observations.find((o) => o.id === id);
    if (obs && obs.status === "triaged") {
      obs.status = "new";
      this.touch();
    }
  }

  /** Mark an observation as consumed by deep synthesis. */
  markObservationSynthesized(id: string, consumedBy: string): void {
    const obs = this.state.observations.find((o) => o.id === id);
    if (obs) {
      obs.status = "synthesized";
      obs.consumedBy = consumedBy;
      this.touch();
    }
  }

  /** Dismiss an observation as irrelevant. Tracks dismissal rate per source. */
  dismissObservation(id: string): void {
    const obs = this.state.observations.find((o) => o.id === id);
    if (obs) {
      obs.status = "dismissed";
      this.touch();

      emit("wm:observation-dismissed", {
        id,
        source: obs.source,
      });
    }
  }

  /**
   * Dismissal rate per source component (0-1).
   * High rates indicate a source is producing irrelevant observations
   * and its relevance estimates should be discounted.
   */
  getDismissalRates(): Map<string, { total: number; dismissed: number; rate: number }> {
    const bySource = new Map<string, { total: number; dismissed: number }>();

    for (const obs of this.state.observations) {
      const key = obs.source.component;
      let entry = bySource.get(key);
      if (!entry) {
        entry = { total: 0, dismissed: 0 };
        bySource.set(key, entry);
      }
      entry.total++;
      if (obs.status === "dismissed") entry.dismissed++;
    }

    const rates = new Map<string, { total: number; dismissed: number; rate: number }>();
    for (const [key, { total, dismissed }] of bySource) {
      rates.set(key, { total, dismissed, rate: total > 0 ? dismissed / total : 0 });
    }
    return rates;
  }

  /**
   * Observation pressure (0-1). Separate from WM load.
   * High pressure signals that synthesis should run sooner.
   */
  getObservationPressure(): number {
    return observationPressure(this.state.observations);
  }

  // ── Reading ─────────────────────────────────────────────────────

  getTasks(): WMTask[] {
    return [...this.state.tasks];
  }

  getCurrentTaskId(): string | null {
    return this.state.currentTaskId;
  }

  /** Summaries from all completed tasks, in completion order. */
  getCompletedSummaries(): TaskSummary[] {
    return this.state.tasks
      .filter((t): t is WMTask & { summary: TaskSummary } => t.summary != null)
      .map((t) => t.summary);
  }

  /** Raw score history for deep consumers (Cerebellum, Basal Ganglia). */
  getScoreHistory(): ScoreSnapshot[] {
    return [...this.state.scoreHistory];
  }

  // ── Vital Signs ─────────────────────────────────────────────────

  /**
   * Working memory load as a vital sign. 0–1.
   * Combines item counts relative to practical limits.
   * The brainstem monitors this; when high, rest cycle prunes WM.
   */
  getLoad(): number {
    const patternLoad = this.state.patterns.length / 50;
    const decisionLoad = this.state.decisions.length / 100;
    const questionLoad =
      this.state.openQuestions.filter((q) => !q.resolvedAt).length / 20;
    const convictionLoad = this.state.convictionLedger.length / 50;

    const load =
      patternLoad * 0.35 +
      decisionLoad * 0.35 +
      questionLoad * 0.2 +
      convictionLoad * 0.1;
    return Math.min(1, load);
  }

  // ── Snapshot ────────────────────────────────────────────────────

  /** Deep copy of full state for serialization or dashboard. */
  snapshot(): WorkingMemoryState {
    return structuredClone(this.state);
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /**
   * Deduplicate scoreHistory: keep only the last snapshot per taskId.
   * Build-cycle may record multiple snapshots per task (one per revision
   * cycle). Trends should reflect the final evaluation, not intermediate
   * revision attempts.
   */
  private lastSnapshotPerTask(): ScoreSnapshot[] {
    const lastPerTask = new Map<string, ScoreSnapshot>();
    for (const snapshot of this.state.scoreHistory) {
      lastPerTask.set(snapshot.taskId, snapshot);
    }
    return [...lastPerTask.values()];
  }

  private findTask(taskId: string): WMTask {
    const task = this.state.tasks.find((t) => t.taskId === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in working memory`);
    }
    return task;
  }

  /**
   * Begin a named mutation. Throws if another mutation is in progress.
   * Call endMutation() when done. Use try/finally to guarantee cleanup.
   */
  beginMutation(writerId: string): void {
    if (this.activeWriter) {
      throw new Error(
        `WorkingMemory concurrent mutation: "${writerId}" attempted while "${this.activeWriter}" holds write access`,
      );
    }
    this.activeWriter = writerId;
  }

  /** Release the mutation guard. */
  endMutation(): void {
    this.activeWriter = null;
  }

  private touch(): void {
    this.state.lastUpdated = new Date();
  }
}

// ─── Pure Functions ──────────────────────────────────────────────

/**
 * Compute trend direction by comparing first half mean to second half.
 * Threshold of 0.5 on the 10-point scale prevents noise from
 * showing as a trend.
 */
function computeDirection(scores: number[]): TrendDirection {
  if (scores.length < 2) return "stable";

  const mid = Math.ceil(scores.length / 2);
  const firstHalf = scores.slice(0, mid);
  const secondHalf = scores.slice(mid);

  const firstMean = mean(firstHalf);
  const secondMean = mean(secondHalf);
  const delta = secondMean - firstMean;

  if (delta > DIRECTION_THRESHOLD) return "up";
  if (delta < -DIRECTION_THRESHOLD) return "down";
  return "stable";
}

/**
 * Split scores into halves and compute means.
 * Used by both trend computation and trend reporting.
 */
function splitMeans(scores: number[]): {
  firstMean: number;
  secondMean: number;
} {
  if (scores.length === 0) return { firstMean: 0, secondMean: 0 };
  if (scores.length === 1) return { firstMean: scores[0], secondMean: scores[0] };

  const mid = Math.ceil(scores.length / 2);
  return {
    firstMean: mean(scores.slice(0, mid)),
    secondMean: mean(scores.slice(mid)),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Conviction-scale direction. Same split-halves algorithm as score trends,
 * but with a threshold proportional to the 0-1 range (5%) rather than
 * the 10-point score range (0.5).
 */
function computeConvictionDirection(levels: number[]): TrendDirection {
  if (levels.length < 2) return "stable";

  const mid = Math.ceil(levels.length / 2);
  const firstMean = mean(levels.slice(0, mid));
  const secondMean = mean(levels.slice(mid));
  const delta = secondMean - firstMean;

  if (delta > CONVICTION_DIRECTION_THRESHOLD) return "up";
  if (delta < -CONVICTION_DIRECTION_THRESHOLD) return "down";
  return "stable";
}
