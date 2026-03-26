/**
 * Norepinephrine Signal — Smoke Test
 *
 * Verifies the NE computation across all scenarios:
 *   1. Pure function: cold start, mature, novel, conviction erosion
 *   2. Risk factors: max-of-risks, individual factors
 *   3. Amygdala override
 *   4. Custom weights
 *   5. Clamping
 *   6. Scheduler integration: dispatch NE uses new function
 *   7. Full lifecycle: cold → mature → novel spike → conviction erosion
 *
 * Run: npx tsx examples/norepinephrine-smoke.ts
 */

import { computeNE, DEFAULT_NE_WEIGHTS, extractRiskFromSchedulerSignals } from "../src/kernel/norepinephrine.js";
import type { NEInputs, RiskFactors, NEWeights } from "../src/types/norepinephrine.js";

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

function assertApprox(value: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(value - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label} — got ${value.toFixed(4)}, expected ~${expected} ±${tolerance}`);
  }
}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (value >= min && value <= max) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label} — got ${value.toFixed(3)}, expected [${min}, ${max}]`);
  }
}

// ─── 1. Cold start (no inputs) ──────────────────────────────────

console.log("\n1. Cold start — no inputs");
{
  // No inputs: accuracy defaults 0.5, novelty defaults 1.0 (max), conviction defaults 0.5.
  // Max-blend with novelty 1.0 as max component → NE ~0.70 (deliberative — first task ever).
  const result = computeNE({});
  assertRange(result.ne, 0.65, 0.75, "No inputs → NE ~0.70 (max novelty drives deliberative)");
  assert(!result.components.amygdalaOverride, "No amygdala override");
  assertApprox(result.components.maturityComponent, 0.5, 0.01, "Maturity: 1 - 0.5 (default) = 0.5");
  assert(result.components.noveltyComponent === 1.0, "Novelty: 1 - 0 (default) = 1.0");
  assertApprox(result.components.convictionComponent, 0.5, 0.01, "Conviction: 1 - 0.5 (default) = 0.5");
}

// ─── 2. Cold start with cerebellum (no prediction) ──────────────

console.log("\n2. Cold start — cerebellum present but no prediction");
{
  // Cerebellum returns accuracy 0.8 on cold start, but no prediction → no bestSimilarity
  const result = computeNE({
    cerebellumAccuracy: 0.8,
    // bestSimilarity absent → novelty = 1.0
  });
  assertRange(result.ne, 0.55, 0.75, "Accuracy 0.8, max novelty → NE ~0.65 (deliberative)");
  assertApprox(result.components.maturityComponent, 0.2, 0.01, "Maturity: 1 - 0.8 = 0.2");
  assert(result.components.noveltyComponent === 1.0, "Novelty: max (no similar episodes)");
}

// ─── 3. Mature + routine ─────────────────────────────────────────

console.log("\n3. Mature system, routine task");
{
  const result = computeNE({
    cerebellumAccuracy: 0.9,
    bestSimilarity: 0.95,
    convictionLevel: 0.7,
  });
  assertRange(result.ne, 0.10, 0.25, "Mature + routine → NE ~0.18 (expedient territory)");
  assert(result.components.maturityComponent < 0.15, "Low maturity component");
  assert(result.components.noveltyComponent < 0.10, "Low novelty component");
}

// ─── 4. Mature + novel ──────────────────────────────────────────

console.log("\n4. Mature system, novel task");
{
  const result = computeNE({
    cerebellumAccuracy: 0.9,
    bestSimilarity: 0.1,
    convictionLevel: 0.6,
  });
  assertRange(result.ne, 0.45, 0.65, "Mature + novel → NE ~0.56 (democratic/deliberative)");
  assertApprox(result.components.noveltyComponent, 0.9, 0.01, "High novelty: 1 - 0.1 = 0.9");
  assertApprox(result.components.maturityComponent, 0.1, 0.01, "Low maturity: 1 - 0.9 = 0.1");
}

// ─── 5. Conviction erosion ──────────────────────────────────────

console.log("\n5. Conviction erosion across cycles");
{
  const base: NEInputs = {
    cerebellumAccuracy: 0.8,
    bestSimilarity: 0.7,
    risk: { wmPressure: 0.3 },
  };

  const highConviction = computeNE({ ...base, convictionLevel: 0.7 });
  const lowConviction = computeNE({ ...base, convictionLevel: 0.3 });
  const delta = lowConviction.ne - highConviction.ne;

  assertRange(delta, 0.10, 0.25, `Conviction 0.7→0.3 raises NE by ${delta.toFixed(3)}`);
  assert(lowConviction.ne > highConviction.ne, "Lower conviction → higher NE");
}

