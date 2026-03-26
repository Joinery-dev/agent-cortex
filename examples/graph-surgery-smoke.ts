/**
 * Graph Surgery — Smoke Test
 *
 * Verifies the four atomic operations on a live task graph:
 *   1. discoveryId() — ID generation
 *   2. computeBlastRadius() — fraction of remaining tasks affected
 *   3. validateProposal() — safety checks (cycles, missing refs, active tasks)
 *   4. applySurgery() — insert, amend, rework, reorder
 *
 * Run: npx tsx examples/graph-surgery-smoke.ts
 */

import type { TaskGraphNode } from "../src/types/brainstem.js";
import type { SurgeryProposal, GraphSurgeryOp } from "../src/types/graph-surgery.js";
import { createTask } from "../src/types/task.js";
import {
  discoveryId,
  computeBlastRadius,
  validateProposal,
  applySurgery,
} from "../src/kernel/graph-surgery.js";

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

// ─── Test Fixtures ──────────────────────────────────────────────

function makeGraph(): TaskGraphNode[] {
  return [
    { task: createTask("t1", "Setup database"), dependsOn: [], phaseGroup: "phase-1" },
    { task: createTask("t2", "Build API layer"), dependsOn: ["t1"], phaseGroup: "phase-1" },
    { task: createTask("t3", "Build auth module"), dependsOn: ["t1"], phaseGroup: "phase-1" },
    { task: createTask("t4", "Build dashboard UI"), dependsOn: ["t2", "t3"], phaseGroup: "phase-2" },
    { task: createTask("t5", "Integration tests"), dependsOn: ["t4"], phaseGroup: "phase-2" },
  ];
}

function makeProposal(ops: GraphSurgeryOp[]): SurgeryProposal {
  return {
    id: "proposal-1",
    source: "quick-triage",
    reasoning: "test",
    operations: ops,
    blastRadius: 0,
    grounding: [],
    createdAt: new Date(),
    status: "pending",
  };
}

// ─── 1. Discovery ID Generation ────────────────────────────────

console.log("\n  1. Discovery ID generation");

const id1 = discoveryId(1, "API pagination handler");
assert(id1 === "discovery-1-api-pagination-handler", `ID format: ${id1}`);

const id2 = discoveryId(42, "Fix broken!! auth & tokens");
assert(id2 === "discovery-42-fix-broken-auth-tokens", `Sanitized: ${id2}`);

const id3 = discoveryId(3, "A".repeat(100));
assert(id3.length <= 55, `Truncated length: ${id3.length}`);

// ─── 2. Blast Radius ───────────────────────────────────────────

console.log("  2. Blast radius computation");

const graph = makeGraph();
const completed = new Set(["t1"]);

// Amend one of 4 remaining tasks = 25%
const radius1 = computeBlastRadius(
  [{ op: "amend", taskId: "t2", description: "new" }],
  graph,
  completed,
);
assert(Math.abs(radius1 - 0.25) < 0.01, `Amend blast radius: ${radius1}`);

// Rework t1 (completed) — it affects t2, t3 downstream = rework itself counted as remaining? No, t1 is completed.
// Remaining: t2, t3, t4, t5 (4 tasks). Rework t1 affects t1 (but completed, not counted) + t2, t3 (depend on t1) = 2/4 = 50%
const radius2 = computeBlastRadius(
  [{ op: "rework", directive: { taskId: "t1", reason: "test", amendedDescription: "new", additionalContext: {}, downstreamDependents: [] } }],
  graph,
  completed,
);
assert(Math.abs(radius2 - 0.5) < 0.01, `Rework blast radius: ${radius2}`);

// Insert: the new task is in affected set but not in completed → counts against remaining
// 1 affected (t6, not completed) / 4 remaining = 0.25
const radius3 = computeBlastRadius(
  [{ op: "insert", node: { task: createTask("t6", "new"), dependsOn: ["t4"], phaseGroup: "phase-2" } }],
  graph,
  completed,
);
assert(Math.abs(radius3 - 0.25) < 0.01, `Insert blast radius: ${radius3}`);

// Empty ops = 0
const radius4 = computeBlastRadius([], graph, completed);
assert(radius4 === 0, `Empty ops blast radius: ${radius4}`);

// ─── 3. Validation ─────────────────────────────────────────────

console.log("  3. Validation");

// Valid amend
const v1 = validateProposal(
  makeProposal([{ op: "amend", taskId: "t2", description: "new desc" }]),
  graph, completed, null,
);
assert(v1.valid, "Valid amend passes");

// Amend on completed task
const v2 = validateProposal(
  makeProposal([{ op: "amend", taskId: "t1", description: "new desc" }]),
  graph, completed, null,
);
assert(!v2.valid, "Amend on completed task rejected");
assert(v2.issues[0].includes("already completed"), `Issue: ${v2.issues[0]}`);

// Amend on active task
const v3 = validateProposal(
  makeProposal([{ op: "amend", taskId: "t2", description: "new desc" }]),
  graph, completed, "t2",
);
assert(!v3.valid, "Amend on active task rejected");

// Rework on non-completed task
const v4 = validateProposal(
  makeProposal([{ op: "rework", directive: { taskId: "t2", reason: "test", amendedDescription: "new", additionalContext: {}, downstreamDependents: [] } }]),
  graph, completed, null,
);
assert(!v4.valid, "Rework on non-completed task rejected");

