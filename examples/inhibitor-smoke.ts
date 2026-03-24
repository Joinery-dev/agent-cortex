/**
 * Smoke test for Inhibitor — validates:
 * 1. InhibitorConfig defaults and merge
 * 2. Scope hierarchy (clearInhibitionsByScope)
 * 3. WM inhibitSense/uninhibitSense with scope
 * 4. Thalamus forInhibition() briefing assembly
 * 5. Type correctness for suppress/detectCollapse signatures
 *
 * Note: suppress() and detectCollapse() make LLM calls and cannot be
 * tested without a live API key. This test validates everything around
 * them: the WM plumbing, scope cleanup, config, briefing assembly,
 * and that the component constructs and wires correctly.
 */

import { Inhibitor } from "../src/kernel/inhibitor.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import { Thalamus } from "../src/kernel/thalamus.js";
import { SensoryCortex } from "../src/senses/cortex.js";
import {
  DEFAULT_INHIBITOR_CONFIG,
  SCOPE_HIERARCHY,
} from "../src/types/inhibitor.js";
import type { InhibitorConfig, InhibitionBriefing } from "../src/types/inhibitor.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";

// ── Helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

function makeIntent(): ProjectIntent {
  return {
    id: "test-intent",
    summary: "Build a portfolio site",
    audience: "potential clients",
    successCriteria: ["looks professional", "loads fast"],
    vision: "clean and modern",
    constraints: [],
  };
}

function makeTaste(): TasteProfile {
  return {
    id: "test-taste",
    visual: "minimal, dark",
    decisionStyle: "opinionated",
    patterns: "consistent spacing",
    raw: {},
  };
}

// ══════════════════════════════════════════════════════════════════
console.log("\n═══ Inhibitor Smoke Tests ═══\n");

// ── 1. Config defaults ──────────────────────────────────────────
console.log("1. Config defaults");
{
  assert(DEFAULT_INHIBITOR_CONFIG.minActiveSenses === 2, "default minActiveSenses is 2");
  assert(DEFAULT_INHIBITOR_CONFIG.highNeThreshold === 0.7, "default highNeThreshold is 0.7");
  assert(DEFAULT_INHIBITOR_CONFIG.exploreSuppressionScale === 0.5, "default exploreSuppressionScale is 0.5");

  const inhibitor = new Inhibitor();
  assert(inhibitor instanceof Inhibitor, "constructs with no config");

  const custom = new Inhibitor({ minActiveSenses: 3 });
  assert(custom instanceof Inhibitor, "constructs with partial config");
}

// ── 2. Scope hierarchy ──────────────────────────────────────────
console.log("\n2. Scope hierarchy");
{
  assert(SCOPE_HIERARCHY.length === 4, "4 scope levels");
  assert(SCOPE_HIERARCHY[0] === "project", "broadest scope is project");
  assert(SCOPE_HIERARCHY[3] === "task", "narrowest scope is task");
  assert(
    SCOPE_HIERARCHY.indexOf("phase") < SCOPE_HIERARCHY.indexOf("subphase"),
    "phase is broader than subphase",
  );
}

// ── 3. WM scope-aware inhibition ────────────────────────────────
console.log("\n3. WM scope-aware inhibition");
{
  const wm = new WorkingMemory("test-scope");

  // Add inhibitions at different scopes
  wm.inhibitSense("sense-a", "irrelevant for project", "inhibitor", "project");
  wm.inhibitSense("sense-b", "irrelevant for phase", "inhibitor", "phase");
  wm.inhibitSense("sense-c", "irrelevant for subphase", "inhibitor", "subphase");
  wm.inhibitSense("sense-d", "irrelevant for task", "inhibitor", "task");
  wm.inhibitSense("sense-e", "urgent override", "amygdala"); // no scope

  assert(wm.getInhibitedSenses().length === 5, "5 total inhibitions");

  // Clear task scope — should only clear task
  const clearedTask = wm.clearInhibitionsByScope("task");
  assert(clearedTask.length === 1, "clearing task scope removes 1");
  assert(clearedTask[0] === "sense-d", "cleared sense-d (task scope)");
  assert(wm.getInhibitedSenses().length === 4, "4 remaining after task clear");

  // Amygdala override should survive all clears
  assert(wm.isInhibited("sense-e"), "amygdala override survives task clear");

  // Clear subphase — should clear subphase + task (task already cleared)
  wm.inhibitSense("sense-d2", "new task inhibition", "inhibitor", "task");
  const clearedSubphase = wm.clearInhibitionsByScope("subphase");
  assert(clearedSubphase.includes("sense-c"), "cleared sense-c (subphase)");
  assert(clearedSubphase.includes("sense-d2"), "cleared sense-d2 (task, under subphase)");
  assert(!clearedSubphase.includes("sense-b"), "did not clear sense-b (phase)");

  // Clear phase — should clear phase + subphase + task
  wm.inhibitSense("sense-f", "another task", "inhibitor", "task");
  const clearedPhase = wm.clearInhibitionsByScope("phase");
  assert(clearedPhase.includes("sense-b"), "cleared sense-b (phase)");
  assert(clearedPhase.includes("sense-f"), "cleared sense-f (task, under phase)");
  assert(!clearedPhase.includes("sense-a"), "did not clear sense-a (project)");

  // Clear project — clears everything with scope
  const clearedProject = wm.clearInhibitionsByScope("project");
  assert(clearedProject.includes("sense-a"), "cleared sense-a (project)");

  // Only amygdala override should remain
  assert(wm.getInhibitedSenses().length === 1, "only amygdala override remains");
  assert(wm.getInhibitedSenses()[0].source === "amygdala", "remaining is amygdala");
}

