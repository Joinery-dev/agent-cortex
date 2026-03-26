/**
 * Deep Synthesis — LLM-assisted PFC analysis at phase gates.
 *
 * Reads all territory observations + hippocampal simulations + world model
 * + drift assessment, and produces typed graph surgery proposals. Each
 * proposal carries a blast radius. If any proposal exceeds 30% blast
 * radius, the result flags for replan instead of surgery.
 *
 * Called from task-dispatch.integrate inside the isPhaseComplete block,
 * after integration check passes.
 */

import type { TaskGraphNode } from "../types/brainstem.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { SimulatedScenario } from "../types/hippocampal-simulation.js";
import type {
  GraphSurgeryOp,
  SurgeryProposal,
  GraphSurgeryInsert,
  GraphSurgeryAmend,
  GraphSurgeryRework,
  GraphSurgeryReorder,
} from "../types/graph-surgery.js";
import type { DriftAssessment } from "../types/drift-monitor.js";
import { computeBlastRadius, discoveryId } from "./graph-surgery.js";
import { callStructured } from "../llm/structured.js";
import { deepSynthesisSystem, deepSynthesisUser } from "../llm/prompts.js";
import { newId } from "../util/ids.js";
import { z } from "zod";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { createTask } from "../types/task.js";

const log = createLogger("deep-synthesis");

/** Default blast radius above which proposals trigger replan instead of surgery. */
const DEFAULT_REPLAN_BLAST_RADIUS_THRESHOLD = 0.3;

// ─── Input / Output Types ───────────────────────────────────────

export interface DeepSynthesisInputs {
  /** All observations with status "new" or "triaged". */
  observations: TerritoryObservation[];
  /** All simulations with status "new". */
  simulations: SimulatedScenario[];
  /** World model maxims. */
  maxims: string[];
  /** Drift assessment if available. */
  drift: DriftAssessment | null;
  /** Remaining task graph (non-completed, non-escalated). */
  remainingTasks: TaskGraphNode[];
  /** Completed task IDs. */
  completedTaskIds: Set<string>;
  /** Manifested future (destination). */
  manifestedFuture: string;
  /** Phase group that just completed. */
  phaseGroup: string;
}