// ─── 6. Amygdala override ───────────────────────────────────────

console.log("\n6. Amygdala override");
{
  const result = computeNE({
    cerebellumAccuracy: 0.95,
    bestSimilarity: 0.99,
    convictionLevel: 0.9,
    amygdalaOverride: true,
  });
  assert(result.ne === 0.95, "Amygdala spike → NE 0.95 regardless of other signals");
  assert(result.components.amygdalaOverride === true, "Override flag set");
  assert(result.components.maturityComponent === 0, "Other components zeroed");
}

// ─── 7. Risk factors — max of risks ─────────────────────────────

console.log("\n7. Risk factors — max-of-risks behavior");
{
  const singleRisk = computeNE({
    cerebellumAccuracy: 0.8,
    bestSimilarity: 0.8,
    convictionLevel: 0.5,
    risk: { phaseGateProximity: 0.9 },
  });

  const multiRisk = computeNE({
    cerebellumAccuracy: 0.8,
    bestSimilarity: 0.8,
    convictionLevel: 0.5,
    risk: { phaseGateProximity: 0.9, wmPressure: 0.3, decliningTrends: 0.2 },
  });

  assert(
    Math.abs(singleRisk.ne - multiRisk.ne) < 0.01,
    "Max-of-risks: adding lower risks doesn't increase NE",
  );
  assert(singleRisk.components.riskComponent === 0.9, "Risk component = max = 0.9");
}

// ─── 8. Each risk factor independently ──────────────────────────

console.log("\n8. Individual risk factors raise NE");
{
  const baseline = computeNE({
    cerebellumAccuracy: 0.8,
    bestSimilarity: 0.7,
    convictionLevel: 0.5,
  });

  const riskFactors: (keyof RiskFactors)[] = [
    "phaseGateProximity",
    "dependencyFanOut",
    "decliningTrends",
    "wmPressure",
    "weightVolatility",
  ];

  for (const factor of riskFactors) {
    const withRisk = computeNE({
      cerebellumAccuracy: 0.8,
      bestSimilarity: 0.7,
      convictionLevel: 0.5,
      risk: { [factor]: 0.8 },
    });
    assert(withRisk.ne > baseline.ne, `${factor} at 0.8 raises NE above baseline`);
  }
}

// ─── 9. Custom weights override ─────────────────────────────────

console.log("\n9. Custom weights");
{
  const defaultResult = computeNE({
    cerebellumAccuracy: 0.5,
    bestSimilarity: 0.5,
    convictionLevel: 0.5,
  });

  // Heavy novelty weight
  const noveltyHeavy: NEWeights = { maturity: 0.1, risk: 0.1, novelty: 0.7, conviction: 0.1 };
  const customResult = computeNE(
    { cerebellumAccuracy: 0.5, bestSimilarity: 0.5, convictionLevel: 0.5 },
    noveltyHeavy,
  );

  assert(customResult.ne !== defaultResult.ne, "Custom weights produce different NE");
}

// ─── 10. Clamping ───────────────────────────────────────────────

console.log("\n10. Clamping");
{
  // Extreme inputs shouldn't produce NE < 0 or > 1
  const maxInputs = computeNE({
    cerebellumAccuracy: 0,
    bestSimilarity: 0,
    convictionLevel: 0,
    risk: { phaseGateProximity: 1, dependencyFanOut: 1, decliningTrends: 1, wmPressure: 1, weightVolatility: 1 },
  });
  assert(maxInputs.ne <= 1.0, `Max inputs → NE ${maxInputs.ne.toFixed(3)} ≤ 1.0`);
  assert(maxInputs.ne >= 0.0, `Max inputs → NE ${maxInputs.ne.toFixed(3)} ≥ 0.0`);

  const minInputs = computeNE({
    cerebellumAccuracy: 1.0,
    bestSimilarity: 1.0,
    convictionLevel: 1.0,
  });
  assert(minInputs.ne >= 0.0, `Min inputs → NE ${minInputs.ne.toFixed(3)} ≥ 0.0`);
  assert(minInputs.ne <= 0.05, `Min inputs → NE ${minInputs.ne.toFixed(3)} near zero`);
}

// ─── 11. extractRiskFromSchedulerSignals ─────────────────────────

