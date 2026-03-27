/**
 * Smoke test for AttentionScheduler — validates:
 * 1. All five action paths (complete, dispatch, escalate, rest, replan)
 * 2. Priority cascade ordering
 * 3. Task selection scoring (phase group, dependency unblocking)
 * 4. NE computation and capping
 * 5. Explore/leverage mode selection
 * 6. Edge cases (deadlock, rest-before-first-task, single task)
 */

import { AttentionScheduler } from "../src/kernel/attention-scheduler.js";
import type {
  SchedulerSignals,
  SchedulerAction,
  SchedulerConfig,
} from "../src/types/attention-scheduler.js";
import type { TaskGraphNode, VitalSigns, ConsolidationLoad } from "../src/types/brainstem.js";
import { createTask } from "../src/types/task.js";
import type { ScoreTrend, WMTask, OpenQuestion } from "../src/types/working-memory.js";

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

function node(id: string, deps: string[] = [], phaseGroup?: string): TaskGraphNode {
  return {
    task: createTask(id, `Task ${id}`),
    dependsOn: deps,
    phaseGroup,
  };
}

function defaultVitals(): VitalSigns {
  return {
    workingMemoryLoad: 0.3,
    predictionAccuracy: 0.7,
    contextCapacity: 0.4,
    learningSignalHealth: 0.8,
    weightVolatility: 0.2,
  };
}

function defaultConsolidationLoad(): ConsolidationLoad {
  return {
    episodeDensity: 0.2,
    memoryPressure: 0.2,
    predictionDrift: 0.1,
    weightInstability: 0.1,
    deferredProcessing: 0.0,
  };
}

function baseSignals(
  graph: TaskGraphNode[],
  completed: string[] = [],
  escalated: string[] = [],
): SchedulerSignals {
  return {
    taskGraph: graph,
    completedTaskIds: new Set(completed),
    escalatedTaskIds: new Set(escalated),
    wmSnapshot: {
      tasks: graph.map((n): WMTask => ({
        taskId: n.task.id,
        description: n.task.description,
        status: completed.includes(n.task.id) ? "complete" : "pending",
      })),
      senseTrends: [],
      receptorTrends: [],
      openQuestions: [],
      patterns: [],
      inhibitedSenses: [],
      load: 0.3,
    },
    vitals: defaultVitals(),
    needsRest: false,
    consolidationLoad: defaultConsolidationLoad(),
  };
}

function downTrend(name: string): ScoreTrend {
  return {
    id: name,
    label: name,
    level: "sense",
    direction: "down",
    currentMean: 4.0,
    previousMean: 7.0,
    dataPoints: 4,
  };
}

function stableTrend(name: string): ScoreTrend {
  return {
    id: name,
    label: name,
    level: "sense",
    direction: "stable",
    currentMean: 7.0,
    previousMean: 7.0,
    dataPoints: 4,
  };
}

function openQuestion(q: string): OpenQuestion {
  return {
    id: `q-${Math.random().toString(36).slice(2)}`,
    question: q,
    context: "test",
    askedAt: new Date(),
  };
}

// ── Tests ────────────────────────────────────────────────────────

console.log("\n─── Attention Scheduler Smoke Test ───\n");

const scheduler = new AttentionScheduler();

// ── 1. Complete ──────────────────────────────────────────────────

console.log("Complete action:");
{
  const graph = [node("a"), node("b", ["a"])];
  const signals = baseSignals(graph, ["a", "b"]);
  const action = scheduler.decide(signals);
  assert(action.action === "complete", "All tasks done → complete");
}
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph, ["a"], ["b"]);
  const action = scheduler.decide(signals);
  assert(action.action === "complete", "Mix of completed + escalated → complete");
}

// ── 2. Dispatch — single task ────────────────────────────────────

console.log("\nDispatch action (single task):");
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Single ready task → dispatch");
  if (action.action === "dispatch-task") {
    assert(action.taskId === "a", "Dispatches the correct task ID");
    assert(action.neLevel >= 0 && action.neLevel <= 1, "NE level is 0–1");
    assert(action.mode === "explore", "Default mode is explore (no BG)");
  }
}

// ── 3. Dispatch — multiple tasks, dependency unblocking ──────────

console.log("\nDispatch (dependency priority):");
{
  // Task "a" unblocks "c" and "d". Task "b" unblocks nothing.
  const graph = [
    node("a"),
    node("b"),
    node("c", ["a"]),
    node("d", ["a"]),
  ];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Multiple ready → dispatch");
  if (action.action === "dispatch-task") {
    assert(action.taskId === "a", "Picks task that unblocks the most (a unblocks c,d)");
  }
}

// ── 4. Dispatch — phase group coherence ──────────────────────────

console.log("\nDispatch (phase group coherence):");
{
  // Last completed task was in group "design". Task "b" is also in "design".
  // Task "c" is in "content". Both are ready, no dependency difference.
  const graph = [
    node("a", [], "design"),
    node("b", [], "design"),
    node("c", [], "content"),
  ];
  const signals = baseSignals(graph, ["a"]);
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Phase group test → dispatch");
  if (action.action === "dispatch-task") {
    assert(action.taskId === "b", "Prefers task in same phase group as last completed");
  }
}

// ── 5. Escalate — too many open questions ────────────────────────

console.log("\nEscalate (open questions):");
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.wmSnapshot.openQuestions = [
    openQuestion("What color scheme?"),
    openQuestion("Which font?"),
    openQuestion("What layout?"),
  ];
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "3+ open questions → escalate");
  if (action.action === "escalate") {
    assert(action.questions.length === 3, "Passes through all open questions");
  }
}

// ── 6. Escalate — scores cratering ───────────────────────────────

