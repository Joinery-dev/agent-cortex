/**
 * Nursery Rhythm — runtime stress-testing of completed phase artifacts.
 *
 * Cortex's interoception. After a phase gate passes and runtime
 * surface area is detected, the nursery exercises the artifacts and
 * observes what happens.
 *
 *   prepare:   Consult senses for stress-test scenarios
 *   execute:   Observer (PNS) exercises scenarios against running artifacts
 *   integrate: Senses interpret observations, flag findings
 *   gate:      Findings? → surgery proposals. None? → graduate.
 *
 * Single-pass per invocation. Fix-then-re-exercise looping happens
 * at the task-dispatch level, not inside the nursery rhythm.
 */

import type { RhythmDefinition } from "../../types/rhythm.js";
import type { NurseryContext, NurseryResult, NurseryScenario, NurseryFinding } from "../../types/nursery.js";
import type { EvaluatorObservation } from "../../types/sense.js";
import type { SurgeryProposal, GraphSurgeryInsert, GraphSurgeryRework } from "../../types/graph-surgery.js";
import type { CortexConfig } from "../../types/orchestrator.js";
import type { SensoryCortex } from "../../senses/cortex.js";
import type { PeripheralNervousSystem } from "../../kernel/pns.js";
import { createTask } from "../../types/task.js";
import { consultForScenarios } from "../../kernel/nursery-consul.js";
import { createLogger } from "../../util/logger.js";
import { emit } from "../../events.js";
import { newId } from "../../util/ids.js";
import { call } from "../../llm/client.js";
import { nurseryObservationSystem } from "../../kernel/nursery-consul.js";

const log = createLogger("nursery");

// ─── Intermediate types ─────────────────────────────────────────

interface PreparedNursery {
  scenarios: NurseryScenario[];
  observerTools: import("../../types/pns.js").ActivatedToolSet;
}

interface ExecutedNursery {
  /** Raw observations per scenario. */
  observations: Map<string, EvaluatorObservation[]>;
  scenarios: NurseryScenario[];
}

interface IntegratedNursery {
  findings: NurseryFinding[];
  scenarios: NurseryScenario[];
}

// ─── Definition factory ─────────────────────────────────────────

