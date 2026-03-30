/**
 * Conviction Loop — PFC reasoning protocol.
 *
 * Pure functions. No class, no state, no LLM calls.
 * Fires at every gate decision point. Tests:
 *   1. Necessity — does this action need to happen?
 *   2. Conviction — can we still manifest the outcome?
 *   3. Speed of light — how close to the ceiling?
 *   4. Shape downstream — what should consumers know?
 *
 * Imported directly by rhythm gate phases.
 */

import type {
  ConvictionContext,
  ConvictionResult,
  ConvictionEvidence,
  ConvictionShaping,
  NecessityResult,
  ConvictionTestResult,
  SpeedOfLightTestResult,
} from "../types/conviction.js";
import { emit } from "../events.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("conviction");

// ─── Thresholds ─────────────────────────────────────────────────
// Defaults — overridable via ConvictionThresholds parameter.

export interface ConvictionThresholds {
  /** Below this, conviction is too low — escalate to Parsifal. */
  escalateThreshold: number;
  /** Below this, conviction is weak — reshape approach. */
  reshapeThreshold: number;
  /** Speed-of-light: within this fraction of ceiling = near ceiling. */
  solNearCeiling: number;
  /** Speed-of-light: beyond this fraction of ceiling = far from ceiling. */
  solFarFromCeiling: number;
  /** Tonic dopamine below this = project persistently disappointing. */
  tonicLowThreshold: number;
}

export const DEFAULT_CONVICTION_THRESHOLDS: ConvictionThresholds = {
  escalateThreshold: 0.3,
  reshapeThreshold: 0.5,
  solNearCeiling: 0.2,
  solFarFromCeiling: 0.5,
  tonicLowThreshold: 0.25,
};

/**
 * Compute NE-modulated conviction thresholds.
 * High NE → lower thresholds (escalate/reshape sooner).
 * Low NE → higher thresholds (push through more).
 *
 * Formula: effectiveThreshold = baseThreshold * (1 - sensitivity * neLevel)
 * At NE=1.0 with default sensitivity, thresholds drop by 40%.
 *
 * Only modulates escalateThreshold and reshapeThreshold — SoL thresholds
 * and tonicLowThreshold are about physics and project health, not arousal.
 */
export function modulateThresholds(
  base: ConvictionThresholds,
  neLevel?: number,
  sensitivity = 0.4,
): ConvictionThresholds {
  if (neLevel === undefined) return base;
  const factor = 1 - sensitivity * Math.max(0, Math.min(1, neLevel));
  return {
    ...base,
    escalateThreshold: base.escalateThreshold * factor,
    reshapeThreshold: base.reshapeThreshold * factor,
  };
}

/** Default conviction when no prior exists. */
const NEUTRAL_PRIOR = 0.5;

/** Conviction momentum decay — previous conviction erodes if not reinforced. */
const MOMENTUM_DECAY = 0.8;

// ─── Pipeline ───────────────────────────────────────────────────

/**
 * Run the full conviction loop.
 *
 * Called at gate decision points in build-cycle and task-dispatch rhythms.
 * Returns a structured decision that feeds into SignalLandscape, gate
 * strategy selection, and downstream shaping.
 */