console.log("\n11. Risk extraction from scheduler signals");
{
  const signals = {
    taskGraph: [
      { task: { id: "t1" }, phaseGroup: "p1" },
      { task: { id: "t2" }, phaseGroup: "p1" },
      { task: { id: "t3" }, phaseGroup: "p1" },
      { task: { id: "t4" }, dependsOn: ["t1"] },
    ] as Array<{ task: { id: string }; phaseGroup?: string; dependsOn?: string[] }>,
    completedTaskIds: new Set(["t2"]),
    escalatedTaskIds: new Set<string>(),
    wmSnapshot: {
      senseTrends: [
        { direction: "down" },
        { direction: "up" },
        { direction: "down" },
      ] as Array<{ direction: string }>,
      load: 0.7,
    },
    vitals: { weightVolatility: 0.4 },
  };

  // t1 is in phase group p1, t2 is completed in p1 (1 of 3)
  // t4 depends on t1 (1 dependent / 3 remaining)
  const risk = extractRiskFromSchedulerSignals("t1", "p1", 1, signals);

  assertRange(risk.phaseGateProximity!, 0.3, 0.4, "Phase gate: 1/3 complete ≈ 0.33");
  assertRange(risk.dependencyFanOut!, 0.3, 0.4, "Fan-out: 1/3 remaining ≈ 0.33");
  assertRange(risk.decliningTrends!, 0.6, 0.7, "Declining: 2/3 ≈ 0.67");
  assert(risk.wmPressure === 0.7, "WM pressure passthrough: 0.7");
  assert(risk.weightVolatility === 0.4, "Weight volatility passthrough: 0.4");
}

// ─── 12. Full lifecycle simulation ──────────────────────────────

console.log("\n12. Full lifecycle: cold start → mature → novel → conviction drop");
{
  // Task 1: cold start (no cerebellum data)
  const task1 = computeNE({});
  assertRange(task1.ne, 0.60, 0.80, `Task 1 (cold start): NE ${task1.ne.toFixed(3)}`);

  // Task 5: system learning (accuracy 0.6, some familiarity)
  const task5 = computeNE({
    cerebellumAccuracy: 0.6,
    bestSimilarity: 0.4,
    convictionLevel: 0.6,
  });
  assert(task5.ne < task1.ne, `Task 5: NE ${task5.ne.toFixed(3)} < task 1 ${task1.ne.toFixed(3)}`);

  // Task 20: mature system, routine
  const task20 = computeNE({
    cerebellumAccuracy: 0.85,
    bestSimilarity: 0.9,
    convictionLevel: 0.7,
  });
  assertRange(task20.ne, 0.10, 0.30, `Task 20 (mature routine): NE ${task20.ne.toFixed(3)}`);

  // Task 21: novel task arrives on mature system
  const task21 = computeNE({
    cerebellumAccuracy: 0.85,
    bestSimilarity: 0.15,
    convictionLevel: 0.5,
  });
  assert(task21.ne > task20.ne + 0.15, `Task 21 (novel spike): NE ${task21.ne.toFixed(3)} >> task 20`);

  // Task 21, cycle 3: conviction drops
  const task21c3 = computeNE({
    cerebellumAccuracy: 0.85,
    bestSimilarity: 0.15,
    convictionLevel: 0.2,
  });
  assert(
    task21c3.ne > task21.ne,
    `Task 21 cycle 3 (conviction erosion): NE ${task21c3.ne.toFixed(3)} > ${task21.ne.toFixed(3)}`,
  );

  // Accuracy degrades (environment changed) → training wheels back on
  const degraded = computeNE({
    cerebellumAccuracy: 0.4,
    bestSimilarity: 0.5,
    convictionLevel: 0.5,
  });
  assert(
    degraded.ne > task20.ne,
    `Accuracy degraded: NE ${degraded.ne.toFixed(3)} > mature routine ${task20.ne.toFixed(3)}`,
  );
}

// ─── 13. Gate strategy alignment ─────────────────────────────────

console.log("\n13. Gate strategy alignment");
{
  // Expedient territory (< 0.3)
  const expedient = computeNE({
    cerebellumAccuracy: 0.9,
    bestSimilarity: 0.95,
    convictionLevel: 0.8,
  });
  assert(expedient.ne < 0.3, `Routine → expedient territory: NE ${expedient.ne.toFixed(3)} < 0.3`);

  // Deliberative territory (> 0.7)
  const deliberative = computeNE({
    cerebellumAccuracy: 0.3,
    bestSimilarity: 0.1,
    convictionLevel: 0.3,
  });
  assert(deliberative.ne > 0.7, `Novel + immature + low conviction → deliberative: NE ${deliberative.ne.toFixed(3)} > 0.7`);
}

// ─── Results ─────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
