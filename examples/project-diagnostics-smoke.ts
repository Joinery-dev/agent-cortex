/**
 * Project Diagnostics — Smoke Test
 *
 * Verifies:
 *   1. DiagnosticContext construction
 *   2. DiagnosticResult shape validation
 *   3. SelfHealAction mapping for each diagnosis
 *   4. Graceful fallback on error
 *   5. Prompt generation (system + user)
 *   6. DiagnosticInputs construction and formatting
 *
 * Note: The LLM call in ProjectDiagnostics.diagnose() cannot be tested
 * without a live API. This smoke test validates the type system,
 * data flow patterns, prompt generation, and mapping logic.
 *
 * Run: npx tsx examples/project-diagnostics-smoke.ts
 */

import type {
  DiagnosticContext,
  DiagnosticResult,
  ProjectDiagnosis,
  SelfHealAction,
  TriageContext,
  TriageResult,
  TriageRoute,
} from "../src/types/project-diagnostics.js";
import type { OrchestratorResult } from "../src/types/orchestrator.js";
import type { ConvictionResult } from "../src/types/conviction.js";
import type { ScoreTrend, ConvictionEntry, ConvictionTrajectory } from "../src/types/working-memory.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { DriftAssessment } from "../src/types/drift-monitor.js";
import {
  projectDiagnosticsSystem,
  projectDiagnosticsUser,
} from "../src/llm/prompts.js";
import type { DiagnosticInputs } from "../src/llm/prompts.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import { ProjectDiagnostics } from "../src/kernel/project-diagnostics.js";

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

// ─── Test data factories ─────────────────────────────────────────

function makeIntent(): ProjectIntent {
  return {
    id: "test-intent",
    summary: "Build a portfolio site for a freelance photographer",
    audience: "potential clients and art directors",
    successCriteria: ["loads in under 2s", "showcases work beautifully", "mobile-first"],
    constraints: ["no JavaScript frameworks", "static hosting only"],
    vision: "A gallery-focused site that lets the photography speak for itself",
    keyDecisions: [],
    driftLog: [],
  };
}

function makeTaste(): TasteProfile {
  return {
    id: "test-taste",
    name: "Taylor",
    visual: "minimal, dark backgrounds, generous whitespace",
    decisionStyle: "opinionated, first-principles",
    communication: "direct, visual thinker",
    patterns: "consistent spacing, no decorative elements",
    raw: {},
  };
}

function makeConvictionResult(
  verdict: "proceed" | "reshape" | "escalate",
  level: number,
): ConvictionResult {
  return {
    verdict,
    level,
    delta: -0.1,
    evidence: [
      {
        source: "score-trajectory",
        description: "scores declining across replans",
        magnitude: 0.6,
        valence: "undermines",
      },
    ],
    shaping: {
      notes: ["conviction eroding across replans"],
      reshapeGuidance: verdict === "reshape" ? "approach needs rethinking" : undefined,
      escalationReason: verdict === "escalate" ? "conviction critically low" : undefined,
    },
    decidingStep: "conviction",
  };
}

function makeScoreTrend(label: string, direction: "up" | "stable" | "down", currentMean: number): ScoreTrend {
  return {
    id: label.toLowerCase(),
    label,
    level: "sense",
    direction,
    currentMean,
    previousMean: direction === "down" ? currentMean + 1.5 : currentMean - 0.5,
    delta: direction === "down" ? -1.5 : 0.5,
    dataPoints: 6,
  };
}

function makeOrchestratorResult(taskId: string, status: "complete" | "needs_revision"): OrchestratorResult {
  return {
    taskId,
    status,
    work: "test work output",
    evaluations: [],
    tensions: [],
    resolutions: [],
    cycles: status === "complete" ? 2 : 4,
    confidence: status === "complete" ? 0.8 : 0.4,
    decisionLog: [],
  };
}

