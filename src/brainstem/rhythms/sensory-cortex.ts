/**
 * Sensory-Cortex Rhythm — the per-task loop.
 *
 * Lifts the current orchestrator's outer function into a rhythm:
 *   prepare:   consult senses → get Council
 *   execute:   spawn build-cycle child rhythm
 *   integrate: assemble OrchestratorResult from build-cycle result
 *   gate:      complete (single-pass for now)
 *
 * Future: Cognitive Flexibility could trigger re-consultation (gate → continue),
 * and the Explore phase would insert between prepare and execute.
 */

import type { RhythmDefinition, RhythmState, RhythmRunner } from "../../types/rhythm.js";
import type { SensoryCortexContext, SensoryCortexResult, BuildCycleContext, BuildCycleResult } from "../../types/brainstem.js";
import type { OrchestratorResult, CortexConfig } from "../../types/orchestrator.js";
import type { Council } from "../../types/council.js";
import type { DecisionRecord } from "../../types/intent.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { Sense } from "../../types/sense.js";
import { consult } from "../../kernel/consul.js";
import { addEvent } from "../../types/task.js";
import { newId } from "../../util/ids.js";
import { emit } from "../../events.js";
import { createBuildCycleDefinition } from "./build-cycle.js";
import type { SubcorticalHooks } from "../stubs.js";
import type { WorkingMemory } from "../../kernel/working-memory.js";
import type { Thalamus } from "../../kernel/thalamus.js";
import type { MotorCortex } from "../../kernel/motor-cortex.js";
import type { Inhibitor } from "../../kernel/inhibitor.js";

// ─── Intermediate types ─────────────────────────────────────────

interface PreparedSensory {
  council: Council;
  buildCycleContext: BuildCycleContext;
}

// ─── Definition factory ─────────────────────────────────────────

export function createSensoryCortexDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  hooks: SubcorticalHooks,
  wm: WorkingMemory,
  thalamus: Thalamus,
  motorCortex: MotorCortex,
  inhibitor: Inhibitor,
): RhythmDefinition<SensoryCortexContext, SensoryCortexResult, PreparedSensory, BuildCycleResult, SensoryCortexResult> {
  const buildCycleDef = createBuildCycleDefinition(config, library, hooks, wm, thalamus, motorCortex, inhibitor);

  return {
    name: "sensory-cortex",
    maxCycles: 1, // Single pass: consult once, build-cycle loops internally

    // ── Prepare: consult senses ─────────────────────────────
    async prepare(context, state) {
      const { task, intent, taste } = context;

      task.status = "consulting";
      addEvent(task, "status_change", { status: "consulting" });

      emit("task:start", {
        id: task.id,
        description: task.description,
        maxCycles: config.maxCycles,
      });

      // Get active senses (inhibited ones filtered out by thalamus)
      const activeSenses = thalamus.getActiveSenses(library);

      // Assemble consultation briefing with WM enrichment
      const briefing = await thalamus.forConsultation(task);

      const council = await consult(briefing, activeSenses, library, config);

      const totalEvaluators = council.perspectives.reduce(
        (sum, p) => sum + p.evaluators.length,
        0,
      );

      addEvent(task, "consultation_result", {
        perspectives: council.perspectives.length,
        totalEvaluators,
        senses: council.perspectives.map((p) => p.senseName),
      });

      const buildCycleContext: BuildCycleContext = {
        task,
        council,
        intent,
        taste,
        basePrompt: "", // build-cycle's prepare assembles this
      };

      return { council, buildCycleContext };
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

    // ── Integrate: assemble OrchestratorResult ──────────────
    async integrate(executed, state) {
      const ctx = state.initialContext;
      const confidence = computeConfidence(executed.evaluations);
      const finalStatus = executed.accepted
        ? "complete"
        : confidence >= 0.6
          ? "complete"
          : "needs_human";

      ctx.task.status = "complete";
      addEvent(ctx.task, "status_change", { status: "complete" });

      const decisionLog: DecisionRecord[] = [
        {
          id: newId(),
          timestamp: new Date(),
          description: "consultation",
          reasoning: `Consulted ${state.accumulator.__councilPerspectives ?? "?"} senses`,
          confidence: 0.9,
          requiresHumanReview: false,
        },
        {
          id: newId(),
          timestamp: new Date(),
          description: executed.accepted ? "completion" : "max_cycles",
          reasoning: executed.accepted
            ? `Task completed in ${executed.cycles} cycle(s). Accepted.`
            : `Reached max cycles (${executed.cycles}). Confidence: ${confidence.toFixed(2)}`,
          confidence,
          requiresHumanReview: confidence < 0.5,
        },
      ];

      const result: SensoryCortexResult = {
        taskId: ctx.task.id,
        status: finalStatus as OrchestratorResult["status"],
        work: executed.work,
        evaluations: executed.evaluations,
        tensions: executed.tensions,
        resolutions: executed.resolutions,
        cycles: executed.cycles,
        confidence,
        decisionLog,
      };

      // Call subcortical hooks
      await hooks.recordEpisode(ctx.task.id, result);

      // Record task completion in working memory
      // (summary + decisions; scores already recorded by build-cycle)
      wm.completeTask(ctx.task.id, result);

      emit("task:complete", {
        status: finalStatus,
        cycles: executed.cycles,
        confidence,
      });

      return result;
    },

    // ── Gate: always complete (single-pass) ─────────────────
    async gate(integrated, _state) {
      return {
        action: "complete",
        result: integrated,
      };
    },
  };
}

function computeConfidence(evaluations: { score: number }[]): number {
  if (evaluations.length === 0) return 0;
  const total = evaluations.reduce((sum, e) => sum + e.score, 0);
  return total / (evaluations.length * 10);
}
