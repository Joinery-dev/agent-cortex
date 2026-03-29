/**
 * Planner — project-level planning through two phases.
 *
 * Kernel component. Called by the project rhythm to produce:
 *   1. A manifested future (Phase A, via sensory cortex)
 *   2. A task graph (Phase B, via structured LLM backward reasoning)
 *
 * The Planner doesn't run rhythms itself. It creates tasks and
 * interprets results — the project rhythm orchestrates the actual
 * sensory cortex invocations.
 *
 * Phase A: Manifestation
 *   createManifestationTask() → Task for sensory cortex
 *   extractManifestedFuture() → parses sensory cortex result
 *
 * Phase B: Path Reasoning
 *   reasonBackward() → LLM call producing proposed tasks
 *   applyNecessityGates() → filters through Jensen's three gates
 *   buildGraph() → converts to TaskGraphNode[]
 */

import { z } from "zod";
import type { Task } from "../types/task.js";
import { createTask } from "../types/task.js";
import type { ProjectIntent, TasteProfile } from "../types/intent.js";
import type { TaskGraphNode, SensoryCortexResult } from "../types/brainstem.js";
import type {
  PlannerConfig,
  ManifestedFuture,
  ProposedTask,
  ProposedPhase,
  PathReasoningRaw,
  RejectedTask,
  PlannerResult,
  ReplanContext,
  ReplanResult,
  ShaelNode,
  HierarchicalPlanResult,
  DependencyWiringResult,
  AffinityGroup,
} from "../types/planner.js";
import { DEFAULT_PLANNER_CONFIG } from "../types/planner.js";
import type { PathReasoningInputs, ReplanReasoningInputs, ShaelDecompositionInputs } from "../llm/prompts.js";
import {
  pathReasoningSystem,
  pathReasoningUser,
  replanReasoningSystem,
  replanReasoningUser,
  shaelDecompositionSystem,
  shaelDecompositionUser,
} from "../llm/prompts.js";
import { GraphBuilder } from "./graph-builder.js";
import { callStructured } from "../llm/structured.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { computeCallCost } from "../types/cost.js";
import type { ProjectCostEstimate } from "../types/cost.js";
import type { CortexConfig } from "../types/orchestrator.js";

const log = createLogger("planner");

// ─── Zod schemas for Phase B ────────────────────────────────────

const ProposedPhaseSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  gateCondition: z.string(),
});

const ProposedTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()),
  phaseGroup: z.string(),
  necessity: z.string(),
  formJustification: z.string(),
  scopeJustification: z.string(),
});

const PathReasoningSchema = z.object({
  reasoning: z.string(),
  phases: z.array(ProposedPhaseSchema),
  tasks: z.array(ProposedTaskSchema),
});

// ─── Zod schemas for hierarchical Phase B.1 ─────────────────────

const ShaelNodeSchema = z.object({
  id: z.string(),
  description: z.string(),
  level: z.enum(["shael", "shana"]),
  phaseGroup: z.string(),
  parentId: z.string().nullable(),
  gateCondition: z.string(),
  necessity: z.string(),
  formJustification: z.string(),
  scopeJustification: z.string(),
});

const ShaelDecompositionSchema = z.object({
  reasoning: z.string(),
  phases: z.array(ProposedPhaseSchema),
  nodes: z.array(ShaelNodeSchema),
});

// ─── Planner ────────────────────────────────────────────────────

export class Planner {
  private config: PlannerConfig;
  private model: string;

  constructor(model: string, config?: Partial<PlannerConfig>) {
    this.model = model;
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
  }

  // ── Phase A: Manifestation ──────────────────────────────────

  /**
   * Create a task for Phase A. Run this through sensory cortex.
   *
   * The task description frames the work: senses will consult on
   * what the finished outcome must look like, and the motor cortex
   * will synthesize their perspectives into the manifested future.
   */
  createManifestationTask(intent: ProjectIntent): Task {
    const id = `plan-manifest-${newId()}`;

    return createTask(id, [
      `Manifest the completed outcome for this project.`,
      ``,
      `Project: ${intent.summary}`,
      `Vision: ${intent.vision}`,
      `Audience: ${intent.audience}`,
      ``,
      `Produce a CONCRETE VISION of the finished artifact. Not a plan.`,
      `Not a list of features. The actual finished thing — described in`,
      `enough detail that someone could evaluate whether a real artifact`,
      `matches this vision.`,
      ``,
      `For each quality dimension the senses care about, describe what`,
      `the finished artifact achieves. Be specific: what does the visual`,
      `language look like? What's the performance profile? What's the`,
      `user experience? What's the content strategy?`,
      ``,
      `This vision becomes the destination the system builds toward.`,
      `Every future task will be evaluated against it. Make it concrete`,
      `enough to reason backward from.`,
    ].join("\n"), {
      planningPhase: "manifestation",
      intentId: intent.id,
    });
  }