function makeDriftAssessment(driftLevel: number): DriftAssessment {
  return {
    driftLevel,
    driftSummary: `Drift level ${driftLevel.toFixed(2)} — project trajectory diverging from intent`,
    quickCheck: null,
    deepAnalysis: driftLevel > 0.5
      ? {
          intentAlignment: {
            level: "drifting",
            trajectory: "worsening",
            description: "Tasks are producing work that doesn't serve the vision",
            evidence: [],
          },
          tasteDivergence: { detected: false, divergences: [] },
          conventionHealth: { eroding: [], emerging: [] },
          overallLevel: driftLevel,
          summary: "Project is drifting from intent. Task decomposition may be wrong.",
          recommendations: ["Consider restructuring task order", "Re-examine vision alignment"],
        }
      : null,
    deepAnalysisAt: null,
    deepAnalysisPhaseGroup: null,
    sensitivityWeight: null,
  };
}

function makeDiagnosticContext(overrides?: Partial<DiagnosticContext>): DiagnosticContext {
  const taskResults = new Map<string, OrchestratorResult>();
  taskResults.set("task-1", makeOrchestratorResult("task-1", "complete"));
  taskResults.set("task-2", makeOrchestratorResult("task-2", "needs_revision"));
  taskResults.set("task-3", makeOrchestratorResult("task-3", "complete"));

  return {
    taskResults,
    driftAssessment: makeDriftAssessment(0.65),
    convictionHistory: [
      makeConvictionResult("proceed", 0.7),
      makeConvictionResult("reshape", 0.45),
      makeConvictionResult("reshape", 0.3),
    ],
    senseTrends: [
      makeScoreTrend("Design", "down", 5.2),
      makeScoreTrend("Performance", "up", 7.8),
      makeScoreTrend("Usability", "stable", 6.5),
    ],
    worldModelMaxims: [
      "Visual density and load time are in genuine tension on this project",
      "Mobile-first is a hard constraint, not a nice-to-have",
    ],
    manifestedFuture: "A fast-loading, visually stunning gallery that showcases photography on any device",
    originalGraph: [
      { id: "task-1", description: "Build gallery grid", dependsOn: [], phaseGroup: "foundation" },
      { id: "task-2", description: "Optimize images", dependsOn: ["task-1"], phaseGroup: "polish" },
      { id: "task-3", description: "Add navigation", dependsOn: ["task-1"], phaseGroup: "polish" },
    ],
    currentGraph: [
      { id: "task-1", description: "Build gallery grid", dependsOn: [], phaseGroup: "foundation" },
      { id: "task-2b", description: "Image pipeline + optimization", dependsOn: ["task-1"], phaseGroup: "polish" },
      { id: "task-3", description: "Add navigation", dependsOn: ["task-1"], phaseGroup: "polish" },
    ],
    intent: makeIntent(),
    taste: makeTaste(),
    replanCount: 2,
    ...overrides,
  };
}

