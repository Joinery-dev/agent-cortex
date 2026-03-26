/**
 * Smoke test: Integration Check — Phase Gate Coherence Verification
 *
 * Verifies that the IntegrationChecker can:
 * 1. Detect phase gate completion
 * 2. Run quantitative pre-check with green/yellow/red verdicts
 * 3. Build synthetic evaluation plans from WM score history
 * 4. weighEvaluationsWithStakes produces correct output
 * 5. Full integration check with live LLM (optional, skipped if no API key)
 *
 * Run: npx tsx examples/integration-check-smoke.ts
 */

import { IntegrationChecker } from "../src/kernel/integration-check.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import { weighEvaluationsWithStakes, computeComposite } from "../src/kernel/evaluation-weighter.js";
import type { TaskGraphNode } from "../src/types/brainstem.js";
import type { OrchestratorResult } from "../src/types/orchestrator.js";
import type { SenseEvaluation, ImprovementPotential } from "../src/types/sense.js";
import { setLogLevel } from "../src/util/logger.js";

setLogLevel("info");

// ─── Fixtures ────────────────────────────────────────────────────

function makeGraph(phases: Record<string, string[]>): TaskGraphNode[] {
  const nodes: TaskGraphNode[] = [];
  for (const [phaseGroup, taskIds] of Object.entries(phases)) {
    for (const id of taskIds) {
      nodes.push({
        task: { id, description: `Task ${id}`, status: "pending", metadata: {}, events: [] },
        dependsOn: [],
        phaseGroup,
      });
    }
  }
  return nodes;
}

function makeResult(taskId: string, work: string, confidence = 0.7): OrchestratorResult {
  return {
    taskId,
    status: "complete",
    work,
    evaluations: [],
    tensions: [],
    resolutions: [],
    cycles: 2,
    confidence,
    decisionLog: [],
  };
}

/**
 * Add a completed task to WM with specific sense scores.
 */
