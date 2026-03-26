/**
 * Planner — Smoke Test
 *
 * Verifies the Planner's two-phase planning process:
 *   1. createManifestationTask() — produces a well-formed task for Phase A
 *   2. extractManifestedFuture() — parses sensory cortex result
 *   3. applyNecessityGates() — Jensen's three gates filter weak tasks
 *   4. buildGraph() — converts proposed tasks to TaskGraphNode[]
 *   5. Thalamus integration — manifestedFuture storage and retrieval
 *   6. End-to-end: reasonBackward() with LLM (skipped if no API key)
 *
 * Run: npx tsx examples/planner-smoke.ts
 */

import { Planner } from "../src/kernel/planner.js";
import { Thalamus } from "../src/kernel/thalamus.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { SensoryCortexResult } from "../src/types/brainstem.js";
import type { SenseEvaluation } from "../src/types/sense.js";
import type { ProposedTask, ProposedPhase, ReplanContext } from "../src/types/planner.js";
import { bus } from "../src/events.js";

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

function makeIntent(): ProjectIntent {
  return {
    id: "test-project-1",
    summary: "Build a landing page for a SaaS product",
    audience: "Technical founders evaluating developer tools",
    successCriteria: [
      "Clear value proposition above the fold",
      "Fast load time (<2s)",
      "Mobile-responsive",
      "Compelling CTA hierarchy",
    ],
    constraints: [
      "Must work without JavaScript for core content",
      "Brand colors: dark theme with accent blue",
    ],
    vision: "A fast, authoritative landing page that makes technical founders feel like this tool was built for them.",
    keyDecisions: [],
    driftLog: [],
  };
}

function makeTaste(): TasteProfile {
  return {
    id: "taste-1",
    name: "Technical Minimalist",
    visual: "Dark, bold, minimal. Let the product speak.",
    decisionStyle: "First principles. Strip to essentials, then add only what earns its place.",
    communication: "Direct, no fluff. Show don't tell.",
    patterns: "Component-based, semantic HTML, utility CSS.",
    raw: {},
  };
}

function makeSensoryCortexResult(): SensoryCortexResult {
  const evaluations: SenseEvaluation[] = [
    {
      senseId: "design",
      activationPath: ["Design", "Visual Language", "color-harmony"],
      score: 8,
      acceptable: true,
      assessment: "The vision establishes a cohesive dark palette with blue accents that convey technical authority.",
      tensions: [],
      suggestions: [],
    },
    {
      senseId: "performance",
      activationPath: ["Performance", "Load Time", "time-to-interactive"],
      score: 7,
      acceptable: true,
      assessment: "The no-JS constraint enables excellent core web vitals. Image strategy needs definition.",
      tensions: [],
      suggestions: ["Define image optimization pipeline"],
    },
    {
      senseId: "content",
      activationPath: ["Content", "Messaging", "value-proposition"],
      score: 9,
      acceptable: true,
      assessment: "Strong technical-founder-focused messaging with clear hierarchy.",
      tensions: [],
      suggestions: [],
    },
  ];

  return {
    taskId: "plan-manifest-test",
    status: "complete",
    work: `The finished landing page is a dark-themed, single-page experience that loads in under 1.5 seconds. Above the fold: a bold headline targeting technical founders ("Ship faster with fewer tools"), a one-line subtitle explaining the value proposition, and a primary CTA to start a free trial. The visual language is minimal — dark background (#0a0a0a), blue accent (#3b82f6), system font stack. No hero images — instead, an inline code snippet showing the tool in action. Below the fold: three feature cards with icons, a testimonial from a known technical founder, pricing comparison table, and a secondary CTA. Mobile layout stacks vertically, CTA is sticky. The page works fully without JavaScript — progressive enhancement adds smooth scrolling and the interactive code demo.`,
    evaluations,
    tensions: [],
    resolutions: [],
    cycles: 1,
    confidence: 0.82,
    decisionLog: [],
  };
}

