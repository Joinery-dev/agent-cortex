/**
 * PlasticityStore Implementation — Smoke Test
 *
 * Tests the real PlasticityStoreImpl (Feature #19):
 *   1. registerAll + template expansion
 *   2. get / getByCategory / update / clamping
 *   3. Relative normalization after updates
 *   4. Decay toward category mean
 *   5. Settle volatile weights
 *   6. Volatility computation
 *   7. Snapshot / restore roundtrip
 *   8. StakeAdjuster wiring pattern
 *   9. Dopamine → weight update flow
 *
 * Run: npx tsx examples/plasticity-store-smoke.ts
 */

import {
  PlasticityStoreImpl,
} from "../src/subcortical/plasticity-store.js";
import type { PlasticWeight } from "../src/types/plasticity.js";
import { PLASTIC_CONNECTIONS } from "../src/types/plasticity.js";

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

// ─── 1. registerAll + template expansion ──────────────────────

console.log("1. registerAll + template expansion");
{
  const store = new PlasticityStoreImpl();
  const senseIds = ["design", "performance", "security"];
  store.registerAll(new Map([["evaluator.sense-weight", senseIds]]));

  // Non-template connections are registered
  assert(
    store.get("thalamus.routing.hippocampus") !== undefined,
    "thalamus.routing.hippocampus registered",
  );
  assert(
    store.get("basal-ganglia.threshold.aggressiveness") !== undefined,
    "basal-ganglia.threshold.aggressiveness registered",
  );

  // Template expanded per entity
  assert(
    store.get("evaluator.sense-weight.design") !== undefined,
    "evaluator.sense-weight.design expanded",
  );
  assert(
    store.get("evaluator.sense-weight.performance") !== undefined,
    "evaluator.sense-weight.performance expanded",
  );
  assert(
    store.get("evaluator.sense-weight.security") !== undefined,
    "evaluator.sense-weight.security expanded",
  );

  // Raw template ID is NOT registered (only expanded instances)
  assert(
    store.get("evaluator.sense-weight") === undefined,
    "raw template ID not registered",
  );

  // Expanded weights in relative category sum to target (1.0)
  const evalWeights = store.getByCategory("evaluation-influence");
  assert(evalWeights.length === 3, `3 evaluation-influence weights (got ${evalWeights.length})`);
  const evalSum = evalWeights.reduce((s, w) => s + w.value, 0);
  assert(
    Math.abs(evalSum - 1.0) < 0.001,
    `evaluation-influence sum = 1.0 (got ${evalSum.toFixed(4)})`,
  );

  // Each sense gets equal share: 1/3
  const designWeight = store.get("evaluator.sense-weight.design")!;
  assert(
    Math.abs(designWeight.value - 1 / 3) < 0.001,
    `each sense gets 1/3 (got ${designWeight.value.toFixed(4)})`,
  );

  // Total count: 16 non-template + 3 expanded = 19
  // (17 declarations - 1 template + 3 entities)
  const nonTemplateCount = PLASTIC_CONNECTIONS.filter(
    (c) => !("perEntity" in c && c.perEntity),
  ).length;
  assert(
    store.size === nonTemplateCount + 3,
    `total ${nonTemplateCount + 3} weights (got ${store.size})`,
  );
}

// ─── 2. get / getByCategory / update / clamping ──────────────

console.log("\n2. get / getByCategory / update / clamping");
{
  const store = new PlasticityStoreImpl();
  store.registerAll(new Map([["evaluator.sense-weight", ["a", "b"]]]));

  // Basic get
  const w = store.get("basal-ganglia.threshold.aggressiveness")!;
  assert(w.value === 0.5, `default value 0.5 (got ${w.value})`);

  // Update
  const newVal = store.update("basal-ganglia.threshold.aggressiveness", 0.1, "dopamine", "task-1");
  assert(Math.abs(newVal - 0.6) < 0.001, `updated to 0.6 (got ${newVal})`);

  // Delta recorded
  const after = store.get("basal-ganglia.threshold.aggressiveness")!;
  assert(after.recentDeltas.length === 1, "delta recorded");
  assert(after.recentDeltas[0].source === "dopamine", "source is dopamine");
  assert(after.recentDeltas[0].context === "task-1", "context preserved");

  // Clamping at max
  store.update("basal-ganglia.threshold.aggressiveness", 0.5, "dopamine"); // 0.6 + 0.5 = 1.1 → 1.0
  assert(store.get("basal-ganglia.threshold.aggressiveness")!.value === 1.0, "clamped to max");

  // Clamping at min
  store.update("basal-ganglia.threshold.aggressiveness", -2.0, "dopamine"); // 1.0 - 2.0 → 0.0
  assert(store.get("basal-ganglia.threshold.aggressiveness")!.value === 0.0, "clamped to min");

  // Update unknown returns NaN
  const result = store.update("nonexistent.weight", 0.1, "dopamine");
  assert(Number.isNaN(result), "update unknown returns NaN");

  // getByCategory
  const thresholds = store.getByCategory("threshold");
  assert(thresholds.length > 5, `threshold category has multiple weights (got ${thresholds.length})`);
}