export function runConvictionLoop(
  ctx: ConvictionContext,
  thresholds?: Partial<ConvictionThresholds>,
): ConvictionResult {
  const t = { ...DEFAULT_CONVICTION_THRESHOLDS, ...thresholds };

  emit("conviction:start", { level: ctx.level, cycle: ctx.cycle });

  // Step 1: Necessity
  const necessity = testNecessity(ctx, t);
  if (!necessity.necessary) {
    const verdict = necessity.verdict ?? "reshape";
    const level = verdict === "escalate" ? 0.1 : 0.3;
    const delta = level - (ctx.previousConviction?.level ?? NEUTRAL_PRIOR);
    const shaping = computeShaping(ctx, necessity.evidence, verdict, necessity.reshapeGuidance);

    log.info("Necessity failed", {
      level: ctx.level,
      cycle: ctx.cycle,
      verdict,
      evidenceCount: necessity.evidence.length,
    });

    return {
      verdict,
      level,
      delta,
      evidence: necessity.evidence,
      shaping,
      decidingStep: "necessity",
    };
  }

  // Step 2: Conviction
  const conviction = testConviction(ctx, t);

  if (conviction.shouldEscalate) {
    const shaping = computeShaping(ctx, conviction.evidence, "escalate");

    log.info("Conviction too low — escalating", {
      level: ctx.level,
      cycle: ctx.cycle,
      convictionLevel: conviction.level,
    });

    return {
      verdict: "escalate",
      level: conviction.level,
      delta: conviction.delta,
      evidence: conviction.evidence,
      shaping,
      decidingStep: "conviction",
    };
  }

  const allEvidence = [...conviction.evidence];

  // Step 3: Speed of Light (build-cycle only)
  if (ctx.level === "build-cycle") {
    const sol = testSpeedOfLight(ctx, t);
    allEvidence.push(...sol.evidence);

    if (sol.shouldRearchitect) {
      const reshapeGuidance = sol.evidence
        .filter((e) => e.valence === "undermines")
        .map((e) => e.description)
        .join(". ");
      const shaping = computeShaping(ctx, allEvidence, "reshape", reshapeGuidance);

      log.info("Speed of light — rearchitect", {
        level: ctx.level,
        cycle: ctx.cycle,
        gapRatio: sol.gapRatio,
      });

      return {
        verdict: "reshape",
        level: Math.min(conviction.level, 0.4),
        delta: Math.min(conviction.level, 0.4) - (ctx.previousConviction?.level ?? NEUTRAL_PRIOR),
        evidence: allEvidence,
        shaping,
        decidingStep: "speed-of-light",
      };
    }
  }

  // Step 4: Shape downstream
  const verdict = conviction.level < t.reshapeThreshold ? "reshape" : "proceed";
  const reshapeGuidance = verdict === "reshape"
    ? conviction.evidence
        .filter((e) => e.valence === "undermines")
        .map((e) => e.description)
        .join(". ")
    : undefined;
  const shaping = computeShaping(ctx, allEvidence, verdict, reshapeGuidance);

  log.info("Conviction loop complete", {
    level: ctx.level,
    cycle: ctx.cycle,
    verdict,
    convictionLevel: conviction.level,
    delta: conviction.delta,
    evidenceCount: allEvidence.length,
  });

  return {
    verdict,
    level: conviction.level,
    delta: conviction.delta,
    evidence: allEvidence,
    shaping,
    decidingStep: "conviction",
  };
}

// ─── Step 1: Necessity ──────────────────────────────────────────

/**
 * Pre-gate filter. If this action isn't necessary, short-circuit
 * before computing conviction or checking speed of light.
 */
export function testNecessity(ctx: ConvictionContext, t: ConvictionThresholds = DEFAULT_CONVICTION_THRESHOLDS): NecessityResult {
  const evidence: ConvictionEvidence[] = [];

  if (ctx.level === "build-cycle") {
    return testBuildCycleNecessity(ctx, evidence);
  }

  if (ctx.level === "task-dispatch") {
    return testTaskDispatchNecessity(ctx, evidence, t);
  }

  return { necessary: true, evidence };
}