function makeDiagnosticInputs(overrides?: Partial<DiagnosticInputs>): DiagnosticInputs {
  return {
    intent: {
      summary: "Build a portfolio site",
      vision: "Gallery-focused photography showcase",
      audience: "potential clients",
      successCriteria: ["loads fast", "looks great"],
      constraints: ["static hosting"],
    },
    taste: {
      visual: "minimal, dark",
      decisionStyle: "opinionated",
      patterns: "consistent spacing",
    },
    manifestedFuture: "A stunning gallery site",
    taskResults: [
      { id: "task-1", description: "Build grid", status: "accepted", confidence: 0.8, cycles: 2 },
      { id: "task-2", description: "Optimize images", status: "rejected", confidence: 0.4, cycles: 4 },
    ],
    driftAssessment: {
      driftLevel: 0.65,
      driftSummary: "Trajectory diverging from intent",
      deepAnalysisSummary: "Tasks don't compose well",
      recommendations: ["Restructure task order"],
    },
    convictionHistory: [
      { verdict: "proceed", level: 0.7, decidingStep: "conviction" },
      { verdict: "reshape", level: 0.3, decidingStep: "conviction" },
    ],
    senseTrends: [
      { label: "Design", direction: "down", currentMean: 5.2 },
      { label: "Performance", direction: "up", currentMean: 7.8 },
    ],
    worldModelMaxims: ["Visual density and load time are in tension"],
    replanCount: 2,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
console.log("\n═══ Project Diagnostics Smoke Tests ═══\n");

// ─── 1. DiagnosticContext construction ──────────────────────────

console.log("1. DiagnosticContext construction");
{
  const ctx = makeDiagnosticContext();
  assert(ctx.taskResults.size === 3, "3 task results");
  assert(ctx.replanCount === 2, "replanCount is 2");
  assert(ctx.driftAssessment !== null, "drift assessment present");
  assert(ctx.driftAssessment!.driftLevel === 0.65, "drift level is 0.65");
  assert(ctx.convictionHistory.length === 3, "3 conviction entries");
  assert(ctx.senseTrends.length === 3, "3 sense trends");
  assert(ctx.worldModelMaxims.length === 2, "2 world model maxims");
  assert(ctx.manifestedFuture.length > 0, "manifested future present");
  assert(ctx.originalGraph.length === 3, "3 original tasks");
  assert(ctx.currentGraph.length === 3, "3 current tasks");
  assert(ctx.intent.summary.length > 0, "intent summary present");
  assert(ctx.taste.visual.length > 0, "taste visual present");
}

// ─── 2. DiagnosticResult shape validation ───────────────────────

console.log("\n2. DiagnosticResult shape validation");
{
  // Path problem with replan directive
  const pathResult: DiagnosticResult = {
    diagnosis: "path-problem",
    reasoning: "Task decomposition keeps producing wrong ordering. Similar drift before and after replan.",
    selfHealAction: { type: "replan-with-directive", directive: "Merge UI tasks into one holistic pass" },
  };
  assert(pathResult.diagnosis === "path-problem", "diagnosis is path-problem");
  assert(pathResult.selfHealAction !== null, "self-heal action present");
  assert(pathResult.selfHealAction!.type === "replan-with-directive", "action type is replan-with-directive");
  assert(pathResult.escalationContext === undefined, "no escalation context");

  // Environmental with escalation
  const envResult: DiagnosticResult = {
    diagnosis: "environmental",
    reasoning: "Build tool fails on every attempt.",
    selfHealAction: null,
    escalationContext: "The deployment target is unreachable. External infrastructure issue.",
  };
  assert(envResult.diagnosis === "environmental", "diagnosis is environmental");
  assert(envResult.selfHealAction === null, "no self-heal for environmental");
  assert(envResult.escalationContext !== undefined, "escalation context present");
}

// ─── 3. SelfHealAction mapping: path-problem → replan-with-directive ──

console.log("\n3. SelfHealAction mapping: path-problem → replan-with-directive");
{
  const action: SelfHealAction = {
    type: "replan-with-directive",
    directive: "Reverse dependency order — build data layer before presentation",
  };
  assert(action.type === "replan-with-directive", "type is replan-with-directive");
  assert("directive" in action, "has directive field");
  assert(action.directive.length > 0, "directive is non-empty");
}

// ─── 4. SelfHealAction mapping: vision-problem → re-manifest ───

console.log("\n4. SelfHealAction mapping: vision-problem → re-manifest");
{
  const result: DiagnosticResult = {
    diagnosis: "vision-problem",
    reasoning: "Manifested future omits mobile-first requirement from intent.",
    selfHealAction: { type: "re-manifest" },
  };
  assert(result.diagnosis === "vision-problem", "diagnosis is vision-problem");
  assert(result.selfHealAction!.type === "re-manifest", "action is re-manifest");
  // re-manifest has no additional fields
  const action = result.selfHealAction as { type: "re-manifest" };
  assert(Object.keys(action).length === 1, "re-manifest has only type field");
}

// ─── 5. SelfHealAction mapping: calibration-problem → recalibrate-evaluation ──

console.log("\n5. SelfHealAction mapping: calibration-problem → recalibrate-evaluation");
{
  const result: DiagnosticResult = {
    diagnosis: "calibration-problem",
    reasoning: "Design sense is scoring 2-3 points harsher than other senses on equivalent quality.",
    selfHealAction: {
      type: "recalibrate-evaluation",
      directive: "Design sense acceptance threshold is unreachable for this task complexity",
    },
  };
  assert(result.diagnosis === "calibration-problem", "diagnosis is calibration-problem");
  assert(result.selfHealAction!.type === "recalibrate-evaluation", "action is recalibrate-evaluation");
  const action = result.selfHealAction as { type: "recalibrate-evaluation"; directive: string };
  assert(action.directive.length > 0, "recalibrate directive is non-empty");
}

// ─── 6. SelfHealAction mapping: taste-problem → propose-taste-update ──

console.log("\n6. SelfHealAction mapping: taste-problem → propose-taste-update");
{
  const result: DiagnosticResult = {
    diagnosis: "taste-problem",
    reasoning: "Scores improve when minimalist constraints are violated. Rich visuals score higher.",
    selfHealAction: {
      type: "propose-taste-update",
      proposedChanges: "Update visual from 'minimal' to 'rich with intentional negative space'",
    },
  };
  assert(result.diagnosis === "taste-problem", "diagnosis is taste-problem");
  assert(result.selfHealAction!.type === "propose-taste-update", "action is propose-taste-update");
  const action = result.selfHealAction as { type: "propose-taste-update"; proposedChanges: string };
  assert(action.proposedChanges.length > 0, "proposed changes is non-empty");
}

// ─── 7. SelfHealAction mapping: environmental → null (escalation) ──

console.log("\n7. SelfHealAction mapping: environmental → null (escalation)");
{
  const result: DiagnosticResult = {
    diagnosis: "environmental",
    reasoning: "Deployment target is unreachable. Repeated tool failures.",
    selfHealAction: null,
    escalationContext: "Cannot deploy — hosting provider returns 503 on all attempts.",
  };
  assert(result.selfHealAction === null, "environmental has null selfHealAction");
  assert(result.escalationContext !== undefined, "environmental has escalation context");
  assert(result.escalationContext!.length > 0, "escalation context is non-empty");
}

// ─── 8. All five diagnoses are distinct ─────────────────────────

console.log("\n8. All five diagnoses are distinct");
{
  const diagnoses: ProjectDiagnosis[] = [
    "path-problem",
    "vision-problem",
    "calibration-problem",
    "taste-problem",
    "environmental",
  ];
  assert(diagnoses.length === 5, "5 diagnosis types");
  assert(new Set(diagnoses).size === 5, "all diagnoses are unique");

  // Only environmental cannot self-heal
  const selfHealable = diagnoses.filter((d) => d !== "environmental");
  assert(selfHealable.length === 4, "4 self-healable diagnoses");
}

// ─── 9. Graceful fallback shape ─────────────────────────────────

console.log("\n9. Graceful fallback shape");
{
  // Simulate what the catch block produces
  const fallback: DiagnosticResult = {
    diagnosis: "path-problem",
    reasoning: "Diagnostics failed: Error: LLM timeout. Falling through to replan with simpler decomposition.",
    selfHealAction: {
      type: "replan-with-directive",
      directive: "Try a simpler task decomposition with fewer phases.",
    },
  };
  assert(fallback.diagnosis === "path-problem", "fallback diagnosis is path-problem");
  assert(fallback.selfHealAction !== null, "fallback has self-heal action");
  assert(fallback.selfHealAction!.type === "replan-with-directive", "fallback action is replan-with-directive");
  assert(fallback.reasoning.includes("Diagnostics failed"), "fallback reasoning mentions failure");
  assert(fallback.escalationContext === undefined, "fallback has no escalation context");
}

// ─── 10. Prompt generation: projectDiagnosticsSystem() ──────────

console.log("\n10. Prompt generation: projectDiagnosticsSystem()");
{
  const system = projectDiagnosticsSystem();
  assert(typeof system === "string", "system prompt is a string");
  assert(system.length > 100, "system prompt is substantial");
  assert(system.includes("ProjectDiagnostics"), "mentions ProjectDiagnostics");
  assert(system.includes("path-problem"), "mentions path-problem");
  assert(system.includes("vision-problem"), "mentions vision-problem");
  assert(system.includes("calibration-problem"), "mentions calibration-problem");
  assert(system.includes("taste-problem"), "mentions taste-problem");
  assert(system.includes("environmental"), "mentions environmental");
  assert(system.includes("ROOT CAUSE"), "emphasizes root cause diagnosis");
  assert(system.includes("Diagnose exactly ONE"), "enforces single diagnosis");
}

// ─── 11. Prompt generation: projectDiagnosticsUser() ────────────

console.log("\n11. Prompt generation: projectDiagnosticsUser()");
{
  const inputs = makeDiagnosticInputs();
  const user = projectDiagnosticsUser(inputs);
  assert(typeof user === "string", "user prompt is a string");
  assert(user.length > 100, "user prompt is substantial");
  assert(user.includes("PROJECT INTENT"), "has PROJECT INTENT section");
  assert(user.includes("MANIFESTED FUTURE"), "has MANIFESTED FUTURE section");
  assert(user.includes("TASTE PROFILE"), "has TASTE PROFILE section");
  assert(user.includes("TASK RESULTS"), "has TASK RESULTS section");
  assert(user.includes("DRIFT ASSESSMENT"), "has DRIFT ASSESSMENT section");
  assert(user.includes("CONVICTION TRAJECTORY"), "has CONVICTION TRAJECTORY section");
  assert(user.includes("SENSE TRENDS"), "has SENSE TRENDS section");
  assert(user.includes("WORLD MODEL"), "has WORLD MODEL section");
  assert(user.includes("REPLAN ATTEMPTS: 2"), "has replan count");
  assert(user.includes("Return JSON"), "has JSON format instruction");
}

// ─── 12. DiagnosticInputs: task results formatting ──────────────

console.log("\n12. DiagnosticInputs: task results formatting");
{
  const inputs = makeDiagnosticInputs();
  const user = projectDiagnosticsUser(inputs);
  assert(user.includes("task-1"), "includes task-1 id");
  assert(user.includes("Build grid"), "includes task description");
  assert(user.includes("accepted"), "includes accepted status");
  assert(user.includes("2 tasks"), "includes task count");
}

// ─── 13. DiagnosticInputs: drift assessment with deep analysis ──

console.log("\n13. DiagnosticInputs: drift assessment with deep analysis");
{
  const inputs = makeDiagnosticInputs();
  const user = projectDiagnosticsUser(inputs);
  assert(user.includes("0.65"), "includes drift level");
  assert(user.includes("Trajectory diverging"), "includes drift summary");
  assert(user.includes("Tasks don't compose"), "includes deep analysis summary");
  assert(user.includes("Restructure task order"), "includes recommendations");
}

// ─── 14. DiagnosticInputs: minimal drift (no deep analysis) ────

console.log("\n14. DiagnosticInputs: minimal drift (no deep analysis)");
{
  const inputs = makeDiagnosticInputs({
    driftAssessment: {
      driftLevel: 0.2,
      driftSummary: "Minor drift detected",
    },
  });
  const user = projectDiagnosticsUser(inputs);
  assert(user.includes("0.20"), "includes drift level");
  assert(user.includes("Minor drift"), "includes drift summary");
  assert(!user.includes("Deep Analysis:"), "no deep analysis section when absent");
}

// ═══════════════════════════════════════════════════════════════════
// NEW: Conviction Ledger + Triage + Graph Diff Tests
// ═══════════════════════════════════════════════════════════════════

// ─── 15. WM conviction ledger — record and retrieve ──────────────

console.log("\n15. WM conviction ledger — record and retrieve");
{
  const wm = new WorkingMemory("test-project");

  // Record convictions across two replan generations
  const conv1: ConvictionResult = {
    verdict: "proceed",
    level: 0.8,
    delta: 0,
    evidence: [],
    shaping: { notes: [] },
    decidingStep: "conviction",
  };
  const conv2: ConvictionResult = {
    verdict: "proceed",
    level: 0.6,
    delta: -0.2,
    evidence: [],
    shaping: { notes: [] },
    decidingStep: "conviction",
  };
  const conv3: ConvictionResult = {
    verdict: "reshape",
    level: 0.4,
    delta: -0.2,
    evidence: [],
    shaping: { notes: [] },
    decidingStep: "conviction",
  };
  const conv4: ConvictionResult = {
    verdict: "reshape",
    level: 0.3,
    delta: -0.1,
    evidence: [],
    shaping: { notes: [] },
    decidingStep: "conviction",
  };

  wm.recordConviction(conv1, "task-1", 0);
  wm.recordConviction(conv2, "task-2", 0);
  wm.recordConviction(conv3, null, 1);
  wm.recordConviction(conv4, null, 1);

  const history = wm.getConvictionHistory();
  assert(history.length === 4, "4 conviction entries in ledger");
  assert(history[0].level === 0.8, "first entry level is 0.8");
  assert(history[0].replanGeneration === 0, "first entry is generation 0");
  assert(history[2].replanGeneration === 1, "third entry is generation 1");
  assert(history[3].taskId === null, "dispatch-level entry has null taskId");
}

// ─── 16. WM conviction trajectory — declining across generations ──

console.log("\n16. WM conviction trajectory — declining across generations");
{
  const wm = new WorkingMemory("test-project");

  wm.recordConviction({ verdict: "proceed", level: 0.8, delta: 0, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" }, "t1", 0);
  wm.recordConviction({ verdict: "proceed", level: 0.7, delta: -0.1, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" }, "t2", 0);
  wm.recordConviction({ verdict: "reshape", level: 0.4, delta: -0.3, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" }, null, 1);
  wm.recordConviction({ verdict: "reshape", level: 0.3, delta: -0.1, evidence: [], shaping: { notes: [] }, decidingStep: "conviction" }, null, 1);

  const traj = wm.getConvictionTrajectory();
  assert(traj.levels.length === 4, "trajectory has 4 levels");
  assert(traj.direction === "down", "trajectory direction is down");
  assert(traj.currentLevel === 0.3, "current level is 0.3");
  assert(traj.generationCount === 2, "2 replan generations");
  assert(traj.generationMeans.length === 2, "2 generation means");
  assert(traj.generationMeans[0].generation === 0, "first generation is 0");
  assert(traj.generationMeans[0].meanLevel === 0.75, "gen 0 mean is 0.75");
  assert(traj.generationMeans[1].meanLevel === 0.35, "gen 1 mean is 0.35");
}

// ─── 17. WM conviction trajectory — empty ledger ─────────────────

console.log("\n17. WM conviction trajectory — empty ledger");
{
  const wm = new WorkingMemory("test-project");
  const traj = wm.getConvictionTrajectory();
  assert(traj.levels.length === 0, "empty trajectory has no levels");
  assert(traj.direction === "stable", "empty trajectory is stable");
  assert(traj.currentLevel === 0.5, "empty trajectory defaults to 0.5");
  assert(traj.generationCount === 0, "no generations");
}

// ─── 18. Triage R0: max-replans → escalate ───────────────────────

console.log("\n18. Triage R0: max-replans → escalate");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: { levels: [0.8], direction: "stable", currentLevel: 0.8, generationCount: 1, generationMeans: [{ generation: 0, meanLevel: 0.8, entryCount: 1 }] },
    convictionHistory: [],
    senseTrends: [],
    driftAssessment: null,
    cerebellumAccuracy: 0.5,
    replanCount: 3,
    maxReplans: 3,
  });
  assert(result.route === "escalate", "R0 routes to escalate");
  assert(result.firedRule === "max-replans", "R0 fires max-replans rule");
}

// ─── 19. Triage R1: cross-generation-decline → full-diagnostic ───

console.log("\n19. Triage R1: cross-generation-decline → full-diagnostic");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.8, 0.7, 0.4, 0.3],
      direction: "down",
      currentLevel: 0.3,
      generationCount: 2,
      generationMeans: [
        { generation: 0, meanLevel: 0.75, entryCount: 2 },
        { generation: 1, meanLevel: 0.35, entryCount: 2 },
      ],
    },
    convictionHistory: [],
    senseTrends: [makeScoreTrend("Design", "stable", 6.0)],
    driftAssessment: null,
    cerebellumAccuracy: 0.5,
    replanCount: 2,
    maxReplans: 3,
  });
  assert(result.route === "full-diagnostic", "R1 routes to full-diagnostic");
  assert(result.firedRule === "cross-generation-decline", "R1 fires cross-generation-decline");
}

