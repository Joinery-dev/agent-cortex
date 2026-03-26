/**
 * Conviction Loop — Smoke Test
 *
 * Verifies the four-step pipeline:
 *   1. Necessity — oscillation, approach bottleneck, graph exhaustion, low tonic
 *   2. Conviction — score trajectory, maxim orientation, momentum, progress
 *   3. Speed of light — near ceiling, far from ceiling, approach bottleneck
 *   4. Shaping — notes, reshape guidance, escalation reason
 *
 * Run: npx tsx examples/conviction-smoke.ts
 */

import {
  runConvictionLoop,
  testNecessity,
  testConviction,
  testSpeedOfLight,
  computeShaping,
} from "../src/kernel/conviction.js";
import type { ConvictionContext } from "../src/types/conviction.js";
import type { WeightedComposite } from "../src/kernel/evaluation-weighter.js";
import type { OscillationSignal } from "../src/types/working-memory.js";
import type { SpeedOfLight, ApproachCeiling } from "../src/types/cerebellum.js";
import type { VitalSigns, TaskGraphNode } from "../src/types/brainstem.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ─── Test data factories ─────────────────────────────────────────

function makeComposite(weightedMean: number, acceptability = 0.7): WeightedComposite {
  return {
    weightedMean,
    weightedAcceptability: acceptability,
    meanStake: 0.6,
    confidence: acceptability,
    evaluationCount: 3,
  } as WeightedComposite;
}

function makeOscillation(receptorId: string, swing: number): OscillationSignal {
  return {
    receptorId,
    activationPath: ["sense", receptorId],
    recentScores: [8, 8 - swing],
    swingMagnitude: swing,
  };
}

function makeSpeedOfLight(
  ceiling: number,
  opts?: {
    approachIsBottleneck?: boolean;
    bottleneckGap?: number;
  },
): SpeedOfLight {
  const sol: SpeedOfLight = {
    taskId: "test-task",
    perSense: [],
    compositeCeiling: ceiling,
    compositeBestAchieved: null,
    compositeGap: null,
    hasHistory: false,
    computedAt: new Date(),
  };

  if (opts?.approachIsBottleneck !== undefined) {
    sol.approachSpecific = {
      approachTags: ["test"],
      perSense: [],
      compositeBestAchieved: null,
      episodesConsidered: 1,
      approachIsBottleneck: opts.approachIsBottleneck,
      bottleneckGap: opts.bottleneckGap ?? null,
    };
  }

  return sol;
}

function makeVitals(tonicDopamine: number): VitalSigns {
  return {
    workingMemoryLoad: 0.3,
    predictionAccuracy: 0.7,
    contextCapacity: 0.4,
    learningSignalHealth: 0.8,
    weightVolatility: 0.2,
    tonicDopamine,
  };
}

function makeTaskGraph(count: number): TaskGraphNode[] {
  return Array.from({ length: count }, (_, i) => ({
    task: {
      id: `task-${i}`,
      description: `Task ${i}`,
      status: "pending" as const,
      events: [],
      createdAt: new Date(),
    },
    dependsOn: [],
  }));
}

// ─── 1. Build-cycle: oscillation → reshape (necessity) ───────────

console.log("\n1. Build-cycle: oscillation → reshape");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(7),
    oscillations: [makeOscillation("d.color", 4)],
    speedOfLight: makeSpeedOfLight(9),
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape");
  assert(result.decidingStep === "necessity", "Decided at necessity step");
  assert(result.evidence.some((e) => e.source === "oscillation"), "Oscillation evidence present");
  assert(result.shaping.reshapeGuidance !== undefined, "Reshape guidance provided");
}

// ─── 2. Build-cycle: approach bottleneck → reshape (necessity) ───

console.log("2. Build-cycle: approach bottleneck → reshape");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 1,
    composite: makeComposite(5),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9, { approachIsBottleneck: true, bottleneckGap: 3 }),
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape");
  assert(result.decidingStep === "necessity", "Decided at necessity step");
  assert(result.evidence.some((e) => e.source === "approach-bottleneck"), "Approach bottleneck evidence");
}