export function createNurseryDefinition(
  config: CortexConfig,
  library: SensoryCortex,
  pns: PeripheralNervousSystem,
): RhythmDefinition<NurseryContext, NurseryResult, PreparedNursery, ExecutedNursery, IntegratedNursery> {
  return {
    name: "nursery",
    maxCycles: 1, // Single-pass — looping happens at task-dispatch level

    // ── Prepare: consult senses for stress-test scenarios ──────────

    async prepare(context) {
      const startMs = Date.now();

      // Get active senses from the library
      const senses = library.getSenses();

      // Consult senses for scenarios
      const scenarios = await consultForScenarios(
        context.surfaceScan,
        senses,
        library,
        config,
      );

      // Activate observer tools
      const observerTools = pns.activateToolsForTask(
        `Nursery stress-testing for phase "${context.phaseGroup}"`,
        context.neLevel,
        "observer",
      );

      log.info("Nursery prepared", {
        phaseGroup: context.phaseGroup,
        scenarioCount: scenarios.length,
        observerToolCount: observerTools.tools.length,
        prepareMs: Date.now() - startMs,
      });

      return { scenarios, observerTools };
    },

    // ── Execute: observer exercises scenarios ─────────────────────

    async execute(prepared, state) {
      const context = state.initialContext;
      const observations = new Map<string, EvaluatorObservation[]>();

      if (prepared.scenarios.length === 0) {
        log.info("No scenarios to exercise — senses had nothing to contribute");
        return { observations, scenarios: prepared.scenarios };
      }

      // Exercise each scenario sequentially (some may need exclusive port access)
      for (const scenario of prepared.scenarios) {
        emit("nursery:exercise-start", {
          phaseGroup: context.phaseGroup,
          scenarioId: scenario.id,
          senseName: scenario.senseName,
          description: scenario.description,
        });

        const startMs = Date.now();

        try {
          // The observer executes the scenario by asking the LLM to run it
          // with observer tools (Bash to start processes, Read to check output, etc.)
          const observerPrompt = buildObserverPrompt(scenario, prepared.observerTools);

          const result = await call(
            "nursery-observation",
            config.models.evaluation,
            observerPrompt.system,
            observerPrompt.user,
          );

          // Parse observations from the LLM's response
          const scenarioObs = parseObservations(result.text, scenario);
          observations.set(scenario.id, scenarioObs);

          emit("nursery:exercise-complete", {
            phaseGroup: context.phaseGroup,
            scenarioId: scenario.id,
            observationCount: scenarioObs.length,
            durationMs: Date.now() - startMs,
          });
        } catch (err) {
          log.warn("Scenario exercise failed", {
            scenarioId: scenario.id,
            error: String(err),
          });

          // Record the failure itself as an observation
          observations.set(scenario.id, [{
            kind: "runtime-check",
            target: scenario.description,
            finding: `Exercise failed: ${String(err)}`,
            interpretation: "The scenario could not be exercised — this may indicate the artifact cannot start or has a fundamental startup failure.",
          }]);
        }
      }

      return { observations, scenarios: prepared.scenarios };
    },

    // ── Integrate: senses interpret observations ──────────────────

    async integrate(executed, state) {
      const context = state.initialContext;
      const findings: NurseryFinding[] = [];

      for (const scenario of executed.scenarios) {
        const obs = executed.observations.get(scenario.id) ?? [];
        if (obs.length === 0) continue;

        // Get the sense that proposed this scenario to interpret
        const sense = library.getSenses().find((s) => s.id === scenario.senseId);
        if (!sense) continue;

        try {
          const system = nurseryObservationSystem(sense);
          const user = buildInterpretationPrompt(scenario, obs);

          const result = await call(
            "nursery-observation",
            config.models.evaluation,
            system,
            user,
          );

          // Check if the sense flagged a finding
          const finding = parseFindings(result.text, scenario, sense);
          if (finding) {
            findings.push(finding);

            emit("nursery:finding", {
              phaseGroup: context.phaseGroup,
              scenarioId: scenario.id,
              senseId: sense.id,
              senseName: sense.name,
              severity: finding.severity,
              description: finding.description,
            });
          }
        } catch (err) {
          log.warn("Observation interpretation failed", {
            scenarioId: scenario.id,
            senseId: sense.id,
            error: String(err),
          });
        }
      }

      return { findings, scenarios: executed.scenarios };
    },

    // ── Gate: findings → surgery proposals, or graduate ───────────

    async gate(integrated, state) {
      const context = state.initialContext;
      const { findings, scenarios } = integrated;

      if (findings.length === 0) {
        // Clean — artifact is healthy
        const result: NurseryResult = {
          graduated: true,
          findings: [],
          exercisedScenarios: scenarios,
          surgeryProposals: [],
          durationMs: Date.now() - state.startedAt.getTime(),
        };

        return { action: "complete" as const, result };
      }

      // Findings exist — produce surgery proposals
      const proposals = findingsToProposals(findings, context);

      const result: NurseryResult = {
        graduated: false,
        findings,
        exercisedScenarios: scenarios,
        surgeryProposals: proposals,
        durationMs: Date.now() - state.startedAt.getTime(),
      };

      return { action: "complete" as const, result };
    },
  };
}

// ─── Helper: observer prompt ────────────────────────────────────

function buildObserverPrompt(
  scenario: NurseryScenario,
  tools: import("../../types/pns.js").ActivatedToolSet,
): { system: string; user: string } {
  return {
    system: `You are a nursery observer — your job is to EXERCISE a runtime artifact and OBSERVE what happens. You can start processes, send requests, read output, and check system state. You MUST NOT modify any source code or artifacts.

${tools.systemContext}

Your approach:
1. Start the artifact (if it's a server/process)
2. Exercise the scenario described below
3. Observe the results carefully
4. Report exactly what you saw — raw facts, not judgments
5. Stop the artifact when done

Be systematic. If something crashes, report the error. If something hangs, report the timeout. If something succeeds, report the output.`,

    user: `SCENARIO: ${scenario.description}

EXERCISE METHOD: ${scenario.exerciseMethod}

EXPECTED HEALTHY BEHAVIOR: ${scenario.expectedBehavior}

SURFACE AREA: ${scenario.surfaceArea.kind} — ${scenario.surfaceArea.description}
FILES: ${scenario.surfaceArea.files.join(", ")}

Execute this scenario and report your raw observations. What happened when you ran it?`,
  };
}

// ─── Helper: parse observations from LLM response ───────────────

function parseObservations(llmResponse: string, scenario: NurseryScenario): EvaluatorObservation[] {
  // The observer's response is free-text describing what it saw.
  // We wrap it as a single observation — the interpretation step
  // will do the real analysis.
  return [{
    kind: "runtime-check",
    target: scenario.description,
    finding: llmResponse,
    interpretation: `Raw observer output for scenario: ${scenario.description}`,
  }];
}

// ─── Helper: interpretation prompt ──────────────────────────────