function addTask(
  wm: WorkingMemory,
  taskId: string,
  description: string,
  senses: Array<{ name: string; score: number; stake?: number }>,
  opts?: { cycles?: number; highTensions?: number },
): void {
  wm.addTask(taskId, description);
  wm.startTask(taskId);

  const evaluations = senses.map((s) => ({
    senseId: `${s.name}-receptor`,
    senseName: s.name,
    activationPath: [s.name, `${s.name}-pathway`, `${s.name}-receptor`],
    score: s.score,
    acceptable: s.score >= 5,
    assessment: `Score: ${s.score}`,
    tensionFlags: [] as Array<{ otherSenseId: string; description: string }>,
    suggestions: [] as string[],
  }));

  const tensionCount = opts?.highTensions ?? 0;
  const tensions = [];
  for (let i = 0; i < tensionCount; i++) {
    tensions.push({
      id: `t-${taskId}-${i}`,
      senseA: { senseId: senses[0].name, senseName: senses[0].name, score: senses[0].score, stake: 0.8 },
      senseB: { senseId: senses[1]?.name ?? senses[0].name, senseName: senses[1]?.name ?? senses[0].name, score: senses[1]?.score ?? 5, stake: 0.7 },
      description: `Tension ${i}`,
      severity: "high" as const,
      scoreGap: 3,
      stakeProduct: 0.56,
    });
  }

  // Record scores in WM (so getScoreHistory works)
  const weightedEvals = senses.map((s) => ({
    senseId: `${s.name}-receptor`,
    activationPath: [s.name, `${s.name}-pathway`, `${s.name}-receptor`],
    score: s.score,
    acceptable: s.score >= 5,
    assessment: `Score: ${s.score}`,
    tensions: [],
    suggestions: [],
    improvementPotential: { level: "none" as const },
    stake: s.stake ?? 0.7,
    adjustedStake: s.stake ?? 0.7,
    weightedScore: s.score * (s.stake ?? 0.7),
  }));
  wm.recordScores(taskId, weightedEvals);

  wm.completeTask(taskId, {
    taskId,
    status: "complete",
    work: description,
    evaluations,
    tensions,
    resolutions: [],
    decisionLog: [],
    cycles: opts?.cycles ?? 2,
    confidence: 0.7,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures++;
  }
}

// ─── Mock Thalamus (minimal for tests) ──────────────────────────

function mockThalamus(manifestedFuture?: string) {
  return {
    getManifestedFuture: () => manifestedFuture ?? null,
    getActiveSenses: () => [],
    forIntegrationCheck: (
      phaseGroup: string,
      gateCondition: string,
      graph: TaskGraphNode[],
      taskResults: Map<string, OrchestratorResult>,
    ) => {
      const phaseNodes = graph.filter((n) => n.phaseGroup === phaseGroup);
      const phaseWork = phaseNodes
        .map((n) => {
          const r = taskResults.get(n.task.id);
          return r ? { taskId: n.task.id, description: n.task.description, work: r.work, confidence: r.confidence } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x != null);

      return {
        phaseGroup,
        gateCondition,
        manifestedFuture: manifestedFuture ?? null,
        phaseWork,
        enrichment: { patterns: [], senseTrends: [], principles: [] },
        meta: { consumer: "integration-check", assembledAt: new Date(), sources: [], enrichmentCounts: {} },
      };
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── Mock SensoryCortex library ─────────────────────────────────

function mockLibrary() {
  const senses = new Map([
    ["DESIGN-receptor", { id: "DESIGN-receptor", name: "DESIGN-receptor", level: "receptor", sensitivity: "Visual coherence", activationHint: "", parentId: "DESIGN" }],
    ["PERF-receptor", { id: "PERF-receptor", name: "PERF-receptor", level: "receptor", sensitivity: "Performance", activationHint: "", parentId: "PERF" }],
  ]);

  return {
    get: (id: string) => senses.get(id) ?? null,
    getAncestorPath: (id: string) => {
      if (id === "DESIGN-receptor") return ["DESIGN", "DESIGN-pathway", "DESIGN-receptor"];
      if (id === "PERF-receptor") return ["PERF", "PERF-pathway", "PERF-receptor"];
      return [id];
    },
    getSenses: () => [...senses.values()],
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("\n── Integration Check Smoke Test ──\n");

  const config = {
    maxCycles: 2,
    maxOuterCycles: 3,
    improvementThreshold: 0.3,
    diminishingReturnsDelta: 0.5,
    models: {
      consultation: "claude-sonnet-4-6-20250514",
      motorCortex: "claude-sonnet-4-6-20250514",
      evaluation: "claude-sonnet-4-6-20250514",
      resolution: "claude-sonnet-4-6-20250514",
    },
  };

  // ── 1. Phase gate detection ──────────────────────────────────
  console.log("1. Phase gate detection");

  const graph = makeGraph({
    "Design Phase": ["d1", "d2", "d3"],
    "Content Phase": ["c1", "c2"],
  });

  const checker = new IntegrationChecker(
    undefined,
    mockLibrary(),
    new WorkingMemory("detect-test"),
    mockThalamus(),
    config,
  );

  const completed = new Set(["d1", "d2"]);
  const escalated = new Set<string>();

  check("Phase not complete with 2/3 tasks done", !checker.detectPhaseGate("Design Phase", graph, completed, escalated));

  completed.add("d3");
  check("Phase complete with 3/3 tasks done", checker.detectPhaseGate("Design Phase", graph, completed, escalated));
  check("Other phase not complete", !checker.detectPhaseGate("Content Phase", graph, completed, escalated));

  // Escalated task counts as done for gate purposes
  const completed2 = new Set(["d1", "d2"]);
  const escalated2 = new Set(["d3"]);
  check("Phase complete when last task is escalated", checker.detectPhaseGate("Design Phase", graph, completed2, escalated2));

  // ── 2. Pre-check green ───────────────────────────────────────
  console.log("\n2. Pre-check — green signals, low NE → skip LLM");

  const wmGreen = new WorkingMemory("green-test");
  // Add 3 tasks with good scores (need >= 3 for sense trends)
  addTask(wmGreen, "g1", "Good task 1", [{ name: "DESIGN", score: 8 }, { name: "PERF", score: 7 }]);
  addTask(wmGreen, "g2", "Good task 2", [{ name: "DESIGN", score: 8 }, { name: "PERF", score: 8 }]);
  addTask(wmGreen, "g3", "Good task 3", [{ name: "DESIGN", score: 9 }, { name: "PERF", score: 8 }]);

  // Record a conviction entry so trajectory reads stable
  wmGreen.recordConviction(
    { verdict: "proceed", level: 0.8, delta: 0, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" },
    null,
    0,
  );

  const greenChecker = new IntegrationChecker(
    undefined,
    mockLibrary(),
    wmGreen,
    mockThalamus("A beautiful portfolio site"),
    config,
  );

  const greenGraph = makeGraph({ "Phase A": ["g1", "g2", "g3"] });
  const greenResults = new Map<string, OrchestratorResult>([
    ["g1", makeResult("g1", "Header component")],
    ["g2", makeResult("g2", "Nav component")],
    ["g3", makeResult("g3", "Footer component")],
  ]);

  const greenResult = await greenChecker.check(
    "Phase A",
    "Visual language is consistent across all components",
    greenGraph,
    greenResults,
    0.2, // low NE
    0.0, // no drift
  );

  check("Pre-check verdict is green", greenResult.preCheck.verdict === "green");
  check("LLM was skipped", greenResult.evaluations === null);
  check("Phase passed", greenResult.passed === true);
  check("No integration issues", greenResult.integrationIssues.length === 0);

  // ── 3. Pre-check red ─────────────────────────────────────────
  console.log("\n3. Pre-check — red signals (declining trends, low scores)");

  const wmRed = new WorkingMemory("red-test");
  addTask(wmRed, "r1", "Task 1", [{ name: "DESIGN", score: 7 }, { name: "PERF", score: 7 }]);
  addTask(wmRed, "r2", "Task 2", [{ name: "DESIGN", score: 5 }, { name: "PERF", score: 5 }]);
  addTask(wmRed, "r3", "Task 3", [{ name: "DESIGN", score: 3 }, { name: "PERF", score: 3 }]);

  wmRed.recordConviction(
    { verdict: "reshape", level: 0.3, delta: -0.2, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" },
    null,
    0,
  );

  const redChecker = new IntegrationChecker(
    undefined,
    mockLibrary(),
    wmRed,
    mockThalamus(),
    config,
  );

  const redGraph = makeGraph({ "Phase A": ["r1", "r2", "r3"] });
  const redResults = new Map<string, OrchestratorResult>([
    ["r1", makeResult("r1", "Work 1")],
    ["r2", makeResult("r2", "Work 2")],
    ["r3", makeResult("r3", "Work 3")],
  ]);

  // Use check() without LLM — pre-check should be red and NOT skip
  const redResult = await redChecker.check(
    "Phase A",
    "All components are polished",
    redGraph,
    redResults,
    0.8, // high NE
    0.8, // high drift
  );

  check("Pre-check verdict is red", redResult.preCheck.verdict === "red");
  check("LLM NOT skipped (red verdict)", redResult.preCheck.skipLLM === false);

  // ── 4. Synthetic evaluation plan ─────────────────────────────
  console.log("\n4. Synthetic evaluation plan from WM score history");

  const wmPlan = new WorkingMemory("plan-test");
  addTask(wmPlan, "p1", "Task 1", [
    { name: "DESIGN", score: 7, stake: 0.8 },
    { name: "PERF", score: 6, stake: 0.6 },
  ]);
  addTask(wmPlan, "p2", "Task 2", [
    { name: "DESIGN", score: 8, stake: 0.9 },
    { name: "PERF", score: 7, stake: 0.7 },
  ]);

  const scoreHistory = wmPlan.getScoreHistory();
  const phaseScores = scoreHistory.filter((s) => ["p1", "p2"].includes(s.taskId));
  check("Score history has phase entries", phaseScores.length === 2);

  const totalReceptors = new Set<string>();
  for (const snap of phaseScores) {
    for (const entry of snap.scores) {
      totalReceptors.add(entry.receptorId);
    }
  }
  check("Union has 2 receptors (DESIGN + PERF)", totalReceptors.size === 2);

  // ── 5. weighEvaluationsWithStakes ────────────────────────────
  console.log("\n5. weighEvaluationsWithStakes");

  const fakeEvals: SenseEvaluation[] = [
    {
      senseId: "DESIGN-receptor",
      activationPath: ["DESIGN", "DESIGN-pathway", "DESIGN-receptor"],
      score: 7,
      acceptable: true,
      assessment: "Looks good",
      tensions: [],
      suggestions: [],
      improvementPotential: { level: "none" } as ImprovementPotential,
    },
    {
      senseId: "PERF-receptor",
      activationPath: ["PERF", "PERF-pathway", "PERF-receptor"],
      score: 5,
      acceptable: false,
      assessment: "Too slow",
      tensions: [],
      suggestions: [],
      improvementPotential: { level: "moderate" } as ImprovementPotential,
    },
  ];

  const stakeMap = new Map([["DESIGN", 0.8], ["PERF", 0.6]]);
  const weighted = weighEvaluationsWithStakes(fakeEvals, stakeMap);

  check("Weighted has 2 entries", weighted.length === 2);
  check("DESIGN stake is 0.8", weighted[0].stake === 0.8);
  check("PERF stake is 0.6", weighted[1].stake === 0.6);
  check("DESIGN weightedScore is 5.6", Math.abs(weighted[0].weightedScore - 5.6) < 0.01);
  check("PERF weightedScore is 3.0", Math.abs(weighted[1].weightedScore - 3.0) < 0.01);

  const composite = computeComposite(weighted);
  check("Composite weightedMean > 0", composite.weightedMean > 0);
  check("Composite confidence > 0", composite.confidence > 0);
  console.log(`  (weightedMean: ${composite.weightedMean.toFixed(2)}, confidence: ${composite.confidence.toFixed(2)})`);

  // ── 6. NE override forces LLM ────────────────────────────────
  console.log("\n6. High NE overrides green pre-check");

  const greenHighNE = await greenChecker.check(
    "Phase A",
    "Visual language is consistent",
    greenGraph,
    greenResults,
    0.7, // high NE — above override threshold
    0.0,
  );

  check("Pre-check still green", greenHighNE.preCheck.verdict === "green");
  check("LLM NOT skipped due to NE override", greenHighNE.preCheck.skipLLM === false);

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n── ${failures === 0 ? "All tests passed" : `${failures} test(s) FAILED`} ──\n`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
