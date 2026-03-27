/**
 * Dopamine Signal — Smoke Test
 *
 * Verifies the full dopamine distribution protocol:
 *   1. TonicTracker — EMA convergence, per-project isolation, trend detection
 *   2. Projection functions — hippocampal, striatal, plasticity, prefrontal
 *   3. computeProjections() — composite produces all four projections
 *   4. Significance migration — encodingStrength matches old formula
 *   5. Plasticity projection — preserves the old applyDopamineToWeights behavior
 *   6. Tonic vital sign — maps unbounded tonic to 0–1 range
 *   7. Persistence — serialize/restore roundtrip
 *
 * Run: npx tsx examples/dopamine-smoke.ts
 */

import { TonicTracker } from "../src/subcortical/tonic.js";
import {
  projectToHippocampus,
  projectToStriatum,
  projectToPlasticity,
  projectToPrefrontal,
  computeProjections,
} from "../src/subcortical/projections.js";
import type { DopamineSignal, ReceptorDopamine } from "../src/types/cerebellum.js";
import type { TonicDopamine } from "../src/types/dopamine.js";
import { DEFAULT_TONIC_CONFIG } from "../src/types/dopamine.js";

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

function approx(a: number, b: number, epsilon = 0.001): boolean {
  return Math.abs(a - b) < epsilon;
}

// ─── Test data factories ─────────────────────────────────────────

function makeSignal(overrides?: Partial<DopamineSignal>): DopamineSignal {
  return {
    taskId: "task-1",
    perReceptor: [
      {
        receptorId: "design.visual-harmony",
        predicted: 6,
        actual: 8,
        delta: 2,
        confidence: 0.7,
      },
      {
        receptorId: "content-craft.clarity",
        predicted: 7,
        actual: 5,
        delta: -2,
        confidence: 0.8,
      },
    ],
    aggregate: 0.5,
    rawAggregate: 0.6,
    predictionConfidence: 0.75,
    ...overrides,
  };
}

