/**
 * Evaluation Rework — Smoke Test
 *
 * Verifies the new signal-driven evaluation gate:
 *   1. weighEvaluations() — stake inheritance from consultation
 *   2. computeComposite() — weighted mean, acceptability, confidence
 *   3. Gate strategies — deliberative/democratic/expedient behavior
 *   4. defaultSelector() — NE-based dispatch
 *   5. detectTensions() — stake-modulated severity
 *   6. Score oscillation detection
 *   7. CortexConfig — no acceptableMinScore
 *
 * Run: npx tsx examples/evaluation-rework-smoke.ts
 */

import {
  weighEvaluations,
  computeComposite,
  type WeightedEvaluation,
  type StakeAdjuster,
} from "../src/kernel/evaluation-weighter.js";
import {
  deliberativeStrategy,
  democraticStrategy,
  expedientStrategy,
  defaultSelector,
  createGate,
} from "../src/kernel/gate.js";
import { detectTensions } from "../src/kernel/resolver.js";
import type { SenseEvaluation } from "../src/types/sense.js";
import type { Consultation } from "../src/types/consultation.js";
import type { GateInput, SignalLandscape } from "../src/types/gate.js";
import type { CortexConfig } from "../src/types/orchestrator.js";
import { DEFAULT_CONFIG } from "../src/types/orchestrator.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";

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

function makeEval(
  senseId: string,
  senseName: string,
  score: number,
  acceptable: boolean,
): SenseEvaluation {
  return {
    senseId,
    activationPath: [senseName, "Pathway", senseId],
    score,
    acceptable,
    assessment: `${senseName} assessment: score ${score}`,
    tensions: [],
    suggestions: [],
  };
}

function makeConsultation(perspectives: { senseId: string; senseName: string; stake: number }[]): Consultation {
  const perspectivesFull = perspectives.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    perspective: `${p.senseName} perspective`,
    evaluators: [p.senseId],
    stake: p.stake,
  }));

  // Derive evaluation plan
  const evaluationPlan = perspectivesFull.flatMap((p) =>
    p.evaluators.map((receptorId) => ({
      receptorId,
      parentSenseId: p.senseId,
      parentSenseName: p.senseName,
      parentStake: p.stake,
      parentPerspective: p.perspective,
    })),
  );

  // Derive stake distribution
  const stakeEntries = perspectivesFull.map((p) => ({
    senseId: p.senseId,
    senseName: p.senseName,
    stake: p.stake,
  }));
  const totalStake = stakeEntries.reduce((sum, e) => sum + e.stake, 0);
  const meanStake = stakeEntries.length > 0 ? totalStake / stakeEntries.length : 0;
  const maxEntry = stakeEntries.reduce(
    (max, e) => (e.stake > max.stake ? e : max),
    { senseId: "", senseName: "", stake: 0 },
  );

  return {
    taskId: "test-task",
    producedAt: new Date(),
    perspectives: perspectivesFull,
    evaluationPlan,
    stakeDistribution: {
      entries: stakeEntries,
      totalStake,
      meanStake,
      max: maxEntry,
    },
    conditions: {
      activeSenses: perspectivesFull.map((p) => ({ senseId: p.senseId, senseName: p.senseName })),
      inhibitedSenses: [],
    },
  };
}

function makeGateInput(
  weighted: WeightedEvaluation[],
  ne?: number,
): GateInput {
  const composite = computeComposite(weighted);
  const tensions = detectTensions(weighted, "test-task");
  return {
    composite,
    tensions,
    cycle: 1,
    maxCycles: 3,
    signals: { ne },
  };
}

// ─── 1. weighEvaluations — stake inheritance ─────────────────────

console.log("\n1. weighEvaluations — stake inheritance");

const consultation1 = makeConsultation([
  { senseId: "design.visual.color", senseName: "DESIGN", stake: 0.9 },
  { senseId: "security.auth.csrf", senseName: "SECURITY", stake: 0.3 },
]);

