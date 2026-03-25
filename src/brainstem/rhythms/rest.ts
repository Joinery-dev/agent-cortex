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
}

interface ExecutedRest {
  completed: ConsolidationPriority[];
  principlesExtracted: number;
  memoryItemsPruned: number;
  memoryItemsPromoted: number;
  connectionsDecayed: number;
  predictionsRecalibrated: boolean;
}

export function createRestCycleDefinition(
  hooks: SubcorticalHooks,
): RhythmDefinition<RestCycleContext, RestCycleResult, PreparedRest, ExecutedRest, RestCycleResult> {
  return {
    name: "rest-cycle",
    maxCycles: 3, // Don't rest forever

    async prepare(context, _state) {
      log.info("Entering rest cycle", {
        priorities: context.priorities,
      });

      emit("rest:start", {
        load: context.load,
        priorities: context.priorities,
      });

      return { priorities: context.priorities };
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

    async integrate(executed, state) {
      // In the real system, this would re-read vitals from the
      // homeostasis monitor to see if rest helped. For now, return
      // healthy defaults.
      const vitalsAfter: VitalSigns = {
        workingMemoryLoad: 0.2,
        predictionAccuracy: 0.8,
        contextCapacity: 0.2,
        learningSignalHealth: 0.9,
        weightVolatility: 0.1,
        tonicDopamine: 0.5,
      };

      const loadAfter: ConsolidationLoad = {
        episodeDensity: 0,
        memoryPressure: 0.2,
        predictionDrift: 0.2,
        weightInstability: 0.1,
        deferredProcessing: 0,
      };

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

    async gate(integrated, _state) {
      emit("rest:complete", {
        completed: integrated.completed,
        principlesExtracted: integrated.principlesExtracted,
      });

      log.info("Rest cycle complete", {
        completed: integrated.completed,
      });

      // For now, one rest cycle is always enough (stubs resolve everything)
      return {
        action: "complete",
        result: integrated,
      };
    },
  };
}
