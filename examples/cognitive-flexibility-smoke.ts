/**
 * Cognitive Flexibility — Smoke Test
 *
 * Verifies:
 *   1. FlexibilityContext type construction
 *   2. FlexibilityAssessment shape validation
 *   3. ResetDirective flows through types
 *   4. Diagnosis → action mapping logic
 *   5. Approach history tracking patterns
 *   6. Integration with conviction evidence types
 *
 * Note: The LLM call in CognitiveFlexibility.assess() cannot be tested
 * without a live API. This smoke test validates the type system and
 * data flow patterns, not the LLM reasoning.
 *
 * Run: npx tsx examples/cognitive-flexibility-smoke.ts
 */

import type {
  FlexibilityContext,
  FlexibilityAssessment,
  FlexibilityDiagnosis,
  ResetDirective,
  ApproachHistoryEntry,
} from "../src/types/cognitive-flexibility.js";
import type { ConvictionResult, ConvictionEvidence } from "../src/types/conviction.js";
import type { SpeedOfLight, SenseCeiling, ApproachCeiling } from "../src/types/cerebellum.js";
import type { WeightedComposite } from "../src/kernel/evaluation-weighter.js";
import type { Task } from "../src/types/task.js";
import { createTask } from "../src/types/task.js";

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

function makeConvictionResult(
  verdict: "proceed" | "reshape" | "escalate",
  level: number,
  evidenceSources: ConvictionEvidence["source"][] = [],
): ConvictionResult {
  return {
    verdict,
    level,
    delta: -0.1,
    evidence: evidenceSources.map((source) => ({
      source,
      description: `${source} triggered`,
      magnitude: 0.5,
      valence: "undermines" as const,
    })),
    shaping: {
      notes: ["test shaping"],
      reshapeGuidance: verdict === "reshape" ? "approach needs rethinking" : undefined,
      escalationReason: verdict === "escalate" ? "conviction too low" : undefined,
    },
    decidingStep: "conviction",
  };
}

function makeComposite(weightedMean: number): WeightedComposite {
  return {
    weightedMean,
    weightedAcceptability: weightedMean / 10,
    confidence: weightedMean / 10,
    meanStake: 0.7,
    evaluations: [],
  };
}

function makeSpeedOfLight(ceiling: number, bestAchieved: number | null): SpeedOfLight {
  const senseCeiling: SenseCeiling = {
    senseName: "Design",
    senseId: "design",
    stake: 0.8,
    ceiling,
    ceilingRationale: "test constraint",
    bestAchieved,
    gap: bestAchieved !== null ? ceiling - bestAchieved : null,
  };
  return {
    taskId: "test",
    perSense: [senseCeiling],
    compositeCeiling: ceiling,
    compositeBestAchieved: bestAchieved,
    compositeGap: bestAchieved !== null ? ceiling - bestAchieved : null,
    hasHistory: bestAchieved !== null,
    computedAt: new Date(),
  };
}

function makeFlexContext(overrides?: Partial<FlexibilityContext>): FlexibilityContext {
  return {
    conviction: makeConvictionResult("reshape", 0.35, ["approach-bottleneck", "oscillation"]),
    previousConviction: makeConvictionResult("proceed", 0.6),
    composite: makeComposite(5.0),
    tensions: [],
    oscillations: [],
    cycle: 3,
    approachHistory: [
      { approach: "Card grid layout with image-first design", bestComposite: 5.2 },
    ],
    speedOfLight: makeSpeedOfLight(8.5, 7.0),
    worldModelMaxims: ["Visual density and load time are in genuine tension on this project"],
    task: createTask("task-1", "Build the portfolio gallery page"),
    ...overrides,
  };
}

// ─── 1. FlexibilityContext construction ──────────────────────────

