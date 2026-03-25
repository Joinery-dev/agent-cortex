/**
 * Plasticity Connections — Smoke Test
 *
 * Verifies the connection map (Feature #20):
 *   1. Library consistency — no duplicate IDs, valid categories
 *   2. Defaults within range
 *   3. Normalized category defaults sum correctly
 *   4. CATEGORY_CONFIG completeness
 *   5. Fixed connections — count, no duplicates
 *   6. PlasticityStore interface contract (mock)
 *   7. Snapshot / restore roundtrip
 *   8. Decay toward mean
 *   9. Relative normalization
 *
 * Run: npx tsx examples/plasticity-connections-smoke.ts
 */

import {
  CATEGORY_CONFIG,
  FIXED_CONNECTIONS,
  PLASTIC_CONNECTIONS,
} from "../src/types/plasticity.js";
import type {
  ConnectionCategory,
  ConnectionSnapshot,
  DeltaSource,
  PlasticConnectionDeclaration,
  PlasticWeight,
  PlasticityStore,
} from "../src/types/plasticity.js";

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

// ─── Mock PlasticityStore ───────────────────────────────────────

class MockPlasticityStore implements PlasticityStore {
  private weights = new Map<string, PlasticWeight>();

  get size(): number {
    return this.weights.size;
  }

  get(connectionId: string): PlasticWeight | undefined {
    return this.weights.get(connectionId);
  }

  getByCategory(category: ConnectionCategory): PlasticWeight[] {
    return [...this.weights.values()].filter((w) => w.category === category);
  }

  update(
    connectionId: string,
    delta: number,
    source: DeltaSource,
    context?: string,
  ): number {
    const weight = this.weights.get(connectionId);
    if (!weight) return NaN;

    const newValue = Math.max(weight.range[0], Math.min(weight.range[1], weight.value + delta));
    weight.value = newValue;
    weight.recentDeltas.unshift({
      timestamp: new Date(),
      delta,
      source,
      context,
    });
    weight.lastModified = new Date();

    // Normalize relative categories
    const config = CATEGORY_CONFIG[weight.category];
    if (config.normalization === "relative" && config.target !== undefined) {
      const siblings = this.getByCategory(weight.category);
      const sum = siblings.reduce((s, w) => s + w.value, 0);
      if (sum > 0) {
        const scale = config.target / sum;
        for (const s of siblings) {
          s.value = Math.max(s.range[0], Math.min(s.range[1], s.value * scale));
        }
      }
    }

    return weight.value;
  }

  register(declaration: PlasticConnectionDeclaration): void {
    if (this.weights.has(declaration.id)) return;
    this.weights.set(declaration.id, {
      connectionId: declaration.id,
      value: declaration.defaultValue,
      defaultValue: declaration.defaultValue,
      range: [...declaration.range] as [number, number],
      category: declaration.category,
      recentDeltas: [],
      lastModified: new Date(),
    });
  }

  snapshot(label?: string): ConnectionSnapshot {
    return {
      weights: [...this.weights.values()].map((w) => ({
        ...w,
        range: [...w.range] as [number, number],
        recentDeltas: [...w.recentDeltas],
      })),
      capturedAt: new Date(),
      label,
    };
  }

  restore(snapshot: ConnectionSnapshot): void {
    this.weights.clear();
    for (const w of snapshot.weights) {
      this.weights.set(w.connectionId, {
        ...w,
        range: [...w.range] as [number, number],
        recentDeltas: [...w.recentDeltas],
      });
    }
  }

  *all(): IterableIterator<PlasticWeight> {
    yield* this.weights.values();
  }
}

// ─── 1. No duplicate IDs ───────────────────────────────────────

console.log("1. Library consistency — no duplicate IDs");
{
  const ids = PLASTIC_CONNECTIONS.map((c) => c.id);
  const unique = new Set(ids);
  assert(unique.size === ids.length, `no duplicate IDs (${ids.length} declarations, ${unique.size} unique)`);
}

// ─── 2. Valid categories ────────────────────────────────────────

console.log("\n2. Valid categories — every declaration references a known category");
{
  const validCategories = Object.keys(CATEGORY_CONFIG);
  let allValid = true;
  for (const conn of PLASTIC_CONNECTIONS) {
    if (!validCategories.includes(conn.category)) {
      allValid = false;
      console.error(`  FAIL: ${conn.id} has unknown category "${conn.category}"`);
    }
  }
  assert(allValid, "all categories reference CATEGORY_CONFIG");
}

// ─── 3. Defaults within range ───────────────────────────────────

console.log("\n3. Defaults within range");
{
  let allInRange = true;
  for (const conn of PLASTIC_CONNECTIONS) {
    if (conn.perEntity) continue; // templates have pre-normalization defaults
    if (conn.defaultValue < conn.range[0] || conn.defaultValue > conn.range[1]) {
      allInRange = false;
      console.error(`  FAIL: ${conn.id} default ${conn.defaultValue} outside [${conn.range}]`);
    }
  }
  assert(allInRange, "all non-template defaults within range");
}

