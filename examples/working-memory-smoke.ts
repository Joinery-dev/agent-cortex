/**
 * Smoke test for WorkingMemory — validates the three subtasks:
 * 1. Types compile and are usable
 * 2. Class methods work (task lifecycle, recording, reading)
 * 3. Score trend computation produces correct directions
 */

import { WorkingMemory } from "../src/kernel/working-memory.js";
import type { OrchestratorResult } from "../src/types/orchestrator.js";
import type { SenseEvaluation } from "../src/types/sense.js";
import type { TrendDirection } from "../src/types/working-memory.js";

// ── Helpers ──────────────────────────────────────────────────────

function mockEvaluation(
  receptorId: string,
  activationPath: string[],
  score: number,
): SenseEvaluation {
  return {
    senseId: receptorId,
    activationPath,
    score,
    assessment: `Score: ${score}`,
    tensions: [],
    suggestions: [],
  };
}

function mockResult(
  evaluations: SenseEvaluation[],
  cycles = 1,
): OrchestratorResult {
  const scores = evaluations.map((e) => e.score);
  const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    taskId: "ignored", // completeTask uses the taskId param, not this
    status: "complete",
    work: "mock work",
    evaluations,
    tensions: [],
    resolutions: [],
    cycles,
    confidence: mean / 10,
    decisionLog: [
      {
        id: `dec-${Date.now()}`,
        timestamp: new Date(),
        description: "Test decision",
        reasoning: "Testing",
        confidence: 0.8,
        requiresParsifalReview: false,
      },
    ],
  };
}

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

function assertDirection(
  actual: TrendDirection,
  expected: TrendDirection,
  label: string,
): void {
  assert(actual === expected, `${label}: expected "${expected}", got "${actual}"`);
}

// ── Tests ────────────────────────────────────────────────────────

console.log("\n─── Working Memory Smoke Test ───\n");

// 1. Basic lifecycle
console.log("Task lifecycle:");
const wm = new WorkingMemory("test-project");

wm.addTask("task-1", "Build hero section");
wm.addTask("task-2", "Build about page");
wm.addTask("task-3", "Build gallery");

assert(wm.getTasks().length === 3, "3 tasks added");
assert(
  wm.getTasks().every((t) => t.status === "pending"),
  "All tasks pending",
);

wm.startTask("task-1");
assert(wm.getCurrentTaskId() === "task-1", "Current task is task-1");

// Complete task-1 with rising design scores
wm.completeTask(
  "task-1",
  mockResult([
    mockEvaluation("color-harmony", ["DESIGN", "Visual Identity", "Color Harmony"], 6),
    mockEvaluation("typography", ["DESIGN", "Visual Identity", "Typography"], 5),
    mockEvaluation("input-validation", ["CORRECTNESS", "Functional", "Input Validation"], 8),
  ]),
);

assert(wm.getCurrentTaskId() === null, "No current task after completion");
assert(
  wm.getTasks().find((t) => t.taskId === "task-1")?.status === "complete",
  "task-1 is complete",
);
assert(wm.getCompletedSummaries().length === 1, "1 completed summary");

// 2. Score trends with not enough data (1 task)
console.log("\nScore trends (1 task — should be stable):");
const earlyReceptorTrends = wm.getReceptorTrends();
assert(earlyReceptorTrends.length === 3, "3 receptor trends");
assert(
  earlyReceptorTrends.every((t) => t.direction === "stable"),
  "All stable with 1 data point",
);

const earlySenseTrends = wm.getSenseTrends();
assert(earlySenseTrends.length === 2, "2 sense trends (DESIGN, CORRECTNESS)");

// 3. Complete task-2 with higher design scores (should trend up)
wm.startTask("task-2");
wm.completeTask(
  "task-2",
  mockResult([
    mockEvaluation("color-harmony", ["DESIGN", "Visual Identity", "Color Harmony"], 8),
    mockEvaluation("typography", ["DESIGN", "Visual Identity", "Typography"], 7),
    mockEvaluation("input-validation", ["CORRECTNESS", "Functional", "Input Validation"], 8),
  ]),
);

// 4. Complete task-3 with even higher design, lower correctness
wm.startTask("task-3");
wm.completeTask(
  "task-3",
  mockResult([
    mockEvaluation("color-harmony", ["DESIGN", "Visual Identity", "Color Harmony"], 9),
    mockEvaluation("typography", ["DESIGN", "Visual Identity", "Typography"], 8),
    mockEvaluation("input-validation", ["CORRECTNESS", "Functional", "Input Validation"], 5),
  ]),
);

// 5. Verify receptor trends
console.log("\nReceptor trends (3 tasks):");
const receptorTrends = wm.getReceptorTrends();
const colorTrend = receptorTrends.find((t) => t.id === "color-harmony")!;
const typoTrend = receptorTrends.find((t) => t.id === "typography")!;
const inputTrend = receptorTrends.find((t) => t.id === "input-validation")!;