function buildInterpretationPrompt(
  scenario: NurseryScenario,
  observations: EvaluatorObservation[],
): string {
  const obsText = observations
    .map((o) => `[${o.kind}] Target: ${o.target}\nFinding: ${o.finding}`)
    .join("\n\n---\n\n");

  return `A nursery observer exercised the following scenario and produced these observations:

SCENARIO: ${scenario.description}
EXPECTED BEHAVIOR: ${scenario.expectedBehavior}
SEVERITY: ${scenario.severity}

OBSERVATIONS:
${obsText}

Does this reveal a runtime problem from your perspective? If yes, describe the problem, cite the evidence, suggest a fix direction, and rate severity. If the observations look healthy, say "HEALTHY" and explain briefly why.`;
}

// ─── Helper: parse findings from interpretation ─────────────────

function parseFindings(
  llmResponse: string,
  scenario: NurseryScenario,
  sense: import("../../types/sense.js").Sense,
): NurseryFinding | null {
  // Simple heuristic: if the response contains "HEALTHY" at the start,
  // the sense didn't find a problem.
  const trimmed = llmResponse.trim();
  if (trimmed.toUpperCase().startsWith("HEALTHY")) {
    return null;
  }

  // The sense flagged a problem — create a finding
  return {
    id: newId(),
    scenarioId: scenario.id,
    senseId: sense.id,
    senseName: sense.name,
    description: trimmed.slice(0, 500), // First 500 chars as description
    evidence: [{
      kind: "runtime-check",
      target: scenario.description,
      finding: llmResponse,
      interpretation: `${sense.name} identified a runtime problem`,
    }],
    suggestedFix: extractSuggestedFix(trimmed),
    severity: scenario.severity,
  };
}

function extractSuggestedFix(response: string): string {
  // Look for common patterns in the response
  const fixPatterns = [
    /(?:suggest|recommend|fix|solution|to fix|to resolve)[:\s]+(.+?)(?:\n\n|$)/is,
    /(?:fix direction|suggested fix)[:\s]+(.+?)(?:\n\n|$)/is,
  ];

  for (const pattern of fixPatterns) {
    const match = response.match(pattern);
    if (match) return match[1].trim().slice(0, 300);
  }

  return "See finding description for details";
}

// ─── Helper: findings → surgery proposals ───────────────────────

function findingsToProposals(
  findings: NurseryFinding[],
  context: NurseryContext,
): SurgeryProposal[] {
  if (findings.length === 0) return [];

  const operations = findings.map((finding) => {
    if (finding.severity === "critical") {
      // Critical → rework the original task
      // Find which task produced the affected surface area
      const taskId = findSourceTask(finding, context);
      if (taskId) {
        return {
          op: "rework" as const,
          directive: {
            taskId,
            reason: `Nursery finding: ${finding.description}`,
            amendedDescription: `Fix runtime issue: ${finding.description}. ${finding.suggestedFix}`,
            additionalContext: {
              nurseryFinding: finding.id,
              nurseryEvidence: finding.evidence.map((e) => e.finding).join("\n"),
            },
            downstreamDependents: [],
          },
        };
      }
    }

    // Standard → insert a new fix task
    const fixTask = createTask(
      newId(),
      `[Nursery fix] ${finding.description}. Fix direction: ${finding.suggestedFix}`,
      { nurseryFinding: finding.id, nurseryEvidence: finding.evidence.map((e) => e.finding).join("\n") },
    );

    return {
      op: "insert" as const,
      node: {
        task: fixTask,
        dependsOn: [],
        phaseGroup: context.phaseGroup,
      },
    };
  });

  return [{
    id: newId(),
    source: "nursery" as const,
    reasoning: `Nursery found ${findings.length} runtime issue(s) in phase "${context.phaseGroup}": ${findings.map((f) => f.description).join("; ")}`,
    operations,
    blastRadius: operations.length / Math.max(1, context.graph.length),
    grounding: findings.map((f) => f.id),
    createdAt: new Date(),
    status: "pending" as const,
  }];
}

function findSourceTask(finding: NurseryFinding, context: NurseryContext): string | null {
  // Try to match the finding's scenario surface area files to a completed task
  const surfaceFiles = new Set(finding.evidence.flatMap((e) => [e.target]));

  for (const node of context.graph) {
    if (!context.completedTaskIds.has(node.task.id)) continue;
    if (node.phaseGroup !== context.phaseGroup) continue;

    const result = context.taskResults.get(node.task.id);
    if (!result?.work) continue;

    // Check if any surface file appears in the task's work output
    for (const file of surfaceFiles) {
      if (result.work.includes(file)) return node.task.id;
    }
  }

  return null;
}
