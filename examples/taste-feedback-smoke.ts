/**
 * Smoke test: Taste Feedback Loop (Feature #24) + Satisfaction Signal (Feature #25)
 *
 * Verifies that:
 * 1. No proposals when deep analysis shows no taste divergence
 * 2. No proposals when divergence persistence is below threshold
 * 3. Proposals generated when strong + persistent + mature system
 * 4. Proposal contains correct dimensions and strength
 * 5. Maturity factor suppresses proposals for immature systems
 * 6. Max pending proposals respected
 * 7. Response handling: receiveResponse + status transitions
 * 8. "update" response → routing weight DOWN + taste mutation
 * 9. "keep" response → routing weight UP, no taste mutation
 * 10. "nuanced" response → routing weight slight DOWN + taste mutation to new value
 * 11. "deferred" response → no plasticity changes
 * 12. applyMapping writes to plasticity store
 * 13. applyTasteUpdate produces correct profile mutation
 * 14. processTaskSignal routes approval/correction to sense weights
 * 15. State/dashboard accessors return correct values
 * 16. Proposal expiration works
 *
 * Run: npx tsx examples/taste-feedback-smoke.ts
 */

import { TasteFeedbackLoop } from "../src/kernel/taste-feedback.js";
import {
  processTasteResponse,
  processTaskSignal,
  applyMapping,
  applyTasteUpdate,
} from "../src/kernel/satisfaction-signal.js";
import type { TasteFeedbackSources } from "../src/types/taste-feedback.js";
import type { DriftAssessment, DeepAnalysis, TasteDivergenceItem } from "../src/types/drift-monitor.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { SatisfactionResponse, SatisfactionSignal } from "../src/types/satisfaction-signal.js";
import type { PlasticityStore, PlasticWeight, ConnectionCategory, ConnectionSnapshot, DeltaSource, PlasticConnectionDeclaration, WeightDelta } from "../src/types/plasticity.js";
import { setLogLevel } from "../src/util/logger.js";

setLogLevel("warn");

// ─── Fixtures ────────────────────────────────────────────────────

const intent: ProjectIntent = {
  id: "taste-test-project",
  summary: "Build a minimalist portfolio site for a photographer",
  audience: "Prospective clients",
  successCriteria: ["Visual impact", "Fast load times"],
  constraints: ["Mobile-first"],
  vision: "Gallery-first, minimal chrome.",
  keyDecisions: [],
  driftLog: [],
};

const taste: TasteProfile = {
  id: "taste-test-taste",
  name: "Test Client",
  visual: "Warm tones, organic flowing layouts",
  decisionStyle: "Show me options",
  communication: "Brief and direct",
  patterns: "Asymmetric grids, hand-drawn elements",
  raw: {},
};

const divergenceItems: TasteDivergenceItem[] = [
  {
    dimension: "visual",
    stated: "Warm tones, organic flowing layouts",
    demonstrated: "Cool tones, clean geometric layouts",
    strength: 0.8,
  },
];

function makeDeepAnalysis(detected: boolean, divergences: TasteDivergenceItem[] = []): DeepAnalysis {
  return {
    intentAlignment: {
      level: "aligned",
      trajectory: "stable",
      description: "On track",
      evidence: [],
    },
    tasteDivergence: { detected, divergences },
    conventionHealth: { eroding: [], emerging: [] },
    overallLevel: 0.2,
    summary: "Test analysis",
    recommendations: [],
  };
}

function makeAssessment(deepAnalysis: DeepAnalysis | null): DriftAssessment {
  return {
    driftLevel: 0.2,
    driftSummary: "",
    quickCheck: null,
    deepAnalysis,
    deepAnalysisAt: deepAnalysis ? new Date() : null,
    deepAnalysisPhaseGroup: deepAnalysis ? "phase-1" : null,
    sensitivityWeight: 0.5,
  };
}

function makeSources(assessment: DriftAssessment, overrides?: {
  neLevel?: number;
  cerebellumAccuracy?: number;
}): TasteFeedbackSources {
  const sources: TasteFeedbackSources = {
    driftMonitor: { getAssessment: () => assessment },
    taste,
    intent,
    neLevel: overrides?.neLevel ?? 0.3,
  };
  // Only set cerebellumAccuracy if explicitly provided (not undefined).
  // This lets immature-system tests omit it so NE is used as fallback.
  if (overrides && "cerebellumAccuracy" in overrides && overrides.cerebellumAccuracy !== undefined) {
    sources.cerebellumAccuracy = overrides.cerebellumAccuracy;
  } else if (!overrides) {
    sources.cerebellumAccuracy = 0.8;
  }
  return sources;
}

