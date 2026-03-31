/**
 * Sensory-Cortex Rhythm — the per-task outer loop.
 *
 * The core plan → build → evaluate loop at the task level:
 *   prepare:   cycle 1: efference → consult → predict → explore (full pipeline)
 *              cycle 2+: selective re-consultation (senses with improvement potential)
 *   execute:   spawn build-cycle child rhythm (inner loop for execution-level fixes)
 *   integrate: weigh evaluations, compute improvement potential
 *   gate:      improvement potential + speed-of-light + diminishing returns → continue or complete
 *
 * The senses are both the planners (consultation) and the evaluators (receptors).
 * When the gate decides to loop, senses that expressed improvement potential
 * re-consult after seeing the actual work — their perspectives evolve from
 * speculative to grounded to surgical across outer cycles.
 */

import type { RhythmDefinition, RhythmState, RhythmRunner } from "../../types/rhythm.js";
import type { SensoryCortexContext, SensoryCortexResult, BuildCycleContext, BuildCycleResult } from "../../types/brainstem.js";
import type { OrchestratorResult, CortexConfig } from "../../types/orchestrator.js";
import type { Consultation } from "../../types/consultation.js";
import type { ImprovementPotential } from "../../types/sense.js";
import type { DecisionRecord } from "../../types/intent.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { Sense } from "../../types/sense.js";
import type { SpeedOfLight } from "../../types/cerebellum.js";
import type { CerebellumPrediction } from "../../types/cerebellum.js";
import { consult, reconsult } from "../../kernel/consul.js";
import type { ReconsultInput } from "../../kernel/consul.js";
import { explore } from "../../kernel/explore.js";
import { weighEvaluations, computeComposite } from "../../kernel/evaluation-weighter.js";
import type { WeightedEvaluation, WeightedComposite, StakeAdjuster } from "../../kernel/evaluation-weighter.js";
import { addEvent } from "../../types/task.js";
import { newId } from "../../util/ids.js";
import { emit } from "../../events.js";
import { createLogger } from "../../util/logger.js";
import { createBuildCycleDefinition } from "./build-cycle.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { BasalGanglia } from "../../kernel/basal-ganglia.js";
import type { Gate } from "../../types/gate.js";
import type { CognitiveFlexibility } from "../../kernel/cognitive-flexibility.js";
import type { PeripheralNervousSystem } from "../../kernel/pns.js";
import type { RiskFactors } from "../../types/norepinephrine.js";
import type { TaskGestalt } from "../../types/task-gestalt.js";
import type { SerializedEpisode } from "../../types/efference-copy.js";
import type { ScoredEpisode } from "../../types/cerebellum.js";
import { computeNE, mapUrgencyToNE } from "../../kernel/norepinephrine.js";
import { reviseWithEfference, computeAttentionBudget } from "../../kernel/attention-budget.js";
import { extractFingerprint } from "../../subcortical/forward-model.js";

const log = createLogger("sensory-cortex");

// ─── Shared helper ──────────────────────────────────────────────

/** Extract risk factors from a gestalt snapshot. Fallback when no frozen dispatch risk is available. */
export function extractRiskFromGestalt(gestalt: TaskGestalt | null): RiskFactors {
  const risk: RiskFactors = {};
  if (gestalt?.graphPosition) {
    const gp = gestalt.graphPosition;
    if (gp.totalInPhase && gp.completedInPhase !== undefined) {
      risk.phaseGateProximity = gp.completedInPhase / gp.totalInPhase;
    }
    const remaining = gp.totalTasks - gp.completedTaskIds.length - gp.escalatedTaskIds.length;
    risk.dependencyFanOut = remaining > 0 ? gp.dependedOnBy.length / remaining : 0;
  }
  if (gestalt?.accumulated) {
    const trends = gestalt.accumulated.senseTrends;
    const downCount = trends.filter((t) => t.direction === "down").length;
    risk.decliningTrends = trends.length > 0 ? downCount / trends.length : 0;
    risk.wmPressure = gestalt.accumulated.load;
  }
  return risk;
}

// ─── Intermediate types ─────────────────────────────────────────

interface PreparedSensory {
  consultation: Consultation;
  buildCycleContext: BuildCycleContext;
}