console.log("\nEscalate (cratering scores):");
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.wmSnapshot.senseTrends = [
    downTrend("Design"),
    downTrend("Performance"),
    stableTrend("Accessibility"),
  ];
  // 2/3 = 0.67 > threshold 0.5
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Majority of sense trends down → escalate");
}
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.wmSnapshot.senseTrends = [
    downTrend("Design"),
    stableTrend("Performance"),
    stableTrend("Accessibility"),
  ];
  // 1/3 = 0.33 < threshold 0.5
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Minority of trends down → still dispatches");
}

// ── 7. Escalate — perseveration ──────────────────────────────────

console.log("\nEscalate (perseveration):");
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.perseverating = true;
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Perseveration detected → escalate");
}

// ── 8. Escalate — deadlock ───────────────────────────────────────

console.log("\nEscalate (deadlock):");
{
  // Task "a" depends on "b", task "b" depends on "a". Neither is done.
  const graph = [node("a", ["b"]), node("b", ["a"])];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Circular deps → escalate (deadlock)");
}

// ── 9. Rest ──────────────────────────────────────────────────────

console.log("\nRest action:");
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph, ["a"]);
  signals.needsRest = true;
  const action = scheduler.decide(signals);
  assert(action.action === "rest", "Rest needed + tasks completed → rest");
}
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.needsRest = true;
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Rest needed but no completed tasks → dispatch (don't rest before doing anything)");
}

// ── 10. Replan ───────────────────────────────────────────────────

console.log("\nReplan action:");
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.driftLevel = 0.9;
  signals.driftSummary = "Project diverged from original visual direction";
  const action = scheduler.decide(signals);
  assert(action.action === "replan", "Drift above replan threshold → replan");
}
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.driftLevel = 0.6;
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Drift above escalate but below replan threshold → escalate");
}
{
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph);
  signals.driftLevel = 0.3;
  const action = scheduler.decide(signals);
  assert(action.action === "dispatch-task", "Drift below escalate threshold → dispatch normally");
}

// ── 11. Priority cascade ─────────────────────────────────────────

console.log("\nPriority cascade:");
{
  // Perseveration AND drift → perseveration wins (higher priority)
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.perseverating = true;
  signals.driftLevel = 0.9;
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Perseveration beats drift (higher in cascade)");
}
{
  // Drift replan AND open questions → drift replan wins
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.driftLevel = 0.85;
  signals.wmSnapshot.openQuestions = [
    openQuestion("q1"), openQuestion("q2"), openQuestion("q3"),
  ];
  const action = scheduler.decide(signals);
  assert(action.action === "replan", "Drift replan beats open questions");
}
{
  // Open questions AND rest needed → open questions wins
  const graph = [node("a"), node("b")];
  const signals = baseSignals(graph, ["a"]);
  signals.needsRest = true;
  signals.wmSnapshot.openQuestions = [
    openQuestion("q1"), openQuestion("q2"), openQuestion("q3"),
  ];
  const action = scheduler.decide(signals);
  assert(action.action === "escalate", "Open questions beat rest");
}

// ── 12. NE computation ───────────────────────────────────────────

console.log("\nNE computation (dynamic signal):");
{
  // No risk factors, no cerebellum accuracy → conservative defaults.
  // Dispatch-time NE has maturity + risk only (no novelty, no conviction).
  const graph = [node("a")];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.neLevel > 0 && action.neLevel < 1, `NE is in valid range (got ${action.neLevel.toFixed(3)})`);
  }
}
{
  // Down trends → risk factor raises NE
  const graph = [node("a")];
  const baseAction = scheduler.decide(baseSignals(graph));
  const baseNE = baseAction.action === "dispatch-task" ? baseAction.neLevel : 0;

  const riskySignals = baseSignals(graph);
  riskySignals.wmSnapshot.senseTrends = [
    downTrend("Design"),
    stableTrend("Performance"),
    stableTrend("Accessibility"),
  ];
  const riskyAction = scheduler.decide(riskySignals);
  if (riskyAction.action === "dispatch-task") {
    assert(riskyAction.neLevel > baseNE, `Down trend raises NE: ${riskyAction.neLevel.toFixed(3)} > ${baseNE.toFixed(3)}`);
  }
}
{
  // Stack risk factors — NE should cap at 1.0
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.wmSnapshot.senseTrends = [
    downTrend("Design"),
    stableTrend("Perf"),
    stableTrend("A11y"),
  ];
  signals.wmSnapshot.load = 0.95;
  signals.vitals.weightVolatility = 0.95;
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.neLevel <= 1.0, `NE caps at 1.0 (got ${action.neLevel.toFixed(3)})`);
  }
}

// ── 13. Explore / leverage ───────────────────────────────────────

console.log("\nExplore / leverage:");
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.mode === "explore", "No routine matches → explore");
  }
}
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.routineMatches = new Map([["a", { confidence: 0.9, routineId: "r1" }]]);
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.mode === "leverage", "High-confidence routine match → leverage");
  }
}
{
  const graph = [node("a")];
  const signals = baseSignals(graph);
  signals.routineMatches = new Map([["a", { confidence: 0.5, routineId: "r1" }]]);
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.mode === "explore", "Low-confidence routine match → still explore");
  }
}

// ── 14. Graph order as tie-break ─────────────────────────────────

console.log("\nGraph order tie-break:");
{
  // Two tasks with no phase group, no deps on each other, no trends
  const graph = [node("first"), node("second")];
  const signals = baseSignals(graph);
  const action = scheduler.decide(signals);
  if (action.action === "dispatch-task") {
    assert(action.taskId === "first", "Equal scores → graph order wins (first in array)");
  }
}

// ── Results ──────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) {
  process.exit(1);
}
