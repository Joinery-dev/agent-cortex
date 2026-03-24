/**
 * Build-Cycle Rhythm — the innermost loop.
 *
 * Lifts the current orchestrator's inner while-loop into a rhythm:
 *   prepare:   assemble motor briefing (or revision context)
 *   execute:   motor cortex runs premotor → primary → proprioception
 *   integrate: evaluate work + detect tensions
 *   gate:      scores acceptable? tensions resolved? → complete / continue / escalate
 *
 * The Motor Cortex class handles the three-phase build internally.
 * The build-cycle orchestrates the evaluate→revise loop around it.
 */

import type { RhythmDefinition, RhythmState } from "../../types/rhythm.js";
import type { BuildCycleContext, BuildCycleResult } from "../../types/brainstem.js";
import type { SenseEvaluation } from "../../types/sense.js";
import type { Tension, TensionResolution } from "../../types/tension.js";
import type { CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { MotorBriefing } from "../../types/thalamus.js";
import type { MotorPlan, SelfAssessment, RevisionContext } from "../../types/motor-cortex.js";
import type { Intention } from "../../types/pns.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import { evaluate } from "../../kernel/evaluator.js";
import { detectTensions, resolve } from "../../kernel/resolver.js";
import { addEvent } from "../../types/task.js";
import { emit } from "../../events.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { Inhibitor } from "../../kernel/inhibitor.js";
import type { CollapseContext } from "../../types/inhibitor.js";

// ─── Intermediate types for the four phases ─────────────────────

interface PreparedBuild {
  motorBriefing: MotorBriefing;
  isRevision: boolean;
  revision?: RevisionContext;
}

interface ExecutedBuild {
  work: string;
  plan: MotorPlan;
  selfAssessment?: SelfAssessment;
  intentions: Intention[];
}

interface IntegratedBuild {
  work: string;
  plan: MotorPlan;
  selfAssessment?: SelfAssessment;
  intentions: Intention[];
  evaluations: SenseEvaluation[];
  tensions: Tension[];
  minScore: number;
  highTensionCount: number;
}

// ─── Accumulator shape ──────────────────────────────────────────

interface BuildCycleAccumulator {
  /** All evaluations from the latest cycle. */
  lastEvaluations: SenseEvaluation[];
  /** All tensions across all cycles. */
  allTensions: Tension[];
  /** All resolutions across all cycles. */
  allResolutions: TensionResolution[];
  /** The latest produced work. */
  lastWork: string | null;
  /** The latest premotor plan — for revision cycles. */
  lastPlan: MotorPlan | null;
  /** The motor briefing from the first cycle — reused in revisions. */
  motorBriefing: MotorBriefing | null;
}

function getAcc(
  state: RhythmState<BuildCycleContext, BuildCycleResult>,
): BuildCycleAccumulator {
  return (state.accumulator as unknown as { __bc: BuildCycleAccumulator }).__bc ??= {
    lastEvaluations: [],
    allTensions: [],
    allResolutions: [],
    lastWork: null,
    lastPlan: null,
    motorBriefing: null,
  };
}

// ─── Definition factory ─────────────────────────────────────────

export function createBuildCycleDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  wm: WorkingMemory,
  thalamus: Thalamus,
  motorCortex: MotorCortex,
  inhibitor: Inhibitor,
): RhythmDefinition<BuildCycleContext, BuildCycleResult, PreparedBuild, ExecutedBuild, IntegratedBuild> {
  return {
    name: "build-cycle",
    maxCycles: config.maxCycles,

    // ── Prepare: assemble motor briefing ──────────────────
    async prepare(context, state) {
      const acc = getAcc(state);

      if (state.completedCycles === 0) {
        // First cycle: get motor briefing from thalamus
        const motorBriefing = await thalamus.forMotor(context.task, context.council);
        acc.motorBriefing = motorBriefing;

        context.task.status = "producing";
        addEvent(context.task, "status_change", {
          status: "producing",
          cycle: 1,
        });

        return { motorBriefing, isRevision: false };
      }

      // Revision cycle: pass revision context to premotor
      context.task.status = "producing";
      addEvent(context.task, "status_change", {
        status: "producing",
        cycle: state.completedCycles + 1,
      });

      return {
        motorBriefing: acc.motorBriefing!,
        isRevision: true,
        revision: {
          previousPlan: acc.lastPlan!,
          evaluations: acc.lastEvaluations,
          resolutions: acc.allResolutions.slice(-acc.lastEvaluations.length),
        },
      };
    },

    // ── Execute: run motor cortex (premotor → primary → proprioception) ──
    async execute(prepared, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;

      emit("cycle:start", { cycle, maxCycles: config.maxCycles });

      // TODO: When NE signal is wired (Phase 4), read it here to modulate proprioception
      const enableProprioception = true;

      const result = await motorCortex.execute(prepared.motorBriefing, {
        enableProprioception,
        revision: prepared.revision,
        previousWork: acc.lastWork ?? undefined,
      });

      addEvent(state.initialContext.task, "work_produced", {
        cycle,
        length: result.work.length,
        planConfidence: result.plan.confidence,
        proprioceptionConfidence: result.selfAssessment?.confidence,
      });

      acc.lastWork = result.work;
      acc.lastPlan = result.plan;

      return {
        work: result.work,
        plan: result.plan,
        selfAssessment: result.selfAssessment,
        intentions: result.intentions,
      };
    },

    // ── Integrate: evaluate + detect tensions ───────────────
    async integrate(executed, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      ctx.task.status = "evaluating";
      addEvent(ctx.task, "status_change", { status: "evaluating", cycle });

      const evaluations = await evaluate(
        ctx.council,
        ctx.task,
        executed.work,
        library,
        config,
        thalamus,
      );

      acc.lastEvaluations = evaluations;

      addEvent(ctx.task, "evaluation", {
        cycle,
        scores: evaluations.map((e) => ({
          path: e.activationPath.join(" > "),
          score: e.score,
        })),
      });

      const tensions = detectTensions(evaluations, ctx.task.id);
      acc.allTensions = [...acc.allTensions, ...tensions];

      emit("tension:detection-complete", {
        count: tensions.length,
        tensions: tensions.map((t) => ({
          severity: t.severity,
          senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score },
          senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score },
        })),
      });

      if (tensions.length > 0) {
        addEvent(ctx.task, "tension_detected", {
          cycle,
          tensions: tensions.map((t) => ({
            description: t.description,
            severity: t.severity,
          })),
        });
      }

      const minScore = evaluations.length > 0
        ? Math.min(...evaluations.map((e) => e.score))
        : 0;
      const highTensionCount = tensions.filter((t) => t.severity === "high").length;

      // Record evaluation scores in WM (each cycle overwrites the previous)
      wm.recordScores(ctx.task.id, evaluations);

      // Call subcortical hooks (no-op for now)
      await hooks.recordBuildOutcome(ctx, {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        tensions,
        resolutions: [],
        cycles: cycle,
        accepted: minScore >= config.acceptableMinScore && highTensionCount === 0,
      });

      return {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        tensions,
        minScore,
        highTensionCount,
      };
    },

    // ── Gate: accept, revise, or escalate ───────────────────
    async gate(integrated, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      // Proprioception signal: low plan adherence penalizes effective score
      const proprioceptionPenalty = integrated.selfAssessment
        ? (1 - integrated.selfAssessment.planAdherence) * 2 // 0-2 point penalty
        : 0;
      const effectiveMinScore = integrated.minScore - proprioceptionPenalty;

      // Check for forced completion from max cycles
      if (state.accumulator.__maxCyclesReached) {
        const confidence = computeConfidence(integrated.evaluations);
        return {
          action: "complete",
          result: {
            work: integrated.work,
            plan: integrated.plan,
            selfAssessment: integrated.selfAssessment,
            intentions: integrated.intentions,
            evaluations: integrated.evaluations,
            tensions: acc.allTensions,
            resolutions: acc.allResolutions,
            cycles: cycle,
            accepted: confidence >= 0.6,
          },
        };
      }

      // Accept if scores are good and no high tensions
      if (
        effectiveMinScore >= config.acceptableMinScore &&
        integrated.highTensionCount === 0
      ) {
        return {
          action: "complete",
          result: {
            work: integrated.work,
            plan: integrated.plan,
            selfAssessment: integrated.selfAssessment,
            intentions: integrated.intentions,
            evaluations: integrated.evaluations,
            tensions: acc.allTensions,
            resolutions: acc.allResolutions,
            cycles: cycle,
            accepted: true,
          },
        };
      }

      // Need revision — resolve tensions for next cycle
      ctx.task.status = "resolving";
      addEvent(ctx.task, "status_change", { status: "resolving", cycle });

      const resolutions = await resolve(integrated.tensions, integrated.work, config);
      acc.allResolutions = [...acc.allResolutions, ...resolutions];

      // Collapsed-tension detection: was this genuine synthesis or capitulation?
      const collapseContext: CollapseContext = {
        tensions: integrated.tensions,
        resolutions,
        evaluations: integrated.evaluations,
        priorEvaluations: state.completedCycles > 0 ? acc.lastEvaluations : undefined,
        work: integrated.work,
      };
      const collapseSignal = await inhibitor.detectCollapse(collapseContext, config);

      addEvent(ctx.task, "resolution", {
        cycle,
        resolutions: resolutions.map((r) => r.strategy),
        collapsedTensions: collapseSignal.collapsed
          ? collapseSignal.details.filter((d) => d.collapsed).length
          : 0,
      });

      addEvent(ctx.task, "cycle_back", { cycle });

      // If tensions collapsed, add re-engagement guidance to the revision reason
      let collapseNote = "";
      if (collapseSignal.collapsed) {
        const guidance = collapseSignal.details
          .filter((d) => d.collapsed && d.reEngagementGuidance)
          .map((d) => d.reEngagementGuidance)
          .join("; ");
        collapseNote = ` COLLAPSED TENSIONS DETECTED: ${guidance || "Senses capitulated instead of synthesizing. Re-engage with genuine tension."}`;
      }

      return {
        action: "continue",
        reason: `Cycle ${cycle}: effective min score ${effectiveMinScore.toFixed(1)} (raw ${integrated.minScore}, proprioception penalty ${proprioceptionPenalty.toFixed(1)}), ${integrated.highTensionCount} high tension(s). Resolved ${resolutions.length} tension(s), requesting revision.${collapseNote}`,
      };
    },
  };
}

function computeConfidence(evaluations: SenseEvaluation[]): number {
  if (evaluations.length === 0) return 0;
  const total = evaluations.reduce((sum, e) => sum + e.score, 0);
  return total / (evaluations.length * 10);
}