// ─── 3. Relative normalization ────────────────────────────────

console.log("\n3. Relative normalization after updates");
{
  const store = new PlasticityStoreImpl();
  store.registerAll(new Map([["evaluator.sense-weight", ["a", "b", "c"]]]));

  // Initial: each 1/3
  const initial = store.getByCategory("evaluation-influence");
  const initialSum = initial.reduce((s, w) => s + w.value, 0);
  assert(Math.abs(initialSum - 1.0) < 0.001, `initial sum 1.0 (got ${initialSum.toFixed(4)})`);

  // Boost 'a' — should stay normalized
  store.update("evaluator.sense-weight.a", 0.2, "dopamine");
  const after = store.getByCategory("evaluation-influence");
  const afterSum = after.reduce((s, w) => s + w.value, 0);
  assert(Math.abs(afterSum - 1.0) < 0.001, `still 1.0 after boost (got ${afterSum.toFixed(4)})`);

  // 'a' should have gained relative share
  const aWeight = store.get("evaluator.sense-weight.a")!;
  const bWeight = store.get("evaluator.sense-weight.b")!;
  assert(aWeight.value > bWeight.value, "'a' has more weight than 'b' after boost");

  // selection-weight also normalized
  store.update("scheduler.selection.phase-group", 0.3, "dopamine");
  const selAfter = store.getByCategory("selection-weight");
  const selSum = selAfter.reduce((s, w) => s + w.value, 0);
  assert(Math.abs(selSum - 1.0) < 0.001, `selection-weight still 1.0 (got ${selSum.toFixed(4)})`);
}

// ─── 4. Decay toward category mean ───────────────────────────

console.log("\n4. Decay toward category mean");
{
  const store = new PlasticityStoreImpl({ decayRate: 0.1 });
  store.registerAll(new Map([["evaluator.sense-weight", ["x"]]]));

  // Push a threshold weight away from the group mean
  store.update("basal-ganglia.threshold.aggressiveness", 0.3, "dopamine"); // 0.5 → 0.8

  const before = store.get("basal-ganglia.threshold.aggressiveness")!.value;

  const decayed = store.decay();
  assert(decayed > 0, `some weights decayed (got ${decayed})`);

  const afterDecay = store.get("basal-ganglia.threshold.aggressiveness")!.value;
  // Should have moved toward the category mean (which is ~0.5ish for thresholds)
  assert(afterDecay < before, `0.8 decayed toward mean (now ${afterDecay.toFixed(4)})`);

  // Verify the delta was recorded as 'decay' source
  const w = store.get("basal-ganglia.threshold.aggressiveness")!;
  const decayDelta = w.recentDeltas.find((d) => d.source === "decay");
  assert(decayDelta !== undefined, "decay delta recorded");
}

// ─── 5. Settle volatile weights ──────────────────────────────

console.log("\n5. Settle volatile weights");
{
  const store = new PlasticityStoreImpl({
    volatilityThreshold: 0.001, // Very low threshold — easy to trigger
    settleRate: 0.2,
  });
  store.registerAll(new Map([["evaluator.sense-weight", ["x"]]]));

  // Create volatility: oscillating updates
  const connId = "basal-ganglia.threshold.aggressiveness";
  store.update(connId, 0.3, "dopamine");
  store.update(connId, -0.2, "dopamine");
  store.update(connId, 0.25, "dopamine");
  store.update(connId, -0.15, "dopamine");

  const before = store.get(connId)!.value;
  const defaultVal = store.get(connId)!.defaultValue;

  const settled = store.settle();
  assert(settled > 0, `some weights settled (got ${settled})`);

  const afterSettle = store.get(connId)!.value;
  // Should have moved toward defaultValue
  const distBefore = Math.abs(before - defaultVal);
  const distAfter = Math.abs(afterSettle - defaultVal);
  assert(distAfter < distBefore, `moved toward default (dist ${distBefore.toFixed(4)} → ${distAfter.toFixed(4)})`);

  // Verify settle delta recorded
  const w = store.get(connId)!;
  const settleDelta = w.recentDeltas.find((d) => d.source === "settle");
  assert(settleDelta !== undefined, "settle delta recorded");
}

// ─── 6. Volatility computation ───────────────────────────────