function makeProposedTasks(): ProposedTask[] {
  return [
    {
      id: "t1",
      description: "Build HTML structure with semantic markup and dark theme foundation",
      dependsOn: [],
      phaseGroup: "foundation",
      necessity: "The page cannot exist without its HTML structure. Everything else builds on this.",
      formJustification: "Semantic HTML with embedded dark theme ensures no-JS constraint is met from the start.",
      scopeJustification: "Only the structural skeleton and theme variables — no content or interactivity.",
    },
    {
      id: "t2",
      description: "Implement above-the-fold hero section with headline, subtitle, and primary CTA",
      dependsOn: ["t1"],
      phaseGroup: "content",
      necessity: "The hero section is the first thing visitors see — without it, there's no value proposition.",
      formJustification: "Combined hero because headline, subtitle, and CTA are a single visual unit.",
      scopeJustification: "Just the hero — below-fold content is a separate task with different concerns.",
    },
    {
      id: "t3",
      description: "Build below-the-fold content: features, testimonial, pricing, secondary CTA",
      dependsOn: ["t1"],
      phaseGroup: "content",
      necessity: "Below-fold content provides evidence and social proof needed to convert visitors.",
      formJustification: "Grouped because these sections share layout patterns and progressive disclosure logic.",
      scopeJustification: "All below-fold content together to ensure visual consistency within the section.",
    },
    {
      id: "t4",
      description: "Add responsive mobile layout and sticky CTA",
      dependsOn: ["t2", "t3"],
      phaseGroup: "polish",
      necessity: "Mobile traffic is 50%+ for SaaS. Without mobile layout, half the audience gets a broken experience.",
      formJustification: "Responsive CSS with sticky CTA — not a separate mobile site.",
      scopeJustification: "Mobile layout plus sticky CTA are coupled — the sticky CTA only matters on mobile.",
    },
    // This one should be rejected — weak justification
    {
      id: "t5",
      description: "Add analytics tracking",
      dependsOn: ["t4"],
      phaseGroup: "polish",
      necessity: "Nice to have",  // Too short — should fail gate
      formJustification: "Standard analytics setup",  // Too short
      scopeJustification: "Basic tracking only",  // Too short
    },
  ];
}

function makeProposedPhases(): ProposedPhase[] {
  return [
    {
      name: "foundation",
      purpose: "Establish the structural skeleton and visual foundation",
      gateCondition: "HTML structure renders correctly with dark theme, no-JS baseline works",
    },
    {
      name: "content",
      purpose: "Fill the structure with compelling content and messaging",
      gateCondition: "All content sections present, value proposition is clear above the fold",
    },
    {
      name: "polish",
      purpose: "Responsive design and progressive enhancement",
      gateCondition: "Page works on mobile, CTA is accessible, core web vitals pass",
    },
  ];
}

// ─── Tests ──────────────────────────────────────────────────────

const events: Array<{ type: string; data: Record<string, unknown> }> = [];
bus.onCortex((e) => events.push(e));

const planner = new Planner("claude-sonnet-4-6-20250514");
const intent = makeIntent();
const taste = makeTaste();

// Test 1: createManifestationTask
console.log("\n1. createManifestationTask");
{
  const task = planner.createManifestationTask(intent);
  assert(task.id.startsWith("plan-manifest-"), "Task ID has planning prefix");
  assert(task.description.includes("Manifest the completed outcome"), "Description frames the work correctly");
  assert(task.description.includes(intent.summary), "Description includes project summary");
  assert(task.context.planningPhase === "manifestation", "Context marks planning phase");
  assert(task.context.intentId === intent.id, "Context carries intent ID");
  assert(task.status === "pending", "Task starts as pending");
}

// Test 2: extractManifestedFuture
console.log("\n2. extractManifestedFuture");
{
  const scResult = makeSensoryCortexResult();
  const future = planner.extractManifestedFuture(scResult);

  assert(future.vision === scResult.work, "Vision is the sensory cortex work output");
  assert(future.confidence === scResult.confidence, "Confidence carried through");
  assert(future.cycles === scResult.cycles, "Cycle count carried through");
  assert(Object.keys(future.senseContributions).length === 3, "Three sense contributions extracted");
  assert("Design" in future.senseContributions, "Design sense contribution present");
  assert("Performance" in future.senseContributions, "Performance sense contribution present");
  assert("Content" in future.senseContributions, "Content sense contribution present");
  assert(
    future.senseContributions["Design"].includes("dark palette"),
    "Design contribution contains assessment text",
  );

  // Check event emission
  const manifestEvent = events.find((e) => e.type === "planner:manifestation-complete");
  assert(!!manifestEvent, "Manifestation complete event emitted");
  assert((manifestEvent?.data.senseCount as number) === 3, "Event carries sense count");
}

// Test 3: applyNecessityGates
console.log("\n3. applyNecessityGates — Jensen's three gates");
{
  const proposed = makeProposedTasks();
  const { accepted, rejected } = planner.applyNecessityGates(proposed);

  assert(accepted.length === 4, `4 tasks accepted (got ${accepted.length})`);
  assert(rejected.length === 1, `1 task rejected (got ${rejected.length})`);
  assert(rejected[0].task.id === "t5", "Analytics task rejected");
  assert(rejected[0].gate === "existence", `Rejected on existence gate (got ${rejected[0].gate})`);
  assert(rejected[0].reason.includes("No substantive justification"), "Rejection reason explains why");

  // Verify all accepted tasks have meaningful justifications
  for (const task of accepted) {
    assert(task.necessity.length >= 10, `${task.id} has substantive necessity`);
    assert(task.formJustification.length >= 10, `${task.id} has substantive form justification`);
    assert(task.scopeJustification.length >= 10, `${task.id} has substantive scope justification`);
  }
}