function makeTonic(overrides?: Partial<TonicDopamine>): TonicDopamine {
  return {
    level: 0,
    trend: "stable",
    sampleCount: 5,
    projectId: "proj-1",
    lastUpdated: new Date(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 1. TonicTracker: EMA convergence ===");
{
  const tracker = new TonicTracker({ alpha: 0.3, trendWindow: 4, trendThreshold: 0.15 });

  // Unknown project → neutral
  const neutral = tracker.get("proj-unknown");
  assert(neutral.level === 0, "Unknown project has level 0");
  assert(neutral.trend === "stable", "Unknown project trend is stable");
  assert(neutral.sampleCount === 0, "Unknown project has 0 samples");

  // Feed consistent positive signals → tonic rises
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);

  const positive = tracker.get("proj-1");
  assert(positive.level > 1.0, `Tonic rises with positive signals: ${positive.level.toFixed(3)}`);
  assert(positive.sampleCount === 5, "Sample count tracks updates");

  // Feed consistent negative signals → tonic falls
  const tracker2 = new TonicTracker({ alpha: 0.3, trendWindow: 4, trendThreshold: 0.15 });
  tracker2.update("proj-2", -2.0);
  tracker2.update("proj-2", -2.0);
  tracker2.update("proj-2", -2.0);
  tracker2.update("proj-2", -2.0);
  tracker2.update("proj-2", -2.0);

  const negative = tracker2.get("proj-2");
  assert(negative.level < -1.0, `Tonic falls with negative signals: ${negative.level.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 2. TonicTracker: per-project isolation ===");
{
  const tracker = new TonicTracker();

  tracker.update("proj-A", 3.0);
  tracker.update("proj-A", 3.0);
  tracker.update("proj-B", -3.0);
  tracker.update("proj-B", -3.0);

  const a = tracker.get("proj-A");
  const b = tracker.get("proj-B");

  assert(a.level > 0, `Project A tonic positive: ${a.level.toFixed(3)}`);
  assert(b.level < 0, `Project B tonic negative: ${b.level.toFixed(3)}`);
  assert(a.projectId === "proj-A", "Project A ID correct");
  assert(b.projectId === "proj-B", "Project B ID correct");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 3. TonicTracker: trend detection ===");
{
  const tracker = new TonicTracker({ alpha: 0.5, trendWindow: 3, trendThreshold: 0.1 });

  // Not enough data → stable
  tracker.update("proj-trend", 1.0);
  assert(tracker.get("proj-trend").trend === "stable", "Insufficient data → stable");

  // Rising: feed increasing signals
  tracker.update("proj-trend", 2.0);
  tracker.update("proj-trend", 3.0);
  tracker.update("proj-trend", 4.0);
  assert(tracker.get("proj-trend").trend === "rising", "Increasing signals → rising");

  // Falling: feed negative signals to reverse
  tracker.update("proj-trend", -5.0);
  tracker.update("proj-trend", -5.0);
  tracker.update("proj-trend", -5.0);
  tracker.update("proj-trend", -5.0);
  assert(tracker.get("proj-trend").trend === "falling", "Negative reversal → falling");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 4. Hippocampal projection ===");
{
  const tonic = makeTonic({ level: 0 });

  // encodingStrength matches old computeSignificance formula
  const signalSmall = makeSignal({ aggregate: 1.5 });
  const projSmall = projectToHippocampus(signalSmall, tonic);
  const expectedSmall = Math.min(1, Math.abs(1.5) / 3);
  assert(approx(projSmall.encodingStrength, expectedSmall), `Small signal: encodingStrength=${projSmall.encodingStrength.toFixed(3)} matches ${expectedSmall.toFixed(3)}`);

  const signalLarge = makeSignal({ aggregate: 5.0 });
  const projLarge = projectToHippocampus(signalLarge, tonic);
  assert(projLarge.encodingStrength === 1.0, "Large signal saturates at 1.0");

  const signalZero = makeSignal({ aggregate: 0 });
  const projZero = projectToHippocampus(signalZero, tonic);
  assert(projZero.encodingStrength === 0, "Zero signal → zero encoding strength");

  // Negative signal → same encoding strength (absolute value)
  const signalNeg = makeSignal({ aggregate: -2.0 });
  const projNeg = projectToHippocampus(signalNeg, tonic);
  const expectedNeg = Math.min(1, 2.0 / 3);
  assert(approx(projNeg.encodingStrength, expectedNeg), "Negative signal uses absolute value");

  // consolidationUrgency: negative tonic → higher urgency
  const tonicNeg = makeTonic({ level: -1.5 });
  const projUrgent = projectToHippocampus(signalSmall, tonicNeg);
  assert(projUrgent.consolidationUrgency > 0.5, `Negative tonic increases urgency: ${projUrgent.consolidationUrgency.toFixed(3)}`);

  // consolidationUrgency: positive tonic → baseline urgency
  const tonicPos = makeTonic({ level: 1.0 });
  const projCalm = projectToHippocampus(signalSmall, tonicPos);
  assert(approx(projCalm.consolidationUrgency, 0.1), `Positive tonic → baseline urgency: ${projCalm.consolidationUrgency.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 5. Striatal projection ===");
{
  const tonic = makeTonic({ level: 0 });

  // Positive aggregate → positive reinforcement
  const posSignal = makeSignal({ aggregate: 2.0 });
  const posProj = projectToStriatum(posSignal, tonic);
  assert(posProj.reinforcement > 0.9, `Positive signal → reinforcement ${posProj.reinforcement.toFixed(3)}`);

  // Negative aggregate → negative reinforcement
  const negSignal = makeSignal({ aggregate: -2.0 });
  const negProj = projectToStriatum(negSignal, tonic);
  assert(negProj.reinforcement < -0.9, `Negative signal → reinforcement ${negProj.reinforcement.toFixed(3)}`);

  // Zero aggregate → near-zero reinforcement
  const zeroSignal = makeSignal({ aggregate: 0 });
  const zeroProj = projectToStriatum(zeroSignal, tonic);
  assert(Math.abs(zeroProj.reinforcement) < 0.01, "Zero signal → zero reinforcement");

  // Reinforcement is bounded by tanh to [-1, +1]
  const hugeSignal = makeSignal({ aggregate: 100 });
  const hugeProj = projectToStriatum(hugeSignal, tonic);
  assert(hugeProj.reinforcement <= 1.0, "Reinforcement capped at 1.0");

  // explorationBias: negative tonic → more exploration
  const tonicNeg = makeTonic({ level: -1.0 });
  const exploreProj = projectToStriatum(posSignal, tonicNeg);
  assert(exploreProj.explorationBias === 0.9, `Negative tonic → exploration bias ${exploreProj.explorationBias.toFixed(3)}`);

  // explorationBias: positive tonic → more leveraging
  const tonicPos = makeTonic({ level: 1.0 });
  const leverageProj = projectToStriatum(posSignal, tonicPos);
  assert(leverageProj.explorationBias === 0.1, `Positive tonic → leveraging bias ${leverageProj.explorationBias.toFixed(3)}`);

  // explorationBias: neutral tonic → balanced
  assert(approx(posProj.explorationBias, 0.5), `Neutral tonic → balanced: ${posProj.explorationBias.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 6. Plasticity projection ===");
{
  const tonic = makeTonic({ level: 0 });
  const signal = makeSignal();

  const proj = projectToPlasticity(signal, tonic);

  // Learning rate scales with |aggregate| × confidence
  assert(proj.learningRate > 0, `Learning rate positive: ${proj.learningRate.toFixed(4)}`);
  assert(proj.learningRate <= 0.15, `Learning rate capped: ${proj.learningRate.toFixed(4)}`);

  // Per-receptor deltas present
  assert(proj.perReceptor.length === 2, `Two receptor deltas: ${proj.perReceptor.length}`);

  // Positive delta receptor: actual > predicted → positive weight delta
  const designReceptor = proj.perReceptor.find(r => r.receptorId === "design.visual-harmony");
  assert(designReceptor !== undefined, "Design receptor found");
  assert(designReceptor!.delta > 0, `Undervalued sense → positive delta: ${designReceptor!.delta.toFixed(4)}`);

  // Negative delta receptor: actual < predicted → negative weight delta
  const contentReceptor = proj.perReceptor.find(r => r.receptorId === "content-craft.clarity");
  assert(contentReceptor !== undefined, "Content receptor found");
  assert(contentReceptor!.delta < 0, `Overvalued sense → negative delta: ${contentReceptor!.delta.toFixed(4)}`);

  // Zero aggregate → zero learning rate
  const zeroSignal = makeSignal({ aggregate: 0, predictionConfidence: 0.8 });
  const zeroProj = projectToPlasticity(zeroSignal, tonic);
  assert(zeroProj.learningRate === 0, "Zero aggregate → zero learning rate");

  // Confidence modulation: high confidence wrong prediction → bigger delta
  const hiConfReceptor: ReceptorDopamine = { receptorId: "r1", predicted: 5, actual: 8, delta: 3, confidence: 1.0 };
  const loConfReceptor: ReceptorDopamine = { receptorId: "r2", predicted: 5, actual: 8, delta: 3, confidence: 0.2 };
  const hiConfSignal = makeSignal({ perReceptor: [hiConfReceptor], aggregate: 2.0 });
  const loConfSignal = makeSignal({ perReceptor: [loConfReceptor], aggregate: 2.0 });
  const hiConfProj = projectToPlasticity(hiConfSignal, tonic);
  const loConfProj = projectToPlasticity(loConfSignal, tonic);
  assert(
    Math.abs(hiConfProj.perReceptor[0].delta) > Math.abs(loConfProj.perReceptor[0].delta),
    "Higher confidence → larger delta magnitude",
  );
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 7. Prefrontal projection ===");
{
  const tonic = makeTonic({ level: 0 });

  // Large surprise → high WM gating
  const bigSignal = makeSignal({ aggregate: 3.0 });
  const bigProj = projectToPrefrontal(bigSignal, tonic);
  assert(bigProj.wmGateStrength === 1.0, `Large surprise → max gating: ${bigProj.wmGateStrength}`);

  // Zero surprise → baseline gating (0.2)
  const zeroSignal = makeSignal({ aggregate: 0 });
  const zeroProj = projectToPrefrontal(zeroSignal, tonic);
  assert(approx(zeroProj.wmGateStrength, 0.2), `Zero surprise → baseline gating: ${zeroProj.wmGateStrength.toFixed(3)}`);

  // Bounded 0-1
  assert(bigProj.wmGateStrength <= 1.0, "WM gate strength <= 1.0");
  assert(zeroProj.wmGateStrength >= 0, "WM gate strength >= 0");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 8. computeProjections composite ===");
{
  const signal = makeSignal({ aggregate: 1.5 });
  const tonic = makeTonic({ level: -0.5 });

  const projections = computeProjections(signal, tonic);

  assert(projections.taskId === "task-1", "taskId propagated");
  assert(projections.phasicAggregate === 1.5, "phasicAggregate propagated");
  assert(projections.tonic.level === -0.5, "tonic propagated");

  // All four projections present
  assert(projections.hippocampal.encodingStrength > 0, "Hippocampal projection present");
  assert(projections.striatal.reinforcement > 0, "Striatal projection present");
  assert(projections.plasticity.learningRate > 0, "Plasticity projection present");
  assert(projections.prefrontal.wmGateStrength > 0, "Prefrontal projection present");

  // Negative tonic should affect striatal explorationBias
  assert(projections.striatal.explorationBias > 0.5, "Negative tonic biases toward exploration");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 9. Tonic vital sign mapping ===");
{
  // Verify the mapping from unbounded tonic to 0-1 vital sign
  // Formula from hooks.ts: 0.5 + level / 6, clamped [0, 1]
  function tonicToVital(level: number): number {
    return Math.max(0, Math.min(1, 0.5 + level / 6));
  }

  assert(approx(tonicToVital(0), 0.5), "Neutral tonic → 0.5 vital");
  assert(approx(tonicToVital(3), 1.0), "Tonic +3 → 1.0 vital");
  assert(approx(tonicToVital(-3), 0.0), "Tonic -3 → 0.0 vital");
  assert(approx(tonicToVital(-1), 0.333, 0.01), "Tonic -1 → ~0.33 vital");
  assert(approx(tonicToVital(1), 0.667, 0.01), "Tonic +1 → ~0.67 vital");

  // Default threshold is 0.25, so tonic of -2 should trigger flag-pfc
  assert(tonicToVital(-2.0) < 0.25, "Tonic -2.0 → below threshold → flags PFC");
  assert(approx(tonicToVital(-1.5), 0.25), "Tonic -1.5 → exactly at threshold boundary");
  assert(tonicToVital(-0.5) > 0.25, "Tonic -0.5 → above threshold → no flag");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 10. Tonic persistence roundtrip ===");
{
  const tracker = new TonicTracker();
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);
  tracker.update("proj-1", 2.0);
  tracker.update("proj-2", -1.0);

  const snapshot = tracker.serialize();
  assert(snapshot.projects.length === 2, `Snapshot has 2 projects: ${snapshot.projects.length}`);
  assert(snapshot.config.alpha === DEFAULT_TONIC_CONFIG.alpha, "Config preserved in snapshot");

  const restored = new TonicTracker();
  restored.restore(snapshot);

  const p1 = restored.get("proj-1");
  const originalP1 = tracker.get("proj-1");
  assert(approx(p1.level, originalP1.level), `Restored level matches: ${p1.level.toFixed(3)} ≈ ${originalP1.level.toFixed(3)}`);
  assert(p1.sampleCount === originalP1.sampleCount, "Restored sample count matches");

  // Trend resets on restore (ring buffer lost) but rebuilds from new signals
  assert(p1.trend === "stable", "Trend resets to stable after restore");
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n=== 11. EMA math verification ===");
{
  const alpha = 0.3;
  const tracker = new TonicTracker({ alpha, trendWindow: 4, trendThreshold: 0.15 });

  // Manual EMA calculation
  let expected = 0;
  const signals = [1.0, 2.0, -1.0, 0.5, 3.0];

  for (const signal of signals) {
    expected = alpha * signal + (1 - alpha) * expected;
    tracker.update("ema-test", signal);
  }

  const actual = tracker.get("ema-test");
  assert(approx(actual.level, expected, 0.0001), `EMA matches manual: ${actual.level.toFixed(6)} ≈ ${expected.toFixed(6)}`);
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "─".repeat(50));
console.log(`Dopamine smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