// ─── 20. Triage R2: cerebellum-wrong → full-diagnostic ───────────

console.log("\n20. Triage R2: cerebellum-wrong → full-diagnostic");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.7, 0.5],
      direction: "down",
      currentLevel: 0.5,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.6, entryCount: 2 }],
    },
    convictionHistory: [],
    senseTrends: [makeScoreTrend("Design", "stable", 6.0)],
    driftAssessment: null,
    cerebellumAccuracy: 0.7, // high accuracy but conviction declining
    replanCount: 1,
    maxReplans: 3,
  });
  assert(result.route === "full-diagnostic", "R2 routes to full-diagnostic");
  assert(result.firedRule === "cerebellum-wrong", "R2 fires cerebellum-wrong");
}

// ─── 21. Triage R3: all-senses-declining → re-manifest (first) ──

console.log("\n21. Triage R3: all-senses-declining → re-manifest (first occurrence)");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.6, 0.5],
      direction: "down",
      currentLevel: 0.5,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.55, entryCount: 2 }],
    },
    convictionHistory: [],
    senseTrends: [
      makeScoreTrend("Design", "down", 4.0),
      makeScoreTrend("Performance", "down", 5.0),
      makeScoreTrend("Usability", "down", 4.5),
    ],
    driftAssessment: null,
    cerebellumAccuracy: 0.4, // low accuracy so R2 doesn't fire
    replanCount: 1,
    maxReplans: 3,
  });
  assert(result.route === "re-manifest", "R3 routes to re-manifest on first occurrence");
  assert(result.firedRule === "all-senses-declining", "R3 fires all-senses-declining");
}

