/**
 * Nursery Consultation — senses propose stress-test scenarios.
 *
 * Same machinery as build-cycle consultation but different question:
 * "What could kill this at runtime?" not "What should we build?"
 *
 * Each sense proposes NurseryScenario[] from its perspective:
 *   - Correctness: race conditions, ordering violations, data corruption
 *   - Performance: memory leaks, resource exhaustion, degradation under load
 *   - Reliability: crash recovery, failover, partial failure
 *   - Security: injection under concurrency, privilege escalation under load
 */

import { z } from "zod";
import type { Sense } from "../types/sense.js";
import type { NurseryScenario, NurserySurfaceScan, RuntimeSurfaceArea } from "../types/nursery.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

const log = createLogger("nursery-consul");

// ─── Structured output schema ───────────────────────────────────

const ScenarioResult = z.object({
  scenarios: z.array(z.object({
    description: z.string(),
    exerciseMethod: z.string(),
    expectedBehavior: z.string(),
    surfaceAreaKind: z.string(),
    severity: z.enum(["critical", "standard"]),
  })),
  /** If the sense has nothing to contribute, explain briefly. */
  noContribution: z.string().optional(),
});

// ─── Prompts ────────────────────────────────────────────────────

function nurseryConsultationSystem(sense: Sense, subTree: Sense[]): string {
  const pathways = subTree.filter((g) => g.level === "pathway");
  const subConcerns = pathways
    .map((pathway) => {
      const receptors = subTree.filter(
        (g) => g.level === "receptor" && g.parentId === pathway.id,
      );
      const receptorList = receptors
        .map((m) => `    - ${m.name}: ${m.sensitivity}`)
        .join("\n");
      return `  - ${pathway.name}: ${pathway.sensitivity}\n${receptorList}`;
    })
    .join("\n");

  return `You are ${sense.name}. ${sense.sensitivity}

Your sub-concerns:
${subConcerns}

A phase has completed and its artifacts are entering the NURSERY — runtime stress-testing before graduation.

Your job: propose stress-test scenarios from your perspective. Think about what could go wrong AT RUNTIME that static code review can't catch. Not "is the code well-written" but "does it SURVIVE contact with reality?"

For each scenario, describe:
1. What to test (the failure mode you're looking for)
2. How to exercise it (specific steps the observer should take — start server, send requests, check output)
3. What healthy behavior looks like (so the observer knows what "broken" means)
4. Severity: "critical" (blocks graduation) or "standard" (produces a fix task)

If this phase's artifacts don't touch your domain, say so briefly and return no scenarios. Not every sense has something to say about every runtime surface.`;
}

function nurseryConsultationUser(surfaceScan: NurserySurfaceScan): string {
  const surfaceDescriptions = surfaceScan.surfaceAreas
    .map((sa) => `- ${sa.kind}: ${sa.description} (files: ${sa.files.join(", ")})`)
    .join("\n");

  return `Phase "${surfaceScan.phaseGroup}" has completed. The following runtime surface areas were detected:

${surfaceDescriptions}

Propose stress-test scenarios that exercise these artifacts at runtime. Focus on failure modes that ONLY manifest when the code actually runs — race conditions, resource leaks, degradation under load, crash recovery, etc.

Return your scenarios as structured data.`;
}

// ─── Observation interpretation prompt ──────────────────────────

export function nurseryObservationSystem(sense: Sense): string {
  return `You are ${sense.name}. ${sense.sensitivity}

You are observing the results of a nursery stress-test. You were given the observer's raw observations from exercising a runtime artifact.

Your job: determine whether the observations reveal a RUNTIME PROBLEM from your perspective. Not code quality — runtime behavior.

If you identify a problem:
- Describe what went wrong
- Cite the specific evidence from the observations
- Suggest a fix direction (not a prescription — just point the way)
- Rate severity: "critical" (fundamentally broken) or "standard" (needs fixing but not catastrophic)

If the observations look healthy from your perspective, say so.`;
}

// ─── Consultation function ──────────────────────────────────────

/**
 * Consult senses for nursery stress-test scenarios.
 * Runs parallel LLM calls — one per sense.
 */
export async function consultForScenarios(
  surfaceScan: NurserySurfaceScan,
  senses: Sense[],
  library: SensoryCortex,
  config: CortexConfig,
): Promise<NurseryScenario[]> {
  emit("nursery:consultation-start", {
    senseCount: senses.length,
    names: senses.map((s) => s.name),
    surfaceAreaCount: surfaceScan.surfaceAreas.length,
  });

  log.info("Consulting senses for nursery scenarios", {
    count: senses.length,
    names: senses.map((s) => s.name),
  });

  const userPrompt = nurseryConsultationUser(surfaceScan);

  // Consult all senses in parallel
  const scenarioPromises = senses.map(async (sense) => {
    const subTree = library.getSubTree(sense.id).filter((g) => g.id !== sense.id);

    try {
      const result = await callStructured(
        "nursery-consultation",
        config.models.consultation,
        nurseryConsultationSystem(sense, subTree),
        userPrompt,
        ScenarioResult,
      );

      if (result.noContribution || result.scenarios.length === 0) {
        log.info("Sense has no nursery scenarios", { sense: sense.name });
        return [];
      }

      // Map LLM output to typed NurseryScenario[]
      const scenarios: NurseryScenario[] = result.scenarios.map((s) => {
        // Match the surfaceAreaKind to an actual surface area
        const matchedSurface = surfaceScan.surfaceAreas.find(
          (sa) => sa.kind === s.surfaceAreaKind,
        ) ?? surfaceScan.surfaceAreas[0]; // Fallback to first if no match

        return {
          id: newId(),
          senseId: sense.id,
          senseName: sense.name,
          description: s.description,
          exerciseMethod: s.exerciseMethod,
          expectedBehavior: s.expectedBehavior,
          surfaceArea: matchedSurface,
          severity: s.severity,
        };
      });

      emit("nursery:scenarios-from-sense", {
        sense: sense.name,
        scenarioCount: scenarios.length,
      });

      return scenarios;
    } catch (err) {
      log.warn("Nursery consultation failed for sense", {
        sense: sense.name,
        error: String(err),
      });
      return [];
    }
  });

  const scenarioArrays = await Promise.all(scenarioPromises);
  const allScenarios = scenarioArrays.flat();

  emit("nursery:scenario-generated", {
    phaseGroup: surfaceScan.phaseGroup,
    scenarioCount: allScenarios.length,
    senseCount: senses.length,
  });

  log.info("Nursery consultation complete", {
    totalScenarios: allScenarios.length,
    bySense: senses.map((s) => ({
      name: s.name,
      count: scenarioArrays[senses.indexOf(s)].length,
    })),
  });

  return allScenarios;
}
