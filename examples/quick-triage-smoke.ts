/**
 * Quick Triage — Smoke Test
 *
 * Verifies procedural between-task observation scanning:
 *   1. No observations → no proposals
 *   2. Observation matching a ready task → amend proposal
 *   3. NE-modulated relevance filtering
 *   4. High observation pressure → flag for deep synthesis
 *   5. High-relevance observation → flag for deep synthesis
 *   6. Observations marked as triaged after processing
 *
 * Run: npx tsx examples/quick-triage-smoke.ts
 */

import { WorkingMemory } from "../src/kernel/working-memory.js";
import { quickTriage } from "../src/kernel/quick-triage.js";
import type { TaskGraphNode } from "../src/types/brainstem.js";
import type { TerritoryObservation } from "../src/types/territory-observation.js";
import { createTask } from "../src/types/task.js";
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

function makeGraph(): TaskGraphNode[] {
  return [
    { task: createTask("t1", "Setup database schema"), dependsOn: [], phaseGroup: "phase-1" },
    { task: createTask("t2", "Build API layer with pagination"), dependsOn: ["t1"], phaseGroup: "phase-1" },
    { task: createTask("t3", "Build authentication module"), dependsOn: ["t1"], phaseGroup: "phase-1" },
    { task: createTask("t4", "Build dashboard component"), dependsOn: ["t2", "t3"], phaseGroup: "phase-2" },
  ];
}

function makeObs(overrides?: Partial<TerritoryObservation>): TerritoryObservation {
  return {
    id: newId(),
    fact: "Some generic observation",
    source: { taskId: "t1", component: "builder" },
    relevance: 0.5,
    observedAt: new Date(),
    status: "new",
    ...overrides,
  };
}

// ─── 1. No observations → no proposals ─────────────────────────

console.log("\n  1. No observations");

const wm1 = new WorkingMemory("test-1");
const result1 = quickTriage(wm1, makeGraph(), new Set(["t1"]), new Set(), 0.5);
assert(result1.observationsTriaged === 0, "No observations triaged");
assert(result1.proposals.length === 0, "No proposals");
assert(!result1.flagForDeepSynthesis, "No flag");

// ─── 2. Matching observation → amend proposal ──────────────────

console.log("  2. Matching observation produces amend proposal");

const wm2 = new WorkingMemory("test-2");
// This observation mentions "API" and "pagination" which overlap with task t2
wm2.addObservation(makeObs({
  id: "obs-api",
  fact: "The API endpoint uses cursor-based pagination instead of offset pagination",
  source: { taskId: "t1", component: "builder" },
  relevance: 0.6,
}));

const graph2 = makeGraph();
const result2 = quickTriage(wm2, graph2, new Set(["t1"]), new Set(), 0.5);
assert(result2.proposals.length === 1, `Got ${result2.proposals.length} proposal(s)`);
if (result2.proposals.length > 0) {
  assert(result2.proposals[0].operations[0].op === "amend", "Proposal is amend");
  assert(
    (result2.proposals[0].operations[0] as { taskId: string }).taskId === "t2",
    "Targets the API task",
  );
  assert(result2.proposals[0].source === "quick-triage", "Source is quick-triage");
}

// ─── 3. NE-modulated relevance filtering ────────────────────────

console.log("  3. NE relevance filtering");

const wm3 = new WorkingMemory("test-3");
// Low-relevance observation
wm3.addObservation(makeObs({
  id: "obs-low",
  fact: "The API endpoint returns JSON format responses with pagination headers",
  relevance: 0.3,
}));

// High NE (threshold = 0.2) → observation passes
const result3a = quickTriage(wm3, makeGraph(), new Set(["t1"]), new Set(), 0.9);
// Even with high NE, need keyword match — but the observation mentions "API" and "pagination"
// which should match t2. Let's check.
// At NE 0.9: threshold = 0.6 - 0.4*0.9 = 0.24. Relevance 0.3 >= 0.24 → passes

// Low NE (threshold = 0.6) → observation filtered out
const wm3b = new WorkingMemory("test-3b");
wm3b.addObservation(makeObs({
  id: "obs-low-2",
  fact: "The API endpoint returns JSON format responses with pagination headers",
  relevance: 0.3,
}));
const result3b = quickTriage(wm3b, makeGraph(), new Set(["t1"]), new Set(), 0.1);
// At NE 0.1: threshold = 0.6 - 0.4*0.1 = 0.56. Relevance 0.3 < 0.56 → filtered
assert(result3b.proposals.length === 0, "Low NE filters out low-relevance observations");

// ─── 4. High observation pressure → flag ────────────────────────

console.log("  4. High observation pressure flags for deep synthesis");

const wm4 = new WorkingMemory("test-4");
// Add 15+ observations to create pressure > 0.7
for (let i = 0; i < 15; i++) {
  wm4.addObservation(makeObs({
    id: `pressure-${i}`,
    fact: `Observation number ${i} about something`,
    relevance: 0.5,
  }));
}

const result4 = quickTriage(wm4, makeGraph(), new Set(["t1"]), new Set(), 0.5);
assert(result4.flagForDeepSynthesis, "High pressure triggers flag");
assert(result4.flagReason?.includes("pressure"), `Flag reason mentions pressure: ${result4.flagReason}`);

// ─── 5. High-relevance observation → flag ───────────────────────

console.log("  5. High-relevance observation flags for deep synthesis");

const wm5 = new WorkingMemory("test-5");
wm5.addObservation(makeObs({
  id: "obs-critical",
  fact: "Critical security vulnerability found in dependency",
  relevance: 0.95,
}));

const result5 = quickTriage(wm5, makeGraph(), new Set(["t1"]), new Set(), 0.5);
assert(result5.flagForDeepSynthesis, "High relevance triggers flag");
assert(result5.flagReason?.includes("High-relevance"), `Flag reason: ${result5.flagReason}`);

// ─── 6. Observations marked as triaged ──────────────────────────

console.log("  6. Consumed observations marked as triaged");

const wm6 = new WorkingMemory("test-6");
wm6.addObservation(makeObs({
  id: "obs-match",
  fact: "The database schema needs additional indexes for pagination queries on the API",
  source: { taskId: "t1", component: "builder" },
  relevance: 0.7,
}));

assert(wm6.getNewObservations().length === 1, "1 new before triage");

quickTriage(wm6, makeGraph(), new Set(["t1"]), new Set(), 0.5);

assert(wm6.getNewObservations().length === 0, "0 new after triage (matched obs was triaged)");
assert(wm6.getObservations("triaged").length === 1, "1 triaged");

// ─── 7. Non-matching observation stays new ──────────────────────

console.log("  7. Non-matching observations stay new");

const wm7 = new WorkingMemory("test-7");
wm7.addObservation(makeObs({
  id: "obs-unrelated",
  fact: "The deployment environment uses Kubernetes version 1.28",
  relevance: 0.5,
}));

quickTriage(wm7, makeGraph(), new Set(["t1"]), new Set(), 0.5);

// "Kubernetes" and "deployment" don't match any task description
assert(wm7.getNewObservations().length === 1, "Non-matching observation stays new");

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n  Quick Triage smoke test: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