// ─── 22. Triage R3: all-senses-declining → full-diagnostic (2nd) ──

console.log("\n22. Triage R3: all-senses-declining → full-diagnostic (second occurrence)");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.6, 0.5],
      direction: "down",
      currentLevel: 0.5,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.55, entryCount: 2 }],
    },
    convictionHistory: [],
    senseTrends: [
      makeScoreTrend("Design", "down", 4.0),
      makeScoreTrend("Performance", "down", 5.0),
    ],
    driftAssessment: null,
    cerebellumAccuracy: 0.4,
    replanCount: 2, // ≥ 2 → full-diagnostic
    maxReplans: 3,
  });
  assert(result.route === "full-diagnostic", "R3 routes to full-diagnostic on second occurrence");
  assert(result.firedRule === "all-senses-declining", "R3 fires all-senses-declining");
}

// ─── 23. Triage R4: single-sense-diverging → replan with directive ──

console.log("\n23. Triage R4: single-sense-diverging → replan with directive");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.7],
      direction: "stable",
      currentLevel: 0.7,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.7, entryCount: 1 }],
    },
    convictionHistory: [],
    senseTrends: [
      makeScoreTrend("Design", "down", 4.0),
      makeScoreTrend("Performance", "up", 7.5),
      makeScoreTrend("Usability", "stable", 6.5),
    ],
    driftAssessment: null,
    cerebellumAccuracy: 0.5,
    replanCount: 1,
    maxReplans: 3,
  });
  assert(result.route === "replan", "R4 routes to replan");
  assert(result.firedRule === "single-sense-diverging", "R4 fires single-sense-diverging");
  assert(result.senseDirective !== undefined, "R4 has sense directive");
  assert(result.senseDirective!.includes("Design"), "R4 directive names struggling sense");
}

