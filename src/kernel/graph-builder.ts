/**
 * Graph Builder — Phase B.2 dependency wiring pipeline.
 *
 * Three steps:
 *   Step 1: Semantic Mapping (LLM) — capability tokens per node
 *   Step 2: Algorithmic Dependency Derivation (code) — provides→consumes matching
 *   Step 3: Affinity Analysis + Dependency Correction (LLM) — co-design risks, dep fixes
 *
 * The split is principled:
 *   - Step 1: LLM identifies what each node provides/consumes (semantic)
 *   - Step 2: Algorithm mechanically matches tokens (deterministic, provably correct)
 *   - Step 3: LLM fixes what algorithms can't — cycles from bidirectional tokens,
 *     missing composition edges, semantic direction inversions, affinity groups
 *
 * Experimentally validated: algorithmic deps match LLM-wired deps exactly when
 * tokens are well-assigned. Remaining errors are all semantic (Step 3's domain).
 */

import { z } from "zod";
import type {
  ShaelNode,
  SemanticMapEntry,
  CapabilityToken,
  AffinityGroup,
  DepCorrection,
  DependencyWiringResult,
} from "../types/planner.js";
import {
  semanticMappingSystem,
  semanticMappingUser,
  semanticMappingCorrectionUser,
  affinityAnalysisSystem,
  affinityAnalysisUser,
} from "../llm/prompts.js";
import type { SemanticMappingInputs, AffinityAnalysisInputs } from "../llm/prompts.js";
import { callStructured } from "../llm/structured.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import type { Worldview } from "../types/worldview.js";

const log = createLogger("graph-builder");

// ─── Configuration ───────────────────────────────────────────────

export interface GraphBuilderConfig {
  /** Max tokens for each LLM call (Steps 1 and 3). */
  maxTokens: number;
  /** Retry Step 1 once if unresolved consumes are detected. Default true. */
  retryOnUnresolvedConsumes: boolean;
}

const DEFAULT_CONFIG: GraphBuilderConfig = {
  maxTokens: 8192,
  retryOnUnresolvedConsumes: true,
};

// ─── Zod Schemas ─────────────────────────────────────────────────

const CapabilityTokenSchema = z.object({
  capability: z.string(),
  description: z.string(),
});

const SemanticMapEntrySchema = z.object({
  id: z.string(),
  provides: z.array(CapabilityTokenSchema),
  consumes: z.array(CapabilityTokenSchema),
});

const SemanticMapResultSchema = z.object({
  entries: z.array(SemanticMapEntrySchema),
});

const AffinityGroupSchema = z.object({
  name: z.string(),
  nodeIds: z.array(z.string()),
  sharedBoundary: z.string(),
  coDesignRisk: z.string(),
});

const DepCorrectionSchema = z.object({
  action: z.enum(["add", "remove"]),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
});

const AffinityAnalysisResultSchema = z.object({
  affinityGroups: z.array(AffinityGroupSchema),
  corrections: z.array(DepCorrectionSchema),
});

// ─── Internal types ──────────────────────────────────────────────

interface AlgorithmicDerivationResult {
  edges: Array<{ from: string; to: string }>;
  /** Strongly connected components with > 1 node (cycles). */
  cycles: string[][];
}

interface TaggedEdge {
  from: string;
  to: string;
  source: "algorithmic" | "correction";
  reason?: string;
}

// ─── GraphBuilder ────────────────────────────────────────────────

export class GraphBuilder {
  private model: string;
  private config: GraphBuilderConfig;
  private worldview?: Worldview;

  constructor(model: string, config?: Partial<GraphBuilderConfig>, worldview?: Worldview) {
    this.model = model;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.worldview = worldview;
  }

  // ── Step 1: Semantic Mapping (LLM) ─────────────────────────────