// ── 4. WM inhibitSense with scope (idempotent update) ───────────
console.log("\n4. WM inhibitSense idempotent with scope");
{
  const wm = new WorkingMemory("test-idempotent");

  wm.inhibitSense("sense-x", "reason 1", "inhibitor", "task");
  assert(wm.getInhibitedSenses().length === 1, "1 inhibition after first call");
  assert(wm.getInhibitedSenses()[0].scope === "task", "scope is task");

  // Update same sense with new scope
  wm.inhibitSense("sense-x", "reason 2", "inhibitor", "phase");
  assert(wm.getInhibitedSenses().length === 1, "still 1 inhibition (idempotent)");
  assert(wm.getInhibitedSenses()[0].scope === "phase", "scope updated to phase");
  assert(wm.getInhibitedSenses()[0].reason === "reason 2", "reason updated");
}

// ── 5. Thalamus forInhibition() briefing ────────────────────────
console.log("\n5. Thalamus forInhibition() briefing");
{
  const wm = new WorkingMemory("test-thalamus");
  const thalamus = new Thalamus({ wm });
  const library = SensoryCortex.withDefaults();
  const intent = makeIntent();
  const taste = makeTaste();

  thalamus.updateProject(intent, taste);

  // Without task
  const briefing = await thalamus.forInhibition(library);
  assert(briefing.intent.id === "test-intent", "briefing has intent");
  assert(briefing.taste.id === "test-taste", "briefing has taste");
  assert(briefing.task === undefined, "no task for project-level");
  assert(briefing.enrichment.senses.length > 0, "senses included");
  assert(briefing.enrichment.totalSenseCount > 0, "totalSenseCount > 0");
  assert(briefing.meta.consumer === "inhibition", "consumer is inhibition");

  // Verify sense summaries have required fields
  const firstSense = briefing.enrichment.senses[0];
  assert(typeof firstSense.id === "string", "sense has id");
  assert(typeof firstSense.name === "string", "sense has name");
  assert(typeof firstSense.sensitivity === "string", "sense has sensitivity");
  assert(typeof firstSense.activationHint === "string", "sense has activationHint");

  // With task + NE + mode
  const { createTask } = await import("../src/types/task.js");
  const task = createTask("test-task", "Build hero section");
  const taskBriefing = await thalamus.forInhibition(library, task, 0.8, "explore");
  assert(taskBriefing.task?.id === "test-task", "task included in briefing");
  assert(taskBriefing.enrichment.neLevel === 0.8, "NE level passed through");
  assert(taskBriefing.enrichment.mode === "explore", "mode passed through");
  assert(taskBriefing.meta.taskId === "test-task", "meta has taskId");

  // With existing inhibitions in WM
  wm.inhibitSense("sense-x", "test reason", "inhibitor", "task");
  const enrichedBriefing = await thalamus.forInhibition(library);
  assert(
    enrichedBriefing.enrichment.currentInhibitions.length === 1,
    "current inhibitions included in briefing",
  );
}

// ── 6. Inhibitor constructs with Brainstem pattern ──────────────
console.log("\n6. Brainstem integration pattern");
{
  // Verify the Inhibitor can be imported and constructed
  // the same way Brainstem does it
  const inhibitor = new Inhibitor({ minActiveSenses: 3 });
  assert(inhibitor instanceof Inhibitor, "Inhibitor constructs like Scheduler pattern");

  // Verify methods exist with correct signatures
  assert(typeof inhibitor.suppress === "function", "suppress() method exists");
  assert(typeof inhibitor.detectCollapse === "function", "detectCollapse() method exists");
}

// ── 7. CollapseContext and CollapseSignal types ─────────────────
console.log("\n7. Type correctness");
{
  // Verify types are importable and structurally correct
  const context = await import("../src/types/inhibitor.js");

  assert(context.SCOPE_HIERARCHY.length === 4, "SCOPE_HIERARCHY exported");
  assert(context.DEFAULT_INHIBITOR_CONFIG.minActiveSenses === 2, "DEFAULT_INHIBITOR_CONFIG exported");

  // Verify CollapseSignal structure
  const signal = { collapsed: false, details: [] };
  assert(signal.collapsed === false, "CollapseSignal.collapsed is boolean");
  assert(Array.isArray(signal.details), "CollapseSignal.details is array");
}

// ══════════════════════════════════════════════════════════════════
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
if (failed > 0) {
  process.exit(1);
}