console.log("\n6. Volatility computation");
{
  const store = new PlasticityStoreImpl({ volatilityThreshold: 0.001 });
  store.registerAll(new Map([["evaluator.sense-weight", ["x"]]]));

  // Fresh store — no deltas, no volatility
  assert(store.getVolatility() === 0, `fresh store volatility = 0`);

  // Add oscillating deltas to a few weights
  store.update("basal-ganglia.threshold.aggressiveness", 0.3, "dopamine");
  store.update("basal-ganglia.threshold.aggressiveness", -0.2, "dopamine");
  store.update("gate.threshold.deliberative-ne", 0.1, "dopamine");
  store.update("gate.threshold.deliberative-ne", -0.15, "dopamine");

  const vol = store.getVolatility();
  assert(vol > 0, `volatility > 0 after oscillation (got ${vol.toFixed(4)})`);
  assert(vol <= 1, `volatility <= 1 (got ${vol.toFixed(4)})`);
}

// ─── 7. Snapshot / restore roundtrip ─────────────────────────

console.log("\n7. Snapshot / restore roundtrip");
{
  const store = new PlasticityStoreImpl();
  store.registerAll(new Map([["evaluator.sense-weight", ["a", "b"]]]));

  // Modify some values
  store.update("thalamus.routing.hippocampus", 0.2, "dopamine");
  store.update("evaluator.sense-weight.a", 0.1, "satisfaction");

  const snapA = store.get("evaluator.sense-weight.a")!.value;
  const snapH = store.get("thalamus.routing.hippocampus")!.value;

  // Take snapshot
  const snap = store.snapshot("test-snap");
  assert(snap.label === "test-snap", "snapshot label");
  assert(snap.weights.length === store.size, `snapshot has ${store.size} weights`);

  // Modify further
  store.update("thalamus.routing.hippocampus", -0.3, "decay");
  assert(
    store.get("thalamus.routing.hippocampus")!.value !== snapH,
    "value changed after snapshot",
  );

  // Restore
  store.restore(snap);
  assert(
    Math.abs(store.get("thalamus.routing.hippocampus")!.value - snapH) < 0.001,
    `hippocampus restored (got ${store.get("thalamus.routing.hippocampus")!.value.toFixed(4)})`,
  );
  assert(
    Math.abs(store.get("evaluator.sense-weight.a")!.value - snapA) < 0.001,
    `sense-weight.a restored`,
  );
}

// ─── 8. StakeAdjuster pattern ─────────────────────────────────

console.log("\n8. StakeAdjuster wiring pattern");
{
  const store = new PlasticityStoreImpl();
  const senses = ["design", "performance"];
  store.registerAll(new Map([["evaluator.sense-weight", senses]]));

  // Build the same adjuster the Brainstem builds
  const adjuster = (senseId: string, rawStake: number): number => {
    const weight = store.get(`evaluator.sense-weight.${senseId}`);
    if (!weight) return rawStake;
    const senseCount = store.getByCategory("evaluation-influence").length;
    return rawStake * weight.value * senseCount;
  };

  // At default (equal weights, 1/2 each with 2 senses), adjuster is identity
  const raw = 0.8;
  const adjusted = adjuster("design", raw);
  assert(
    Math.abs(adjusted - raw) < 0.001,
    `default weights → identity adjustment (got ${adjusted.toFixed(4)})`,
  );

  // Boost design — should get more influence
  store.update("evaluator.sense-weight.design", 0.2, "dopamine");
  const boosted = adjuster("design", raw);
  assert(boosted > raw, `boosted design gets more influence (${boosted.toFixed(4)} > ${raw})`);

  // Performance should get less (normalization)
  const perfAdjusted = adjuster("performance", raw);
  assert(perfAdjusted < raw, `performance gets less (${perfAdjusted.toFixed(4)} < ${raw})`);

  // Unknown sense falls through
  assert(adjuster("unknown", raw) === raw, "unknown sense → raw stake");
}

// ─── 9. all() iterator ───────────────────────────────────────

console.log("\n9. all() iterator");
{
  const store = new PlasticityStoreImpl();
  store.registerAll(new Map([["evaluator.sense-weight", ["a"]]]));

  let count = 0;
  for (const _w of store.all()) count++;
  assert(count === store.size, `all() yields ${store.size} weights (got ${count})`);
}

// ─── 10. getState() ──────────────────────────────────────────

console.log("\n10. getState() dashboard snapshot");
{
  const store = new PlasticityStoreImpl();
  store.registerAll(new Map([["evaluator.sense-weight", ["a", "b"]]]));
  store.update("thalamus.routing.hippocampus", 0.1, "dopamine", "task-1");

  const state = store.getState();
  assert(state.total === store.size, `total matches (got ${state.total})`);
  assert(typeof state.volatility === "number", "volatility is a number");
  assert(state.recentUpdates.length > 0, "has recent updates");

  // The updated weight should appear in recent updates with a delta
  const hippEntry = state.recentUpdates.find(
    (u) => u.connectionId === "thalamus.routing.hippocampus",
  );
  assert(hippEntry !== undefined, "updated weight in recent updates");
  assert(hippEntry!.lastDelta?.source === "dopamine", "delta source preserved in state");
}

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  PlasticityStore smoke test: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
