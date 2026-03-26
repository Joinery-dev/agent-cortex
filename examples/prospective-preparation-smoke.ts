/**
 * Prospective Preparation — Smoke Test
 *
 * Verifies:
 *   1. Tension detection (score divergence, trend divergence, episode pattern)
 *   2. Bottleneck detection (gap > threshold, trending direction)
 *   3. Predicted cycles (median from episodes, cold start)
 *   4. Conviction carry-forward (notes, reshape guidance pass through)
 *   5. Deduplication (same pair from multiple bases)
 *
 * Run: npx tsx examples/prospective-preparation-smoke.ts
 */

import {
  prepareForward,
  detectTensions,
  detectBottlenecks,
  predictCycles,
} from "../src/kernel/prospective-preparation.js";
import type {
  ForwardBriefingSources,
  HippocampusEpisodeSummary,
} from "../src/types/forward-briefing.js";
import type { ScoreTrend } from "../src/types/working-memory.js";
import type { SpeedOfLight, SenseCeiling, CerebellumPrediction, ReceptorPrediction } from "../src/types/cerebellum.js";
import type { ConvictionShaping } from "../src/types/conviction.js";

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

function makeSenseTrend(
  id: string,
  direction: "up" | "down" | "stable",
  currentMean: number,
): ScoreTrend {
  return {
    id,
    label: id,
    level: "sense",
    direction,
    currentMean,
    previousMean: currentMean + (direction === "down" ? 1 : direction === "up" ? -1 : 0),
    dataPoints: 4,
  };
}

function makeSenseCeiling(senseName: string, ceiling: number): SenseCeiling {
  return {
    senseName,
    senseId: senseName.toLowerCase(),
    stake: 0.5,
    ceiling,
    ceilingRationale: "Test ceiling",
    bestAchieved: null,
    gap: null,
    hasHistory: false,
  };
}

function makeSpeedOfLight(ceilings: SenseCeiling[]): SpeedOfLight {
  const compositeCeiling = ceilings.reduce((sum, c) => sum + c.ceiling * c.stake, 0)
    / ceilings.reduce((sum, c) => sum + c.stake, 0);
  return {
    compositeCeiling,
    perSense: ceilings,
    hasHistory: false,
    approachSpecific: null,
  };
}

function makeEpisode(
  taskId: string,
  cycles: number,
  tensions: Array<{ senseA: string; senseB: string }> = [],
  senseScores: Array<{ senseName: string; score: number }> = [],
): HippocampusEpisodeSummary {
  return { taskId, cycles, senseScores, tensions };
}

function makeConvictionShaping(
  notes: string[] = [],
  reshapeGuidance?: string,
): ConvictionShaping {
  const s: ConvictionShaping = { notes };
  if (reshapeGuidance) s.reshapeGuidance = reshapeGuidance;
  return s;
}

function makePrediction(
  senseScores: Array<{ sense: string; score: number }>,
): CerebellumPrediction {
  const receptorPredictions: ReceptorPrediction[] = senseScores.map((s) => ({
    receptorId: `${s.sense.toLowerCase()}.quality`,
    activationPath: [s.sense],
    predicted: s.score,
    confidence: 0.7,
    basedOnEpisodes: 3,
    source: "sense-fallback" as const,
  }));
  return {
    taskId: "test-task",
    receptorPredictions,
    overallConfidence: 0.7,
    basedOnEpisodes: 3,
    fingerprint: { senseStakes: new Map(), activeReceptors: new Set() },
  };
}

function emptySources(): ForwardBriefingSources {
  return {
    senseTrends: [],
    speedOfLight: null,
    recentEpisodes: [],
    convictionShaping: { notes: [] },
    cerebellumPredictions: null,
  };
}

// ─── 1. Cold start ──────────────────────────────────────────────

console.log("\n1. Cold start (no data)");
{
  const result = prepareForward(emptySources());
  assert(result.predictedTensions.length === 0, "Zero tensions");
  assert(result.predictedBottlenecks.length === 0, "Zero bottlenecks");
  assert(result.predictedCycles === null, "Null predicted cycles");
  assert(result.convictionCarryForward.notes.length === 0, "Empty conviction notes");
  assert(result.manifestedFuture === undefined, "No manifested future");
}