// ─── Mock PlasticityStore ────────────────────────────────────────

class MockPlasticityStore implements PlasticityStore {
  weights = new Map<string, PlasticWeight>();
  updates: Array<{ connectionId: string; delta: number; source: DeltaSource; context?: string }> = [];

  constructor() {
    // Pre-register taste routing weight
    this.weights.set("thalamus.routing.taste", {
      connectionId: "thalamus.routing.taste",
      value: 0.5,
      defaultValue: 0.5,
      range: [0, 1] as [number, number],
      category: "routing-intensity" as ConnectionCategory,
      recentDeltas: [],
      lastModified: new Date(),
    });
  }

  get(connectionId: string): PlasticWeight | undefined {
    return this.weights.get(connectionId);
  }

  getByCategory(_category: ConnectionCategory): PlasticWeight[] {
    return [...this.weights.values()].filter((w) => w.category === _category);
  }

  update(connectionId: string, delta: number, source: DeltaSource, context?: string): number {
    this.updates.push({ connectionId, delta, source, context });
    const existing = this.weights.get(connectionId);
    if (existing) {
      existing.value = Math.max(existing.range[0], Math.min(existing.range[1], existing.value + delta));
      existing.lastModified = new Date();
      return existing.value;
    }
    return 0;
  }

  register(_declaration: PlasticConnectionDeclaration): void {}
  snapshot(_label?: string): ConnectionSnapshot {
    return { weights: [...this.weights.values()], capturedAt: new Date() };
  }
  restore(_snapshot: ConnectionSnapshot): void {}
  *all(): IterableIterator<PlasticWeight> {
    yield* this.weights.values();
  }
  get size(): number {
    return this.weights.size;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
    process.exitCode = 1;
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("\n── Taste Feedback + Satisfaction Signal Smoke Test ──\n");

  // ── 1. No proposals when no taste divergence ──────────────────
  console.log("1. No proposals when no taste divergence");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(false));
    const sources = makeSources(assessment);
    const proposals = await loop.evaluate(sources, "phase-1");
    check("returns empty array", proposals.length === 0);
    check("state shows 0 pending", loop.getState().pendingProposals === 0);
  }

  // ── 2. No proposals on first sighting (persistence < 2) ──────
  console.log("\n2. No proposals on first sighting (persistence = 1)");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    const sources = makeSources(assessment);
    const proposals = await loop.evaluate(sources, "phase-1");
    check("returns empty (persistence = 1, needs 2)", proposals.length === 0);
    check("tracks 1 divergence dimension", loop.getDivergenceHistory().length === 1);
    check("persistence is 1", loop.getDivergenceHistory()[0].persistence === 1);
  }

  // ── 3. Proposals generated when persistent + strong + mature ──
  console.log("\n3. Proposals generated when persistent + strong + mature");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    const sources = makeSources(assessment, { cerebellumAccuracy: 0.9 });

    // First sighting — no proposal
    await loop.evaluate(sources, "phase-1");
    check("no proposal on first sighting", loop.getState().totalProposed === 0);

    // Second sighting — should now propose (persistence = 2)
    const proposals = await loop.evaluate(sources, "phase-2");
    check("proposal generated on second sighting", proposals.length === 1);
    check("proposal has correct dimension", proposals[0]?.dimensions[0] === "visual");
    check("proposal strength > 0", (proposals[0]?.proposalStrength ?? 0) > 0);
    check("proposal status is pending", proposals[0]?.status === "pending");
    check("state shows 1 pending", loop.getState().pendingProposals === 1);
    check("state shows 1 total proposed", loop.getState().totalProposed === 1);
    check("persistence is 2", loop.getDivergenceHistory()[0].persistence === 2);
  }

  // ── 4. Immature system (high NE) suppresses proposals ─────────
  console.log("\n4. Immature system suppresses proposals");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    // High NE = immature. cerebellumAccuracy overrides NE, so omit it.
    const sources = makeSources(assessment, { neLevel: 0.9, cerebellumAccuracy: undefined });

    await loop.evaluate(sources, "phase-1");
    const proposals = await loop.evaluate(sources, "phase-2");
    // maturityFactor = 1 - 0.9 = 0.1 → proposalStrength = 0.8 * 0.75 * 0.1 = 0.06
    // well below default minDivergenceStrength of 0.3
    check("no proposals for immature system", proposals.length === 0);
  }

  // ── 5. Max pending proposals respected ────────────────────────
  console.log("\n5. Max pending proposals respected");
  {
    const loop = new TasteFeedbackLoop({ maxPendingProposals: 1 });

    const multiDivergences: TasteDivergenceItem[] = [
      { ...divergenceItems[0] },
      { dimension: "patterns", stated: "Asymmetric grids", demonstrated: "Strict grids", strength: 0.7 },
    ];
    const assessment = makeAssessment(makeDeepAnalysis(true, multiDivergences));
    const sources = makeSources(assessment, { cerebellumAccuracy: 0.9 });

    await loop.evaluate(sources, "phase-1");
    const proposals = await loop.evaluate(sources, "phase-2");
    check("only 1 proposal despite 2 divergences", proposals.length <= 1);
  }

  // ── 6. receiveResponse transitions proposal status ────────────
  console.log("\n6. Response handling and status transitions");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    const sources = makeSources(assessment, { cerebellumAccuracy: 0.9 });

    await loop.evaluate(sources, "phase-1");
    const proposals = await loop.evaluate(sources, "phase-2");
    const proposalId = proposals[0]?.id ?? "";

    const response: SatisfactionResponse = {
      proposalId,
      type: "update",
      receivedAt: new Date(),
    };

    const result = loop.receiveResponse(response);
    check("receiveResponse returns the proposal", result !== null);
    check("proposal status is responded", result?.status === "responded");
    check("response is attached", result?.response?.type === "update");
    check("removed from pending", loop.getState().pendingProposals === 0);
    check("totalResponded is 1", loop.getState().totalResponded === 1);
  }

  // ── 7. "deferred" keeps proposal pending ──────────────────────
  console.log("\n7. Deferred response keeps proposal pending");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    const sources = makeSources(assessment, { cerebellumAccuracy: 0.9 });

    await loop.evaluate(sources, "phase-1");
    const proposals = await loop.evaluate(sources, "phase-2");
    const proposalId = proposals[0]?.id ?? "";

    loop.receiveResponse({
      proposalId,
      type: "deferred",
      receivedAt: new Date(),
    });

    check("proposal stays pending", loop.getState().pendingProposals === 1);
  }

  // ── 8. processTasteResponse: "update" ─────────────────────────
  console.log("\n8. Satisfaction Signal: 'update' response");
  {
    const proposal = makeTestProposal();
    const response: SatisfactionResponse = {
      proposalId: proposal.id,
      type: "update",
      receivedAt: new Date(),
    };
    const mapping = processTasteResponse(response, proposal);
    check("has plasticity updates", mapping.updates.length > 0);
    check("routing weight delta is negative (DOWN)", mapping.updates[0].delta < 0);
    check("targets thalamus.routing.taste", mapping.updates[0].connectionId === "thalamus.routing.taste");
    check("has taste update", mapping.tasteUpdate !== undefined);
    check("taste update dimension is visual", mapping.tasteUpdate?.dimension === "visual");
    check("taste update newValue is demonstrated", mapping.tasteUpdate?.newValue === "Cool tones, clean geometric layouts");
  }

  // ── 9. processTasteResponse: "keep" ───────────────────────────
  console.log("\n9. Satisfaction Signal: 'keep' response (Goodhart)");
  {
    const proposal = makeTestProposal();
    const response: SatisfactionResponse = {
      proposalId: proposal.id,
      type: "keep",
      receivedAt: new Date(),
    };
    const mapping = processTasteResponse(response, proposal);
    check("has plasticity updates", mapping.updates.length > 0);
    check("routing weight delta is positive (UP)", mapping.updates[0].delta > 0);
    check("no taste update", mapping.tasteUpdate === undefined);
  }

  // ── 10. processTasteResponse: "nuanced" ───────────────────────
  console.log("\n10. Satisfaction Signal: 'nuanced' response (co-creation)");
  {
    const proposal = makeTestProposal();
    const response: SatisfactionResponse = {
      proposalId: proposal.id,
      type: "nuanced",
      detail: "Warm but with blue accents — the warmth is in the composition, not the palette",
      newPreference: "Warm composition with cool accent palette",
      receivedAt: new Date(),
    };
    const mapping = processTasteResponse(response, proposal);
    check("has plasticity updates", mapping.updates.length > 0);
    check("routing weight delta is negative (slight DOWN)", mapping.updates[0].delta < 0);
    check("has taste update", mapping.tasteUpdate !== undefined);
    check("taste update uses newPreference", mapping.tasteUpdate?.newValue === "Warm composition with cool accent palette");

    // Nuanced delta should be smaller than update delta
    const updateMapping = processTasteResponse(
      { proposalId: proposal.id, type: "update", receivedAt: new Date() },
      proposal,
    );
    check(
      "nuanced delta smaller than update delta",
      Math.abs(mapping.updates[0].delta) < Math.abs(updateMapping.updates[0].delta),
    );
  }

  // ── 11. processTasteResponse: "deferred" ──────────────────────
  console.log("\n11. Satisfaction Signal: 'deferred' response");
  {
    const proposal = makeTestProposal();
    const response: SatisfactionResponse = {
      proposalId: proposal.id,
      type: "deferred",
      receivedAt: new Date(),
    };
    const mapping = processTasteResponse(response, proposal);
    check("no plasticity updates", mapping.updates.length === 0);
    check("no taste update", mapping.tasteUpdate === undefined);
  }

  // ── 12. applyMapping writes to store ──────────────────────────
  console.log("\n12. applyMapping writes to PlasticityStore");
  {
    const store = new MockPlasticityStore();
    const proposal = makeTestProposal();
    const response: SatisfactionResponse = {
      proposalId: proposal.id,
      type: "update",
      receivedAt: new Date(),
    };
    const mapping = processTasteResponse(response, proposal);
    applyMapping(mapping, store);

    check("store received update", store.updates.length === 1);
    check("source is satisfaction", store.updates[0].source === "satisfaction");
    check("weight value decreased", (store.get("thalamus.routing.taste")?.value ?? 1) < 0.5);
  }

  // ── 13. applyTasteUpdate mutates profile correctly ────────────
  console.log("\n13. applyTasteUpdate produces correct profile");
  {
    const updated = applyTasteUpdate(taste, {
      dimension: "visual",
      oldValue: taste.visual,
      newValue: "Cool tones, geometric layouts",
    });
    check("visual updated", updated.visual === "Cool tones, geometric layouts");
    check("other fields unchanged", updated.decisionStyle === taste.decisionStyle);
    check("original not mutated", taste.visual === "Warm tones, organic flowing layouts");

    // Unknown dimension goes to raw
    const rawUpdated = applyTasteUpdate(taste, {
      dimension: "experimental",
      oldValue: "",
      newValue: "Yes please",
    });
    check("unknown dimension goes to raw", rawUpdated.raw["experimental"] === "Yes please");
  }

  // ── 14. processTaskSignal routes to sense weights ─────────────
  console.log("\n14. processTaskSignal for approval/correction");
  {
    const approvalSignal: SatisfactionSignal = {
      id: "sig-1",
      kind: "task-approval",
      taskSignal: { taskId: "t1", approved: true, notes: "Looks great" },
      raw: "Looks great",
      receivedAt: new Date(),
    };
    const mapping = processTaskSignal(approvalSignal, ["DESIGN", "PERFORMANCE"]);
    check("2 sense weight updates", mapping.updates.length === 2);
    check("positive delta for approval", mapping.updates[0].delta > 0);
    check("targets evaluator.sense-weight.DESIGN", mapping.updates[0].connectionId === "evaluator.sense-weight.DESIGN");

    const correctionSignal: SatisfactionSignal = {
      id: "sig-2",
      kind: "task-correction",
      taskSignal: { taskId: "t2", approved: false, notes: "Too flashy" },
      raw: "Too flashy",
      receivedAt: new Date(),
    };
    const corrMapping = processTaskSignal(correctionSignal, ["DESIGN"]);
    check("negative delta for correction", corrMapping.updates[0].delta < 0);
  }

  // ── 15. Proposal expiration ───────────────────────────────────
  console.log("\n15. Proposal expiration");
  {
    const loop = new TasteFeedbackLoop();
    const assessment = makeAssessment(makeDeepAnalysis(true, divergenceItems));
    const sources = makeSources(assessment, { cerebellumAccuracy: 0.9 });

    await loop.evaluate(sources, "phase-1");
    await loop.evaluate(sources, "phase-2");
    check("1 pending before expiration", loop.getState().pendingProposals === 1);

    const expired = loop.expireOldProposals(0); // expire everything
    check("1 proposal expired", expired === 1);
    check("0 pending after expiration", loop.getState().pendingProposals === 0);
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
}

// ─── Test Proposal Factory ──────────────────────────────────────

function makeTestProposal() {
  return {
    id: "test-proposal-1",
    divergences: divergenceItems,
    interpretation: "Test interpretation",
    dimensions: ["visual"],
    persistence: 2,
    proposalStrength: 0.6,
    phaseGroup: "phase-2",
    createdAt: new Date(),
    status: "pending" as const,
  };
}

main().catch(console.error);
