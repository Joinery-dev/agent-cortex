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
  HierarchyAssessment,
  PlannedPhase,
  PhasePlanResult,
  GenerativeCompletionResult,
  PfcReviewResult,
  PlanWarning,
  DependencyPatch,
} from "../types/planner.js";
import { DEFAULT_PLANNER_CONFIG } from "../types/planner.js";
import type { PathReasoningInputs, ReplanReasoningInputs, ShaelDecompositionInputs, GenerativeCompletionInputs, PfcReviewInputs } from "../llm/prompts.js";
import {
  pathReasoningSystem,
  pathReasoningUser,
  replanReasoningSystem,
  replanReasoningUser,
  shaelDecompositionSystem,
  shaelDecompositionUser,
  generativeCompletionSystem,
  generativeCompletionUser,
  pfcReviewSystem,
  pfcReviewUser,
} from "../llm/prompts.js";
import { GraphBuilder } from "./graph-builder.js";
import { callStructured } from "../llm/structured.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { computeCallCost } from "../types/cost.js";
import type { ProjectCostEstimate } from "../types/cost.js";
import type { CortexConfig } from "../types/orchestrator.js";
import { DEFAULT_WORLDVIEW } from "../types/worldview.js";
import type { Worldview } from "../types/worldview.js";
// getFrame import removed — no longer needed after Phase A moved to synthesis loop

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

/**
 * Build the decomposition node schema with level values from the worldview vocabulary.
 * The level enum uses the worldview's actual terms (e.g. "block"/"cut" for sculptor,
 * "set"/"riff" for groove) so the LLM thinks and outputs in the worldview's language.
 */
function buildDecompositionSchema(worldview?: Worldview) {
  const wv = worldview ?? DEFAULT_WORLDVIEW;
  const topLevel = wv.vocabulary.topUnit.singular;
  const leafLevel = wv.vocabulary.leafUnit.singular;

  const nodeSchema = z.object({
    id: z.string(),
    description: z.string(),
    level: z.enum([topLevel, leafLevel] as [string, string]),
    phaseGroup: z.string(),
    parentId: z.string().nullable(),
    gateCondition: z.string(),
    necessity: z.string(),
    formJustification: z.string(),
    scopeJustification: z.string(),
  });

  const decompositionSchema = z.object({
    reasoning: z.string(),
    phases: z.array(ProposedPhaseSchema),
    nodes: z.array(nodeSchema),
  });

  return { nodeSchema, decompositionSchema };
}

// ─── Planner ────────────────────────────────────────────────────

export class Planner {
  private config: PlannerConfig;
  private model: string;
  private worldview?: Worldview;

  constructor(model: string, config?: Partial<PlannerConfig>, worldview?: Worldview) {
    this.model = model;
    this.config = { ...DEFAULT_PLANNER_CONFIG, ...config };
    this.worldview = worldview;
  }

  /** Create a GraphBuilder that inherits this Planner's worldview. */
  createGraphBuilder(model?: string, config?: Partial<import("./graph-builder.js").GraphBuilderConfig>): GraphBuilder {
    return new GraphBuilder(model ?? this.model, config, this.worldview);
  }

  // ── Phase A: Manifestation ──────────────────────────────────

  // Phase A (createManifestationTask, extractManifestedFuture) removed —
  // replaced by manifestation synthesis loop in project.ts
  // (manifestSenses → synthesizeVision → evaluateVision)

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

    const system = pathReasoningSystem(this.worldview);
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
   * The existing reasonBackward() is still used for per-shael JIT planning.
   * The project rhythm calls this for project-level planning.
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

    const system = shaelDecompositionSystem(this.worldview);
    const user = shaelDecompositionUser(inputs, this.worldview);

