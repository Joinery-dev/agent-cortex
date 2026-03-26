/**
 * Deep Synthesis — Smoke Test
 *
 * Verifies the synthesis machinery (NOT the LLM call):
 *   1. Empty inputs → no proposals
 *   2. Prompt generation (system + user)
 *   3. Blast radius threshold (>30% → shouldReplan)
 *   4. Conviction type extension (plan-modification level)
 *   5. Operation conversion logic
 *
 * Run: npx tsx examples/deep-synthesis-smoke.ts
 */

import {
  deepSynthesisSystem,
  deepSynthesisUser,
} from "../src/llm/prompts.js";
import type { DeepSynthesisPromptInputs } from "../src/llm/prompts.js";
import { deepSynthesis } from "../src/kernel/deep-synthesis.js";
import type { DeepSynthesisInputs } from "../src/kernel/deep-synthesis.js";
import { computeBlastRadius, discoveryId } from "../src/kernel/graph-surgery.js";
import type { ConvictionContext } from "../src/types/conviction.js";
import type { TaskGraphNode } from "../src/types/brainstem.js";
import { createTask } from "../src/types/task.js";

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

// ─── 1. Empty inputs → no proposals ────────────────────────────

console.log("\n  1. Empty inputs produce no proposals");

const emptyResult = await deepSynthesis(
  {
    observations: [],
    simulations: [],
    maxims: [],
    drift: null,
    remainingTasks: [],
    completedTaskIds: new Set(),
    manifestedFuture: "",
    phaseGroup: "phase-1",
  },
  "test-model",
);

assert(emptyResult.proposals.length === 0, "No proposals from empty inputs");
assert(!emptyResult.shouldReplan, "No replan from empty inputs");
assert(emptyResult.observationsConsumed === 0, "0 observations consumed");

// ─── 2. Prompt generation ──────────────────────────────────────

console.log("  2. Prompt generation");

const systemPrompt = deepSynthesisSystem();
assert(systemPrompt.includes("PFC Deep Synthesis"), "System prompt identifies component");
assert(systemPrompt.includes("INSERT"), "System prompt covers insert");
assert(systemPrompt.includes("AMEND"), "System prompt covers amend");
assert(systemPrompt.includes("REWORK"), "System prompt covers rework");
assert(systemPrompt.includes("REORDER"), "System prompt covers reorder");
assert(systemPrompt.includes("30%"), "System prompt mentions blast radius threshold");
assert(systemPrompt.includes("backward-compatible"), "System prompt mentions backward compat");

const userInputs: DeepSynthesisPromptInputs = {
  observations: [
    { id: "obs-1", fact: "API uses cursor-based pagination", component: "builder", relevance: 0.7 },
    { id: "obs-2", fact: "Auth module has no rate limiting", component: "evaluator", relevance: 0.9 },
  ],
  simulations: [
    {
      id: "sim-1",
      narrative: "Dashboard will struggle with cursor pagination because it expects offset-based",
      affectedTaskIds: ["t4"],
      impact: 0.7,
      confidence: 0.6,
      suggestedResponse: "Amend dashboard task to handle cursor pagination",
    },
  ],
  maxims: ["Data shape mismatches multiply integration cost"],
  driftLevel: 0.3,
  driftSummary: "Minor drift on performance dimension",
  remainingTasks: [
    { id: "t3", description: "Build authentication module", dependsOn: ["t1"], phaseGroup: "phase-1" },
    { id: "t4", description: "Build dashboard component", dependsOn: ["t2", "t3"], phaseGroup: "phase-2" },
  ],
  completedTaskIds: ["t1", "t2"],
  manifestedFuture: "A responsive dashboard with secure auth and paginated data views",
  phaseGroup: "phase-1",
};