// ─── 2. Trend divergence ────────────────────────────────────────

console.log("\n2. Trend divergence detection");
{
  const sources: ForwardBriefingSources = {
    ...emptySources(),
    senseTrends: [
      makeSenseTrend("Design", "up", 7.5),
      makeSenseTrend("Performance", "down", 4.0),
      makeSenseTrend("Security", "stable", 6.0),
    ],
  };
  const tensions = detectTensions(sources);
  assert(tensions.length === 1, "One tension detected");
  assert(tensions[0].senseA === "Design", "SenseA is Design (rising)");
  assert(tensions[0].senseB === "Performance", "SenseB is Performance (falling)");
  assert(tensions[0].basis === "trend-divergence", "Basis is trend-divergence");
  assert(tensions[0].severity > 0, "Non-zero severity");
  assert(tensions[0].severity <= 1, "Severity clamped to 1");
  // Severity = |7.5 - 4.0| / 10 = 0.35
  assert(Math.abs(tensions[0].severity - 0.35) < 0.01, "Severity ~0.35");
}

// ─── 3. Bottleneck detection ────────────────────────────────────

console.log("\n3. Bottleneck detection");
{
  const trends = [
    makeSenseTrend("Design", "stable", 8.5),
    makeSenseTrend("Performance", "down", 4.0),
  ];
  const sol = makeSpeedOfLight([
    makeSenseCeiling("Design", 9.0),
    makeSenseCeiling("Performance", 9.0),
  ]);
  const bottlenecks = detectBottlenecks(trends, sol);

  // Design: gap 0.5 (below threshold) — NOT a bottleneck
  // Performance: gap 5.0 (above threshold) — IS a bottleneck
  assert(bottlenecks.length === 1, "One bottleneck detected");
  assert(bottlenecks[0].sense === "Performance", "Performance is the bottleneck");
  assert(bottlenecks[0].gap === 5.0, "Gap is 5.0");
  assert(bottlenecks[0].trending === "worsening", "Trending is worsening (down)");
  assert(bottlenecks[0].currentMean === 4.0, "Current mean is 4.0");
  assert(bottlenecks[0].ceiling === 9.0, "Ceiling is 9.0");
}

// ─── 4. Episode-pattern tension ─────────────────────────────────

console.log("\n4. Episode-pattern tension");
{
  const sources: ForwardBriefingSources = {
    ...emptySources(),
    recentEpisodes: [
      makeEpisode("t1", 3, [{ senseA: "Design", senseB: "Performance" }]),
      makeEpisode("t2", 4, [{ senseA: "Design", senseB: "Performance" }, { senseA: "Design", senseB: "Security" }]),
      makeEpisode("t3", 2, [{ senseA: "Design", senseB: "Security" }]),
    ],
  };
  const tensions = detectTensions(sources);

  // Design/Performance: in 2/3 episodes → tension
  // Design/Security: in 2/3 episodes → tension
  assert(tensions.length === 2, "Two tensions detected");

  const dp = tensions.find((t) =>
    (t.senseA === "Design" && t.senseB === "Performance") ||
    (t.senseA === "Performance" && t.senseB === "Design"),
  );
  assert(dp !== undefined, "Design/Performance tension found");
  assert(dp!.basis === "episode-pattern", "Basis is episode-pattern");
  // Severity = 2/3 ≈ 0.667
  assert(Math.abs(dp!.severity - 2 / 3) < 0.01, "Severity ~0.667");
}

// ─── 5. Predicted cycles (median) ───────────────────────────────

console.log("\n5. Predicted cycles from episodes");
{
  const episodes = [
    makeEpisode("t1", 3),
    makeEpisode("t2", 5),
    makeEpisode("t3", 4),
    makeEpisode("t4", 6),
    makeEpisode("t5", 2),
  ];
  const cycles = predictCycles(episodes);
  // Sorted: [2, 3, 4, 5, 6]. Median = 4 (odd count)
  assert(cycles === 4, "Median is 4");
}

// ─── 6. Insufficient episodes → null ────────────────────────────

console.log("\n6. Insufficient episodes for cycle prediction");
{
  const cycles = predictCycles([makeEpisode("t1", 5)]);
  assert(cycles === null, "Null with 1 episode");

  const cyclesEmpty = predictCycles([]);
  assert(cyclesEmpty === null, "Null with 0 episodes");
}