// ─── 24. Triage R5: high-drift-low-conviction → full-diagnostic ──

console.log("\n24. Triage R5: high-drift-low-conviction → full-diagnostic");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.35],
      direction: "stable",
      currentLevel: 0.35,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.35, entryCount: 1 }],
    },
    convictionHistory: [],
    senseTrends: [makeScoreTrend("Design", "stable", 6.0)],
    driftAssessment: makeDriftAssessment(0.75),
    cerebellumAccuracy: 0.5,
    replanCount: 1,
    maxReplans: 3,
  });
  assert(result.route === "full-diagnostic", "R5 routes to full-diagnostic");
  assert(result.firedRule === "high-drift-low-conviction", "R5 fires high-drift-low-conviction");
}

// ─── 25. Triage R6: default-replan ───────────────────────────────

console.log("\n25. Triage R6: default-replan");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.7],
      direction: "stable",
      currentLevel: 0.7,
      generationCount: 1,
      generationMeans: [{ generation: 0, meanLevel: 0.7, entryCount: 1 }],
    },
    convictionHistory: [],
    senseTrends: [makeScoreTrend("Design", "stable", 6.0)],
    driftAssessment: makeDriftAssessment(0.3),
    cerebellumAccuracy: 0.5,
    replanCount: 1,
    maxReplans: 3,
  });
  assert(result.route === "replan", "R6 routes to replan");
  assert(result.firedRule === "default-replan", "R6 fires default-replan");
}