const userPrompt = deepSynthesisUser(userInputs);
assert(userPrompt.includes("PHASE GATE: \"phase-1\""), "User prompt has phase gate");
assert(userPrompt.includes("MANIFESTED FUTURE"), "User prompt has manifested future");
assert(userPrompt.includes("[obs-1]"), "User prompt has observation IDs");
assert(userPrompt.includes("[sim-1]"), "User prompt has simulation IDs");
assert(userPrompt.includes("cursor-based pagination"), "User prompt has observation facts");
assert(userPrompt.includes("DRIFT: level 0.30"), "User prompt has drift");
assert(userPrompt.includes("Build dashboard component"), "User prompt has remaining tasks");
assert(userPrompt.includes("COMPLETED: [t1, t2]"), "User prompt has completed task IDs");
assert(userPrompt.includes("Return JSON"), "User prompt has output format");
assert(userPrompt.includes('"type": "insert|amend|rework|reorder"'), "User prompt has operation types");

// Test with minimal inputs
const minimalInputs: DeepSynthesisPromptInputs = {
  observations: [],
  simulations: [],
  maxims: [],
  driftLevel: 0,
  driftSummary: null,
  remainingTasks: [{ id: "t1", description: "Only task", dependsOn: [] }],
  completedTaskIds: [],
  manifestedFuture: "",
  phaseGroup: "phase-1",
};

const minimalPrompt = deepSynthesisUser(minimalInputs);
assert(!minimalPrompt.includes("TERRITORY OBSERVATIONS"), "No observations section when empty");
assert(!minimalPrompt.includes("SIMULATED SCENARIOS"), "No simulations section when empty");
assert(!minimalPrompt.includes("DRIFT:"), "No drift section when level is 0");

// ─── 3. Blast radius threshold ─────────────────────────────────

console.log("  3. Blast radius threshold");

function makeGraph(): TaskGraphNode[] {
  return [
    { task: createTask("t1", "Task 1"), dependsOn: [], phaseGroup: "p1" },
    { task: createTask("t2", "Task 2"), dependsOn: ["t1"], phaseGroup: "p1" },
    { task: createTask("t3", "Task 3"), dependsOn: ["t1"], phaseGroup: "p1" },
    { task: createTask("t4", "Task 4"), dependsOn: ["t2", "t3"], phaseGroup: "p2" },
    { task: createTask("t5", "Task 5"), dependsOn: ["t4"], phaseGroup: "p2" },
  ];
}

const graph = makeGraph();
const completed = new Set(["t1"]);

// Rework t1 → affects t2 and t3 downstream = 2/4 = 50% > 30% threshold
const highRadiusOps = [
  { op: "rework" as const, directive: {
    taskId: "t1", reason: "test", amendedDescription: "new",
    additionalContext: {}, downstreamDependents: ["t2", "t3"],
  }},
];
const highRadius = computeBlastRadius(highRadiusOps, graph, completed);
assert(highRadius > 0.3, `High blast radius: ${highRadius} > 0.3`);

// Amend t2 → 1/4 = 25% < 30% threshold
const lowRadiusOps = [
  { op: "amend" as const, taskId: "t2", description: "new desc" },
];
const lowRadius = computeBlastRadius(lowRadiusOps, graph, completed);
assert(lowRadius <= 0.3, `Low blast radius: ${lowRadius} <= 0.3`);

// ─── 4. Conviction type extension ──────────────────────────────

console.log("  4. Plan-modification conviction level");

// Verify the type system accepts "plan-modification"
const ctx: ConvictionContext = {
  level: "plan-modification",
  cycle: 1,
  intent: { id: "test", brief: "test project", constraints: [], taste: "default" },
};
assert(ctx.level === "plan-modification", "plan-modification is valid ConvictionContext level");

// ─── 5. Discovery ID generation for synthesis ──────────────────

console.log("  5. Discovery IDs for synthesis");

const d1 = discoveryId(1, "rate-limiting-middleware");
assert(d1 === "discovery-1-rate-limiting-middleware", `Synthesis ID: ${d1}`);

const d2 = discoveryId(2, "Pagination Adapter Layer");
assert(d2 === "discovery-2-pagination-adapter-layer", `Capitalized slug: ${d2}`);

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n  Deep Synthesis smoke test: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