const evals1: SenseEvaluation[] = [
  makeEval("design.visual.color", "DESIGN", 8, true),
  makeEval("security.auth.csrf", "SECURITY", 5, true),
];

const weighted1 = weighEvaluations(evals1, consultation1);

assert(weighted1.length === 2, "weighEvaluations returns all evaluations");
assert(weighted1[0].stake === 0.9, "Design receptor inherits sense stake 0.9");
assert(weighted1[1].stake === 0.3, "Security receptor inherits sense stake 0.3");
assert(weighted1[0].adjustedStake === 0.9, "adjustedStake equals stake (identity adjuster)");
assert(weighted1[0].weightedScore === 8 * 0.9, "weightedScore = score * adjustedStake");
assert(weighted1[1].weightedScore === 5 * 0.3, "Security weightedScore = 5 * 0.3");

// Custom stakeAdjuster
const doubler: StakeAdjuster = (_id, stake) => Math.min(stake * 2, 1.0);
const weighted1adj = weighEvaluations(evals1, consultation1, doubler);
assert(weighted1adj[0].adjustedStake === 1.0, "adjuster caps Design stake at 1.0");
assert(weighted1adj[1].adjustedStake === 0.6, "adjuster doubles Security stake to 0.6");

// Missing consultation perspective defaults to 0
const evalOrphan: SenseEvaluation[] = [
  makeEval("unknown.receptor", "UNKNOWN", 7, true),
];
const weightedOrphan = weighEvaluations(evalOrphan, consultation1);
assert(weightedOrphan[0].stake === 0, "Missing consultation perspective defaults stake to 0");

// ─── 2. computeComposite — weighted aggregates ──────────────────

console.log("2. computeComposite — weighted aggregates");

const composite1 = computeComposite(weighted1);
// weightedMean = (8*0.9 + 5*0.3) / (0.9 + 0.3) = (7.2 + 1.5) / 1.2 = 7.25
assert(Math.abs(composite1.weightedMean - 7.25) < 0.01, "weightedMean = 7.25");
assert(composite1.confidence === composite1.weightedMean / 10, "confidence = weightedMean / 10");
// weightedAcceptability = (0.9*1 + 0.3*1) / (0.9+0.3) = 1.2/1.2 = 1.0
assert(composite1.weightedAcceptability === 1.0, "All acceptable → weightedAcceptability = 1.0");
assert(composite1.meanStake === 0.6, "meanStake = (0.9 + 0.3) / 2");
assert(composite1.evaluations.length === 2, "composite carries all evaluations");

// Mixed acceptability
const evals2: SenseEvaluation[] = [
  makeEval("design.visual.color", "DESIGN", 4, false),
  makeEval("security.auth.csrf", "SECURITY", 7, true),
];
const weighted2 = weighEvaluations(evals2, consultation1);
const composite2 = computeComposite(weighted2);
// weightedAcceptability = (0.9*0 + 0.3*1) / (0.9+0.3) = 0.3/1.2 = 0.25
assert(Math.abs(composite2.weightedAcceptability - 0.25) < 0.01, "Design unacceptable → weightedAcceptability = 0.25");

// Empty evaluations
const compositeEmpty = computeComposite([]);
assert(compositeEmpty.weightedMean === 0, "Empty → weightedMean = 0");
assert(compositeEmpty.confidence === 0, "Empty → confidence = 0");

// ─── 3. Gate strategies ──────────────────────────────────────────

console.log("3. Gate strategies");

// --- Deliberative: all invested senses must accept ---
const allAcceptable = weighEvaluations([
  makeEval("d.color", "DESIGN", 8, true),
  makeEval("s.csrf", "SECURITY", 7, true),
], makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.9 },
  { senseId: "s.csrf", senseName: "SECURITY", stake: 0.7 },
]));

const deliberativeAccept = deliberativeStrategy(makeGateInput(allAcceptable));
assert(deliberativeAccept.accept === true, "Deliberative: all accept → accept");