    const { decompositionSchema } = buildDecompositionSchema(this.worldview);
    let raw: { reasoning: string; phases: ProposedPhase[]; nodes: ShaelNode[] };
    try {
      raw = await callStructured(
        "planner",
        this.model,
        system,
        user,
        decompositionSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Decomposition failed", { error: String(err) });
      throw new Error(`Planner decomposition failed: ${String(err)}`);
    }

    const wv = this.worldview ?? DEFAULT_WORLDVIEW;
    const topLevel = wv.vocabulary.topUnit.singular;
    const leafLevel = wv.vocabulary.leafUnit.singular;

    log.info("Decomposition complete", {
      phases: raw.phases.length,
      nodes: raw.nodes.length,
      topNodes: raw.nodes.filter((n) => n.level === topLevel).length,
      leafNodes: raw.nodes.filter((n) => n.level === leafLevel).length,
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
    const graphBuilder = this.createGraphBuilder(graphBuilderModel);
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

  // ── Hierarchical Depth Assessment ──────────────────────────────

  /**
   * Assess whether the hierarchy depth of a shael decomposition is appropriate.
   *
   * Evaluates coherence pressure: if a shael produced too many shana (>= config
   * threshold), it should have been decomposed into sub-shaels first. Necessity
   * gates apply to the hierarchy structure itself — does this level of nesting
   * need to exist?
   *
   * Called after B.1 decomposition to decide whether to re-decompose
   * overloaded shaels before proceeding to B.2 wiring.
   */
  assessHierarchyDepth(
    shaels: ShaelNode[],
    coherenceCeiling?: number,
  ): HierarchyAssessment {
    const leafThreshold = this.config.jitWiringThreshold ?? 5;
    const overloadThreshold = leafThreshold * 3;
    const wv = this.worldview ?? DEFAULT_WORLDVIEW;
    const leafLevel = wv.vocabulary.leafUnit.singular;

    // Group leaf nodes by parent
    const leafPerParent = new Map<string, number>();
    for (const node of shaels) {
      if (node.level === leafLevel && node.parentId) {
        leafPerParent.set(node.parentId, (leafPerParent.get(node.parentId) ?? 0) + 1);
      }
    }

    // Find overloaded parent nodes
    const overloadedShaels: HierarchyAssessment["overloadedShaels"] = [];
    for (const [parentId, count] of leafPerParent) {
      if (count >= overloadThreshold) {
        const recommendedSubShaels = Math.ceil(count / leafThreshold);
        overloadedShaels.push({
          shaelId: parentId,
          shanaCount: count,
          recommendedSubShaels,
          reason: `${count} leaf nodes exceeds coherence threshold (${overloadThreshold}). ` +
            `Decompose into ${recommendedSubShaels} sub-nodes first.`,
        });
      }
    }

    // Compute current max depth
    const depthOf = (id: string): number => {
      const node = shaels.find((n) => n.id === id);
      if (!node?.parentId) return 0;
      return 1 + depthOf(node.parentId);
    };
    const currentDepth = shaels.reduce((max, n) => Math.max(max, depthOf(n.id)), 0);

    const assessment: HierarchyAssessment = {
      appropriate: overloadedShaels.length === 0 && currentDepth <= this.config.maxPhaseDepth,
      overloadedShaels,
      currentDepth,
      maxAllowedDepth: this.config.maxPhaseDepth,
      coherenceCeiling,
    };

    if (!assessment.appropriate) {
      log.info("Hierarchy depth assessment: adjustment needed", {
        overloaded: overloadedShaels.length,
        currentDepth,
        maxAllowed: this.config.maxPhaseDepth,
      });
    }

    return assessment;
  }

  // ── Per-Shael Just-in-Time Planning ───────────────────────────

  /**
   * Plan a single shael just-in-time: decompose into shana and wire dependencies.
   *
   * Runs the per-shael planning cycle from the design doc (Section 6):
   *   B.1': Shael → shana decomposition (via reasonBackward at shael scope)
   *   B.2': Dependency wiring (if ≥ jitWiringThreshold shana or NE ≥ jitWiringNEThreshold)
   *
   * Phase A' (shael manifestation) and B.3' (PFC review) are handled by the
   * project rhythm — this method covers the decomposition and wiring steps.
   */
  async planPhase(
    phase: PlannedPhase,
    intent: ProjectIntent,
    taste: TasteProfile,
    neLevel?: number,
  ): Promise<PhasePlanResult> {
    emit("planner:plan-phase-start", {
      shaelId: phase.shael.id,
      description: phase.shael.description,
      priorContextCount: phase.priorContext.length,
    });

    // ── B.1': Decompose shael into shana ─────────────────────

    // Build context from prior shaels for grounded planning
    const priorSummary = phase.priorContext
      .map((p) => `- ${p.description}: ${p.outcome}`)
      .join("\n");

    const inputs: ShaelDecompositionInputs = {
      manifestedFuture: phase.manifestedFuture.vision,
      senseContributions: phase.manifestedFuture.senseContributions,
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
      capabilities: priorSummary || undefined,
      budget: intent.budget
        ? { total: intent.budget.total, enforcement: intent.budget.enforcement }
        : undefined,
    };

    const system = shaelDecompositionSystem(this.worldview);
    const user = shaelDecompositionUser(inputs, this.worldview);

    const { decompositionSchema } = buildDecompositionSchema(this.worldview);
    const wv = this.worldview ?? DEFAULT_WORLDVIEW;
    let raw: { reasoning: string; phases: ProposedPhase[]; nodes: ShaelNode[] };
    try {
      raw = await callStructured(
        "planner",
        this.model,
        system,
        user,
        decompositionSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Phase planning decomposition failed", {
        shaelId: phase.shael.id,
        error: String(err),
      });
      throw new Error(`planPhase decomposition failed for ${phase.shael.id}: ${String(err)}`);
    }

    // Filter to leaf nodes only (JIT planning produces leaf tasks, not sub-nodes)
    const leafLevel = wv.vocabulary.leafUnit.singular;
    const shana = raw.nodes.filter((n) => n.level === leafLevel);

    // ── Necessity Gates ──────────────────────────────────────
    const asProposed: ProposedTask[] = shana.map((n) => ({
      id: n.id,
      description: n.description,
      dependsOn: [],
      phaseGroup: n.phaseGroup,
      necessity: n.necessity,
      formJustification: n.formJustification,
      scopeJustification: n.scopeJustification,
    }));

    const { accepted, rejected } = this.applyNecessityGates(asProposed);
    const acceptedIds = new Set(accepted.map((t) => t.id));
    const acceptedShana = shana.filter((n) => acceptedIds.has(n.id));

    // ── B.2': Dependency Wiring (conditional) ────────────────
    const wiringThreshold = this.config.jitWiringThreshold ?? 5;
    const neThreshold = this.config.jitWiringNEThreshold ?? 0.5;
    const shouldWire = acceptedShana.length >= wiringThreshold || (neLevel ?? 0) >= neThreshold;

    let wiring: DependencyWiringResult | null = null;
    if (shouldWire) {
      const graphBuilderModel = this.config.graphBuilderModel ?? this.model;
      const graphBuilder = this.createGraphBuilder(graphBuilderModel);
      wiring = await graphBuilder.wire(acceptedShana, neLevel);
    }

    const result: PhasePlanResult = {
      shaelId: phase.shael.id,
      shana: acceptedShana,
      wiring,
      rejected,
      reasoning: raw.reasoning,
    };

    emit("planner:plan-phase-complete", {
      shaelId: phase.shael.id,
      shanaCount: acceptedShana.length,
      rejectedCount: rejected.length,
      wiringTriggered: shouldWire,
    });

    log.info("Phase planning complete", {
      shaelId: phase.shael.id,
      shana: acceptedShana.length,
      rejected: rejected.length,
      wired: shouldWire,
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
      for (const shaelId of group.nodeIds) {
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

    const system = replanReasoningSystem(this.worldview);
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

  // ── PFC Review (Phase B.3) ──────────────────────────────────

  /**
   * Validate the plan's structural integrity against the manifested future.
   *
   * Two tracks:
   *   Mechanical (always): gap detection from unresolved consumes, orphan detection
   *   LLM (NE ≥ 0.7): semantic gap/redundancy/affinity/correction validation + patches
   *
   * Applies patches to wiring and re-sorts. Returns the validated plan.
   */
  async reviewPlan(
    shaels: ShaelNode[],
    wiring: DependencyWiringResult,
    future: ManifestedFuture,
    intent: ProjectIntent,
    neLevel: number,
  ): Promise<PfcReviewResult> {
    emit("planner:pfc-review-start", { shaelCount: shaels.length, neLevel });

    const warnings: PlanWarning[] = [];
    let patches: DependencyPatch[] = [];

    // ── Mechanical checks (always run) ─────────────────────────

    // 1. Gap detection: unresolved consumes from semantic map
    const allProvided = new Set<string>();
    for (const entry of wiring.semanticMap) {
      for (const token of entry.provides) {
        allProvided.add(token.capability);
      }
    }

    const unresolvedConsumes: Array<{ nodeId: string; capability: string }> = [];
    for (const entry of wiring.semanticMap) {
      for (const token of entry.consumes) {
        if (!allProvided.has(token.capability)) {
          unresolvedConsumes.push({ nodeId: entry.id, capability: token.capability });
        }
      }
    }

    if (unresolvedConsumes.length > 0) {
      // Group by capability for clearer warnings
      const byCap = new Map<string, string[]>();
      for (const u of unresolvedConsumes) {
        const nodes = byCap.get(u.capability) ?? [];
        nodes.push(u.nodeId);
        byCap.set(u.capability, nodes);
      }

      for (const [capability, nodeIds] of byCap) {
        warnings.push({
          kind: "gap",
          severity: "warning",
          description: `Capability "${capability}" is consumed but no node provides it. Node(s) ${nodeIds.join(", ")} may be blocked.`,
          affectedNodeIds: nodeIds,
        });
      }
    }

    // 2. Orphan detection: nodes with no deps and no dependents
    const shaelIds = new Set(shaels.map((s) => s.id));
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const dep of wiring.dependencies) {
      if (shaelIds.has(dep.from)) hasOutgoing.add(dep.from);
      if (shaelIds.has(dep.to)) hasIncoming.add(dep.to);
    }

    // Orphans = nodes that neither depend on anything nor are depended upon
    // (only flag if there are 2+ nodes — a single-node plan is fine)
    if (shaels.length > 1) {
      for (const shael of shaels) {
        if (!hasIncoming.has(shael.id) && !hasOutgoing.has(shael.id)) {
          warnings.push({
            kind: "gap",
            severity: "info",
            description: `Node "${shael.id}" is isolated — no dependencies in or out. May indicate a missing connection.`,
            affectedNodeIds: [shael.id],
          });
        }
      }
    }

    log.info("Mechanical review complete", {
      unresolvedConsumes: unresolvedConsumes.length,
      warningsFromMechanical: warnings.length,
    });

    // ── LLM review (NE ≥ 0.7 only) ────────────────────────────

    const thoroughReview = neLevel >= 0.7;

    if (thoroughReview) {
      log.info("Running thorough PFC review (LLM)", { neLevel });

      const inputs: PfcReviewInputs = {
        manifestedFuture: future.vision,
        senseContributions: future.senseContributions,
        nodes: shaels.map((s) => ({
          id: s.id,
          description: s.description,
          level: s.level,
          phaseGroup: s.phaseGroup,
          gateCondition: s.gateCondition,
        })),
        semanticMap: wiring.semanticMap,
        dependencies: wiring.dependencies,
        affinityGroups: wiring.affinityGroups,
        corrections: wiring.corrections,
        unresolvedConsumes,
      };

      const PlanWarningSchema = z.object({
        kind: z.enum(["gap", "redundancy", "affinity", "correction"]),
        severity: z.enum(["info", "warning", "critical"]),
        description: z.string(),
        affectedNodeIds: z.array(z.string()),
      });

      const DependencyPatchSchema = z.object({
        action: z.enum(["add", "remove"]),
        from: z.string(),
        to: z.string(),
        reason: z.string(),
      });

      const PfcReviewSchema = z.object({
        warnings: z.array(PlanWarningSchema),
        patches: z.array(DependencyPatchSchema),
      });

      try {
        const system = pfcReviewSystem(this.worldview);
        const user = pfcReviewUser(inputs);

        const raw = await callStructured<{
          warnings: PlanWarning[];
          patches: DependencyPatch[];
        }>(
          "planner",
          this.model,
          system,
          user,
          PfcReviewSchema,
          this.config.maxTokens,
        );

        // Merge LLM warnings with mechanical warnings (dedup by description)
        const existingDescs = new Set(warnings.map((w) => w.description));
        for (const w of raw.warnings) {
          if (!existingDescs.has(w.description)) {
            warnings.push(w);
          }
        }

        // Validate patches reference real node IDs
        patches = raw.patches.filter((p) => {
          const fromExists = shaelIds.has(p.from);
          const toExists = shaelIds.has(p.to);
          if (!fromExists || !toExists) {
            log.warn("Discarding patch with unknown node ID", {
              from: p.from,
              to: p.to,
              fromExists,
              toExists,
            });
          }
          return fromExists && toExists;
        });

        log.info("LLM review complete", {
          llmWarnings: raw.warnings.length,
          llmPatches: raw.patches.length,
          validPatches: patches.length,
        });
      } catch (err) {
        // Non-fatal — mechanical checks already ran. Log and continue.
        log.warn("PFC review LLM call failed — continuing with mechanical results", {
          error: String(err),
        });
      }
    }

    // ── Apply patches to wiring ────────────────────────────────

    let reviewedWiring = wiring;

    if (patches.length > 0) {
      // Start from existing deps
      let patchedDeps = [...wiring.dependencies];

      for (const patch of patches) {
        if (patch.action === "add") {
          // Only add if not already present
          const exists = patchedDeps.some(
            (d) => d.from === patch.from && d.to === patch.to,
          );
          if (!exists) {
            patchedDeps.push({
              from: patch.from,
              to: patch.to,
              source: "correction" as const,
              reason: `[B.3 patch] ${patch.reason}`,
            });
          }
        } else {
          // Remove matching edge
          patchedDeps = patchedDeps.filter(
            (d) => !(d.from === patch.from && d.to === patch.to),
          );
        }
      }

      // Re-sort topologically with patched deps
      const graphBuilder = this.createGraphBuilder();
      const nodeIds = shaels.map((s) => s.id);
      const topologicalOrder = graphBuilder.topologicalSort(nodeIds, patchedDeps);

      reviewedWiring = {
        ...wiring,
        dependencies: patchedDeps,
        topologicalOrder,
      };

      log.info("Patches applied to wiring", {
        patchCount: patches.length,
        depsBefore: wiring.dependencies.length,
        depsAfter: patchedDeps.length,
      });
    }

    const result: PfcReviewResult = {
      warnings,
      patches,
      shaels, // Unchanged — redundancy detection warns but doesn't auto-merge
      wiring: reviewedWiring,
      thoroughReview,
    };

    emit("planner:pfc-review-complete", {
      warningCount: warnings.length,
      criticalCount: warnings.filter((w) => w.severity === "critical").length,
      patchCount: patches.length,
      thoroughReview,
    });

    log.info("PFC review complete", {
      warnings: warnings.length,
      critical: warnings.filter((w) => w.severity === "critical").length,
      patches: patches.length,
      thoroughReview,
    });

    return result;
  }

  // ── Generative Completion ───────────────────────────────────

  /**
   * After shalem: "What questions couldn't have been asked before?"
   *
   * A single LLM call that receives the manifested future, what was
   * actually built (retrospective + completed tasks), and what the
   * system learned (world model maxims). Produces generative questions
   * that surface to the question-asker as proposals.
   */
  async generateCompletionQuestions(
    future: ManifestedFuture,
    intentSummary: string,
    completedTasks: Array<{ description: string; work?: string }>,
    retrospective?: string,
    maxims?: string[],
  ): Promise<GenerativeCompletionResult> {
    emit("planner:generative-start", {
      completedTasks: completedTasks.length,
      maximCount: maxims?.length ?? 0,
    });

    const inputs: GenerativeCompletionInputs = {
      manifestedFuture: future.vision,
      senseContributions: future.senseContributions,
      retrospective,
      completedTasks,
      maxims,
      intentSummary,
    };

    const system = generativeCompletionSystem(this.worldview);
    const user = generativeCompletionUser(inputs);

    const GenerativeQuestionSchema = z.object({
      question: z.string(),
      kind: z.enum(["extension", "revision"]),
      emergenceReason: z.string(),
      context: z.string(),
    });

    const GenerativeCompletionSchema = z.object({
      reasoning: z.string(),
      questions: z.array(GenerativeQuestionSchema),
    });

    let raw: { reasoning: string; questions: Array<{ question: string; kind: "extension" | "revision"; emergenceReason: string; context: string }> };
    try {
      raw = await callStructured(
        "planner",
        this.model,
        system,
        user,
        GenerativeCompletionSchema,
        this.config.maxTokens,
      );
    } catch (err) {
      log.error("Generative completion LLM call failed", { error: String(err) });
      // Non-fatal — return empty questions rather than failing the project
      return { questions: [], reasoning: `Generative completion failed: ${String(err)}` };
    }

    const result: GenerativeCompletionResult = {
      questions: raw.questions,
      reasoning: raw.reasoning,
    };

    emit("planner:generative-complete", {
      questionCount: result.questions.length,
      extensions: result.questions.filter((q) => q.kind === "extension").length,
      revisions: result.questions.filter((q) => q.kind === "revision").length,
    });

    log.info("Generative completion", {
      questions: result.questions.length,
      extensions: result.questions.filter((q) => q.kind === "extension").length,
      revisions: result.questions.filter((q) => q.kind === "revision").length,
    });

    return result;
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
