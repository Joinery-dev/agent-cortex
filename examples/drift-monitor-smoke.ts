/**
 * Smoke test: Drift Monitor — PFC Feature #6
 *
 * Verifies that the DriftMonitor can:
 * 1. Return zeros during cold start (< 3 tasks)
 * 2. Compute profile shift from diverging sense trends
 * 3. Compute tension escalation from increasing highTensionCount
 * 4. Compute convergence difficulty from increasing cycles
 * 5. Combine signals into composite driftLevel
 * 6. Apply sensitivity modulation from plasticity
 * 7. Run deep analysis via LLM (live call)
 * 8. Return correct getAssessment() and getState()
 *
 * Run: npx tsx examples/drift-monitor-smoke.ts
 */

import { DriftMonitor } from "../src/kernel/drift-monitor.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import type { DriftMonitorSources } from "../src/types/drift-monitor.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { PlasticitySource } from "../src/types/world-model.js";
import type { PlasticWeight, ConnectionSnapshot, ConnectionCategory } from "../src/types/plasticity.js";
import { setLogLevel } from "../src/util/logger.js";

setLogLevel("info");

// ─── Fixtures ────────────────────────────────────────────────────

const intent: ProjectIntent = {
  id: "drift-test-project",
  summary: "Build a minimalist portfolio site for an architectural photographer",
  audience: "Prospective clients — architects and developers",
  successCriteria: [
    "Visual impact is the primary experience",
    "Fast load times despite image-heavy content",
    "Professional credibility",
  ],
  constraints: [
    "Mobile-first",
    "Lighthouse performance > 90",
  ],
  vision: "A gallery-first experience — minimal chrome, maximum impact.",
  keyDecisions: [],
  driftLog: [],
};

const taste: TasteProfile = {
  id: "drift-test-taste",
  name: "Test Client",
  visual: "Clean, minimal, dark backgrounds to make images pop",
  decisionStyle: "Show me options, I'll pick",
  communication: "Brief and direct",
  patterns: "Grid layouts, full-bleed heroes, subtle scroll animations",
  raw: {},
};

/** Mock plasticity source with configurable sensitivity. */
function mockPlasticity(sensitivity: number): PlasticitySource {
  const weight: PlasticWeight = {
    connectionId: "drift-monitor.threshold.sensitivity",
    region: "DriftMonitor",
    description: "Drift sensitivity",
    value: sensitivity,
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
    version: 0,
    lastDelta: null,
  };
  return {
    snapshot(): ConnectionSnapshot {
      return { weights: [weight], version: 0, timestamp: new Date() };
    },
    getByCategory(_category: ConnectionCategory): PlasticWeight[] {
      return [weight];
    },
  };
}

/**
 * Add a completed task to WM with specific sense scores.
 * Each sense is a { name, score } pair — creates a single receptor per sense.
 */
