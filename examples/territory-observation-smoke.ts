/**
 * Territory Observation — Smoke Test
 *
 * Verifies the observation channel in Working Memory:
 *   1. relevanceThreshold() — NE-modulated threshold
 *   2. observationPressure() — untriaged count metric
 *   3. WM observation lifecycle (add → triage → synthesize → dismiss)
 *   4. Observations do NOT affect WM load
 *
 * Run: npx tsx examples/territory-observation-smoke.ts
 */

import { WorkingMemory } from "../src/kernel/working-memory.js";
import {
  relevanceThreshold,
  observationPressure,
} from "../src/types/territory-observation.js";
import type { TerritoryObservation } from "../src/types/territory-observation.js";
import { newId } from "../src/util/ids.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function makeObservation(overrides?: Partial<TerritoryObservation>): TerritoryObservation {
  return {
    id: newId(),
    fact: "This API uses pagination",
    source: { taskId: "task-1", component: "builder" },
    relevance: 0.5,
    observedAt: new Date(),
    status: "new",
    ...overrides,
  };
}

// ─── 1. Relevance Threshold ────────────────────────────────────

console.log("\n  1. Relevance threshold (NE-modulated)");

const t0 = relevanceThreshold(0);
assert(Math.abs(t0 - 0.6) < 0.001, `NE 0 → threshold 0.6: ${t0}`);

const t1 = relevanceThreshold(1);
assert(Math.abs(t1 - 0.2) < 0.001, `NE 1 → threshold 0.2: ${t1}`);

const t05 = relevanceThreshold(0.5);
assert(Math.abs(t05 - 0.4) < 0.001, `NE 0.5 → threshold 0.4: ${t05}`);

// Clamping
const tNeg = relevanceThreshold(-1);
assert(Math.abs(tNeg - 0.6) < 0.001, `NE -1 clamped to 0 → 0.6: ${tNeg}`);

const tHigh = relevanceThreshold(5);
assert(Math.abs(tHigh - 0.2) < 0.001, `NE 5 clamped to 1 → 0.2: ${tHigh}`);

// ─── 2. Observation Pressure ───────────────────────────────────

console.log("  2. Observation pressure");

const p0 = observationPressure([]);
assert(p0 === 0, `Empty → 0: ${p0}`);

const p5 = observationPressure(
  Array.from({ length: 5 }, () => makeObservation()),
);
assert(Math.abs(p5 - 0.25) < 0.01, `5 untriaged → 0.25: ${p5}`);

const p20 = observationPressure(
  Array.from({ length: 20 }, () => makeObservation()),
);
assert(Math.abs(p20 - 1.0) < 0.01, `20 untriaged → 1.0: ${p20}`);

const p30 = observationPressure(
  Array.from({ length: 30 }, () => makeObservation()),
);
assert(Math.abs(p30 - 1.0) < 0.01, `30 untriaged capped at 1.0: ${p30}`);

// Triaged observations don't count
const mixed = [
  makeObservation({ status: "new" }),
  makeObservation({ status: "triaged" }),
  makeObservation({ status: "synthesized" }),
  makeObservation({ status: "dismissed" }),
  makeObservation({ status: "new" }),
];
const pMixed = observationPressure(mixed);
assert(Math.abs(pMixed - 0.1) < 0.01, `2 new out of 5 → 0.1: ${pMixed}`);

// ─── 3. WM Observation Lifecycle ───────────────────────────────

console.log("  3. WM observation lifecycle");

const wm = new WorkingMemory("test-project");

// Add observations
const obs1 = makeObservation({ id: "obs-1", fact: "API uses pagination" });
const obs2 = makeObservation({ id: "obs-2", fact: "No error handling in auth module", relevance: 0.9 });
const obs3 = makeObservation({ id: "obs-3", fact: "Tests use hardcoded ports", source: { taskId: "task-2", component: "evaluator", senseId: "ENGINEERING" } });

wm.addObservation(obs1);
wm.addObservation(obs2);
wm.addObservation(obs3);

assert(wm.getObservations().length === 3, "3 observations stored");
assert(wm.getNewObservations().length === 3, "3 new observations");
assert(wm.getObservations("triaged").length === 0, "0 triaged");

// Triage
wm.markObservationTriaged("obs-1");
assert(wm.getNewObservations().length === 2, "2 new after triage");
assert(wm.getObservations("triaged").length === 1, "1 triaged");

// Synthesize
wm.markObservationSynthesized("obs-2", "synthesis-1");
const synthesized = wm.getObservations("synthesized");
assert(synthesized.length === 1, "1 synthesized");
assert(synthesized[0].consumedBy === "synthesis-1", "consumedBy set");

// Dismiss
wm.dismissObservation("obs-3");
assert(wm.getObservations("dismissed").length === 1, "1 dismissed");
assert(wm.getNewObservations().length === 0, "0 new after all processed");

// Pressure reflects only untriaged
assert(wm.getObservationPressure() === 0, "Pressure 0 when none are new");

// Add more new observations
for (let i = 0; i < 10; i++) {
  wm.addObservation(makeObservation({ id: `batch-${i}` }));
}
assert(Math.abs(wm.getObservationPressure() - 0.5) < 0.01, `10 new → pressure 0.5: ${wm.getObservationPressure()}`);

// ─── 4. Observations Do Not Affect WM Load ─────────────────────

console.log("  4. Observations isolated from WM load");

const wm2 = new WorkingMemory("load-test");
const loadBefore = wm2.getLoad();

// Add 50 observations
for (let i = 0; i < 50; i++) {
  wm2.addObservation(makeObservation({ id: `load-${i}` }));
}

const loadAfter = wm2.getLoad();
assert(loadBefore === loadAfter, `Load unchanged: ${loadBefore} → ${loadAfter}`);

// Observation pressure is independent
assert(wm2.getObservationPressure() === 1.0, "Pressure at max");
assert(wm2.getLoad() === 0, "WM load still 0");

// ─── 5. Snapshot includes observations ─────────────────────────

console.log("  5. Snapshot includes observations");

const snapshot = wm.snapshot();
assert(snapshot.observations.length === 13, `Snapshot has ${snapshot.observations.length} observations`);
assert(snapshot.observations[0].fact === "API uses pagination", "Snapshot preserves facts");

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n  Territory Observation smoke test: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
