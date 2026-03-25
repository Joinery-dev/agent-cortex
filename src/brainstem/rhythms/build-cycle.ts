/**
 * Build-Cycle Rhythm — the innermost loop.
 *
 * Lifts the current orchestrator's inner while-loop into a rhythm:
 *   prepare:   assemble motor briefing (or revision context)
 *   execute:   motor cortex runs premotor → primary → proprioception
 *   integrate: evaluate work → weigh by stake → compute composite → detect tensions → oscillation check
 *   gate:      gate strategy (deliberative/democratic/expedient) decides accept/revise/escalate
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
import type { Gate, GateInput, SignalLandscape } from "../../types/gate.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { WeightedEvaluation, WeightedComposite, StakeAdjuster } from "../../kernel/evaluation-weighter.js";
import type { OscillationSignal } from "../../types/working-memory.js";
import { evaluate } from "../../kernel/evaluator.js";
import { detectTensions, resolve } from "../../kernel/resolver.js";
import { weighEvaluations, computeComposite } from "../../kernel/evaluation-weighter.js";
import { revisionPrompt } from "../../llm/prompts.js";
import { addEvent } from "../../types/task.js";
import { emit } from "../../events.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { BasalGanglia } from "../../kernel/basal-ganglia.js";
import type { CollapseContext } from "../../types/basal-ganglia.js";

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
  weighted: WeightedEvaluation[];
  composite: WeightedComposite;
  tensions: Tension[];
  oscillations: OscillationSignal[];
}

// ─── Accumulator shape ──────────────────────────────────────────

interface BuildCycleAccumulator {
  /** Raw evaluations from the latest cycle (for collapse detection + motor revision). */
  lastEvaluations: SenseEvaluation[];
  /** Weighted evaluations from the latest cycle (for gate + revision prompt). */
  lastWeighted: WeightedEvaluation[];
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
    lastWeighted: [],
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
  basalGanglia: BasalGanglia,
  gate: Gate,
  stakeAdjuster?: StakeAdjuster,
): RhythmDefinition<BuildCycleContext, BuildCycleResult, PreparedBuild, ExecutedBuild, IntegratedBuild> {
  return {
    name: "build-cycle",
    maxCycles: config.maxCycles,

    // ── Prepare: assemble motor briefing ──────────────────
    async prepare(context, state) {
      const acc = getAcc(state);

      if (state.completedCycles === 0) {
        // First cycle: get motor briefing from thalamus
        const motorBriefing = await thalamus.forMotor(context.task, context.consultation);
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

    // ── Integrate: evaluate → weigh → composite → tensions → oscillation ──
    async integrate(executed, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      ctx.task.status = "evaluating";
      addEvent(ctx.task, "status_change", { status: "evaluating", cycle });

      // 1. Raw evaluation (unchanged — each receptor evaluates independently)
      const evaluations = await evaluate(
        ctx.consultation,
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
          acceptable: e.acceptable,
        })),
      });

      // 2. Weigh evaluations by stake from consultation
      const weighted = weighEvaluations(evaluations, ctx.consultation, stakeAdjuster);
      acc.lastWeighted = weighted;

      // 3. Compute weighted composite
      const composite = computeComposite(weighted);

      // 4. Stake-aware tension detection
      const tensions = detectTensions(weighted, ctx.task.id);
      acc.allTensions = [...acc.allTensions, ...tensions];

      emit("tension:detection-complete", {
        count: tensions.length,
        tensions: tensions.map((t) => ({
          severity: t.severity,
          senseA: { path: t.senseA.path.join(" > "), score: t.senseA.score, stake: t.senseA.stake },
          senseB: { path: t.senseB.path.join(" > "), score: t.senseB.score, stake: t.senseB.stake },
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

      // 5. Record weighted scores in WM
      wm.recordScores(ctx.task.id, weighted);

      // 6. Check for score oscillation
      const oscillations = wm.detectOscillations(ctx.task.id);

      // 7. Subcortical hooks (no-op for now)
      await hooks.recordBuildOutcome(ctx, {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        tensions,
        resolutions: [],
        cycles: cycle,
        accepted: composite.weightedAcceptability > 0.5,
        confidence: composite.confidence,
      });

      return {
        work: executed.work,
        plan: executed.plan,
        selfAssessment: executed.selfAssessment,
        intentions: executed.intentions,
        evaluations,
        weighted,
        composite,
        tensions,
        oscillations,
      };
    },

    // ── Gate: gate strategy decides accept/revise/escalate ──
    async gate(integrated, state) {
      const acc = getAcc(state);
      const cycle = state.completedCycles + 1;
      const ctx = state.initialContext;

      // Assemble signal landscape (NE from context when threaded, else undefined)
      const signals: SignalLandscape = {
        ne: ctx.neLevel,
      };

      // Assemble gate input
      const gateInput: GateInput = {
        composite: integrated.composite,
        tensions: integrated.tensions,
        cycle,
        signals,
      };

      // Run gate strategy
      const gateOutput = gate.evaluate(gateInput);

      if (gateOutput.accept) {
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
            confidence: integrated.composite.confidence,
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
      const collapseSignal = await basalGanglia.detectCollapse(collapseContext, config);

      addEvent(ctx.task, "resolution", {
        cycle,
        resolutions: resolutions.map((r) => r.strategy),
        collapsedTensions: collapseSignal.collapsed
          ? collapseSignal.details.filter((d) => d.collapsed).length
          : 0,
      });

      addEvent(ctx.task, "cycle_back", { cycle });

      // Build reason with gate strategy info + oscillation + collapse notes
      let reason = `Cycle ${cycle}: ${gateOutput.reason}. Resolved ${resolutions.length} tension(s), requesting revision.`;

      if (integrated.oscillations.length > 0) {
        reason += ` OSCILLATION: ${integrated.oscillations.length} receptor(s) showing score instability.`;
      }

      if (collapseSignal.collapsed) {
        const guidance = collapseSignal.details
          .filter((d) => d.collapsed && d.reEngagementGuidance)
          .map((d) => d.reEngagementGuidance)
          .join("; ");
        reason += ` COLLAPSED TENSIONS: ${guidance || "Senses capitulated instead of synthesizing. Re-engage with genuine tension."}`;
      }

      return {
        action: "continue",
        reason,
      };
    },
  };
}