// ─── 26. Triage priority — R0 beats R1 ──────────────────────────

console.log("\n26. Triage priority — R0 beats R1");
{
  const diag = new ProjectDiagnostics({ models: { consultation: "test" } } as any);
  // Both R0 and R1 could fire — R0 should win
  const result = diag.triage({
    convictionTrajectory: {
      levels: [0.8, 0.3],
      direction: "down",
      currentLevel: 0.3,
      generationCount: 2,
      generationMeans: [
        { generation: 0, meanLevel: 0.8, entryCount: 1 },
        { generation: 1, meanLevel: 0.3, entryCount: 1 },
      ],
    },
    convictionHistory: [],
    senseTrends: [],
    driftAssessment: null,
    cerebellumAccuracy: 0.5,
    replanCount: 3,
    maxReplans: 3,
  });
  assert(result.route === "escalate", "R0 takes priority over R1");
  assert(result.firedRule === "max-replans", "R0 fires even when R1 conditions met");
}

// ─── 27. Graph diff in diagnostic prompt ─────────────────────────

console.log("\n27. Graph diff in diagnostic prompt");
{
  const inputs = makeDiagnosticInputs({
    graphDiff: {
      originalTaskCount: 5,
      currentTaskCount: 7,
      addedTasks: ["Image pipeline v2", "Mobile viewport check"],
      removedTasks: ["Optimize images"],
      unchangedCount: 4,
    },
  });
  const user = projectDiagnosticsUser(inputs);
  assert(user.includes("PLAN STRUCTURE CHANGES"), "has PLAN STRUCTURE CHANGES section");
  assert(user.includes("Original: 5 tasks"), "includes original task count");
  assert(user.includes("Current: 7 tasks"), "includes current task count");
  assert(user.includes("+ Image pipeline v2"), "includes added task");
  assert(user.includes("- Optimize images"), "includes removed task");
  assert(user.includes("Unchanged: 4"), "includes unchanged count");
}

// ─── 28. Graph diff absent when no changes ───────────────────────

console.log("\n28. Graph diff absent when no changes");
{
  const inputs = makeDiagnosticInputs(); // no graphDiff
  const user = projectDiagnosticsUser(inputs);
  assert(!user.includes("PLAN STRUCTURE CHANGES"), "no PLAN STRUCTURE CHANGES when absent");
}

// ─── 29. TriageResult shape ──────────────────────────────────────

console.log("\n29. TriageResult shape validation");
{
  const result: TriageResult = {
    route: "full-diagnostic",
    reasoning: "Conviction declining across generations",
    firedRule: "cross-generation-decline",
  };
  assert(result.route === "full-diagnostic", "route is full-diagnostic");
  assert(result.firedRule === "cross-generation-decline", "firedRule is set");
  assert(result.senseDirective === undefined, "no senseDirective for non-R4 rules");

  const r4: TriageResult = {
    route: "replan",
    reasoning: "Design struggling",
    firedRule: "single-sense-diverging",
    senseDirective: "Focus on Design",
  };
  assert(r4.senseDirective !== undefined, "R4 result has senseDirective");
}

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  Project Diagnostics smoke test: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