// Valid rework
const v5 = validateProposal(
  makeProposal([{ op: "rework", directive: { taskId: "t1", reason: "test", amendedDescription: "new", additionalContext: {}, downstreamDependents: [] } }]),
  graph, completed, null,
);
assert(v5.valid, "Valid rework passes");

// Insert with duplicate ID
const v6 = validateProposal(
  makeProposal([{ op: "insert", node: { task: createTask("t2", "dup"), dependsOn: [], phaseGroup: "phase-1" } }]),
  graph, completed, null,
);
assert(!v6.valid, "Duplicate insert ID rejected");

// Reorder creating a cycle: t2 depends on t4, and t4 depends on t2 → cycle
const v7 = validateProposal(
  makeProposal([{ op: "reorder", taskId: "t2", dependsOn: "t4" }]),
  graph, completed, null,
);
assert(!v7.valid, "Circular dependency rejected");

// Self-dependency
const v8 = validateProposal(
  makeProposal([{ op: "reorder", taskId: "t3", dependsOn: "t3" }]),
  graph, completed, null,
);
assert(!v8.valid, "Self-dependency rejected");

// Valid reorder (t3 now also depends on t2 — no cycle)
const v9 = validateProposal(
  makeProposal([{ op: "reorder", taskId: "t3", dependsOn: "t2" }]),
  graph, completed, null,
);
assert(v9.valid, "Valid reorder passes");

// ─── 4. Apply Surgery ──────────────────────────────────────────

console.log("  4. Apply surgery");

// Insert
const g1 = makeGraph();
const c1 = new Set(["t1"]);
const r1 = applySurgery("p1", [
  { op: "insert", node: { task: createTask("t6", "New migration task"), dependsOn: ["t1"], phaseGroup: "phase-1" } },
], g1, c1);
assert(r1.operationsApplied === 1, "Insert applied");
assert(r1.insertedTaskIds.includes("t6"), "Insert ID tracked");
assert(r1.graph.length === 6, `Graph grew: ${r1.graph.length}`);
assert(g1.length === 5, "Original graph not mutated");

// Amend
const g2 = makeGraph();
const c2 = new Set(["t1"]);
const r2 = applySurgery("p2", [
  { op: "amend", taskId: "t2", description: "Build API layer with pagination support", additionalContext: { pagination: true } },
], g2, c2);
assert(r2.operationsApplied === 1, "Amend applied");
assert(r2.amendedTaskIds.includes("t2"), "Amend ID tracked");
const amendedNode = r2.graph.find((n) => n.task.id === "t2");
assert(amendedNode?.task.description === "Build API layer with pagination support", "Description updated");
assert((amendedNode?.task.context as Record<string, unknown>).pagination === true, "Context merged");
// Original not mutated
const origNode = g2.find((n) => n.task.id === "t2");
assert(origNode?.task.description === "Build API layer", "Original not mutated");

// Rework
const g3 = makeGraph();
const c3 = new Set(["t1", "t2"]);
const r3 = applySurgery("p3", [
  { op: "rework", directive: { taskId: "t1", reason: "Schema needs soft deletes", amendedDescription: "Setup database with soft deletes", additionalContext: { softDeletes: true }, downstreamDependents: ["t2"] } },
], g3, c3);
assert(r3.operationsApplied === 1, "Rework applied");
assert(r3.reopenedTaskIds.includes("t1"), "Rework ID tracked");
assert(!c3.has("t1"), "Removed from completedTaskIds");
assert(c3.has("t2"), "Other completed tasks untouched");
const reworkedNode = r3.graph.find((n) => n.task.id === "t1");
assert(reworkedNode?.task.description === "Setup database with soft deletes", "Rework description updated");
assert((reworkedNode?.task.context as Record<string, unknown>).softDeletes === true, "Rework context added");
assert(reworkedNode?.task.status === "pending", "Rework resets status to pending");

// Reorder
const g4 = makeGraph();
const c4 = new Set(["t1"]);
const r4 = applySurgery("p4", [
  { op: "reorder", taskId: "t3", dependsOn: "t2" },
], g4, c4);
assert(r4.operationsApplied === 1, "Reorder applied");
const reorderedNode = r4.graph.find((n) => n.task.id === "t3");
assert(reorderedNode?.dependsOn.includes("t2"), "New dependency added");
assert(reorderedNode?.dependsOn.includes("t1"), "Existing dependency preserved");

// Multiple ops in one proposal
const g5 = makeGraph();
const c5 = new Set(["t1"]);
const r5 = applySurgery("p5", [
  { op: "amend", taskId: "t2", description: "Updated API" },
  { op: "insert", node: { task: createTask("t6", "Rate limiter"), dependsOn: ["t2"], phaseGroup: "phase-2" } },
  { op: "reorder", taskId: "t5", dependsOn: "t6" },
], g5, c5);
assert(r5.operationsApplied === 3, `Multiple ops: ${r5.operationsApplied}`);
assert(r5.graph.length === 6, "Graph grew by 1");

// Failed op (amend on nonexistent task) doesn't stop others
const g6 = makeGraph();
const c6 = new Set(["t1"]);
const r6 = applySurgery("p6", [
  { op: "amend", taskId: "nonexistent", description: "nope" },
  { op: "amend", taskId: "t2", description: "this works" },
], g6, c6);
assert(r6.operationsApplied === 1, "Good op still applied");
assert(r6.operationsFailed === 1, "Bad op counted as failed");

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n  Graph Surgery smoke test: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