function testBuildCycleNecessity(
  ctx: ConvictionContext,
  evidence: ConvictionEvidence[],
): NecessityResult {
  // Oscillation: WM already filters at 3-point threshold.
  // Any signal that exists is significant — cycling is counterproductive.
  if (ctx.oscillations && ctx.oscillations.length > 0) {
    const receptors = ctx.oscillations.map((o) => o.receptorId).join(", ");
    evidence.push({
      source: "oscillation",
      description: `Score oscillation on ${ctx.oscillations.length} receptor(s): ${receptors}. Cycling is counterproductive.`,
      magnitude: ctx.oscillations.length,
      valence: "undermines",
    });

    return {
      necessary: false,
      evidence,
      reshapeGuidance: `Score oscillation detected on ${receptors}. Cortex is thrashing — revisions are undoing each other. Re-plan the approach from scratch.`,
      verdict: "reshape",
    };
  }

  // Approach bottleneck: the approach itself can't reach the ceiling.
  if (ctx.speedOfLight?.approachSpecific?.approachIsBottleneck) {
    const gap = ctx.speedOfLight.approachSpecific.bottleneckGap;
    evidence.push({
      source: "approach-bottleneck",
      description: `Approach is the bottleneck (gap: ${gap?.toFixed(1) ?? "?"}). More iteration won't help.`,
      magnitude: gap ?? 0,
      valence: "undermines",
    });

    return {
      necessary: false,
      evidence,
      reshapeGuidance: "Approach is the bottleneck — it consistently underperforms the overall ceiling. Re-plan from scratch, don't optimize.",
      verdict: "reshape",
    };
  }

  return { necessary: true, evidence };
}

function testTaskDispatchNecessity(
  ctx: ConvictionContext,
  evidence: ConvictionEvidence[],
  t: ConvictionThresholds,
): NecessityResult {
  // Graph exhausted: all tasks done or escalated.
  if (ctx.taskGraph && ctx.completedTaskIds && ctx.escalatedTaskIds) {
    const total = ctx.taskGraph.length;
    const done = ctx.completedTaskIds.size + ctx.escalatedTaskIds.size;

    if (total > 0 && done >= total) {
      evidence.push({
        source: "graph-exhausted",
        description: `All ${total} task(s) completed or escalated.`,
        magnitude: 1,
        valence: "supports",
      });

      return {
        necessary: false,
        evidence,
        // Graph exhaustion is completion, not a problem.
        verdict: "reshape",
      };
    }
  }

  // Tonic dopamine persistently low: project is disappointing.
  if (ctx.vitals && ctx.vitals.tonicDopamine < t.tonicLowThreshold) {
    evidence.push({
      source: "tonic-low",
      description: `Tonic dopamine is ${ctx.vitals.tonicDopamine.toFixed(2)} (below ${t.tonicLowThreshold}). Project reward environment is poor.`,
      magnitude: t.tonicLowThreshold - ctx.vitals.tonicDopamine,
      valence: "undermines",
    });

    return {
      necessary: false,
      evidence,
      reshapeGuidance: "Project reward environment is persistently poor. Consider strategy change or escalate for Parsifal guidance.",
      verdict: "reshape",
    };
  }

  return { necessary: true, evidence };
}

// ─── Step 2: Conviction ─────────────────────────────────────────

/**
 * Compute continuous conviction level from available signals.
 * Conviction is orthogonal to dopamine — it measures strategic
 * coherence with the manifested future, not prediction accuracy.
 */
export function testConviction(ctx: ConvictionContext, t: ConvictionThresholds = DEFAULT_CONVICTION_THRESHOLDS): ConvictionTestResult {
  if (ctx.level === "build-cycle") {
    return testBuildCycleConviction(ctx, t);
  }

  if (ctx.level === "task-dispatch") {
    return testTaskDispatchConviction(ctx, t);
  }

  // Fallback: neutral
  return {
    level: NEUTRAL_PRIOR,
    delta: 0,
    evidence: [],
    shouldEscalate: false,
  };
}