  /**
   * Extract the manifested future from a sensory cortex result.
   *
   * The work field contains the motor cortex's synthesis of the
   * senses' perspectives into a concrete vision.
   */
  extractManifestedFuture(
    result: SensoryCortexResult,
  ): ManifestedFuture {
    // Extract per-sense contributions from evaluations.
    // Each SenseEvaluation has an activationPath (sense > pathway > receptor),
    // a score, and an assessment. Group assessments by top-level sense.
    const senseContributions: Record<string, string> = {};
    for (const evaluation of result.evaluations) {
      // activationPath[0] is the top-level sense name
      const senseName = evaluation.activationPath[0] ?? evaluation.senseId;
      const existing = senseContributions[senseName];
      if (evaluation.assessment) {
        senseContributions[senseName] = existing
          ? `${existing} ${evaluation.assessment}`
          : evaluation.assessment;
      }
    }

    const future: ManifestedFuture = {
      vision: result.work,
      senseContributions,
      confidence: result.confidence,
      cycles: result.cycles,
    };

    emit("planner:manifestation-complete", {
      confidence: future.confidence,
      cycles: future.cycles,
      senseCount: Object.keys(senseContributions).length,
      visionLength: future.vision.length,
    });

    log.info("Manifested future extracted", {
      confidence: future.confidence,
      cycles: future.cycles,
      senses: Object.keys(senseContributions),
    });

    return future;
  }

  // ── Phase B: Path Reasoning ─────────────────────────────────