export interface DeepSynthesisResult {
  /** Graph surgery proposals produced. */
  proposals: SurgeryProposal[];
  /** True if any proposal exceeds blast radius threshold → should replan instead. */
  shouldReplan: boolean;
  /** LLM reasoning for the synthesis. */
  reasoning: string;
  /** How many observations were consumed. */
  observationsConsumed: number;
  /** How many simulations were consumed. */
  simulationsConsumed: number;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Deep synthesis: LLM-assisted PFC analysis at phase gates.
 *
 * Produces typed surgery proposals. Each proposal carries blast radius.
 * Proposals > 30% blast radius → flag for replan.
 */
export async function deepSynthesis(
  inputs: DeepSynthesisInputs,
  model: string,
  discoveryCounter: number = 0,
  replanBlastRadiusThreshold: number = DEFAULT_REPLAN_BLAST_RADIUS_THRESHOLD,
): Promise<DeepSynthesisResult> {
  // Skip if nothing to synthesize
  if (inputs.observations.length === 0 && inputs.simulations.length === 0) {
    return {
      proposals: [],
      shouldReplan: false,
      reasoning: "No observations or simulations to synthesize",
      observationsConsumed: 0,
      simulationsConsumed: 0,
    };
  }

  const system = deepSynthesisSystem();
  const user = deepSynthesisUser({
    observations: inputs.observations.map((o) => ({
      id: o.id,
      fact: o.fact,
      component: o.source.component,
      relevance: o.relevance,
    })),
    simulations: inputs.simulations.map((s) => ({
      id: s.id,
      narrative: s.narrative,
      affectedTaskIds: s.affectedTaskIds,
      impact: s.impact,
      confidence: s.confidence,
      suggestedResponse: s.suggestedResponse,
    })),
    maxims: inputs.maxims,
    driftLevel: inputs.drift?.driftLevel ?? 0,
    driftSummary: inputs.drift?.driftSummary ?? null,
    remainingTasks: inputs.remainingTasks.map((n) => ({
      id: n.task.id,
      description: n.task.description,
      dependsOn: n.dependsOn,
      phaseGroup: n.phaseGroup,
    })),
    completedTaskIds: [...inputs.completedTaskIds],
    manifestedFuture: inputs.manifestedFuture,
    phaseGroup: inputs.phaseGroup,
  });

  try {
    const result = await callStructured(
      "simulation", // reuse simulation purpose
      model,
      system,
      user,
      DeepSynthesisSchema,
      8192,
    );

    // Convert LLM proposals into typed SurgeryProposal objects
    const proposals: SurgeryProposal[] = [];
    let counter = discoveryCounter;

    for (const raw of result.proposals) {
      const ops = convertOperations(raw.operations, counter, inputs.remainingTasks);
      counter += ops.filter((o) => o.op === "insert").length;

      const blastRadius = computeBlastRadius(
        ops,
        inputs.remainingTasks,
        inputs.completedTaskIds,
      );

      proposals.push({
        id: newId(),
        source: "deep-synthesis",
        reasoning: raw.reasoning,
        operations: ops,
        blastRadius,
        grounding: raw.grounding,
        createdAt: new Date(),
        status: "pending",
      });
    }

    const shouldReplan = proposals.some(
      (p) => p.blastRadius > replanBlastRadiusThreshold,
    );

    emit("synthesis:complete", {
      phaseGroup: inputs.phaseGroup,
      proposalCount: proposals.length,
      shouldReplan,
      observationCount: inputs.observations.length,
      simulationCount: inputs.simulations.length,
    });

    log.info("Deep synthesis complete", {
      proposals: proposals.length,
      shouldReplan,
      reasoning: result.reasoning.slice(0, 200),
    });

    return {
      proposals,
      shouldReplan,
      reasoning: result.reasoning,
      observationsConsumed: inputs.observations.length,
      simulationsConsumed: inputs.simulations.length,
    };
  } catch (err) {
    log.warn("Deep synthesis failed", { error: String(err) });

    return {
      proposals: [],
      shouldReplan: false,
      reasoning: `Synthesis failed: ${String(err)}`,
      observationsConsumed: 0,
      simulationsConsumed: 0,
    };
  }
}

// ─── Operation Conversion ───────────────────────────────────────

/**
 * Convert LLM-produced operation descriptions into typed GraphSurgeryOp.
 */
function convertOperations(
  rawOps: RawOperation[],
  discoveryStart: number,
  graph: TaskGraphNode[],
): GraphSurgeryOp[] {
  const ops: GraphSurgeryOp[] = [];
  let insertCounter = discoveryStart;

  for (const raw of rawOps) {
    switch (raw.type) {
      case "insert": {
        const id = discoveryId(++insertCounter, raw.description ?? "synthesis");
        const node: TaskGraphNode = {
          task: createTask(id, raw.description ?? "Discovery task"),
          dependsOn: raw.dependsOn ?? [],
          phaseGroup: raw.phaseGroup,
        };
        ops.push({ op: "insert", node } satisfies GraphSurgeryInsert);
        break;
      }

      case "amend":
        if (raw.taskId) {
          ops.push({
            op: "amend",
            taskId: raw.taskId,
            description: raw.description ?? "",
            additionalContext: raw.additionalContext
              ? { synthesisNote: raw.additionalContext }
              : undefined,
          } satisfies GraphSurgeryAmend);
        }
        break;

      case "rework":
        if (raw.taskId) {
          ops.push({
            op: "rework",
            directive: {
              taskId: raw.taskId,
              reason: raw.reason ?? "Deep synthesis identified rework need",
              amendedDescription: raw.description ?? "",
              additionalContext: {},
              downstreamDependents: raw.dependsOn ?? [],
            },
          } satisfies GraphSurgeryRework);
        }
        break;

      case "reorder":
        if (raw.taskId && raw.dependsOn?.length) {
          for (const dep of raw.dependsOn) {
            ops.push({
              op: "reorder",
              taskId: raw.taskId,
              dependsOn: dep,
            } satisfies GraphSurgeryReorder);
          }
        }
        break;
    }
  }

  return ops;
}

// ─── LLM Output Shape ──────────────────────────────────────────

interface RawOperation {
  type: "insert" | "amend" | "rework" | "reorder";
  taskId?: string;
  description?: string;
  reason?: string;
  dependsOn?: string[];
  phaseGroup?: string;
  additionalContext?: string;
}

const DeepSynthesisSchema = z.object({
  proposals: z.array(z.object({
    reasoning: z.string(),
    operations: z.array(z.object({
      type: z.enum(["insert", "amend", "rework", "reorder"]),
      taskId: z.string().optional(),
      description: z.string().optional(),
      reason: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      phaseGroup: z.string().optional(),
      additionalContext: z.string().optional(),
    })),
    grounding: z.array(z.string()),
  })),
  reasoning: z.string(),
});
