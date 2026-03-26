/**
 * Prospective Memory — Smoke Test
 *
 * Verifies structural paths (no LLM calls):
 *   1. Registration and lifecycle
 *   2. Fast-path matching (matchAll, matchTaskIds)
 *   3. One-shot vs per-match persistence
 *   4. State accessors
 *   5. Trigger shapes (directives, questions)
 *
 * Run: npx tsx examples/prospective-memory-smoke.ts
 */

import { ProspectiveMemory } from "../src/kernel/prospective-memory.js";
import type { ProspectiveTrigger, FiredTrigger } from "../src/types/prospective-memory.js";

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

// ─── 1. Register trigger ────────────────────────────────────────

console.log("\n1. Register trigger");
{
  const pm = new ProspectiveMemory();
  const id = pm.register({
    condition: { description: "When booking page starts" },
    action: { directive: "Ask about Calendly", question: "Calendly or custom booking?" },
    persistence: "once",
    source: "human",
  });

  assert(typeof id === "string" && id.length > 0, "Returns non-empty ID");
  assert(pm.getPending().length === 1, "One pending trigger");
  assert(pm.getPending()[0].id === id, "Pending trigger has correct ID");
  assert(pm.getPending()[0].status === "pending", "Status is pending");
  assert(pm.getPending()[0].source === "human", "Source is human");
  assert(pm.getPending()[0].firedOn.length === 0, "No fired-on tasks yet");
}

// ─── 2. checkFastPath with matchTaskIds ─────────────────────────

console.log("\n2. checkFastPath with matchTaskIds");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "Booking page", matchTaskIds: ["task-booking"] },
    action: { directive: "Use Calendly integration" },
    persistence: "once",
    source: "planner",
  });

  const matchResult = pm.checkFastPath("task-booking");
  assert(matchResult.length === 1, "One match on target task");
  assert(matchResult[0].confidence === 1.0, "Structural match has confidence 1.0");
  assert(matchResult[0].reason.includes("matchTaskIds"), "Reason mentions matchTaskIds");

  const noMatch = pm.checkFastPath("task-about");
  assert(noMatch.length === 0, "No match on different task");
}

// ─── 3. checkFastPath with matchAll ─────────────────────────────

console.log("\n3. checkFastPath with matchAll");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "Always enforce a11y", matchAll: true },
    action: { directive: "Accessibility is a hard constraint" },
    persistence: "per-match",
    source: "human",
  });

  const match1 = pm.checkFastPath("task-hero");
  assert(match1.length === 1, "Matches task-hero");

  const match2 = pm.checkFastPath("task-gallery");
  assert(match2.length === 1, "Matches task-gallery");

  const match3 = pm.checkFastPath("task-anything");
  assert(match3.length === 1, "Matches any task");
  assert(match3[0].reason.includes("matchAll"), "Reason mentions matchAll");
}

// ─── 4. checkFastPath with no match ─────────────────────────────

console.log("\n4. checkFastPath with no match");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "Only for specific tasks", matchTaskIds: ["task-x"] },
    action: { directive: "Do something special" },
    persistence: "once",
    source: "planner",
  });

  const result = pm.checkFastPath("task-y");
  assert(result.length === 0, "No match for unrelated task");
}

// ─── 5. Once trigger fires → status "fired" ────────────────────

console.log("\n5. Once trigger fires → status becomes 'fired'");
{
  const pm = new ProspectiveMemory();
  const id = pm.register({
    condition: { description: "Booking page", matchTaskIds: ["task-booking"] },
    action: { directive: "Use Calendly" },
    persistence: "once",
    source: "human",
  });

  // Use check() with a mock task — fast-path will match, no LLM needed
  const task = { id: "task-booking", description: "Build the booking page", context: {} };
  const intent = {
    id: "proj-1",
    summary: "Test project",
    audience: "test",
    successCriteria: [],
    vision: "test",
    constraints: [],
    raw: {},
  };

  const fired = await pm.check(task, intent, "test-model");
  assert(fired.length === 1, "One trigger fired");
  assert(fired[0].trigger.id === id, "Correct trigger fired");

  // Status should now be "fired"
  assert(pm.getPending().length === 0, "No pending triggers (once trigger consumed)");
  assert(pm.getFired().length === 1, "One fired trigger");
  assert(pm.getFired()[0].status === "fired", "Status is fired");
  assert(pm.getFired()[0].firedOn.includes("task-booking"), "firedOn includes task ID");
}

// ─── 6. Per-match trigger fires → stays "pending" ──────────────