// Test 4: buildGraph
console.log("\n4. buildGraph — dependency resolution + cross-phase deps");
{
  const proposed = makeProposedTasks().slice(0, 4); // Only the 4 accepted ones
  const phases = makeProposedPhases();
  const graph = planner.buildGraph(proposed, phases);

  assert(graph.length === 4, `4 graph nodes (got ${graph.length})`);

  // All have real UUIDs (not the proposed temp IDs)
  for (const node of graph) {
    assert(node.task.id.startsWith("task-"), `Real ID: ${node.task.id}`);
  }

  // Phase groups assigned
  assert(graph[0].phaseGroup === "foundation", "First task in foundation phase");
  assert(graph[1].phaseGroup === "content", "Second task in content phase");

  // Foundation task has no deps (first phase)
  assert(graph[0].dependsOn.length === 0, "Foundation task has no dependencies");

  // Content tasks depend on foundation (cross-phase implicit dep)
  const contentTasks = graph.filter((n) => n.phaseGroup === "content");
  for (const ct of contentTasks) {
    assert(
      ct.dependsOn.includes(graph[0].task.id),
      `Content task ${ct.task.id} depends on foundation task`,
    );
  }

  // Polish task depends on content tasks (cross-phase) AND has explicit deps
  const polishTask = graph.find((n) => n.phaseGroup === "polish");
  assert(!!polishTask, "Polish task exists");
  assert(
    polishTask!.dependsOn.length >= 2,
    `Polish task has ${polishTask!.dependsOn.length} dependencies (expected ≥2)`,
  );

  // Task context carries planning metadata
  assert(graph[0].task.context.phaseGroup === "foundation", "Task context has phaseGroup");
  assert(typeof graph[0].task.context.necessity === "string", "Task context has necessity");
  assert(typeof graph[0].task.context.plannedById === "string", "Task context has plannedById");
}

// Test 5: Thalamus integration
console.log("\n5. Thalamus — manifestedFuture storage");
{
  const wm = new WorkingMemory("test-thalamus");
  const thal = new Thalamus({ wm });

  // Initially null
  assert(thal.getManifestedFuture() === null, "Initially null");

  // Set and retrieve
  const vision = "A dark-themed landing page...";
  thal.setManifestedFuture(vision);
  assert(thal.getManifestedFuture() === vision, "Stored and retrieved");

  // Event emitted
  const event = events.find((e) => e.type === "thalamus:manifested-future-set");
  assert(!!event, "Set event emitted");
  assert((event?.data.length as number) === vision.length, "Event carries length");
}

// Test 6: End-to-end reasonBackward (requires LLM)
console.log("\n6. reasonBackward — end-to-end LLM test");
{
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasApiKey) {
    console.log("   Skipped (no ANTHROPIC_API_KEY)");
  } else {
    try {
      const scResult = makeSensoryCortexResult();
      const future = planner.extractManifestedFuture(scResult);

      const result = await planner.reasonBackward(future, intent, taste);

      assert(result.manifestedFuture === future, "ManifestedFuture carried through");
      assert(result.graph.length > 0, `Graph has ${result.graph.length} tasks`);
      assert(result.phases.length > 0, `${result.phases.length} phases defined`);
      assert(result.reasoning.length > 0, "Reasoning trace present");

      // Every task in the graph should have dependencies resolved to real IDs
      for (const node of result.graph) {
        assert(node.task.id.startsWith("task-"), `Real ID: ${node.task.id}`);
        for (const dep of node.dependsOn) {
          assert(dep.startsWith("task-"), `Dependency is real ID: ${dep}`);
          const depExists = result.graph.some((n) => n.task.id === dep);
          assert(depExists, `Dependency ${dep} exists in graph`);
        }
      }

      // Every task should have a phase group matching a defined phase
      const phaseNames = new Set(result.phases.map((p) => p.name));
      for (const node of result.graph) {
        assert(
          phaseNames.has(node.phaseGroup ?? ""),
          `Task ${node.task.id} phase group matches a defined phase`,
        );
      }

      // Check events
      const startEvent = events.find((e) => e.type === "planner:path-reasoning-start");
      const completeEvent = events.find((e) => e.type === "planner:path-reasoning-complete");
      assert(!!startEvent, "Path reasoning start event emitted");
      assert(!!completeEvent, "Path reasoning complete event emitted");

      console.log(`   Produced ${result.graph.length} tasks in ${result.phases.length} phases`);
      console.log(`   Rejected: ${result.rejected.length}`);
      for (const phase of result.phases) {
        const tasksInPhase = result.graph.filter((n) => n.phaseGroup === phase.name).length;
        console.log(`   Phase "${phase.name}": ${tasksInPhase} tasks — ${phase.purpose}`);
      }
    } catch (err) {
      console.error(`   ERROR: ${err}`);
      failed++;
    }
  }
}