// ─── 3. Build-cycle: near ceiling → proceed with evidence ────────

console.log("3. Build-cycle: near ceiling → proceed with evidence");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(8.5), // 8.5/9 = gap of ~5.6%
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["The system values clarity over cleverness."],
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "proceed", "Verdict is proceed");
  assert(result.evidence.some((e) => e.source === "speed-of-light-near"), "Near-ceiling evidence present");
  assert(result.level > 0.5, "Conviction level is healthy");
}

// ─── 4. Build-cycle: far from ceiling → reshape (speed-of-light) ─

console.log("4. Build-cycle: far from ceiling → reshape");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(3), // 3/9 = gap of ~67%
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape");
  assert(result.decidingStep === "speed-of-light", "Decided at speed-of-light step");
  assert(result.evidence.some((e) => e.source === "speed-of-light-gap"), "Far-from-ceiling evidence");
}

// ─── 5. Build-cycle: healthy scores → proceed ────────────────────

console.log("5. Build-cycle: healthy scores → proceed");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 1,
    composite: makeComposite(7),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Build with conviction."],
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "proceed", "Verdict is proceed");
  assert(result.level >= 0.5, "Conviction level is above reshape threshold");
  assert(result.evidence.length > 0, "Evidence collected");
}

// ─── 6. Build-cycle: conviction erosion across cycles ────────────

console.log("6. Build-cycle: conviction erosion across cycles");
{
  // Cycle 1: good scores
  const ctx1: ConvictionContext = {
    level: "build-cycle",
    cycle: 1,
    composite: makeComposite(8),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
  };

  const result1 = runConvictionLoop(ctx1);

  // Cycle 2: declining scores, previous conviction feeds in
  const ctx2: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(4),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
    previousConviction: result1,
  };

  const result2 = runConvictionLoop(ctx2);
  assert(result2.delta < 0, "Conviction delta is negative (erosion)");
  assert(result2.level < result1.level, "Conviction level dropped from cycle 1 to cycle 2");
  assert(result2.evidence.some((e) => e.source === "previous-conviction"), "Previous conviction evidence");
}

// ─── 7. Task-dispatch: graph exhausted → unnecessary ─────────────