console.log("\n6. Per-match trigger fires → stays 'pending'");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "All tasks", matchAll: true },
    action: { directive: "Enforce perf budget" },
    persistence: "per-match",
    source: "human",
  });

  const task1 = { id: "task-1", description: "First task", context: {} };
  const task2 = { id: "task-2", description: "Second task", context: {} };
  const intent = {
    id: "proj-1",
    summary: "Test",
    audience: "test",
    successCriteria: [],
    vision: "test",
    constraints: [],
    raw: {},
  };

  const fired1 = await pm.check(task1, intent, "test-model");
  assert(fired1.length === 1, "Fires on first task");
  assert(pm.getPending().length === 1, "Still pending after first fire");

  const fired2 = await pm.check(task2, intent, "test-model");
  assert(fired2.length === 1, "Fires on second task");
  assert(pm.getPending().length === 1, "Still pending after second fire");

  const trigger = pm.getPending()[0];
  assert(trigger.firedOn.length === 2, "firedOn has two task IDs");
  assert(trigger.firedOn.includes("task-1"), "firedOn includes task-1");
  assert(trigger.firedOn.includes("task-2"), "firedOn includes task-2");
}

// ─── 7. resolve() ───────────────────────────────────────────────

console.log("\n7. resolve() changes status");
{
  const pm = new ProspectiveMemory();
  const id = pm.register({
    condition: { description: "Test", matchAll: true },
    action: { directive: "Test directive" },
    persistence: "once",
    source: "test",
  });

  pm.resolve(id);
  assert(pm.getPending().length === 0, "No pending after resolve");
  const state = pm.getState();
  assert(state.resolvedCount === 1, "One resolved in state");
}

// ─── 8. expire() ────────────────────────────────────────────────

console.log("\n8. expire() changes status");
{
  const pm = new ProspectiveMemory();
  const id = pm.register({
    condition: { description: "Test", matchAll: true },
    action: { directive: "Test directive" },
    persistence: "once",
    source: "test",
  });

  pm.expire(id);
  assert(pm.getPending().length === 0, "No pending after expire");
  const state = pm.getState();
  assert(state.expiredCount === 1, "One expired in state");
}

// ─── 9. getState() returns correct categorization ───────────────

console.log("\n9. getState() categorization");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "A", matchAll: true },
    action: { directive: "A" },
    persistence: "once",
    source: "test",
  });
  const id2 = pm.register({
    condition: { description: "B", matchAll: true },
    action: { directive: "B" },
    persistence: "once",
    source: "test",
  });
  pm.register({
    condition: { description: "C", matchAll: true },
    action: { directive: "C" },
    persistence: "once",
    source: "test",
  });

  pm.resolve(id2);

  const state = pm.getState();
  assert(state.pendingCount === 2, "Two pending");
  assert(state.resolvedCount === 1, "One resolved");
  assert(state.firedCount === 0, "Zero fired");
  assert(state.expiredCount === 0, "Zero expired");
  assert(state.triggers.length === 3, "Three total triggers");
}

// ─── 10. Trigger with question shapes FiredTrigger correctly ────

console.log("\n10. Trigger with question");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "Booking page", matchTaskIds: ["task-booking"] },
    action: {
      directive: "Integration approach needed for booking",
      question: "Calendly or custom? Don't overbuild.",
    },
    persistence: "once",
    source: "human",
  });

  const result = pm.checkFastPath("task-booking");
  assert(result.length === 1, "Trigger matches");
  assert(result[0].trigger.action.question === "Calendly or custom? Don't overbuild.", "Question preserved");
  assert(result[0].trigger.action.directive === "Integration approach needed for booking", "Directive preserved");
}

// ─── 11. Already-fired once trigger not returned again ──────────

console.log("\n11. Once trigger doesn't re-fire");
{
  const pm = new ProspectiveMemory();
  pm.register({
    condition: { description: "Test", matchAll: true },
    action: { directive: "Test" },
    persistence: "once",
    source: "test",
  });

  const task = { id: "task-1", description: "First", context: {} };
  const intent = {
    id: "proj-1",
    summary: "Test",
    audience: "test",
    successCriteria: [],
    vision: "test",
    constraints: [],
    raw: {},
  };

  const fired1 = await pm.check(task, intent, "test-model");
  assert(fired1.length === 1, "Fires first time");

  // Same task again — should not fire (status is now "fired")
  const fired2 = await pm.check(task, intent, "test-model");
  assert(fired2.length === 0, "Does not re-fire on same task");

  // Different task — should not fire (once trigger is consumed)
  const task2 = { id: "task-2", description: "Second", context: {} };
  const fired3 = await pm.check(task2, intent, "test-model");
  assert(fired3.length === 0, "Does not fire on different task after consumed");
}

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Prospective memory smoke: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