/** Richer integrate output — the gate needs composite + weighted for its decision. */
interface IntegratedSensory {
  result: SensoryCortexResult;
  weighted: WeightedEvaluation[];
  composite: WeightedComposite;
  consultation: Consultation;
  buildResult: BuildCycleResult;
}

// ─── Accumulator ───────────────────────────────────────────────

interface SensoryCortexAccumulator {
  /** Previous consultation (from the last outer cycle). */
  previousConsultation: Consultation | null;
  /** Previous build-cycle result. */
  previousBuildResult: BuildCycleResult | null;
  /** Previous weighted evaluations. */
  previousWeighted: WeightedEvaluation[] | null;
  /** Previous weighted composite. */
  previousComposite: WeightedComposite | null;
  /** Composite score history across outer cycles (for diminishing returns). */
  compositeHistory: number[];
  /** NE level carried across outer cycles. */
  enrichedNE: number | null;
  /** Speed of light (computed once on cycle 1, reused). */
  speedOfLight: SpeedOfLight | null;
  /** Prediction (computed once on cycle 1, reused). */
  prediction: CerebellumPrediction | null;
  /** Sense IDs to re-consult (set by gate, read by next prepare). */
  reconsultSenseIds: string[] | null;
  /** Total inner build cycles accumulated across all outer cycles. */
  totalInnerCycles: number;
  /** Attention budget (may be revised by Phase 2 efference/cerebellum). */
  attentionBudget: import("../../types/attention-budget.js").AttentionBudget | null;
}

function getAcc(
  state: RhythmState<SensoryCortexContext, SensoryCortexResult>,
): SensoryCortexAccumulator {
  return (state.accumulator as unknown as { __sc: SensoryCortexAccumulator }).__sc ??= {
    previousConsultation: null,
    previousBuildResult: null,
    previousWeighted: null,
    previousComposite: null,
    compositeHistory: [],
    enrichedNE: null,
    speedOfLight: null,
    prediction: null,
    reconsultSenseIds: null,
    totalInnerCycles: 0,
    attentionBudget: null,
  };
}

// ─── Improvement potential helpers ─────────────────────────────

const POTENTIAL_NUMERIC: Record<ImprovementPotential["level"], number> = {
  significant: 1.0,
  moderate: 0.6,
  marginal: 0.2,
  none: 0.0,
};

/**
 * Compute the aggregate improvement potential across all evaluations,
 * weighted by stake. Returns 0–1.
 */
function computeAggregateImprovement(weighted: WeightedEvaluation[]): number {
  const totalStake = weighted.reduce((sum, w) => sum + w.adjustedStake, 0);
  if (totalStake === 0) return 0;

  // For each root sense, take the max potential across its receptors
  const senseMaxPotential = new Map<string, { potential: number; stake: number }>();
  for (const w of weighted) {
    const rootSense = w.activationPath[0];
    const numeric = POTENTIAL_NUMERIC[w.improvementPotential.level];
    const existing = senseMaxPotential.get(rootSense);
    if (!existing || numeric > existing.potential) {
      senseMaxPotential.set(rootSense, { potential: numeric, stake: w.adjustedStake });
    }
  }

  let weightedSum = 0;
  let stakeSum = 0;
  for (const { potential, stake } of senseMaxPotential.values()) {
    weightedSum += potential * stake;
    stakeSum += stake;
  }

  return stakeSum > 0 ? weightedSum / stakeSum : 0;
}

/**
 * Determine which senses should re-consult based on improvement potential
 * and tension involvement.
 */
function selectSensesForReconsultation(
  weighted: WeightedEvaluation[],
  buildResult: BuildCycleResult,
  consultation: Consultation,
): string[] {
  const senseIds = new Set<string>();

  // Senses with "significant" or "moderate" improvement potential
  for (const w of weighted) {
    if (w.improvementPotential.level === "significant" || w.improvementPotential.level === "moderate") {
      const rootSenseName = w.activationPath[0];
      const perspective = consultation.perspectives.find((p) => p.senseName === rootSenseName);
      if (perspective) {
        senseIds.add(perspective.senseId);
      }
    }
  }

  // Senses involved in unresolved tensions
  for (const tension of buildResult.tensions) {
    if (!tension.resolution) {
      const senseA = consultation.perspectives.find((p) => p.senseName === tension.senseA.path[0]);
      const senseB = consultation.perspectives.find((p) => p.senseName === tension.senseB.path[0]);
      if (senseA) senseIds.add(senseA.senseId);
      if (senseB) senseIds.add(senseB.senseId);
    }
  }

  return [...senseIds];
}