// High-stake sense rejects
const highStakeRejects = weighEvaluations([
  makeEval("d.color", "DESIGN", 4, false),
  makeEval("s.csrf", "SECURITY", 8, true),
], makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.9 },
  { senseId: "s.csrf", senseName: "SECURITY", stake: 0.3 },
]));

const deliberativeReject = deliberativeStrategy(makeGateInput(highStakeRejects));
assert(deliberativeReject.accept === false, "Deliberative: high-stake rejects → reject");
assert(deliberativeReject.strategy === "deliberative", "Strategy label is correct");

// Low-stake sense rejects (below mean) — no tension gap, just unacceptable
const lowStakeRejects = weighEvaluations([
  makeEval("d.color", "DESIGN", 8, true),
  makeEval("s.csrf", "SECURITY", 6, false), // score 6 but unacceptable — sense has its own standards
], makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.9 },
  { senseId: "s.csrf", senseName: "SECURITY", stake: 0.1 },
]));

const deliberativeLowStake = deliberativeStrategy(makeGateInput(lowStakeRejects));
// weightedAcceptability = (0.9*1 + 0.1*0) / (0.9+0.1) = 0.9 > 0.5
// Security stake (0.1) < meanStake (0.5), so it's NOT above mean → no high-stake rejection
// Gap of 2 → no tension triggered
assert(deliberativeLowStake.accept === true, "Deliberative: low-stake rejection doesn't block");

// --- Democratic: weighted vote majority ---
const democraticLowStake = democraticStrategy(makeGateInput(lowStakeRejects));
assert(democraticLowStake.accept === true, "Democratic: low-stake rejection, majority accepts → accept");

const democraticHighStakeReject = democraticStrategy(makeGateInput(highStakeRejects));
// weightedAcceptability = (0.9*0 + 0.3*1) / (0.9+0.3) = 0.25 ≤ 0.5
assert(democraticHighStakeReject.accept === false, "Democratic: high-stake rejects → majority fails");

// --- Expedient: only catastrophic blocks ---
const expedientPass = expedientStrategy(makeGateInput(highStakeRejects));
// Score of 4 is not catastrophic (< 3), and weightedAcceptability = 0.25 > 0
assert(expedientPass.accept === true, "Expedient: score 4 is not catastrophic → accept");

const catastrophic = weighEvaluations([
  makeEval("d.color", "DESIGN", 2, false),
  makeEval("s.csrf", "SECURITY", 8, true),
], makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.1 },
  { senseId: "s.csrf", senseName: "SECURITY", stake: 0.9 },
]));
const expedientCatastrophic = expedientStrategy(makeGateInput(catastrophic));
assert(expedientCatastrophic.accept === false, "Expedient: score < 3 is catastrophic → reject");

// ─── 4. defaultSelector — NE-based dispatch ─────────────────────

console.log("4. defaultSelector — NE-based dispatch");

const strategies = new Map([
  ["deliberative", deliberativeStrategy],
  ["democratic", democraticStrategy],
  ["expedient", expedientStrategy],
]);

assert(defaultSelector({ ne: 0.9 }, strategies).name === "deliberative", "NE 0.9 → deliberative");
assert(defaultSelector({ ne: 0.8 }, strategies).name === "deliberative", "NE 0.8 → deliberative");
assert(defaultSelector({ ne: 0.5 }, strategies).name === "democratic", "NE 0.5 → democratic");
assert(defaultSelector({ ne: 0.3 }, strategies).name === "democratic", "NE 0.3 → democratic");
assert(defaultSelector({ ne: 0.2 }, strategies).name === "expedient", "NE 0.2 → expedient");
assert(defaultSelector({ ne: 0.0 }, strategies).name === "expedient", "NE 0.0 → expedient");
assert(defaultSelector({}, strategies).name === "deliberative", "No NE → deliberative (cautious default)");
assert(defaultSelector({ ne: undefined }, strategies).name === "deliberative", "NE undefined → deliberative");

// createGate integration
const gate = createGate();
const gateOutput = gate.evaluate(makeGateInput(allAcceptable, 0.5));
assert(gateOutput.accept === true, "createGate: democratic mode accepts all-acceptable");
assert(gateOutput.strategy === "democratic", "createGate: NE 0.5 selects democratic");