console.log("\n1. FlexibilityContext construction");
{
  const ctx = makeFlexContext();
  assert(ctx.conviction.verdict === "reshape", "conviction is reshape");
  assert(ctx.cycle === 3, "cycle is 3");
  assert(ctx.approachHistory.length === 1, "1 approach in history");
  assert(ctx.speedOfLight !== null, "speed of light present");
  assert(ctx.worldModelMaxims.length === 1, "1 world model maxim");
  assert(ctx.task.id === "task-1", "task id correct");
}

// ─── 2. FlexibilityAssessment shape ─────────────────────────────

console.log("\n2. FlexibilityAssessment shape validation");
{
  // Strategy-limited with reset
  const strategyLimited: FlexibilityAssessment = {
    diagnosis: "strategy-limited",
    reasoning: "Card grid layout can't achieve 8/10 Design because mobile screen forces compromises. Progressive enhancement would adapt better.",
    shouldReset: true,
    resetDirective: {
      avoidApproaches: ["component-based-layout"],
      suggestedDirection: "Use progressive enhancement — start mobile-first, enhance for larger screens",
      retainFromCurrent: ["image-first visual language", "dark color palette"],
    },
    shouldEscalate: false,
  };

  assert(strategyLimited.diagnosis === "strategy-limited", "diagnosis correct");
  assert(strategyLimited.shouldReset, "shouldReset true");
  assert(strategyLimited.resetDirective!.avoidApproaches.length === 1, "1 approach to avoid");
  assert(!strategyLimited.shouldEscalate, "not escalating");

  // Execution problem — no reset
  const executionProblem: FlexibilityAssessment = {
    diagnosis: "execution-problem",
    reasoning: "Approach is sound but image optimization is poor. Focus revision on image compression.",
    shouldReset: false,
    shouldEscalate: false,
  };

  assert(!executionProblem.shouldReset, "execution problem → no reset");
  assert(executionProblem.resetDirective === undefined, "no directive for execution problem");

  // Irreconcilable — escalate
  const irreconcilable: FlexibilityAssessment = {
    diagnosis: "irreconcilable",
    reasoning: "Client wants 60fps animations AND sub-1s load time on 3G. These are physically incompatible.",
    shouldReset: false,
    shouldEscalate: true,
    escalationContext: "Design ceiling (8) and Performance ceiling (7) are both constrained by the same resource budget. No approach can satisfy both.",
  };

  assert(irreconcilable.shouldEscalate, "irreconcilable → escalate");
  assert(irreconcilable.escalationContext !== undefined, "escalation context present");
}

// ─── 3. ResetDirective structure ─────────────────────────────────

console.log("\n3. ResetDirective structure");
{
  const directive: ResetDirective = {
    avoidApproaches: ["component-based-layout", "visual-design-heavy"],
    suggestedDirection: "API-first approach: build data layer first, render progressively",
    retainFromCurrent: ["dark palette", "typography choices"],
  };

  assert(directive.avoidApproaches.length === 2, "2 approaches to avoid");
  assert(directive.suggestedDirection.length > 0, "direction is non-empty");
  assert(directive.retainFromCurrent.length === 2, "2 things to retain");
}

// ─── 4. Diagnosis → action mapping ──────────────────────────────

console.log("\n4. Diagnosis → action mapping");
{
  const diagnoses: FlexibilityDiagnosis[] = [
    "execution-problem",
    "strategy-limited",
    "tension-evasion",
    "irreconcilable",
  ];

  assert(diagnoses.length === 4, "4 diagnosis types");

  // Execution problem → no reset, no escalate
  // Strategy limited → reset (usually)
  // Tension evasion → reset (re-engage suppressed sense)
  // Irreconcilable → escalate

  // These are conventions, not hard rules — the LLM decides. But verify
  // the type system supports all combinations.
  const resetWithEscalate: FlexibilityAssessment = {
    diagnosis: "irreconcilable",
    reasoning: "test",
    shouldReset: false,
    shouldEscalate: true,
    escalationContext: "test",
  };
  assert(resetWithEscalate.shouldEscalate, "escalate overrides reset");

  const tensionEvasion: FlexibilityAssessment = {
    diagnosis: "tension-evasion",
    reasoning: "Design sense was suppressed to avoid conflict with Performance",
    shouldReset: true,
    resetDirective: {
      avoidApproaches: [],
      suggestedDirection: "Re-engage Design sense. Find genuine synthesis between visual richness and load performance.",
      retainFromCurrent: ["performance optimizations"],
    },
    shouldEscalate: false,
  };
  assert(tensionEvasion.shouldReset, "tension evasion → reset to re-engage");
}