// ─── Definition factory ─────────────────────────────────────────

export function createSensoryCortexDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  wm: WorkingMemory,
  thalamus: Thalamus,
  motorCortex: MotorCortex,
  basalGanglia: BasalGanglia,
  gate: Gate,
  cognitiveFlexibility: CognitiveFlexibility,
  stakeAdjuster?: StakeAdjuster,
  pns?: PeripheralNervousSystem,
): RhythmDefinition<SensoryCortexContext, SensoryCortexResult, PreparedSensory, BuildCycleResult, IntegratedSensory> {
  const buildCycleDef = createBuildCycleDefinition(config, library, hooks, wm, thalamus, motorCortex, basalGanglia, gate, cognitiveFlexibility, stakeAdjuster, pns);

  return {
    name: "sensory-cortex",
    maxCycles: config.maxOuterCycles,

    // ── Prepare: consult or re-consult senses ─────────────
    async prepare(context, state) {
      const acc = getAcc(state);
      const { task, intent, taste, neLevel, mode } = context;
      const outerCycle = state.completedCycles + 1;

      if (state.completedCycles === 0) {
        // ═══════════════════════════════════════════════════
        // CYCLE 1: Full pipeline — efference, consult, predict, explore
        // ═══════════════════════════════════════════════════

        task.status = "consulting";
        addEvent(task, "status_change", { status: "consulting" });

        emit("task:start", {
          id: task.id,
          description: task.description,
          maxOuterCycles: config.maxOuterCycles,
          maxInnerCycles: config.maxCycles,
        });

        // Get active senses (inhibited ones filtered out by thalamus)
        const activeSenses = thalamus.getActiveSenses(library);

        // Get inhibited senses for consultation conditions
        const inhibitedSenses = wm.getInhibitedSenses().map((s) => ({
          senseId: s.senseId,
          reason: s.reason,
        }));

        // ── Efference Copy: Motor Cortex predicts feasibility ──
        const gestaltForEfference = thalamus.getGestalt(task.id);
        if (gestaltForEfference) {
          const preliminaryMatches = hooks.findPreliminaryMatches(activeSenses, library);
          const efferenceCopy = await motorCortex.predictFeasibility({
            task,
            activeSenses: activeSenses.map((s) => ({ name: s.name, sensitivity: s.sensitivity })),
            capabilities: gestaltForEfference.capabilities.description,
            similarEpisodes: serializeEpisodes(preliminaryMatches),
            patterns: gestaltForEfference.accumulated.patterns,
          });
          thalamus.attachEfferenceCopy(task.id, efferenceCopy);

          addEvent(task, "efference_copy", {
            senseCount: efferenceCopy.perSense.length,
            tensionCostCount: efferenceCopy.tensionCosts.length,
            hardConstraintCount: efferenceCopy.hardConstraints.length,
            convergenceEstimate: efferenceCopy.convergenceEstimate,
            overallFeasibility: efferenceCopy.overallFeasibility,
          });
        }

        // Derive consultation briefing from the task's gestalt
        const briefing = thalamus.forConsultationFromGestalt(task.id);

        const consultation = await consult(briefing, activeSenses, library, config, {
          neLevel,
          mode,
          activeSenses,
          inhibitedSenses,
        });

        addEvent(task, "consultation_result", {
          perspectives: consultation.perspectives.length,
          totalEvaluators: consultation.evaluationPlan.length,
          senses: consultation.perspectives.map((p) => p.senseName),
          generation: 0,
        });

        // Cerebellum: predict evaluation scores before building
        const prediction = await hooks.predictScores(task.id, consultation);
        if (prediction) {
          thalamus.attachPrediction(task.id, prediction);
          addEvent(task, "cerebellum_prediction", {
            receptorCount: prediction.receptorPredictions.length,
            overallConfidence: prediction.overallConfidence,
            episodesUsed: prediction.episodeCount,
          });
        }

        // ── Phase 2: Refine attention budget with cerebellum + efference ──
        {
          let budget = context.attentionBudget ?? null;

          // Cerebellum: predict cycle distribution now that we have a fingerprint
          if (consultation) {
            const fingerprint = extractFingerprint(consultation);
            const cyclePercentiles = hooks.predictCycleDistribution(fingerprint);
            if (cyclePercentiles && budget) {
              // Recompute with learned data, preserving NE from dispatch
              budget = computeAttentionBudget({
                neLevel: budget.basis.neLevel,
                maxOuterCycles: config.maxOuterCycles,
                cerebellumPercentiles: cyclePercentiles,
                taskImportance: budget.basis.importance,
              });
            }
          }

          // Efference copy revision (attached to gestalt during prepare above)
          const gestaltForBudget = thalamus.getGestalt(task.id);
          if (gestaltForBudget?.efferenceCopy && budget) {
            budget = reviseWithEfference(budget, gestaltForBudget.efferenceCopy.convergenceEstimate);
          }

          // Emit revision event if budget changed from dispatch
          if (budget && context.attentionBudget
              && budget.basis.source !== context.attentionBudget.basis.source) {
            emit("attention-budget:revised", {
              taskId: task.id,
              before: context.attentionBudget.cycleRange,
              after: budget.cycleRange,
              source: budget.basis.source,
              efferenceEstimate: budget.basis.efferenceEstimate,
            });
          }

          acc.attentionBudget = budget;
        }

        // Set explore/leverage mode
        if (mode) {
          thalamus.setTaskMode(task.id, mode);
        }

        // Speed of light
        const speedOfLight = await hooks.getSpeedOfLight(task.id);
        if (speedOfLight) {
          thalamus.attachSpeedOfLight(task.id, speedOfLight);
        }

        // Failure mode prediction: predict likely failure category before building
        if (consultation) {
          const fp = extractFingerprint(consultation);
          const failurePrediction = hooks.predictFailureMode(task.id, fp);
          if (failurePrediction) {
            thalamus.attachFailureModePrediction(task.id, failurePrediction);
          }
        }

        // Novelty-enriched NE — use frozen risk from dispatch if available
        const gestalt = thalamus.getGestalt(task.id);
        const riskFactors = context.riskSnapshot ?? extractRiskFromGestalt(gestalt);

        const enrichedNE = computeNE({
          cerebellumAccuracy: hooks.getCerebellumAccuracy(),
          bestSimilarity: prediction?.bestSimilarity,
          risk: riskFactors,
          parsifalUrgency: mapUrgencyToNE(context.intent?.urgency),
        });

        emit("ne:novelty-enriched", {
          taskId: task.id,
          dispatchNE: neLevel,
          enrichedNE: enrichedNE.ne,
          bestSimilarity: prediction?.bestSimilarity ?? null,
          components: enrichedNE.components,
        });

        // ── Explore Phase ──
        task.status = "exploring";
        addEvent(task, "status_change", { status: "exploring" });

        const exploreResult = await explore(task, consultation, thalamus, config, mode);

        if (exploreResult.kind === "selected") {
          thalamus.attachExplorePath(task.id, exploreResult.selected);
          addEvent(task, "explore_result", {
            pathCount: exploreResult.paths.length,
            selectedPath: exploreResult.selected.name,
            selectionScore: exploreResult.selectionScore,
            archetypeTags: exploreResult.selected.archetypeTags,
          });
        } else {
          addEvent(task, "explore_result", {
            skipped: true,
            reason: exploreResult.reason,
          });
        }

        // Store in accumulator for cycle 2+
        acc.previousConsultation = consultation;
        acc.prediction = prediction ?? null;
        acc.speedOfLight = speedOfLight ?? null;
        acc.enrichedNE = enrichedNE.ne;

        const buildCycleContext: BuildCycleContext = {
          task,
          consultation,
          intent,
          taste,
          basePrompt: "",
          neLevel: enrichedNE.ne,
          riskSnapshot: context.riskSnapshot,
          taskBudgetRemaining: context.taskBudget,
          projectBudgetUtilization: context.projectBudgetUtilization,
        };

        return { consultation, buildCycleContext };

      } else {
        // ═══════════════════════════════════════════════════
        // CYCLE 2+: Re-consultation — senses see the work and update guidance
        // ═══════════════════════════════════════════════════

        task.status = "re-consulting";
        addEvent(task, "status_change", { status: "re-consulting", outerCycle });

        const sensesToReconsult = acc.reconsultSenseIds ?? [];
        const activeSenses = thalamus.getActiveSenses(library);
        const inhibitedSenses = wm.getInhibitedSenses().map((s) => ({
          senseId: s.senseId,
          reason: s.reason,
        }));

        const briefing = thalamus.forConsultationFromGestalt(task.id);

        const reconsultInput: ReconsultInput = {
          previousConsultation: acc.previousConsultation!,
          work: acc.previousBuildResult!.work,
          evaluations: acc.previousBuildResult!.evaluations,
          weighted: acc.previousWeighted!,
          composite: acc.previousComposite!,
          tensions: acc.previousBuildResult!.tensions,
        };

        const updatedConsultation = await reconsult(
          reconsultInput,
          sensesToReconsult,
          briefing,
          library,
          config,
          {
            neLevel: acc.enrichedNE ?? neLevel,
            mode,
            activeSenses,
            inhibitedSenses,
          },
        );

        addEvent(task, "consultation_result", {
          perspectives: updatedConsultation.perspectives.length,
          totalEvaluators: updatedConsultation.evaluationPlan.length,
          senses: updatedConsultation.perspectives.map((p) => p.senseName),
          generation: updatedConsultation.generation,
          reconsulted: sensesToReconsult.length,
          preserved: (updatedConsultation.preservedSenseIds ?? []).length,
        });

        acc.previousConsultation = updatedConsultation;

        // Budget proximity: how close to the attention budget ceiling (0–1).
        // Only meaningful on cycle 2+ (cycle 1 is always within budget).
        const budgetCeiling = acc.attentionBudget?.cycleRange.ceiling;
        const budgetProximity = budgetCeiling && budgetCeiling > 0
          ? Math.min(1, outerCycle / budgetCeiling)
          : undefined;

        const buildCycleContext: BuildCycleContext = {
          task,
          consultation: updatedConsultation,
          intent,
          taste,
          basePrompt: "",
          previousWork: acc.previousBuildResult!.work,
          neLevel: acc.enrichedNE ?? neLevel,
          outerCycle,
          taskBudgetRemaining: context.taskBudget,
          projectBudgetUtilization: context.projectBudgetUtilization,
          budgetProximity,
        };

        return { consultation: updatedConsultation, buildCycleContext };
      }
    },

    // ── Execute: spawn build-cycle child rhythm ─────────────
    async execute(prepared, state, runner) {
      const result = await runner.run(
        buildCycleDef,
        prepared.buildCycleContext,
        state.id,
      );

      return result;
    },

    // ── Integrate: weigh evaluations + prepare for gate ─────
    async integrate(executed, state) {
      const acc = getAcc(state);
      const ctx = state.initialContext;
      const outerCycle = state.completedCycles + 1;

      // Track total inner cycles across all outer cycles
      acc.totalInnerCycles += executed.cycles;

      // Weigh evaluations at the outer level (needed for gate decision)
      const consultation = acc.previousConsultation!;
      const weighted = weighEvaluations(executed.evaluations, consultation, stakeAdjuster);
      const composite = computeComposite(weighted);

      // Store in accumulator
      acc.previousBuildResult = executed;
      acc.previousWeighted = weighted;
      acc.previousComposite = composite;
      acc.compositeHistory.push(composite.weightedMean);

      // Assemble the result (may be returned by gate, or may loop)
      const confidence = executed.confidence;
      const finalStatus = executed.accepted
        ? "complete"
        : confidence >= 0.6
          ? "complete"
          : "needs_parsifal";

      const decisionLog: DecisionRecord[] = [
        {
          id: newId(),
          timestamp: new Date(),
          description: "consultation",
          reasoning: `Consulted ${consultation.perspectives.length} senses (generation ${consultation.generation})`,
          confidence: 0.9,
          requiresParsifalReview: false,
        },
        {
          id: newId(),
          timestamp: new Date(),
          description: executed.accepted ? "completion" : "max_cycles",
          reasoning: executed.accepted
            ? `Build accepted in ${executed.cycles} inner cycle(s), outer cycle ${outerCycle}.`
            : `Reached max inner cycles (${executed.cycles}), outer cycle ${outerCycle}. Confidence: ${confidence.toFixed(2)}`,
          confidence,
          requiresParsifalReview: confidence < 0.5,
        },
      ];

      const result: SensoryCortexResult = {
        taskId: ctx.task.id,
        status: finalStatus as OrchestratorResult["status"],
        work: executed.work,
        evaluations: executed.evaluations,
        tensions: executed.tensions,
        resolutions: executed.resolutions,
        resolutionOutcomes: executed.resolutionOutcomes,
        cycles: acc.totalInnerCycles,
        outerCycles: outerCycle,
        confidence,
        decisionLog,
        approach: executed.plan?.approach,
        failureClassification: executed.failureClassification,
      };

      return { result, weighted, composite, consultation, buildResult: executed };
    },

    // ── Gate: improvement potential → continue or complete ───
    async gate(integrated, state) {
      const acc = getAcc(state);
      const ctx = state.initialContext;
      const outerCycle = state.completedCycles + 1;
      const { result, weighted, composite, consultation, buildResult } = integrated;

      // ── Compute aggregate improvement potential ──
      const aggregateImprovement = computeAggregateImprovement(weighted);
      const sensesToReconsult = selectSensesForReconsultation(weighted, buildResult, consultation);

      // ── Attention budget zone logic ──
      const budget = acc.attentionBudget ?? ctx.attentionBudget;
      const floor = budget?.cycleRange.floor ?? 1;
      const expected = budget?.cycleRange.expected ?? config.maxOuterCycles;
      const ceiling = budget?.cycleRange.ceiling ?? config.maxOuterCycles;

      // Progress fraction: 0 at floor, 1 at ceiling
      const progressFraction = ceiling > floor
        ? Math.max(0, (outerCycle - floor) / (ceiling - floor))
        : 1;

      // ── NE-modulated threshold (tightens as we approach ceiling) ──
      const currentNE = acc.enrichedNE ?? ctx.neLevel ?? 0.5;
      let effectiveThreshold = config.improvementThreshold;
      if (currentNE < 0.3) {
        effectiveThreshold *= 1.5; // Routine task: higher bar to loop
      } else if (currentNE > 0.7) {
        effectiveThreshold *= 0.75; // Novel/risky task: lower bar, be more thorough
      }
      // Progressive tightening: easier to exit as we approach ceiling
      effectiveThreshold *= (1 - 0.3 * progressFraction);

      // ── Exit conditions ──
      let exitReason: string | null = null;

      // 0. Floor guard: below floor, never exit (minimum investment not met)
      const belowFloor = outerCycle < floor;

      // 1. Ceiling: hard stop (replaces old maxOuterCycles check)
      if (!belowFloor && outerCycle >= ceiling) {
        exitReason = `Attention budget ceiling reached (${outerCycle}/${ceiling}). Range: floor=${floor}, expected=${expected}, ceiling=${ceiling}`;
      }

      // 2. Safety cap: absolute max from config (should rarely trigger)
      if (!exitReason && outerCycle >= config.maxOuterCycles) {
        exitReason = `Absolute safety cap reached (${config.maxOuterCycles})`;
      }

      // 2x expected checkpoint: cognitive flexibility signal
      if (!exitReason && !belowFloor && outerCycle >= expected * 2 && expected > 0) {
        emit("sensory-cortex:double-expected", {
          taskId: ctx.task.id,
          outerCycle,
          expected,
          ceiling,
        });
      }

      // Remaining exit conditions only apply above floor
      if (!belowFloor) {
        // 3. Build-cycle accepted AND no significant potential
        if (!exitReason && buildResult.accepted) {
          const hasSignificant = weighted.some((w) => w.improvementPotential.level === "significant");
          if (!hasSignificant) {
            exitReason = "Build accepted and no sense flagged significant improvement potential";
          }
        }

        // 4. Aggregate improvement below threshold
        if (!exitReason && aggregateImprovement < effectiveThreshold) {
          exitReason = `Aggregate improvement potential (${aggregateImprovement.toFixed(2)}) below threshold (${effectiveThreshold.toFixed(2)})`;
        }

        // 5. Diminishing returns (composite not improving across outer cycles)
        if (!exitReason && acc.compositeHistory.length >= 2) {
          const prev = acc.compositeHistory[acc.compositeHistory.length - 2];
          const curr = acc.compositeHistory[acc.compositeHistory.length - 1];
          const delta = curr - prev;
          if (delta < config.diminishingReturnsDelta) {
            exitReason = `Diminishing returns: composite delta ${delta.toFixed(2)} < ${config.diminishingReturnsDelta}`;
          }
        }

        // 6. Near speed-of-light ceiling
        if (!exitReason && acc.speedOfLight) {
          const solCeiling = acc.speedOfLight.compositeCeiling;
          if (solCeiling > 0 && composite.weightedMean >= solCeiling * 0.9) {
            exitReason = `Near speed-of-light ceiling (${composite.weightedMean.toFixed(1)} / ${solCeiling.toFixed(1)})`;
          }
        }

        // 7. No senses to re-consult
        if (!exitReason && sensesToReconsult.length === 0) {
          exitReason = "No senses identified for re-consultation";
        }
      }

      const budgetZone = belowFloor ? "below-floor"
        : outerCycle >= ceiling ? "ceiling"
        : outerCycle >= expected ? "tightening"
        : "normal";

      emit("sensory-cortex:gate", {
        taskId: ctx.task.id,
        outerCycle,
        action: exitReason ? "complete" : "continue",
        reason: exitReason ?? `Re-consulting ${sensesToReconsult.length} senses (aggregate improvement: ${aggregateImprovement.toFixed(2)})`,
        aggregateImprovementPotential: aggregateImprovement,
        compositeScore: composite.weightedMean,
        reconsultSenseIds: sensesToReconsult,
        threshold: effectiveThreshold,
        budgetZone,
        budgetRange: { floor, expected, ceiling },
        progressFraction,
      });

      if (exitReason) {
        // ── Complete: finalize and run subcortical hooks ──
        ctx.task.status = "complete";
        addEvent(ctx.task, "status_change", { status: "complete" });

        // Subcortical hooks (dopamine=0 here; real dopamine flows via task-dispatch)
        await hooks.recordEpisode(ctx.task.id, result, 0);

        // Record task completion in working memory
        wm.completeTask(ctx.task.id, result);

        emit("task:complete", {
          status: result.status,
          cycles: result.cycles,
          outerCycles: outerCycle,
          confidence: result.confidence,
          exitReason,
        });

        log.info("Sensory cortex complete", {
          taskId: ctx.task.id,
          outerCycles: outerCycle,
          totalInnerCycles: acc.totalInnerCycles,
          compositeScore: composite.weightedMean.toFixed(2),
          exitReason,
        });

        return { action: "complete", result };
      }

      // ── Continue: store re-consultation targets for next prepare ──
      acc.reconsultSenseIds = sensesToReconsult;

      log.info("Sensory cortex looping", {
        taskId: ctx.task.id,
        outerCycle,
        aggregateImprovement: aggregateImprovement.toFixed(2),
        sensesToReconsult: sensesToReconsult.length,
        compositeScore: composite.weightedMean.toFixed(2),
      });

      return {
        action: "continue",
        reason: `Re-consulting ${sensesToReconsult.length} senses (aggregate improvement: ${aggregateImprovement.toFixed(2)})`,
      };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────

/** Convert Map-based ScoredEpisodes to plain objects for LLM prompts. */
function serializeEpisodes(matches: ScoredEpisode[]): SerializedEpisode[] {
  return matches.map((m) => ({
    taskId: m.episode.taskId,
    senseScores: Object.fromEntries(m.episode.senseScores),
    similarity: m.similarity,
  }));
}