  /**
   * Identify what each node provides and consumes.
   * Retries once if unresolved consumes are detected.
   */
  async semanticMap(nodes: ShaelNode[]): Promise<SemanticMapEntry[]> {
    const inputs: SemanticMappingInputs = {
      nodes: nodes.map((n) => ({
        id: n.id,
        description: n.description,
        level: n.level,
        phaseGroup: n.phaseGroup,
        parentId: n.parentId,
        gateCondition: n.gateCondition,
      })),
    };

    const system = semanticMappingSystem(this.worldview);
    const user = semanticMappingUser(inputs);

    let result = await callStructured<{ entries: SemanticMapEntry[] }>(
      "graph-builder",
      this.model,
      system,
      user,
      SemanticMapResultSchema,
      this.config.maxTokens,
    );

    // Check for unresolved consumes
    const unresolved = this.findUnresolvedConsumes(result.entries);

    if (unresolved.length > 0 && this.config.retryOnUnresolvedConsumes) {
      log.info("Unresolved consumes detected, retrying with correction", {
        unresolvedCount: unresolved.length,
        tokens: unresolved.map((u) => u.capability),
      });

      const correctionUser = semanticMappingCorrectionUser(inputs, unresolved);
      result = await callStructured<{ entries: SemanticMapEntry[] }>(
        "graph-builder",
        this.model,
        system,
        correctionUser,
        SemanticMapResultSchema,
        this.config.maxTokens,
      );
    }

    const finalUnresolved = this.findUnresolvedConsumes(result.entries);

    emit("graph-builder:semantic-map-complete", {
      nodeCount: nodes.length,
      totalProvides: result.entries.reduce((sum, e) => sum + e.provides.length, 0),
      totalConsumes: result.entries.reduce((sum, e) => sum + e.consumes.length, 0),
      unresolvedConsumes: finalUnresolved.length,
    });

    log.info("Semantic mapping complete", {
      nodes: nodes.length,
      entries: result.entries.length,
      unresolved: finalUnresolved.length,
    });

    return result.entries;
  }

  // ── Step 2: Algorithmic Dependency Derivation (code) ───────────