// ─── 7. Score divergence ────────────────────────────────────────

console.log("\n7. Score divergence from Cerebellum predictions");
{
  const sources: ForwardBriefingSources = {
    ...emptySources(),
    cerebellumPredictions: makePrediction([
      { sense: "Design", score: 8.0 },
      { sense: "Performance", score: 4.0 },
      { sense: "Security", score: 7.5 },
    ]),
  };
  const tensions = detectTensions(sources);

  // Design/Performance gap = 4.0 (> 2.0 threshold) → tension
  // Design/Security gap = 0.5 (< 2.0) → no tension
  // Performance/Security gap = 3.5 (> 2.0) → tension
  assert(tensions.length === 2, "Two tensions from score divergence");

  const dp = tensions.find((t) =>
    (t.senseA === "Design" && t.senseB === "Performance") ||
    (t.senseA === "Performance" && t.senseB === "Design"),
  );
  assert(dp !== undefined, "Design/Performance tension detected");
  assert(dp!.basis === "score-divergence", "Basis is score-divergence");
  // Severity = (4.0 - 2.0) / 8 = 0.25
  assert(Math.abs(dp!.severity - 0.25) < 0.01, "Severity ~0.25");
}

// ─── 8. Conviction carry-forward ────────────────────────────────

console.log("\n8. Conviction carry-forward passes through");
{
  const shaping = makeConvictionShaping(
    ["Approach converging slowly", "Performance dimension underperforming"],
    "Frontload performance dimension in next task",
  );
  const result = prepareForward({
    ...emptySources(),
    convictionShaping: shaping,
  });
  assert(result.convictionCarryForward.notes.length === 2, "Two conviction notes carried");
  assert(result.convictionCarryForward.notes[0] === "Approach converging slowly", "First note preserved");
  assert(result.convictionCarryForward.reshapeGuidance === "Frontload performance dimension in next task", "Reshape guidance preserved");
}

// ─── 9. Deduplication ───────────────────────────────────────────

console.log("\n9. Deduplication — same pair from two bases, highest severity kept");
{
  const sources: ForwardBriefingSources = {
    ...emptySources(),
    // Trend divergence: Design up, Performance down → severity ~0.35
    senseTrends: [
      makeSenseTrend("Design", "up", 7.5),
      makeSenseTrend("Performance", "down", 4.0),
    ],
    // Episode pattern: same pair in 3/3 episodes → severity 1.0
    recentEpisodes: [
      makeEpisode("t1", 3, [{ senseA: "Design", senseB: "Performance" }]),
      makeEpisode("t2", 4, [{ senseA: "Design", senseB: "Performance" }]),
      makeEpisode("t3", 2, [{ senseA: "Performance", senseB: "Design" }]),
    ],
  };
  const tensions = detectTensions(sources);

  assert(tensions.length === 1, "Deduplicated to one tension");
  // Episode pattern severity (1.0) > trend divergence severity (0.35)
  assert(tensions[0].basis === "episode-pattern", "Higher severity basis wins");
  assert(tensions[0].severity === 1.0, "Severity is 1.0 (clamped)");
}

// ─── 10. Bottleneck trending direction ──────────────────────────

console.log("\n10. Bottleneck trending maps direction correctly");
{
  const sol = makeSpeedOfLight([
    makeSenseCeiling("A", 9.0),
    makeSenseCeiling("B", 9.0),
    makeSenseCeiling("C", 9.0),
  ]);
  const trends = [
    makeSenseTrend("A", "down", 4.0),
    makeSenseTrend("B", "up", 4.0),
    makeSenseTrend("C", "stable", 4.0),
  ];
  const bottlenecks = detectBottlenecks(trends, sol);

  assert(bottlenecks.length === 3, "Three bottlenecks (all gap > 2)");

  const a = bottlenecks.find((b) => b.sense === "A")!;
  const b = bottlenecks.find((b) => b.sense === "B")!;
  const c = bottlenecks.find((b) => b.sense === "C")!;

  assert(a.trending === "worsening", "Down → worsening");
  assert(b.trending === "improving", "Up → improving");
  assert(c.trending === "stable", "Stable → stable");
}

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Prospective preparation smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