function testBuildCycleConviction(ctx: ConvictionContext, t: ConvictionThresholds): ConvictionTestResult {
  const evidence: ConvictionEvidence[] = [];

  // Signal 1: Score trajectory (weight 0.4)
  // Normalizes 1–10 scale to 0–1.
  let scoreSignal = NEUTRAL_PRIOR;
  if (ctx.composite) {
    scoreSignal = (ctx.composite.weightedMean - 1) / 9;
    evidence.push({
      source: "score-trajectory",
      description: `Weighted mean: ${ctx.composite.weightedMean.toFixed(1)}/10 (normalized: ${scoreSignal.toFixed(2)}).`,
      magnitude: scoreSignal,
      valence: scoreSignal >= 0.5 ? "supports" : "undermines",
    });
  }

  // Signal 2: World model orientation (weight 0.3)
  // Having a worldview = Cortex has orientation. Absent = neutral.
  let maximSignal: number;
  if (ctx.worldModelMaxims && ctx.worldModelMaxims.length > 0) {
    maximSignal = 0.7;
    evidence.push({
      source: "maxim-orientation",
      description: `World model has ${ctx.worldModelMaxims.length} maxim(s) — system has orientation.`,
      magnitude: ctx.worldModelMaxims.length,
      valence: "supports",
    });
  } else {
    maximSignal = NEUTRAL_PRIOR;
  }

  // Signal 3: Previous conviction momentum (weight 0.3)
  // Conviction decays if not reinforced by good signals.
  let momentumSignal: number;
  if (ctx.previousConviction) {
    momentumSignal = ctx.previousConviction.level * MOMENTUM_DECAY;
    const prevLevel = ctx.previousConviction.level;
    evidence.push({
      source: "previous-conviction",
      description: `Previous conviction: ${prevLevel.toFixed(2)} → decayed to ${momentumSignal.toFixed(2)}.`,
      magnitude: momentumSignal,
      valence: momentumSignal >= 0.5 ? "supports" : "undermines",
    });
  } else {
    momentumSignal = NEUTRAL_PRIOR;
  }

  // ── Reliability signals: degraded evaluations undermine conviction ──
  if (ctx.degradedEvaluationCount && ctx.degradedEvaluationCount > 0) {
    evidence.push({
      source: "degraded-evaluation",
      description: `${ctx.degradedEvaluationCount} evaluation(s) produced by fallback paths — scores are not trustworthy.`,
      magnitude: ctx.degradedEvaluationCount,
      valence: "undermines",
    });
    // Degrade the score signal proportionally — degraded evaluations make
    // the composite score unreliable, so the conviction should drop.
    scoreSignal *= 0.7;
  }

  // Evaluation integrity circuit breaker: when most senses failed/degraded,
  // the composite score is unreliable. Critically low integrity (< 0.3) adds
  // strong undermining evidence that can tip conviction toward escalate.
  if (ctx.evaluationIntegrity !== undefined && ctx.evaluationIntegrity < 0.3) {
    evidence.push({
      source: "evaluation-blind",
      description: `Evaluation integrity critically low (${(ctx.evaluationIntegrity * 100).toFixed(0)}%) — most senses failed or degraded. Scores are unreliable.`,
      magnitude: 1 - ctx.evaluationIntegrity,
      valence: "undermines",
    });
    // Severely degrade the score signal — proportional to blindness
    scoreSignal *= ctx.evaluationIntegrity;
  }

  if (ctx.approachClassificationFailed) {
    evidence.push({
      source: "approach-classification-missing",
      description: "Approach classification failed — speed-of-light analysis is running without approach-specific ceiling.",
      magnitude: 0.3,
      valence: "undermines",
    });
  }

  // Proprioception confidence: when the builder itself isn't confident,
  // that's a reliability signal evaluators can't see. Low confidence
  // undermines conviction proportional to the gap from confident (0.7).
  if (ctx.proprioceptionConfidence !== undefined && ctx.proprioceptionConfidence < 0.4) {
    evidence.push({
      source: "proprioception-uncertain",
      description: `Builder confidence low (${(ctx.proprioceptionConfidence * 100).toFixed(0)}%) — the motor cortex is uncertain about its own output.`,
      magnitude: 0.4 - ctx.proprioceptionConfidence,
      valence: "undermines",
    });
    // Degrade score signal — builder knows things evaluators don't
    scoreSignal *= 0.5 + ctx.proprioceptionConfidence;
  }

  // Budget exhaustion: when the task is near/past the attention budget
  // ceiling, continued iteration isn't free. Conviction should reflect
  // that Cortex is running out of runway.
  if (ctx.budgetProximity !== undefined && ctx.budgetProximity > 0.8) {
    const severity = (ctx.budgetProximity - 0.8) / 0.2; // 0 at 80%, 1 at 100%
    evidence.push({
      source: "budget-exhausted",
      description: `Attention budget ${(ctx.budgetProximity * 100).toFixed(0)}% consumed — ${ctx.budgetProximity >= 1 ? "at ceiling" : "approaching ceiling"}.`,
      magnitude: severity,
      valence: "undermines",
    });
  }

  // Weighted sum
  const level = clamp(
    0.4 * scoreSignal + 0.3 * maximSignal + 0.3 * momentumSignal,
    0,
    1,
  );

  const previousLevel = ctx.previousConviction?.level ?? NEUTRAL_PRIOR;
  const delta = level - previousLevel;

  return {
    level,
    delta,
    evidence,
    shouldEscalate: level < t.escalateThreshold,
  };
}