  /**
   * Derive dependency edges by matching provides→consumes tokens.
   * Pure function, no LLM. Detects cycles but does not break them.
   */
  deriveDependencies(
    nodes: ShaelNode[],
    semanticMap: SemanticMapEntry[],
  ): AlgorithmicDerivationResult {
    // Build provider index: capability → node IDs that provide it
    const providerIndex = new Map<string, string[]>();
    for (const entry of semanticMap) {
      for (const token of entry.provides) {
        const providers = providerIndex.get(token.capability) ?? [];
        providers.push(entry.id);
        providerIndex.set(token.capability, providers);
      }
    }

    // Derive edges: for each consume, add edge from consumer to each provider
    const edgeSet = new Set<string>();
    const edges: Array<{ from: string; to: string }> = [];

    for (const entry of semanticMap) {
      for (const token of entry.consumes) {
        const providers = providerIndex.get(token.capability) ?? [];
        for (const providerId of providers) {
          if (providerId === entry.id) continue; // skip self-deps
          const key = `${entry.id}→${providerId}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from: entry.id, to: providerId });
          }
        }
      }
    }

    // Cycle detection: Tarjan's algorithm for strongly connected components
    const cycles = this.findCycles(
      nodes.map((n) => n.id),
      edges,
    );

    return { edges, cycles };
  }

  // ── Step 3: Affinity Analysis + Dependency Correction (LLM) ───

  /**
   * Identify affinity groups and correct algorithmic dependencies.
   * The LLM sees the full context: nodes, semantic map, derived edges, cycles.
   */
  async affinityAnalysis(
    nodes: ShaelNode[],
    semanticMap: SemanticMapEntry[],
    algorithmicEdges: Array<{ from: string; to: string }>,
    cycles: string[][],
  ): Promise<{ affinityGroups: AffinityGroup[]; corrections: DepCorrection[] }> {
    const inputs: AffinityAnalysisInputs = {
      nodes: nodes.map((n) => ({
        id: n.id,
        description: n.description,
        level: n.level,
        phaseGroup: n.phaseGroup,
      })),
      semanticMap: semanticMap.map((m) => ({
        id: m.id,
        provides: m.provides.map((p) => ({ capability: p.capability, description: p.description })),
        consumes: m.consumes.map((c) => ({ capability: c.capability, description: c.description })),
      })),
      derivedEdges: algorithmicEdges,
      cycles,
    };

    const system = affinityAnalysisSystem(this.worldview);
    const user = affinityAnalysisUser(inputs);

    const result = await callStructured<{
      affinityGroups: AffinityGroup[];
      corrections: DepCorrection[];
    }>(
      "graph-builder",
      this.model,
      system,
      user,
      AffinityAnalysisResultSchema,
      this.config.maxTokens,
    );

    emit("graph-builder:affinity-complete", {
      groupCount: result.affinityGroups.length,
      correctionCount: result.corrections.length,
      addCount: result.corrections.filter((c) => c.action === "add").length,
      removeCount: result.corrections.filter((c) => c.action === "remove").length,
    });

    log.info("Affinity analysis complete", {
      groups: result.affinityGroups.length,
      corrections: result.corrections.length,
    });

    return result;
  }

  // ── Post-Step 3: Apply Corrections ─────────────────────────────

  /**
   * Apply LLM corrections to algorithmic edges. Tags provenance.
   * Pure function.
   */
  applyCorrections(
    algorithmicEdges: Array<{ from: string; to: string }>,
    corrections: DepCorrection[],
  ): TaggedEdge[] {
    // Start with algorithmic edges, tagged
    const edges: TaggedEdge[] = algorithmicEdges.map((e) => ({
      from: e.from,
      to: e.to,
      source: "algorithmic" as const,
    }));

    // Apply removals
    const removals = new Set(
      corrections
        .filter((c) => c.action === "remove")
        .map((c) => `${c.from}→${c.to}`),
    );
    const filtered = edges.filter((e) => !removals.has(`${e.from}→${e.to}`));

    // Apply additions
    const existingKeys = new Set(filtered.map((e) => `${e.from}→${e.to}`));
    for (const correction of corrections) {
      if (correction.action === "add") {
        const key = `${correction.from}→${correction.to}`;
        if (!existingKeys.has(key)) {
          filtered.push({
            from: correction.from,
            to: correction.to,
            source: "correction",
            reason: correction.reason,
          });
          existingKeys.add(key);
        }
      }
    }

    return filtered;
  }

  // ── Post-Step 3: Topological Sort ──────────────────────────────

  /**
   * Kahn's algorithm. If cycles remain after corrections, logs a warning
   * and returns a best-effort ordering (remaining nodes appended).
   * Pure function.
   */
  topologicalSort(
    nodeIds: string[],
    edges: Array<{ from: string; to: string }>,
  ): string[] {
    // Build adjacency and in-degree
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const id of nodeIds) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }

    for (const edge of edges) {
      // edge.from depends on edge.to, so edge.to → edge.from in execution order
      // In Kahn's: edge.to must come before edge.from
      const current = inDegree.get(edge.from) ?? 0;
      inDegree.set(edge.from, current + 1);
      const adj = adjacency.get(edge.to) ?? [];
      adj.push(edge.from);
      adjacency.set(edge.to, adj);
    }

    // Seed queue with zero-in-degree nodes
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    // If not all nodes are in order, cycles remain
    if (order.length < nodeIds.length) {
      const remaining = nodeIds.filter((id) => !order.includes(id));
      log.warn("Cycles remain after corrections — appending remaining nodes", {
        ordered: order.length,
        remaining: remaining.length,
        remainingIds: remaining,
      });
      order.push(...remaining);
    }

    return order;
  }

  // ── Orchestrator: wire() ───────────────────────────────────────

  /**
   * Run the full B.2 pipeline: Steps 1 → 2 → 3 → corrections → sort.
   *
   * NE modulation:
   *   - Low NE (< 0.3): skip Step 3 correction review if no cycles
   *   - High NE (> 0.7): thorough mode (no shortcuts)
   */
  async wire(
    nodes: ShaelNode[],
    neLevel?: number,
  ): Promise<DependencyWiringResult> {
    const start = Date.now();
    const ne = neLevel ?? 0.5;

    // Step 1: Semantic Mapping
    const semanticMap = await this.semanticMap(nodes);

    // Step 2: Algorithmic Derivation
    const { edges: algorithmicEdges, cycles } = this.deriveDependencies(nodes, semanticMap);

    // Step 3: Affinity Analysis + Correction
    // At low NE with no cycles, run affinity only (lighter Step 3)
    const skipCorrections = ne < 0.3 && cycles.length === 0;

    let affinityGroups: AffinityGroup[];
    let corrections: DepCorrection[];

    if (skipCorrections) {
      log.info("Low NE + no cycles — running light affinity analysis", { ne });
      // Still run Step 3 for affinity groups but expect fewer corrections
      const result = await this.affinityAnalysis(nodes, semanticMap, algorithmicEdges, cycles);
      affinityGroups = result.affinityGroups;
      corrections = []; // Ignore corrections at low NE with clean graph
    } else {
      const result = await this.affinityAnalysis(nodes, semanticMap, algorithmicEdges, cycles);
      affinityGroups = result.affinityGroups;
      corrections = result.corrections;
    }

    // Apply corrections and sort
    const correctedEdges = this.applyCorrections(algorithmicEdges, corrections);
    const topologicalOrder = this.topologicalSort(
      nodes.map((n) => n.id),
      correctedEdges,
    );

    const result: DependencyWiringResult = {
      semanticMap,
      dependencies: correctedEdges,
      affinityGroups,
      corrections,
      topologicalOrder,
    };

    emit("graph-builder:wire-complete", {
      nodeCount: nodes.length,
      edgeCount: correctedEdges.length,
      affinityGroupCount: affinityGroups.length,
      correctionCount: corrections.length,
      durationMs: Date.now() - start,
    });

    log.info("Wiring complete", {
      nodes: nodes.length,
      edges: correctedEdges.length,
      affinityGroups: affinityGroups.length,
      corrections: corrections.length,
      durationMs: Date.now() - start,
    });

    return result;
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Find consumed capabilities that have no provider.
   */
  private findUnresolvedConsumes(
    entries: SemanticMapEntry[],
  ): Array<{ nodeId: string; capability: string }> {
    const allProvided = new Set<string>();
    for (const entry of entries) {
      for (const token of entry.provides) {
        allProvided.add(token.capability);
      }
    }

    const unresolved: Array<{ nodeId: string; capability: string }> = [];
    for (const entry of entries) {
      for (const token of entry.consumes) {
        if (!allProvided.has(token.capability)) {
          unresolved.push({ nodeId: entry.id, capability: token.capability });
        }
      }
    }

    return unresolved;
  }

  /**
   * Tarjan's algorithm for strongly connected components.
   * Returns only SCCs with > 1 node (actual cycles).
   */
  private findCycles(
    nodeIds: string[],
    edges: Array<{ from: string; to: string }>,
  ): string[][] {
    const adjacency = new Map<string, string[]>();
    for (const id of nodeIds) adjacency.set(id, []);
    for (const edge of edges) {
      const adj = adjacency.get(edge.from) ?? [];
      adj.push(edge.to);
      adjacency.set(edge.from, adj);
    }

    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const sccs: string[][] = [];

    function strongconnect(v: string) {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adjacency.get(v) ?? []) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) sccs.push(scc);
      }
    }

    for (const id of nodeIds) {
      if (!indices.has(id)) strongconnect(id);
    }

    return sccs;
  }
}