console.log("7. Task-dispatch: graph exhausted → unnecessary");
{
  const graph = makeTaskGraph(3);
  const ctx: ConvictionContext = {
    level: "task-dispatch",
    cycle: 4,
    taskGraph: graph,
    completedTaskIds: new Set(["task-0", "task-1", "task-2"]),
    escalatedTaskIds: new Set(),
    vitals: makeVitals(0.6),
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape (graph exhausted = unnecessary)");
  assert(result.decidingStep === "necessity", "Decided at necessity step");
  assert(result.evidence.some((e) => e.source === "graph-exhausted"), "Graph-exhausted evidence");
}

// ─── 8. Task-dispatch: low tonic → reshape ───────────────────────

console.log("8. Task-dispatch: low tonic → reshape");
{
  const graph = makeTaskGraph(5);
  const ctx: ConvictionContext = {
    level: "task-dispatch",
    cycle: 2,
    taskGraph: graph,
    completedTaskIds: new Set(["task-0"]),
    escalatedTaskIds: new Set(),
    vitals: makeVitals(0.15), // Below 0.25 threshold
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape");
  assert(result.decidingStep === "necessity", "Decided at necessity step");
  assert(result.evidence.some((e) => e.source === "tonic-low"), "Tonic-low evidence");
  assert(result.shaping.reshapeGuidance !== undefined, "Reshape guidance present");
}

// ─── 9. Task-dispatch: healthy project → proceed ─────────────────

console.log("9. Task-dispatch: healthy project → proceed");
{
  const graph = makeTaskGraph(5);
  const ctx: ConvictionContext = {
    level: "task-dispatch",
    cycle: 3,
    taskGraph: graph,
    completedTaskIds: new Set(["task-0", "task-1", "task-2"]),
    escalatedTaskIds: new Set(),
    vitals: makeVitals(0.6),
    worldModelMaxims: ["Maxim one", "Maxim two"],
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "proceed", "Verdict is proceed");
  assert(result.level >= 0.5, "Conviction level is healthy");
}

// ─── 10. Task-dispatch: escalation threshold ─────────────────────

console.log("10. Task-dispatch: escalation threshold");
{
  const graph = makeTaskGraph(5);
  const ctx: ConvictionContext = {
    level: "task-dispatch",
    cycle: 5,
    taskGraph: graph,
    completedTaskIds: new Set(), // No progress
    escalatedTaskIds: new Set(["task-0", "task-1", "task-2"]), // 3/5 escalated
    vitals: makeVitals(0.15), // Low tonic — but this triggers necessity first
  };

  // Low tonic triggers necessity reshape before conviction can escalate.
  // Test with tonic just above threshold to let conviction run.
  const ctx2: ConvictionContext = {
    ...ctx,
    vitals: makeVitals(0.26), // Just above tonic threshold
  };

  const result = runConvictionLoop(ctx2);
  // 0 progress (0.4 * 0) + 0.26 tonic (0.3 * 0.26) + 0.4 escalation (0.3 * 0.4) = 0.198
  assert(result.verdict === "escalate", "Verdict is escalate");
  assert(result.decidingStep === "conviction", "Decided at conviction step");
  assert(result.level < 0.3, "Conviction level is below escalation threshold");
}

// ─── 11. Shaping notes populated on reshape ──────────────────────

console.log("11. Shaping notes populated on reshape");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(3),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
  };

  const result = runConvictionLoop(ctx);
  assert(result.verdict === "reshape", "Verdict is reshape");
  assert(result.shaping.notes.length > 0, "Shaping notes are non-empty");
  assert(result.shaping.reshapeGuidance !== undefined, "Reshape guidance provided");
}

// ─── 12. Evidence valence correctness ────────────────────────────

console.log("12. Evidence valence correctness");
{
  // Good scenario: all evidence should support
  const goodCtx: ConvictionContext = {
    level: "build-cycle",
    cycle: 1,
    composite: makeComposite(8),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
  };

  const goodResult = runConvictionLoop(goodCtx);
  const supports = goodResult.evidence.filter((e) => e.valence === "supports");
  const undermines = goodResult.evidence.filter((e) => e.valence === "undermines");
  assert(supports.length > 0, "Good scenario has supporting evidence");
  assert(undermines.length === 0, "Good scenario has no undermining evidence");

  // Bad scenario: should have undermining evidence
  const badCtx: ConvictionContext = {
    level: "build-cycle",
    cycle: 2,
    composite: makeComposite(3),
    oscillations: [],
    speedOfLight: makeSpeedOfLight(9),
    worldModelMaxims: ["Maxim"],
    previousConviction: {
      verdict: "proceed",
      level: 0.8,
      delta: 0,
      evidence: [],
      shaping: { notes: [] },
      decidingStep: "speed-of-light",
    },
  };

  const badResult = runConvictionLoop(badCtx);
  const badUndermines = badResult.evidence.filter((e) => e.valence === "undermines");
  assert(badUndermines.length > 0, "Bad scenario has undermining evidence");
}

// ─── 13. Manifested future stub accepted ─────────────────────────

console.log("13. Manifested future stub accepted");
{
  const ctx: ConvictionContext = {
    level: "build-cycle",
    cycle: 1,
    composite: makeComposite(7),
    oscillations: [],
    manifestedFuture: "A fast, accessible landing page with clear CTA hierarchy.",
  };

  // Should not crash — manifestedFuture is accepted but not yet used.
  const result = runConvictionLoop(ctx);
  assert(result.verdict === "proceed" || result.verdict === "reshape", "Runs without error with manifestedFuture");
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Conviction smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