function testTaskDispatchConviction(ctx: ConvictionContext, t: ConvictionThresholds): ConvictionTestResult {
  const evidence: ConvictionEvidence[] = [];
  const total = ctx.taskGraph?.length ?? 0;

  // Signal 1: Progress ratio (weight 0.4)
  let progressSignal = NEUTRAL_PRIOR;
  if (total > 0 && ctx.completedTaskIds) {
    progressSignal = ctx.completedTaskIds.size / total;
    evidence.push({
      source: "graph-progress",
      description: `${ctx.completedTaskIds.size}/${total} tasks completed (${(progressSignal * 100).toFixed(0)}%).`,
      magnitude: progressSignal,
      valence: progressSignal >= 0.3 ? "supports" : "undermines",
    });
  }

  // Signal 2: Tonic dopamine (weight 0.3)
  let tonicSignal = NEUTRAL_PRIOR;
  if (ctx.vitals) {
    tonicSignal = ctx.vitals.tonicDopamine;
    evidence.push({
      source: "tonic-low",
      description: `Tonic dopamine: ${tonicSignal.toFixed(2)}.`,
      magnitude: tonicSignal,
      valence: tonicSignal >= 0.4 ? "supports" : "undermines",
    });
  }

  // Signal 3: Absence of escalations (weight 0.3)
  let escalationSignal = 1;
  if (total > 0 && ctx.escalatedTaskIds) {
    escalationSignal = 1 - (ctx.escalatedTaskIds.size / total);
    if (ctx.escalatedTaskIds.size > 0) {
      evidence.push({
        source: "escalation-rate",
        description: `${ctx.escalatedTaskIds.size}/${total} tasks escalated.`,
        magnitude: 1 - escalationSignal,
        valence: escalationSignal >= 0.7 ? "supports" : "undermines",
      });
    }
  }

  // Signal 4: Scheduler escalation pressure (applied as penalty)
  // A severity-1.0 escalation pulls conviction down by 0.25.
  // High conviction can absorb it (reshape zone); low conviction compounds it (escalate).
  let schedulerPenalty = 0;
  if (ctx.schedulerEscalation) {
    schedulerPenalty = ctx.schedulerEscalation.severity * 0.25;
    evidence.push({
      source: "scheduler-escalation",
      description: `Scheduler flagged ${ctx.schedulerEscalation.type}: ${ctx.schedulerEscalation.reason}`,
      magnitude: ctx.schedulerEscalation.severity,
      valence: "undermines",
    });
  }

  // Weighted sum (minus scheduler penalty)
  const level = clamp(
    0.4 * progressSignal + 0.3 * tonicSignal + 0.3 * escalationSignal - schedulerPenalty,
    0,
    1,
  );

  const previousLevel = ctx.previousConviction?.level ?? NEUTRAL_PRIOR;
  const delta = level - previousLevel;

  return {
    level,
    delta,
    evidence,
    shouldEscalate: level < t.escalateThreshold,
  };
}