// ─── 4. Normalized category defaults ────────────────────────────

console.log("\n4. Normalized category defaults sum correctly");
{
  // selection-weight: 0.3 + 0.4 + 0.3 = 1.0
  const selectionWeights = PLASTIC_CONNECTIONS.filter(
    (c) => c.category === "selection-weight",
  );
  const selectionSum = selectionWeights.reduce((s, c) => s + c.defaultValue, 0);
  assert(
    Math.abs(selectionSum - 1.0) < 0.001,
    `selection-weight defaults sum to 1.0 (got ${selectionSum})`,
  );

  // evaluation-influence: single template with perEntity
  const evalInfluence = PLASTIC_CONNECTIONS.filter(
    (c) => c.category === "evaluation-influence",
  );
  assert(evalInfluence.length === 1, "evaluation-influence has exactly 1 template");
  assert(evalInfluence[0].perEntity === true, "evaluation-influence template has perEntity: true");
}

// ─── 5. CATEGORY_CONFIG completeness ────────────────────────────

console.log("\n5. CATEGORY_CONFIG completeness");
{
  const relativeCategories = Object.entries(CATEGORY_CONFIG).filter(
    ([, config]) => config.normalization === "relative",
  );
  let allHaveTarget = true;
  for (const [category, config] of relativeCategories) {
    if (config.target === undefined) {
      allHaveTarget = false;
      console.error(`  FAIL: relative category "${category}" has no target`);
    }
  }
  assert(allHaveTarget, "all relative categories have a target defined");
  assert(relativeCategories.length === 2, `2 relative categories (got ${relativeCategories.length})`);

  const independentCategories = Object.entries(CATEGORY_CONFIG).filter(
    ([, config]) => config.normalization === "independent",
  );
  assert(independentCategories.length === 3, `3 independent categories (got ${independentCategories.length})`);
}

// ─── 6. Fixed connections ───────────────────────────────────────

console.log("\n6. Fixed connections");
{
  assert(FIXED_CONNECTIONS.length === 22, `22 fixed connections (got ${FIXED_CONNECTIONS.length})`);

  const pairs = FIXED_CONNECTIONS.map((c) => `${c.source}→${c.target}`);
  const uniquePairs = new Set(pairs);
  assert(uniquePairs.size === pairs.length, `no duplicate source→target pairs`);

  // Spot-check key connections exist
  assert(
    FIXED_CONNECTIONS.some((c) => c.source === "Evaluation" && c.target === "Gate"),
    "Evaluation→Gate exists",
  );
  assert(
    FIXED_CONNECTIONS.some((c) => c.source === "Dopamine" && c.target === "PlasticityStore"),
    "Dopamine→PlasticityStore exists",
  );
  assert(
    FIXED_CONNECTIONS.some((c) => c.source === "Thalamus" && c.target === "MotorCortex"),
    "Thalamus→MotorCortex exists",
  );
}

// ─── 7. PlasticityStore interface contract ──────────────────────

console.log("\n7. PlasticityStore interface contract (mock)");
{
  const store: PlasticityStore = new MockPlasticityStore();

  // Register
  store.register({
    id: "test.weight.alpha",
    region: "Test",
    description: "Test weight",
    defaultValue: 0.5,
    range: [0, 1],
    category: "threshold",
  });
  assert(store.size === 1, "size is 1 after register");

  // Get
  const w = store.get("test.weight.alpha");
  assert(w !== undefined, "get returns registered weight");
  assert(w!.value === 0.5, `value is default (got ${w!.value})`);
  assert(w!.connectionId === "test.weight.alpha", "connectionId matches");

  // Get unknown
  assert(store.get("nonexistent") === undefined, "get unknown returns undefined");

  // Update
  const newVal = store.update("test.weight.alpha", 0.2, "dopamine", "task-1");
  assert(Math.abs(newVal - 0.7) < 0.001, `update: 0.5 + 0.2 = 0.7 (got ${newVal})`);
  const after = store.get("test.weight.alpha")!;
  assert(after.recentDeltas.length === 1, "delta recorded");
  assert(after.recentDeltas[0].source === "dopamine", "delta source is dopamine");
  assert(after.recentDeltas[0].context === "task-1", "delta context preserved");

  // Clamping
  store.update("test.weight.alpha", 0.5, "dopamine"); // 0.7 + 0.5 = 1.2 → clamped to 1.0
  assert(store.get("test.weight.alpha")!.value === 1.0, "clamped to max 1.0");

  store.update("test.weight.alpha", -1.5, "dopamine"); // 1.0 - 1.5 = -0.5 → clamped to 0.0
  assert(store.get("test.weight.alpha")!.value === 0.0, "clamped to min 0.0");

  // getByCategory
  store.register({
    id: "test.weight.beta",
    region: "Test",
    description: "Another test weight",
    defaultValue: 0.3,
    range: [0, 1],
    category: "threshold",
  });
  const thresholds = store.getByCategory("threshold");
  assert(thresholds.length === 2, `getByCategory returns 2 thresholds`);

  const routines = store.getByCategory("routine-strength");
  assert(routines.length === 0, "no routine-strength weights registered");

  // all() iterator
  let count = 0;
  for (const _w of store.all()) count++;
  assert(count === 2, `all() yields 2 weights (got ${count})`);

  // No-op re-register
  store.register({
    id: "test.weight.alpha",
    region: "Test",
    description: "Attempted re-register",
    defaultValue: 0.9,
    range: [0, 1],
    category: "threshold",
  });
  assert(store.size === 2, "re-register is no-op (still 2)");
}