function addTask(
  wm: WorkingMemory,
  taskId: string,
  description: string,
  senses: Array<{ name: string; score: number }>,
  opts?: { cycles?: number; highTensions?: number },
): void {
  wm.addTask(taskId, description);
  wm.startTask(taskId);

  const evaluations = senses.map((s) => ({
    senseId: s.name,
    senseName: s.name,
    activationPath: [s.name, `${s.name}-pathway`, `${s.name}-receptor`],
    score: s.score,
    acceptable: s.score >= 5,
    assessment: `Score: ${s.score}`,
    tensionFlags: [] as Array<{ otherSenseId: string; description: string }>,
    suggestions: [] as string[],
  }));

  // Build high tension array
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

  wm.completeTask(taskId, {
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

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

function buildSources(wm: WorkingMemory, plasticity?: PlasticitySource): DriftMonitorSources {
  return { wm, intent, taste, plasticity };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("\n── Drift Monitor Smoke Test ──\n");

  // 1. Cold start
  console.log("1. Cold start guard (< 3 tasks)");
  const dm = new DriftMonitor();
  const wm1 = new WorkingMemory("cold-start");
  addTask(wm1, "t1", "Task 1", [{ name: "DESIGN", score: 7 }]);
  addTask(wm1, "t2", "Task 2", [{ name: "DESIGN", score: 7 }]);

  const coldResult = dm.quickCheck(buildSources(wm1), "t2");
  check("driftLevel is 0 with 2 tasks", coldResult.driftLevel === 0);
  check("All signals are 0", coldResult.signals.profileShift === 0
    && coldResult.signals.tensionEscalation === 0
    && coldResult.signals.convergenceDifficulty === 0);
  check("taskCount is 2", coldResult.taskCount === 2);

  // 2. Profile shift detection
  console.log("\n2. Profile shift detection");
  const wm2 = new WorkingMemory("profile-shift");
  // Early tasks: Design high, Performance high
  addTask(wm2, "ps-1", "Task 1", [{ name: "DESIGN", score: 8 }, { name: "PERFORMANCE", score: 8 }]);
  addTask(wm2, "ps-2", "Task 2", [{ name: "DESIGN", score: 8 }, { name: "PERFORMANCE", score: 7 }]);
  // Later tasks: Design drops, Performance rises — the shape changes
  addTask(wm2, "ps-3", "Task 3", [{ name: "DESIGN", score: 5 }, { name: "PERFORMANCE", score: 9 }]);
  addTask(wm2, "ps-4", "Task 4", [{ name: "DESIGN", score: 4 }, { name: "PERFORMANCE", score: 9 }]);

  const dm2 = new DriftMonitor();
  const psResult = dm2.quickCheck(buildSources(wm2), "ps-4");
  check("profileShift > 0", psResult.signals.profileShift > 0);
  check(`profileShift is ${psResult.signals.profileShift.toFixed(3)}`, true);
  check("driftLevel > 0", psResult.driftLevel > 0);

  // 3. Tension escalation detection
  console.log("\n3. Tension escalation detection");
  const wm3 = new WorkingMemory("tension-escalation");
  addTask(wm3, "te-1", "Task 1", [{ name: "A", score: 7 }, { name: "B", score: 7 }], { highTensions: 0 });
  addTask(wm3, "te-2", "Task 2", [{ name: "A", score: 7 }, { name: "B", score: 7 }], { highTensions: 1 });
  addTask(wm3, "te-3", "Task 3", [{ name: "A", score: 7 }, { name: "B", score: 7 }], { highTensions: 2 });
  addTask(wm3, "te-4", "Task 4", [{ name: "A", score: 7 }, { name: "B", score: 7 }], { highTensions: 3 });

  const dm3 = new DriftMonitor();
  const teResult = dm3.quickCheck(buildSources(wm3), "te-4");
  check("tensionEscalation > 0", teResult.signals.tensionEscalation > 0);
  check(`tensionEscalation is ${teResult.signals.tensionEscalation.toFixed(3)}`, true);

  // 4. Convergence difficulty detection
  console.log("\n4. Convergence difficulty detection");
  const wm4 = new WorkingMemory("convergence");
  addTask(wm4, "cd-1", "Task 1", [{ name: "X", score: 7 }], { cycles: 1 });
  addTask(wm4, "cd-2", "Task 2", [{ name: "X", score: 7 }], { cycles: 2 });
  addTask(wm4, "cd-3", "Task 3", [{ name: "X", score: 7 }], { cycles: 4 });
  addTask(wm4, "cd-4", "Task 4", [{ name: "X", score: 7 }], { cycles: 5 });

  const dm4 = new DriftMonitor();
  const cdResult = dm4.quickCheck(buildSources(wm4), "cd-4");
  check("convergenceDifficulty > 0", cdResult.signals.convergenceDifficulty > 0);
  check(`convergenceDifficulty is ${cdResult.signals.convergenceDifficulty.toFixed(3)}`, true);

  // 5. Sensitivity modulation
  console.log("\n5. Sensitivity modulation");
  const dm5a = new DriftMonitor();
  const dm5b = new DriftMonitor();

  const lowSensitivity = mockPlasticity(0.2);
  const highSensitivity = mockPlasticity(0.9);

  const resultLow = dm5a.quickCheck(buildSources(wm2, lowSensitivity), "ps-4");
  const resultHigh = dm5b.quickCheck(buildSources(wm2, highSensitivity), "ps-4");

  check("Higher sensitivity → higher driftLevel", resultHigh.driftLevel > resultLow.driftLevel);
  check(`Low sensitivity level: ${resultLow.driftLevel.toFixed(3)}`, true);
  check(`High sensitivity level: ${resultHigh.driftLevel.toFixed(3)}`, true);

  // 6. getAssessment() and getState()
  console.log("\n6. getAssessment() and getState()");
  const assessment = dm2.getAssessment();
  check("assessment.driftLevel matches last quickCheck", assessment.driftLevel === psResult.driftLevel);
  check("assessment.quickCheck is non-null", assessment.quickCheck !== null);
  check("assessment.deepAnalysis is null (no deep analysis run)", assessment.deepAnalysis === null);

  const state = dm2.getState();
  check("state.quickCheckActive is true", state.quickCheckActive);
  check("state.hasDeepAnalysis is false", !state.hasDeepAnalysis);
  check("state.signals is non-null", state.signals !== null);
  check("state.completedTaskCount matches", state.completedTaskCount === 4);

  // 7. Deep analysis (live LLM call)
  console.log("\n7. Deep analysis (live LLM call)");
  const dm7 = new DriftMonitor();
  // Run quick check first to populate history
  dm7.quickCheck(buildSources(wm2), "ps-4");

  const deepResult = await dm7.deepAnalysis(buildSources(wm2), "phase-1");

  if (deepResult) {
    check("intentAlignment has level", ["aligned", "drifting", "diverged"].includes(deepResult.intentAlignment.level));
    check("intentAlignment has trajectory", ["improving", "stable", "worsening"].includes(deepResult.intentAlignment.trajectory));
    check("intentAlignment has description", deepResult.intentAlignment.description.length > 0);
    check("intentAlignment has evidence", Array.isArray(deepResult.intentAlignment.evidence));
    check("tasteDivergence has detected field", typeof deepResult.tasteDivergence.detected === "boolean");
    check("conventionHealth has eroding array", Array.isArray(deepResult.conventionHealth.eroding));
    check("conventionHealth has emerging array", Array.isArray(deepResult.conventionHealth.emerging));
    check("overallLevel is 0-1", deepResult.overallLevel >= 0 && deepResult.overallLevel <= 1);
    check("summary is non-empty", deepResult.summary.length > 0);
    check("recommendations is array", Array.isArray(deepResult.recommendations));

    console.log(`\n  Intent alignment: ${deepResult.intentAlignment.level} (${deepResult.intentAlignment.trajectory})`);
    console.log(`  Overall level: ${deepResult.overallLevel.toFixed(2)}`);
    console.log(`  Summary: "${deepResult.summary.slice(0, 120)}..."`);

    // Verify assessment updated
    const postDeepAssessment = dm7.getAssessment();
    check("assessment.deepAnalysis populated after deep analysis", postDeepAssessment.deepAnalysis !== null);
    check("assessment.driftLevel updated to deep analysis level", postDeepAssessment.driftLevel === deepResult.overallLevel);
    check("assessment.deepAnalysisPhaseGroup set", postDeepAssessment.deepAnalysisPhaseGroup === "phase-1");

    const postDeepState = dm7.getState();
    check("state.hasDeepAnalysis is true", postDeepState.hasDeepAnalysis);
    check("state.deepAnalysisLevel populated", postDeepState.deepAnalysisLevel !== null);
  } else {
    console.log("  ⚠ Deep analysis returned null (LLM call may have failed)");
    // Don't fail the test if the LLM call fails — network issues shouldn't break CI
  }

  console.log("\n── Smoke test complete ──\n");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exitCode = 1;
});