// ─── Step 3: Speed of Light ─────────────────────────────────────

/**
 * How close to the theoretical ceiling? Build-cycle only.
 *
 * Gap ratio = (ceiling - current) / ceiling.
 *   < 0.2  → near ceiling (≥80% of what's achievable)
 *   > 0.5  → far from ceiling (<50% of what's achievable)
 *   approachIsBottleneck → always rearchitect
 */
export function testSpeedOfLight(ctx: ConvictionContext, t: ConvictionThresholds = DEFAULT_CONVICTION_THRESHOLDS): SpeedOfLightTestResult {
  const evidence: ConvictionEvidence[] = [];

  // No SoL data (cold start) — neutral, don't block.
  if (!ctx.speedOfLight || !ctx.composite) {
    return {
      nearCeiling: false,
      shouldRearchitect: false,
      gapRatio: 0,
      evidence,
    };
  }

  const ceiling = ctx.speedOfLight.compositeCeiling;
  const current = ctx.composite.weightedMean;

  // Guard against zero/negative ceiling
  if (ceiling <= 0) {
    return {
      nearCeiling: false,
      shouldRearchitect: false,
      gapRatio: 0,
      evidence,
    };
  }

  const gapRatio = (ceiling - current) / ceiling;

  if (gapRatio < t.solNearCeiling) {
    evidence.push({
      source: "speed-of-light-near",
      description: `Near ceiling: ${current.toFixed(1)}/${ceiling.toFixed(1)} (gap: ${(gapRatio * 100).toFixed(0)}%). Diminishing returns from further iteration.`,
      magnitude: 1 - gapRatio,
      valence: "supports",
    });

    return { nearCeiling: true, shouldRearchitect: false, gapRatio, evidence };
  }

  if (gapRatio > t.solFarFromCeiling) {
    evidence.push({
      source: "speed-of-light-gap",
      description: `Far from ceiling: ${current.toFixed(1)}/${ceiling.toFixed(1)} (gap: ${(gapRatio * 100).toFixed(0)}%). Approach can't reach theoretical max.`,
      magnitude: gapRatio,
      valence: "undermines",
    });

    return { nearCeiling: false, shouldRearchitect: true, gapRatio, evidence };
  }

  // Middle zone — working toward ceiling, keep iterating.
  return { nearCeiling: false, shouldRearchitect: false, gapRatio, evidence };
}

// ─── Step 4: Shaping ────────────────────────────────────────────

/**
 * Assemble tactical notes for downstream consumers.
 *
 * Build-cycle: stored in accumulator, Thalamus picks up for next cycle.
 * Task-dispatch: stored in accumulator, seeds next task's consultation.
 */
export function computeShaping(
  ctx: ConvictionContext,
  evidence: ConvictionEvidence[],
  verdict: "proceed" | "reshape" | "escalate",
  reshapeGuidance?: string,
): ConvictionShaping {
  const notes: string[] = [];

  // Summarize key evidence into concise notes.
  for (const e of evidence) {
    if (e.valence === "undermines") {
      notes.push(e.description);
    }
  }

  // Add positive signals only if proceeding (keeps notes focused).
  if (verdict === "proceed") {
    const nearCeiling = evidence.find((e) => e.source === "speed-of-light-near");
    if (nearCeiling) {
      notes.push(nearCeiling.description);
    }
  }

  const shaping: ConvictionShaping = { notes };

  if (verdict === "reshape" && reshapeGuidance) {
    shaping.reshapeGuidance = reshapeGuidance;
  }

  if (verdict === "escalate") {
    shaping.escalationReason = evidence
      .filter((e) => e.valence === "undermines")
      .map((e) => e.description)
      .join(". ") || "Conviction is critically low.";
  }

  return shaping;
}

// ─── Util ───────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