// ─── 8. Snapshot / restore roundtrip ────────────────────────────

console.log("\n8. Snapshot / restore roundtrip");
{
  const store = new MockPlasticityStore();

  store.register({
    id: "snap.a",
    region: "Test",
    description: "Snap A",
    defaultValue: 0.5,
    range: [0, 1],
    category: "routing-intensity",
  });
  store.register({
    id: "snap.b",
    region: "Test",
    description: "Snap B",
    defaultValue: 0.3,
    range: [0, 1],
    category: "routing-intensity",
  });

  // Modify values
  store.update("snap.a", 0.2, "dopamine");
  store.update("snap.b", -0.1, "satisfaction");

  const valueA = store.get("snap.a")!.value;
  const valueB = store.get("snap.b")!.value;

  // Snapshot
  const snap = store.snapshot("test-snapshot");
  assert(snap.label === "test-snapshot", "snapshot label preserved");
  assert(snap.weights.length === 2, "snapshot has 2 weights");

  // Modify further
  store.update("snap.a", -0.4, "decay");
  store.update("snap.b", 0.5, "dopamine");
  assert(store.get("snap.a")!.value !== valueA, "values changed after snapshot");

  // Restore
  store.restore(snap);
  assert(
    Math.abs(store.get("snap.a")!.value - valueA) < 0.001,
    `snap.a restored to ${valueA} (got ${store.get("snap.a")!.value})`,
  );
  assert(
    Math.abs(store.get("snap.b")!.value - valueB) < 0.001,
    `snap.b restored to ${valueB} (got ${store.get("snap.b")!.value})`,
  );
}

// ─── 9. Decay toward mean ───────────────────────────────────────

console.log("\n9. Decay toward mean");
{
  // Simulate 3 independent weights: [0.8, 0.5, 0.2], mean = 0.5
  const values = [0.8, 0.5, 0.2];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const decayRate = 0.1;

  const decayed = values.map((v) => v + (mean - v) * decayRate);

  // Weight farthest from mean moved the most
  const deltas = values.map((v, i) => Math.abs(decayed[i] - v));
  assert(deltas[0] > deltas[1], "0.8 (farthest above mean) decayed more than 0.5");
  assert(deltas[2] > deltas[1], "0.2 (farthest below mean) decayed more than 0.5");
  assert(deltas[1] === 0, "0.5 (at mean) did not decay");

  // All moved toward mean
  assert(decayed[0] < values[0], "0.8 moved down toward mean");
  assert(decayed[1] === values[1], "0.5 stayed at mean");
  assert(decayed[2] > values[2], "0.2 moved up toward mean");

  // After decay, mean is preserved
  const decayedMean = decayed.reduce((s, v) => s + v, 0) / decayed.length;
  assert(Math.abs(decayedMean - mean) < 0.001, `mean preserved after decay (${decayedMean.toFixed(4)})`);
}

// ─── 10. Relative normalization ─────────────────────────────────

console.log("\n10. Relative normalization for selection-weight");
{
  const store = new MockPlasticityStore();

  // Register the 3 selection-weight connections
  const selConns = PLASTIC_CONNECTIONS.filter((c) => c.category === "selection-weight");
  for (const conn of selConns) {
    store.register(conn);
  }

  // Verify initial sum = 1.0
  const initial = store.getByCategory("selection-weight");
  const initialSum = initial.reduce((s, w) => s + w.value, 0);
  assert(Math.abs(initialSum - 1.0) < 0.001, `initial sum = 1.0 (got ${initialSum})`);

  // Boost phase-group weight
  store.update("scheduler.selection.phase-group", 0.2, "dopamine");

  // After normalization, sum should still be ~1.0
  const after = store.getByCategory("selection-weight");
  const afterSum = after.reduce((s, w) => s + w.value, 0);
  assert(Math.abs(afterSum - 1.0) < 0.001, `sum still 1.0 after update (got ${afterSum.toFixed(4)})`);

  // Phase-group should have gained relative to others
  const pg = store.get("scheduler.selection.phase-group")!;
  const dep = store.get("scheduler.selection.dependency-unblocking")!;
  const trend = store.get("scheduler.selection.trend-response")!;
  assert(
    pg.value / (pg.value + dep.value + trend.value) > 0.3,
    `phase-group gained relative share (${(pg.value / afterSum).toFixed(3)})`,
  );
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  Plasticity connections smoke test: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