// Color: 6, 8, 9 → first half mean [6,8]=7, second half [9]=9, delta=2 → up
assertDirection(colorTrend.direction, "up", "Color Harmony (6→8→9)");
assert(colorTrend.dataPoints === 3, "Color Harmony: 3 data points");
assert(colorTrend.level === "receptor", "Color Harmony: receptor level");
assert(colorTrend.label === "Color Harmony", "Color Harmony: label correct");

// Typography: 5, 7, 8 → first half [5,7]=6, second half [8]=8, delta=2 → up
assertDirection(typoTrend.direction, "up", "Typography (5→7→8)");

// Input validation: 8, 8, 5 → first half [8,8]=8, second half [5]=5, delta=-3 → down
assertDirection(inputTrend.direction, "down", "Input Validation (8→8→5)");

// 6. Verify sense trends
console.log("\nSense trends (3 tasks):");
const senseTrends = wm.getSenseTrends();
const designTrend = senseTrends.find((t) => t.id === "DESIGN")!;
const correctTrend = senseTrends.find((t) => t.id === "CORRECTNESS")!;

// DESIGN: task means = (6+5)/2=5.5, (8+7)/2=7.5, (9+8)/2=8.5
// first half [5.5,7.5]=6.5, second half [8.5]=8.5, delta=2 → up
assertDirection(designTrend.direction, "up", "DESIGN sense (5.5→7.5→8.5)");
assert(designTrend.level === "sense", "DESIGN: sense level");

// CORRECTNESS: task means = 8, 8, 5
// first half [8,8]=8, second half [5]=5, delta=-3 → down
assertDirection(correctTrend.direction, "down", "CORRECTNESS sense (8→8→5)");

// 7. Patterns
console.log("\nPatterns:");
const pattern = wm.recordPattern("Dark + bold visual language", 0.7);
assert(pattern.id.length > 0, "Pattern has ID");
assert(pattern.confidence === 0.7, "Pattern confidence preserved");
assert(wm.getPatterns().length === 1, "1 pattern recorded");

// 8. Inhibition
console.log("\nInhibition:");
wm.inhibitSense("scalability", "Irrelevant for 5-page site", "planner");
assert(wm.isInhibited("scalability"), "Scalability is inhibited");
assert(!wm.isInhibited("design"), "Design is not inhibited");

// Idempotent update
wm.inhibitSense("scalability", "Updated reason", "amygdala");
assert(wm.getInhibitedSenses().length === 1, "Still 1 inhibition (idempotent)");
assert(
  wm.getInhibitedSenses()[0].source === "amygdala",
  "Source updated to amygdala",
);

wm.uninhibitSense("scalability");
assert(!wm.isInhibited("scalability"), "Scalability uninhibited");

// 9. Open questions
console.log("\nOpen questions:");
const q = wm.addQuestion(
  "Should we use Calendly for booking?",
  "Booking page is upcoming",
);
assert(wm.getOpenQuestions().length === 1, "1 open question");

wm.resolveQuestion(q.id, "Yes, integrate Calendly embed");
assert(wm.getOpenQuestions().length === 0, "0 open questions after resolution");

// 10. Decisions
console.log("\nDecisions:");
assert(
  wm.getDecisions().length === 3,
  "3 decisions (1 per completed task from decisionLog)",
);

// 11. Snapshot
console.log("\nSnapshot:");
const snap = wm.snapshot();
assert(snap.projectId === "test-project", "Snapshot has projectId");
assert(snap.tasks.length === 3, "Snapshot has 3 tasks");
assert(snap.scoreHistory.length === 3, "Snapshot has 3 score snapshots");
assert(snap.patterns.length === 1, "Snapshot has 1 pattern");
assert(snap.currentTaskId === null, "Snapshot: no current task");

// Verify snapshot is a deep copy (mutating original doesn't affect it)
wm.recordPattern("Another pattern");
assert(snap.patterns.length === 1, "Snapshot is a deep copy (still 1 pattern)");

// 12. Fail task
console.log("\nFail task:");
wm.addTask("task-4", "Build contact page");
wm.startTask("task-4");
wm.failTask("task-4", "LLM rate limit");
assert(
  wm.getTasks().find((t) => t.taskId === "task-4")?.status === "failed",
  "task-4 is failed",
);
assert(wm.getCurrentTaskId() === null, "No current task after failure");

// 13. Load
console.log("\nLoad:");
const load = wm.getLoad();
assert(load > 0 && load < 1, `Load is ${load.toFixed(3)} (between 0 and 1)`);

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) {
  process.exit(1);
}
