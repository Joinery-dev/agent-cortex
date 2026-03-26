/**
 * Rest-Cycle Rhythm — consolidation when the system needs it.
 *
 * Norepinephrine drops to zero. No task execution. The system turns inward.
 * Same four-phase pattern as every other rhythm.
 *
 * Currently a stub — logs which consolidation processes would run.
 * Real implementation arrives with Phase 3 learning systems.
 */

import type { RhythmDefinition } from "../../types/rhythm.js";
import type {
  RestCycleContext,
  RestCycleResult,
  ConsolidationPriority,
  VitalSigns,
  ConsolidationLoad,
} from "../../types/brainstem.js";
import { createLogger } from "../../util/logger.js";
import { emit } from "../../events.js";
import type { SubcorticalHooks } from "../stubs.js";

const log = createLogger("rest-cycle");

interface PreparedRest {
  priorities: ConsolidationPriority[];
  vitalsBefore: VitalSigns;
}

interface ExecutedRest {
  completed: ConsolidationPriority[];
  principlesExtracted: number;
  memoryItemsPruned: number;
  memoryItemsPromoted: number;
  connectionsDecayed: number;
  predictionsRecalibrated: boolean;
}

/** Compare pre- and post-rest vitals. Returns "recovered" if the most stressed vital improved, "insufficient" otherwise. */
function assessRecovery(before: VitalSigns, after: VitalSigns): "recovered" | "insufficient" {
  // Identify the vital that was most stressed before rest
  const vitals: (keyof VitalSigns)[] = [
    "workingMemoryLoad", "contextCapacity", "budgetUtilization", "weightVolatility",
  ];
  // For these vitals, high = stressed. For predictionAccuracy and learningSignalHealth, low = stressed.
  const invertedVitals: (keyof VitalSigns)[] = ["predictionAccuracy", "learningSignalHealth"];

  let worstStress = 0;
  let improved = false;

  for (const v of vitals) {
    if (before[v] > worstStress) worstStress = before[v];
    if (before[v] - after[v] > 0.1) improved = true;
  }
  for (const v of invertedVitals) {
    const stress = 1 - before[v];
    if (stress > worstStress) worstStress = stress;
    if (after[v] - before[v] > 0.1) improved = true;
  }

  return improved ? "recovered" : "insufficient";
}

export function createRestCycleDefinition(
  hooks: SubcorticalHooks,
  getVitals: () => VitalSigns,
  getConsolidationLoad: () => ConsolidationLoad,
  maxRestCycles: number = 3,
): RhythmDefinition<RestCycleContext, RestCycleResult, PreparedRest, ExecutedRest, RestCycleResult> {
  return {
    name: "rest-cycle",
    maxCycles: maxRestCycles,

    async prepare(context, state) {
      const vitalsBefore = getVitals();
      // Store in accumulator so the gate can compare pre/post vitals
      state.accumulator.__vitalsBefore = vitalsBefore;

      log.info("Entering rest cycle", {
        priorities: context.priorities,
        vitalsBefore,
      });

      emit("rest:start", {
        load: context.load,
        priorities: context.priorities,
      });

      return { priorities: context.priorities, vitalsBefore };
    },

    async execute(prepared, _state, _runner) {
      const completed: ConsolidationPriority[] = [];
      let principlesExtracted = 0;
      let memoryItemsPruned = 0;
      let memoryItemsPromoted = 0;
      let connectionsDecayed = 0;
      let predictionsRecalibrated = false;

      for (const priority of prepared.priorities) {
        switch (priority) {
          case "potentiate": {
            const r = await hooks.potentiate();
            principlesExtracted = r.principlesExtracted;
            completed.push(priority);
            break;
          }
          case "prune-memory": {
            const r = await hooks.pruneMemory();
            memoryItemsPruned = r.pruned;
            memoryItemsPromoted = r.promoted;
            completed.push(priority);
            break;
          }
          case "decay-connections": {
            const r = await hooks.decayConnections();
            connectionsDecayed = r.decayed;
            completed.push(priority);
            break;
          }
          case "recalibrate": {
            const r = await hooks.recalibrate();
            predictionsRecalibrated = r.recalibrated;
            completed.push(priority);
            break;
          }
          case "settle-weights": {
            const r = await hooks.settleWeights();
            completed.push(priority);
            break;
          }
          case "decay-routines": {
            await hooks.decayRoutines();
            completed.push(priority);
            break;
          }
          case "deferred-checks":
            // No-op until phase gate integration exists
            completed.push(priority);
            break;
        }
      }

      return {
        completed,
        principlesExtracted,
        memoryItemsPruned,
        memoryItemsPromoted,
        connectionsDecayed,
        predictionsRecalibrated,
      };
    },

    async integrate(executed, _state) {
      const vitalsAfter = getVitals();
      const loadAfter = getConsolidationLoad();

      return {
        completed: executed.completed,
        principlesExtracted: executed.principlesExtracted,
        memoryItemsPruned: executed.memoryItemsPruned,
        memoryItemsPromoted: executed.memoryItemsPromoted,
        connectionsDecayed: executed.connectionsDecayed,
        predictionsRecalibrated: executed.predictionsRecalibrated,
        vitalsAfter,
        loadAfter,
      };
    },

    async gate(integrated, state) {
      const vitalsBefore = state.accumulator.__vitalsBefore as VitalSigns | undefined;
      const cycle = state.completedCycles + 1;
      const recovery = vitalsBefore
        ? assessRecovery(vitalsBefore, integrated.vitalsAfter)
        : "recovered"; // No baseline to compare — accept

      if (recovery === "insufficient" && cycle < 3) {
        emit("rest:continuing", {
          cycle,
          recovery,
          vitalsAfter: integrated.vitalsAfter,
        });
        log.info("Rest recovery insufficient, continuing", { cycle });
        return { action: "continue", reason: `Recovery insufficient after cycle ${cycle}` };
      }

      if (recovery === "insufficient") {
        emit("rest:incomplete", {
          vitalsAfter: integrated.vitalsAfter,
          loadAfter: integrated.loadAfter,
        });
        log.warn("Rest cycles exhausted without full recovery", {
          vitalsAfter: integrated.vitalsAfter,
        });
      }

      emit("rest:complete", {
        completed: integrated.completed,
        principlesExtracted: integrated.principlesExtracted,
        recovery,
      });

      log.info("Rest cycle complete", {
        completed: integrated.completed,
        recovery,
      });

      return { action: "complete", result: integrated };
    },
  };
}