  /**
   * Reason backward from the manifested future to produce
   * a minimum task graph.
   *
   * This is a single LLM call — not a sensory cortex loop.
   * The LLM receives the manifested future, intent, taste,
   * and world model context, and produces a structured graph.
   * Necessity gates are applied after the LLM call.
   */
  async reasonBackward(
    future: ManifestedFuture,
    intent: ProjectIntent,
    taste: TasteProfile,
    maxims?: string[],
    capabilities?: string,
    neLevel?: number,
  ): Promise<PlannerResult> {
    emit("planner:path-reasoning-start", {
      intentId: intent.id,
      maximCount: maxims?.length ?? 0,
    });

    // Assemble inputs for the prompt
    const inputs: PathReasoningInputs = {
      manifestedFuture: future.vision,
      senseContributions: future.senseContributions,
      neLevel,
      intent: {
        summary: intent.summary,
        audience: intent.audience,
        successCriteria: intent.successCriteria,
        vision: intent.vision,
        constraints: intent.constraints,
      },
      taste: {
        visual: taste.visual,
        decisionStyle: taste.decisionStyle,
        patterns: taste.patterns,
      },
      maxims,
      capabilities,
      budget: intent.budget
        ? { total: intent.budget.total, enforcement: intent.budget.enforcement }
        : undefined,
    };

    const system = pathReasoningSystem();
    const user = pathReasoningUser(inputs);

    let raw: PathReasoningRaw;
    try {
      raw = await callStructured<PathReasoningRaw>(
        "planner",
        this.model,
        system,
        user,
        PathReasoningSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Path reasoning LLM call failed", { error: String(err) });
      throw new Error(`Planner path reasoning failed: ${String(err)}`);
    }

    log.info("Path reasoning complete", {
      phases: raw.phases.length,
      tasks: raw.tasks.length,
      reasoningLength: raw.reasoning.length,
    });

    // Apply necessity gates
    const { accepted, rejected } = this.applyNecessityGates(raw.tasks);

    // Enforce max tasks
    const clamped = accepted.slice(0, this.config.maxTasks);
    if (accepted.length > this.config.maxTasks) {
      log.warn("Task count clamped", {
        proposed: accepted.length,
        max: this.config.maxTasks,
        cut: accepted.length - this.config.maxTasks,
      });
    }

    // Build the graph
    const graph = this.buildGraph(clamped, raw.phases);

    const result: PlannerResult = {
      manifestedFuture: future,
      graph,
      rejected,
      reasoning: raw.reasoning,
      phases: raw.phases,
    };

    emit("planner:path-reasoning-complete", {
      phases: raw.phases.length,
      proposedTasks: raw.tasks.length,
      acceptedTasks: graph.length,
      rejectedTasks: rejected.length,
    });

    log.info("Planning complete", {
      phases: raw.phases.length,
      tasks: graph.length,
      rejected: rejected.length,
    });

    return result;
  }

  // ── Hierarchical Planning (Phase B evolution) ──────────────

  /**
   * Reason backward hierarchically: produce shaels (questions) instead
   * of flat tasks, then wire dependencies via Graph Builder (B.2).
   *
   * Pipeline:
   *   B.1: Shael decomposition (LLM) — backward reasoning → shael tree
   *   B.2: Dependency wiring (GraphBuilder.wire) — semantic map → algo → affinity
   *
   * The existing reasonBackward() is NOT modified. Both coexist.
   * The project rhythm calls this when config.hierarchicalPlanning is true.
   */
  async reasonBackwardHierarchical(
    future: ManifestedFuture,
    intent: ProjectIntent,
    taste: TasteProfile,
    maxims?: string[],
    capabilities?: string,
    neLevel?: number,
  ): Promise<HierarchicalPlanResult> {
    emit("planner:hierarchical-start", {
      intentId: intent.id,
      maximCount: maxims?.length ?? 0,
    });

    // ── B.1: Shael Decomposition ──────────────────────────────

    const inputs: ShaelDecompositionInputs = {
      manifestedFuture: future.vision,
      senseContributions: future.senseContributions,
      intent: {
        summary: intent.summary,
        audience: intent.audience,
        successCriteria: intent.successCriteria,
        vision: intent.vision,
        constraints: intent.constraints,
      },
      taste: {
        visual: taste.visual,
        decisionStyle: taste.decisionStyle,
        patterns: taste.patterns,
      },
      maxims,
      capabilities,
      budget: intent.budget
        ? { total: intent.budget.total, enforcement: intent.budget.enforcement }
        : undefined,
    };

    const system = shaelDecompositionSystem();
    const user = shaelDecompositionUser(inputs);

    let raw: { reasoning: string; phases: ProposedPhase[]; nodes: ShaelNode[] };
    try {
      raw = await callStructured(
        "planner",
        this.model,
        system,
        user,
        ShaelDecompositionSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Shael decomposition failed", { error: String(err) });
      throw new Error(`Planner shael decomposition failed: ${String(err)}`);
    }

    log.info("Shael decomposition complete", {
      phases: raw.phases.length,
      nodes: raw.nodes.length,
      shaels: raw.nodes.filter((n) => n.level === "shael").length,
      shana: raw.nodes.filter((n) => n.level === "shana").length,
    });

    // ── Necessity Gates ──────────────────────────────────────

    // ShaelNode has the same gate fields as ProposedTask — reuse the gate logic
    const asProposed: ProposedTask[] = raw.nodes.map((n) => ({
      id: n.id,
      description: n.description,
      dependsOn: [], // B.1 doesn't produce deps
      phaseGroup: n.phaseGroup,
      necessity: n.necessity,
      formJustification: n.formJustification,
      scopeJustification: n.scopeJustification,
    }));

    const { accepted, rejected } = this.applyNecessityGates(asProposed);
    const acceptedIds = new Set(accepted.map((t) => t.id));
    const acceptedShaels = raw.nodes.filter((n) => acceptedIds.has(n.id));

    // Enforce max tasks
    const clamped = acceptedShaels.slice(0, this.config.maxTasks);
    if (acceptedShaels.length > this.config.maxTasks) {
      log.warn("Shael count clamped", {
        proposed: acceptedShaels.length,
        max: this.config.maxTasks,
        cut: acceptedShaels.length - this.config.maxTasks,
      });
    }

    // ── B.2: Dependency Wiring ───────────────────────────────

    const graphBuilderModel = this.config.graphBuilderModel ?? this.model;
    const graphBuilder = new GraphBuilder(graphBuilderModel);
    const wiring = await graphBuilder.wire(clamped, neLevel);

    // ── Assemble result ──────────────────────────────────────

    const result: HierarchicalPlanResult = {
      manifestedFuture: future,
      shaels: clamped,
      wiring,
      rejected,
      reasoning: raw.reasoning,
      phases: raw.phases,
    };

    emit("planner:hierarchical-complete", {
      phases: raw.phases.length,
      totalNodes: raw.nodes.length,
      acceptedShaels: clamped.length,
      rejectedNodes: rejected.length,
      edges: wiring.dependencies.length,
      affinityGroups: wiring.affinityGroups.length,
    });

    log.info("Hierarchical planning complete", {
      phases: raw.phases.length,
      shaels: clamped.length,
      rejected: rejected.length,
      edges: wiring.dependencies.length,
      affinityGroups: wiring.affinityGroups.length,
    });

    return result;
  }

  // ── Build flat graph from shana (for JIT per-shael planning) ──

  /**
   * Convert shana (leaf tasks from JIT per-shael planning) into
   * flat TaskGraphNode[] for the execution layer.
   *
   * Uses wiring.dependencies for dependsOn (not LLM suggestions).
   * Sets affinityGroupId from wiring's affinity groups.
   * Same ID-mapping pattern as buildGraph().
   */
  buildGraphFromShana(
    shana: ShaelNode[],
    wiring: DependencyWiringResult,
    phases: ProposedPhase[],
  ): TaskGraphNode[] {
    // Map temporary IDs to real IDs
    const idMap = new Map<string, string>();
    for (const node of shana) {
      idMap.set(node.id, `task-${newId()}`);
    }

    // Build affinity lookup: node ID → affinity group name
    const affinityLookup = new Map<string, string>();
    for (const group of wiring.affinityGroups) {
      for (const shaelId of group.shaelIds) {
        affinityLookup.set(shaelId, group.name);
      }
    }

    // Build dependency lookup from wiring
    const depsFor = new Map<string, string[]>();
    for (const dep of wiring.dependencies) {
      const deps = depsFor.get(dep.from) ?? [];
      deps.push(dep.to);
      depsFor.set(dep.from, deps);
    }

    const nodes: TaskGraphNode[] = [];

    for (const node of shana) {
      const realId = idMap.get(node.id)!;

      // Resolve dependencies through ID map
      const rawDeps = depsFor.get(node.id) ?? [];
      const resolvedDeps = rawDeps
        .map((dep) => idMap.get(dep))
        .filter((id): id is string => id !== undefined);

      nodes.push({
        task: createTask(realId, node.description, {
          phaseGroup: node.phaseGroup,
          necessity: node.necessity,
          plannedById: node.id,
        }),
        dependsOn: resolvedDeps,
        phaseGroup: node.phaseGroup,
        affinityGroupId: affinityLookup.get(node.id),
      });
    }

    return nodes;
  }

  // ── Replan ─────────────────────────────────────────────────

  /**
   * Replan mid-project after drift detection.
   *
   * Same structure as reasonBackward() but with replan-specific context:
   * what's already done, what failed, why we're replanning. Reasons
   * backward from the manifested future to the minimum REMAINING path.
   */
  async replan(
    context: ReplanContext,
    intent: ProjectIntent,
    taste: TasteProfile,
    maxims?: string[],
    capabilities?: string,
    neLevel?: number,
  ): Promise<ReplanResult> {
    emit("planner:replan-start", {
      intentId: intent.id,
      completedCount: context.completedTasks.length,
      escalatedCount: context.escalatedTasks.length,
      driftSummary: context.driftSummary,
    });

    // Assemble inputs for the replan prompt
    const inputs: ReplanReasoningInputs = {
      manifestedFuture: context.manifestedFuture,
      senseContributions: {},  // Not available during replan — senses already consulted in Phase A
      neLevel,
      intent: {
        summary: intent.summary,
        audience: intent.audience,
        successCriteria: intent.successCriteria,
        vision: intent.vision,
        constraints: intent.constraints,
      },
      taste: {
        visual: taste.visual,
        decisionStyle: taste.decisionStyle,
        patterns: taste.patterns,
      },
      maxims,
      capabilities,
      completedTasks: context.completedTasks,
      escalatedTasks: context.escalatedTasks,
      driftSummary: context.driftSummary,
      driftAnalysis: context.driftAnalysis
        ? {
            intentAlignment: context.driftAnalysis.intentAlignment.description,
            recommendations: context.driftAnalysis.recommendations,
          }
        : undefined,
      diagnosticDirective: context.diagnosticDirective,
    };

    const system = replanReasoningSystem();
    const user = replanReasoningUser(inputs);

    let raw: PathReasoningRaw;
    try {
      raw = await callStructured<PathReasoningRaw>(
        "planner",
        this.model,
        system,
        user,
        PathReasoningSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Replan LLM call failed", { error: String(err) });
      throw new Error(`Planner replan failed: ${String(err)}`);
    }

    log.info("Replan reasoning complete", {
      phases: raw.phases.length,
      tasks: raw.tasks.length,
      reasoningLength: raw.reasoning.length,
    });

    // Apply necessity gates
    const { accepted, rejected } = this.applyNecessityGates(raw.tasks);

    // Enforce max tasks
    const clamped = accepted.slice(0, this.config.maxTasks);
    if (accepted.length > this.config.maxTasks) {
      log.warn("Replan task count clamped", {
        proposed: accepted.length,
        max: this.config.maxTasks,
        cut: accepted.length - this.config.maxTasks,
      });
    }

    // Build the graph — pass completed IDs so deps on completed tasks resolve
    const graph = this.buildGraph(clamped, raw.phases, context.completedIds);

    const result: ReplanResult = {
      graph,
      rejected,
      reasoning: raw.reasoning,
      phases: raw.phases,
    };

    emit("planner:replan-complete", {
      phases: raw.phases.length,
      proposedTasks: raw.tasks.length,
      acceptedTasks: graph.length,
      rejectedTasks: rejected.length,
    });

    log.info("Replan complete", {
      phases: raw.phases.length,
      tasks: graph.length,
      rejected: rejected.length,
    });

    return result;
  }

  // ── Necessity Gates ─────────────────────────────────────────

  /**
   * Jensen's three gates. Each proposed task must justify:
   *   1. Its existence (what breaks without it?)
   *   2. Its form (why this, not simpler?)
   *   3. Its scope (why this much, not less?)
   *
   * These are structural checks, not LLM calls. If a task's
   * justification is empty or trivially weak, it gets cut.
   * The LLM already applied these gates during reasoning —
   * this is the procedural safety net.
   */
  applyNecessityGates(
    tasks: ProposedTask[],
  ): { accepted: ProposedTask[]; rejected: RejectedTask[] } {
    const accepted: ProposedTask[] = [];
    const rejected: RejectedTask[] = [];

    for (const task of tasks) {
      // Gate 1: Existence — must have a non-trivial necessity.
      if (!task.necessity || task.necessity.trim().length < 25) {
        rejected.push({
          task,
          gate: "existence",
          reason: "No substantive justification for why this task needs to exist.",
        });
        continue;
      }

      // Gate 2: Form — must justify why this specific form.
      if (!task.formJustification || task.formJustification.trim().length < 25) {
        rejected.push({
          task,
          gate: "form",
          reason: "No justification for why this task needs to be this form rather than simpler.",
        });
        continue;
      }

      // Gate 3: Scope — must justify why this scope.
      if (!task.scopeJustification || task.scopeJustification.trim().length < 25) {
        rejected.push({
          task,
          gate: "scope",
          reason: "No justification for why this task needs this scope rather than smaller.",
        });
        continue;
      }

      accepted.push(task);
    }

    if (rejected.length > 0) {
      log.info("Necessity gates rejected tasks", {
        rejected: rejected.length,
        gates: rejected.map((r) => r.gate),
      });
    }

    return { accepted, rejected };
  }

  // ── Graph Construction ──────────────────────────────────────

  /**
   * Convert accepted proposed tasks into TaskGraphNode[].
   *
   * Maps the LLM's temporary IDs to real UUIDs. Resolves
   * dependency references. Adds implicit cross-phase dependencies.
   */
  buildGraph(
    tasks: ProposedTask[],
    phases: ProposedPhase[],
    knownCompletedIds?: Set<string>,
  ): TaskGraphNode[] {
    // Map temporary IDs to real IDs
    const idMap = new Map<string, string>();
    for (const task of tasks) {
      idMap.set(task.id, `task-${newId()}`);
    }

    // Pre-seed idMap with identity mappings for completed IDs so that
    // new tasks can reference completed tasks in their dependsOn arrays.
    if (knownCompletedIds) {
      for (const id of knownCompletedIds) {
        idMap.set(id, id);
      }
    }

    // Determine phase ordering for implicit cross-phase deps
    const phaseOrder = new Map<string, number>();
    for (let i = 0; i < phases.length; i++) {
      phaseOrder.set(phases[i].name, i);
    }

    // Find the last task IDs in each phase (for cross-phase deps)
    const lastTasksPerPhase = new Map<number, string[]>();
    for (const task of tasks) {
      const order = phaseOrder.get(task.phaseGroup) ?? 0;
      if (!lastTasksPerPhase.has(order)) {
        lastTasksPerPhase.set(order, []);
      }
      lastTasksPerPhase.get(order)!.push(task.id);
    }

    const nodes: TaskGraphNode[] = [];

    for (const proposed of tasks) {
      const realId = idMap.get(proposed.id)!;

      // Resolve explicit dependencies
      const explicitDeps = proposed.dependsOn
        .map((dep) => idMap.get(dep))
        .filter((id): id is string => id !== undefined);

      // Add implicit cross-phase dependencies:
      // If this task is in phase N and has no explicit deps on phase N-1,
      // depend on ALL tasks in phase N-1.
      const thisPhaseOrder = phaseOrder.get(proposed.phaseGroup) ?? 0;
      const implicitDeps: string[] = [];

      if (thisPhaseOrder > 0) {
        const prevPhaseTasks = lastTasksPerPhase.get(thisPhaseOrder - 1) ?? [];
        for (const prevTaskId of prevPhaseTasks) {
          const prevRealId = idMap.get(prevTaskId);
          if (prevRealId && !explicitDeps.includes(prevRealId)) {
            implicitDeps.push(prevRealId);
          }
        }
      }

      const allDeps = [...explicitDeps, ...implicitDeps];

      // Filter out completed tasks from dependencies — they're already done,
      // so new tasks don't need to wait on them.
      const liveDeps = allDeps.filter(id => !knownCompletedIds?.has(id));

      nodes.push({
        task: createTask(realId, proposed.description, {
          phaseGroup: proposed.phaseGroup,
          necessity: proposed.necessity,
          plannedById: proposed.id,
        }),
        dependsOn: liveDeps,
        phaseGroup: proposed.phaseGroup,
      });
    }

    return nodes;
  }

  // ── Cost Estimation ──────────────────────────────────────────

  /**
   * Estimate the total cost of a project after planning.
   *
   * Each task's cost = estimatedCycles × costPerCycle.
   * Cycles from Cerebellum prediction (if available) or worst-case
   * default (maxCycles × maxOuterCycles from config).
   * CostPerCycle from model pricing for the configured models.
   */
  estimateProjectCost(
    graph: TaskGraphNode[],
    cortexConfig: CortexConfig,
    planningCostActual: number,
    cerebellumPredictedCycles?: Map<string, number>,
  ): ProjectCostEstimate {
    const worstCaseCycles = cortexConfig.maxCycles * cortexConfig.maxOuterCycles;

    // Estimate cost of one cycle: consultation + motor + evaluation
    const cycleModels = [
      cortexConfig.models.consultation,
      cortexConfig.models.motorCortex,
      cortexConfig.models.evaluation,
    ];

    // Rough estimate: 5K input + 2K output per call
    const estimatedInputPerCall = 5000;
    const estimatedOutputPerCall = 2000;

    const costPerCycle = cycleModels.reduce((sum, model) => {
      const tier = model.includes("haiku") ? "haiku" : model.includes("opus") ? "opus" : "sonnet";
      return sum + computeCallCost(tier, estimatedInputPerCall, estimatedOutputPerCall);
    }, 0);

    const perTaskEstimates = new Map<string, number>();
    let totalEstimate = planningCostActual;

    for (const node of graph) {
      const cycles = cerebellumPredictedCycles?.get(node.task.id) ?? worstCaseCycles;
      const taskCost = cycles * costPerCycle;
      perTaskEstimates.set(node.task.id, taskCost);
      totalEstimate += taskCost;
    }

    const hasPredictions = cerebellumPredictedCycles && cerebellumPredictedCycles.size > 0;

    return {
      totalEstimate,
      perTaskEstimates,
      assumptions: `${graph.length} tasks × ${hasPredictions ? "Cerebellum-predicted" : worstCaseCycles + " worst-case"} cycles × $${costPerCycle.toFixed(4)}/cycle (${cortexConfig.models.consultation.includes("haiku") ? "haiku" : cortexConfig.models.consultation.includes("opus") ? "opus" : "sonnet"}-class). Planning cost: $${planningCostActual.toFixed(4)}.`,
      planningCostActual,
      confidence: hasPredictions ? 0.7 : 0.3,
    };
  }
}