// Test 7: buildGraph with knownCompletedIds — completed deps filtered out
console.log("\n7. buildGraph with knownCompletedIds — completed deps filtered");
{
  const proposed = makeProposedTasks().slice(0, 4);
  const phases = makeProposedPhases();

  // Mark the foundation task (t1) as completed
  const completedIds = new Set(["completed-foundation-id"]);

  // Rewrite t2 and t3 to depend on the completed ID instead of t1
  const replanTasks: ProposedTask[] = [
    {
      ...proposed[1],
      dependsOn: ["completed-foundation-id"],
    },
    {
      ...proposed[2],
      dependsOn: ["completed-foundation-id"],
    },
    {
      ...proposed[3],
      dependsOn: [proposed[1].id, proposed[2].id],
    },
  ];

  const graph = planner.buildGraph(replanTasks, phases.slice(1), completedIds);

  assert(graph.length === 3, `3 graph nodes (got ${graph.length})`);

  // Content tasks should NOT have the completed ID in their dependsOn
  // (completed deps are filtered out)
  for (const node of graph) {
    for (const dep of node.dependsOn) {
      assert(
        !completedIds.has(dep),
        `Node ${node.task.id} should not depend on completed task ${dep}`,
      );
    }
  }
}

// Test 8: buildGraph backward-compatible — no third arg still works
console.log("\n8. buildGraph backward-compatible — no knownCompletedIds");
{
  const proposed = makeProposedTasks().slice(0, 4);
  const phases = makeProposedPhases();
  const graph = planner.buildGraph(proposed, phases);

  assert(graph.length === 4, `4 graph nodes without knownCompletedIds (got ${graph.length})`);

  // Foundation task has no deps (first phase, no completed IDs)
  assert(graph[0].dependsOn.length === 0, "Foundation task has no dependencies (backward compat)");

  // Content tasks still depend on foundation (cross-phase implicit dep)
  const contentTasks = graph.filter((n) => n.phaseGroup === "content");
  for (const ct of contentTasks) {
    assert(
      ct.dependsOn.includes(graph[0].task.id),
      `Content task depends on foundation (backward compat)`,
    );
  }
}

// Test 9: ReplanContext type shape
console.log("\n9. ReplanContext — type shape construction");
{
  const ctx: ReplanContext = {
    completedTasks: [
      { id: "task-abc", description: "Build HTML structure" },
      { id: "task-def", description: "Implement hero section" },
    ],
    escalatedTasks: ["task-ghi"],
    driftSummary: "Score profile shifted toward performance at the expense of design quality.",
    driftAnalysis: null,
    originalGraph: [],
    manifestedFuture: "A dark-themed landing page...",
    completedIds: new Set(["task-abc", "task-def"]),
    diagnosticDirective: undefined,
  };

  assert(ctx.completedTasks.length === 2, "ReplanContext has 2 completed tasks");
  assert(ctx.escalatedTasks.length === 1, "ReplanContext has 1 escalated task");
  assert(ctx.completedIds.size === 2, "ReplanContext completedIds has 2 entries");
  assert(ctx.driftSummary.length > 0, "ReplanContext has drift summary");
  assert(ctx.driftAnalysis === null, "ReplanContext driftAnalysis is null when unavailable");
  assert(ctx.diagnosticDirective === undefined, "ReplanContext diagnosticDirective is optional");
}

// Test 10: replan() method exists and accepts correct args
console.log("\n10. replan — method exists with correct signature");
{
  assert(typeof planner.replan === "function", "Planner has replan method");

  // Verify the method accepts the right number of args (5: context, intent, taste, maxims?, capabilities?)
  // TypeScript enforces the types at compile time — here we just verify it's callable
  assert(planner.replan.length >= 3, `replan accepts at least 3 args (got ${planner.replan.length})`);

  // Verify it returns a promise (async method)
  const ctx: ReplanContext = {
    completedTasks: [{ id: "task-1", description: "Done" }],
    escalatedTasks: [],
    driftSummary: "Drift detected",
    driftAnalysis: null,
    originalGraph: [],
    manifestedFuture: "The future",
    completedIds: new Set(["task-1"]),
  };

  // We can't call it without an LLM, but we can verify it doesn't throw on construction
  // and that calling it returns a promise (which will reject due to no LLM)
  const result = planner.replan(ctx, intent, taste);
  assert(result instanceof Promise, "replan returns a Promise");

  // Let the promise reject gracefully (no LLM configured)
  result.catch(() => {/* expected — no LLM available */});
}

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