// ─── 5. Approach history patterns ────────────────────────────────

console.log("\n5. Approach history patterns");
{
  const history: ApproachHistoryEntry[] = [
    { approach: "Card grid with lazy loading", bestComposite: 5.2 },
    { approach: "Progressive enhancement mobile-first", bestComposite: 6.8 },
    { approach: "Server-side rendered with hydration", bestComposite: 4.1 },
  ];

  assert(history.length === 3, "3 approaches tried");

  // Best approach was #2
  const best = history.reduce((a, b) => a.bestComposite > b.bestComposite ? a : b);
  assert(best.approach.includes("Progressive"), "progressive was best approach");
  assert(best.bestComposite === 6.8, "best composite was 6.8");

  // If all approaches failed to reach ceiling (8.5), that's evidence for strategy issues
  const ceiling = 8.5;
  const allBelowCeiling = history.every((h) => h.bestComposite < ceiling);
  assert(allBelowCeiling, "all approaches below ceiling");
  const noneTouchedCeiling = history.every((h) => h.bestComposite < ceiling * 0.9);
  assert(noneTouchedCeiling, "no approach reached 90% of ceiling");
}

// ─── 6. Integration with conviction evidence ─────────────────────

console.log("\n6. Integration with conviction evidence");
{
  const ctx = makeFlexContext({
    conviction: makeConvictionResult("reshape", 0.3, [
      "approach-bottleneck",
      "oscillation",
      "score-stagnation",
    ]),
  });

  const evidence = ctx.conviction.evidence;
  assert(evidence.length === 3, "3 pieces of evidence");
  assert(evidence.some((e) => e.source === "approach-bottleneck"), "has approach-bottleneck evidence");
  assert(evidence.some((e) => e.source === "oscillation"), "has oscillation evidence");
  assert(evidence.some((e) => e.source === "score-stagnation"), "has stagnation evidence");

  // Approach bottleneck + oscillation = strong signal for strategy-limited
  const hasBottleneck = evidence.some((e) => e.source === "approach-bottleneck");
  const hasOscillation = evidence.some((e) => e.source === "oscillation");
  assert(hasBottleneck && hasOscillation, "bottleneck + oscillation = strategy-limited signal");
}

// ─── 7. Speed of light with approach ceiling ─────────────────────

console.log("\n7. Speed of light with approach-specific ceiling");
{
  const sol = makeSpeedOfLight(8.5, 7.0);

  // Add approach-specific ceiling
  const approachCeiling: ApproachCeiling = {
    approachTags: ["component-based-layout"],
    perSense: [{ senseName: "Design", bestAchieved: 5.5 }],
    compositeBestAchieved: 5.5,
    episodesConsidered: 3,
    approachIsBottleneck: true,
    bottleneckGap: 1.5,
  };
  sol.approachSpecific = approachCeiling;

  assert(sol.approachSpecific.approachIsBottleneck, "approach is bottleneck");
  assert(sol.approachSpecific.bottleneckGap === 1.5, "bottleneck gap is 1.5");

  // The gap between overall best (7.0) and approach best (5.5) is 1.5
  // This means this approach class consistently underperforms
  const gap = sol.compositeBestAchieved! - sol.approachSpecific.compositeBestAchieved!;
  assert(gap === 1.5, `overall vs approach gap = 1.5 (got ${gap})`);
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  Cognitive Flexibility smoke test: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