// ─── 5. detectTensions — stake-modulated severity ────────────────

console.log("5. detectTensions — stake-modulated severity");

// High-stake disagreement → high/medium severity preserved
const highStakeDisagreement = weighEvaluations([
  makeEval("d.color", "DESIGN", 9, true),
  makeEval("perf.load", "PERFORMANCE", 3, false),
], makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.9 },
  { senseId: "perf.load", senseName: "PERFORMANCE", stake: 0.8 },
]));

const tensionsHigh = detectTensions(highStakeDisagreement, "t1");
assert(tensionsHigh.length === 1, "One tension detected (gap of 6)");
assert(tensionsHigh[0].severity === "high", "High-stake gap of 6 → high severity");
assert(tensionsHigh[0].senseA.stake === 0.9, "Tension carries senseA stake");
assert(tensionsHigh[0].senseB.stake === 0.8, "Tension carries senseB stake");

// Low-stake disagreement → capped at "low"
const lowStakeDisagreement = weighEvaluations([
  makeEval("seo.meta", "SEO", 9, true),
  makeEval("i18n.locale", "I18N", 3, false),
], makeConsultation([
  { senseId: "seo.meta", senseName: "SEO", stake: 0.1 },
  { senseId: "i18n.locale", senseName: "I18N", stake: 0.1 },
]));

const tensionsLow = detectTensions(lowStakeDisagreement, "t2");
assert(tensionsLow.length === 1, "One tension detected (low-stake gap of 6)");
assert(tensionsLow[0].severity === "low", "Both senses below mean → severity capped at low");

// ─── 6. Score oscillation detection ──────────────────────────────

console.log("6. Score oscillation detection");

const wm = new WorkingMemory("test-project");
wm.addTask("osc-task", "oscillation test");
wm.startTask("osc-task");

// Simulate 3 build cycles with oscillating scores
const oscConsultation = makeConsultation([
  { senseId: "d.color", senseName: "DESIGN", stake: 0.8 },
]);

const oscCycle1 = weighEvaluations([makeEval("d.color", "DESIGN", 8, true)], oscConsultation);
wm.recordScores("osc-task", oscCycle1);

const oscCycle2 = weighEvaluations([makeEval("d.color", "DESIGN", 4, false)], oscConsultation);
wm.recordScores("osc-task", oscCycle2);

const oscillations = wm.detectOscillations("osc-task");
assert(oscillations.length === 1, "One oscillation detected");
assert(oscillations[0].receptorId === "d.color", "Oscillating receptor identified");
assert(oscillations[0].swingMagnitude === 4, "Swing magnitude = 4");
assert(oscillations[0].recentScores[0] === 8 && oscillations[0].recentScores[1] === 4, "Recent scores captured");

// No oscillation when scores are stable
const wm2 = new WorkingMemory("test-project-2");
wm2.addTask("stable-task", "stable test");
wm2.startTask("stable-task");

const stableCycle1 = weighEvaluations([makeEval("d.color", "DESIGN", 7, true)], oscConsultation);
wm2.recordScores("stable-task", stableCycle1);
const stableCycle2 = weighEvaluations([makeEval("d.color", "DESIGN", 8, true)], oscConsultation);
wm2.recordScores("stable-task", stableCycle2);

const noOscillations = wm2.detectOscillations("stable-task");
assert(noOscillations.length === 0, "No oscillation when scores are stable (swing < 3)");

// ─── 7. CortexConfig — no acceptableMinScore ────────────────────

console.log("7. CortexConfig — no acceptableMinScore");

assert(!("acceptableMinScore" in DEFAULT_CONFIG), "acceptableMinScore removed from DEFAULT_CONFIG");
assert("maxCycles" in DEFAULT_CONFIG, "maxCycles still present");
assert("models" in DEFAULT_CONFIG, "models still present");

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Evaluation Rework Smoke Test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
