/**
 * Amygdala — Smoke Test
 *
 * Verifies all three responsibilities:
 *   1. Detector registry (built-in + learned)
 *   2. Pre-action gate (intention scanning)
 *   3. Alarm receiver + Parsifal escalation
 *   4. Response protocol execution
 *   5. Response level modulation via plasticity
 *   6. Config toggles
 *
 * Run: npx tsx examples/amygdala-smoke.ts
 */

import { Amygdala } from "../src/subcortical/amygdala.js";
import {
  createBuiltInDetectors,
  computeResponseLevel,
  identifyBlockedIntentions,
} from "../src/subcortical/detectors.js";
import type { Intention } from "../src/types/pns.js";
import { createIntention } from "../src/types/pns.js";
import type {
  ThreatDetector,
  DetectedThreat,
  Alarm,
  ResponseDeps,
} from "../src/types/amygdala.js";

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

// ─── Test Data Factories ─────────────────────────────────────────

function makeBenignIntention(taskId: string): Intention {
  return createIntention(
    "intent-benign-1",
    taskId,
    "Create a helper function for string formatting",
    "build",
    [
      {
        target: { kind: "file", path: "src/utils/format.ts" },
        effect: { type: "create", content: "export function formatDate(d: Date): string { return d.toISOString(); }" },
      },
    ],
  );
}

function makeDestructiveIntention(taskId: string): Intention {
  return createIntention(
    "intent-destructive-1",
    taskId,
    "Run rm -rf on the build directory to clean up",
    "control",
    [
      {
        target: { kind: "environment", aspect: "filesystem" },
        effect: { type: "remove" },
      },
    ],
  );
}

function makeSecurityIntention(taskId: string): Intention {
  return createIntention(
    "intent-security-1",
    taskId,
    "Create config file with API credentials",
    "build",
    [
      {
        target: { kind: "file", path: "src/config.ts" },
        effect: {
          type: "create",
          content: 'const api_key = "sk-live-abc123def456ghi789";',
        },
      },
    ],
  );
}

function makeDataLossIntention(taskId: string): Intention {
  return createIntention(
    "intent-dataloss-1",
    taskId,
    "Remove the old configuration file",
    "build",
    [
      {
        target: { kind: "file", path: "src/old-config.ts" },
        effect: { type: "remove" },
      },
    ],
  );
}

function makeVerifyThenRemoveIntention(taskId: string): Intention {
  return createIntention(
    "intent-safe-remove-1",
    taskId,
    "Verify then remove old config",
    "build",
    [
      {
        target: { kind: "file", path: "src/old-config.ts" },
        effect: { type: "verify", condition: "file exists and is backed up" },
      },
      {
        target: { kind: "file", path: "src/old-config.ts" },
        effect: { type: "remove" },
      },
    ],
  );
}

function makeMockDeps(): {
  deps: ResponseDeps;
  calls: { interrupts: unknown[]; inhibitions: unknown[]; questions: unknown[] };
} {
  const calls = {
    interrupts: [] as unknown[],
    inhibitions: [] as unknown[],
    questions: [] as unknown[],
  };
  return {
    deps: {
      runner: {
        interrupt(rhythmId: string, interrupt: unknown) {
          calls.interrupts.push({ rhythmId, interrupt });
        },
      },
      wm: {
        inhibitSense(senseId: string, reason: string, source: string, scope?: string) {
          calls.inhibitions.push({ senseId, reason, source, scope });
        },
        addQuestion(question: string, context: string) {
          calls.questions.push({ question, context });
          return {
            id: "q-mock",
            question,
            context,
            askedAt: new Date(),
          };
        },
      },
      activeRhythmIds: ["rhythm-1", "rhythm-2"],
    },
    calls,
  };
}

// ─── 1. Built-in detectors register on construction ──────────────

console.log("1. Built-in detectors register on construction");
{
  const amygdala = new Amygdala();
  const detectors = amygdala.getDetectors();
  assert(detectors.length === 4, "4 built-in detectors registered");
  assert(
    detectors.every((d) => d.origin === "built-in"),
    "All are built-in origin",
  );
  const ids = detectors.map((d) => d.id);
  assert(ids.includes("built-in:destructive-operation"), "Has destructive-operation detector");
  assert(ids.includes("built-in:security-antipattern"), "Has security-antipattern detector");
  assert(ids.includes("built-in:data-loss-risk"), "Has data-loss-risk detector");
  assert(ids.includes("built-in:scope-violation"), "Has scope-violation detector");
}

// ─── 2. Clean scan — benign intentions pass through ──────────────

console.log("\n2. Clean scan — benign intentions pass through");
{
  const amygdala = new Amygdala();
  const result = amygdala.scanIntentions(
    [makeBenignIntention("task-1")],
    0.8,
  );
  assert(result === null, "Benign intentions → null (clean)");
}

// ─── 3. Destructive operation detected ───────────────────────────

console.log("\n3. Destructive operation detected");
{
  const amygdala = new Amygdala();
  const result = amygdala.scanIntentions(
    [makeDestructiveIntention("task-1")],
    0.8,
  );
  assert(result !== null, "Destructive intention → assessment returned");
  if (result) {
    assert(result.threats.length >= 1, "At least 1 threat detected");
    assert(
      result.threats.some((t) => t.category === "destructive-operation"),
      "Threat category is destructive-operation",
    );
    assert(
      result.blockedIntentionIds.includes("intent-destructive-1"),
      "Destructive intention is blocked",
    );
    assert(result.trigger === "pre-action-gate", "Trigger is pre-action-gate");
  }
}

// ─── 4. Security antipattern detected ────────────────────────────

console.log("\n4. Security antipattern detected");
{
  const amygdala = new Amygdala();
  const result = amygdala.scanIntentions(
    [makeSecurityIntention("task-1")],
    0.8,
  );
  assert(result !== null, "Security intention → assessment returned");
  if (result) {
    assert(
      result.threats.some((t) => t.category === "security-antipattern"),
      "Threat category is security-antipattern",
    );
    assert(
      result.blockedIntentionIds.includes("intent-security-1"),
      "Security intention is blocked",
    );
  }
}

// ─── 5. Data loss risk detected ──────────────────────────────────

console.log("\n5. Data loss risk detected");
{
  const amygdala = new Amygdala();

  // Remove without verify → flagged
  const unsafeResult = amygdala.scanIntentions(
    [makeDataLossIntention("task-1")],
    0.8,
  );
  assert(unsafeResult !== null, "File remove without verify → assessment");
  if (unsafeResult) {
    assert(
      unsafeResult.threats.some((t) => t.category === "data-loss-risk"),
      "Threat category is data-loss-risk",
    );
  }

  // Verify then remove → clean
  const safeResult = amygdala.scanIntentions(
    [makeVerifyThenRemoveIntention("task-1")],
    0.8,
  );
  assert(safeResult === null, "Verify-then-remove → clean (null)");
}

// ─── 6. Multiple threats — all blocked IDs collected ─────────────

console.log("\n6. Multiple threats — all blocked IDs collected");
{
  const amygdala = new Amygdala();
  const result = amygdala.scanIntentions(
    [
      makeDestructiveIntention("task-1"),
      makeSecurityIntention("task-1"),
      makeBenignIntention("task-1"),
    ],
    0.8,
  );
  assert(result !== null, "Mixed intentions → assessment returned");
  if (result) {
    assert(
      result.blockedIntentionIds.includes("intent-destructive-1"),
      "Destructive intention blocked",
    );
    assert(
      result.blockedIntentionIds.includes("intent-security-1"),
      "Security intention blocked",
    );
    assert(
      !result.blockedIntentionIds.includes("intent-benign-1"),
      "Benign intention NOT blocked",
    );
    assert(result.threats.length >= 2, "At least 2 threats detected");
  }
}

// ─── 7. Alarm receiver ───────────────────────────────────────────

console.log("\n7. Alarm receiver");
{
  const amygdala = new Amygdala();
  const alarm: Alarm = {
    source: "cerebellum",
    severity: "urgent",
    description: "Prediction accuracy collapsed to 0.1",
    context: { accuracy: 0.1, threshold: 0.4 },
    rhythmId: "rhythm-build-1",
  };
  const assessment = amygdala.receiveAlarm(alarm);
  assert(assessment.trigger === "alarm", "Trigger is alarm");
  assert(assessment.effectiveSeverity === "urgent", "Severity matches alarm");
  assert(assessment.alarm === alarm, "Alarm reference preserved");
  assert(assessment.responseLevel === 0.75, "Urgent alarm → responseLevel 0.75");

  // Emergency alarm
  const emergencyAlarm: Alarm = {
    source: "drift-monitor",
    severity: "emergency",
    description: "System producing output for wrong project",
    context: {},
  };
  const emergencyAssessment = amygdala.receiveAlarm(emergencyAlarm);
  assert(
    emergencyAssessment.effectiveSeverity === "emergency",
    "Emergency alarm → emergency severity",
  );
  assert(
    emergencyAssessment.responseLevel === 1.0,
    "Emergency alarm → responseLevel 1.0",
  );
}

// ─── 8. Parsifal escalation ─────────────────────────────────────────

console.log("\n8. Parsifal escalation — always emergency, always max");
{
  const amygdala = new Amygdala();
  const assessment = amygdala.receiveParsifalEscalation(
    "Stop — that's the wrong database",
    { intendedTarget: "staging", actualTarget: "production" },
  );
  assert(assessment.trigger === "parsifal-escalation", "Trigger is parsifal-escalation");
  assert(
    assessment.effectiveSeverity === "emergency",
    "Parsifal escalation → always emergency",
  );
  assert(assessment.responseLevel === 1.0, "Parsifal escalation → responseLevel 1.0");
  assert(assessment.threats.length === 1, "One threat (the escalation itself)");
  assert(
    assessment.threats[0].category === "parsifal-escalation",
    "Category is parsifal-escalation",
  );
  assert(
    assessment.threats[0].signalStrength === 1.0,
    "Signal strength is maximum",
  );
}

// ─── 9. Response level modulation — plasticity weight ────────────

console.log("\n9. Response level modulation via urgency threshold");
{
  // Pure function test
  const threats: DetectedThreat[] = [
    {
      detectorId: "test",
      intentionId: "i1",
      description: "test threat",
      signalStrength: 0.85,
      category: "destructive-operation",
    },
  ];

  // High threshold (default 0.8) — responseLevel = 0.85 * 0.8 = 0.68
  const high = computeResponseLevel(threats, 0.8);
  assert(
    Math.abs(high.responseLevel - 0.68) < 0.01,
    "High threshold: responseLevel ≈ 0.68",
  );
  assert(high.effectiveSeverity === "urgent", "High threshold: urgent (below 0.7)");

  // Higher threshold (0.9) — responseLevel = 0.85 * 0.9 = 0.765
  const higher = computeResponseLevel(threats, 0.9);
  assert(
    Math.abs(higher.responseLevel - 0.765) < 0.01,
    "Higher threshold: responseLevel ≈ 0.765",
  );
  assert(
    higher.effectiveSeverity === "emergency",
    "Higher threshold: emergency (above 0.7)",
  );

  // Low threshold (0.3) — responseLevel = 0.85 * 0.3 = 0.255
  const low = computeResponseLevel(threats, 0.3);
  assert(
    Math.abs(low.responseLevel - 0.255) < 0.01,
    "Low threshold: responseLevel ≈ 0.255",
  );
  assert(low.effectiveSeverity === "urgent", "Low threshold: still urgent");
}

// ─── 10. Learned detector — hippocampus installs, fires on scan ──

console.log("\n10. Learned detector installation");
{
  const amygdala = new Amygdala();
  assert(
    amygdala.getDetectorsByOrigin("hippocampus").length === 0,
    "No learned detectors initially",
  );

  // Install a learned detector that flags "communicate" intentions
  const learnedDetector: ThreatDetector = {
    id: "learned:no-communicate-during-build",
    name: "No Communication During Build",
    origin: "hippocampus",
    sourceId: "principle-42",
    description: "Parsifal once escalated because the system sent a message mid-build",
    scan(intentions: Intention[]): DetectedThreat[] {
      return intentions
        .filter((i) => i.category === "communicate")
        .map((i) => ({
          detectorId: "learned:no-communicate-during-build",
          intentionId: i.id,
          description: "Communication during build (learned from Parsifal escalation)",
          signalStrength: 0.6,
          category: "parsifal-escalation" as const,
        }));
    },
  };

  amygdala.registerDetector(learnedDetector);
  assert(
    amygdala.getDetectorsByOrigin("hippocampus").length === 1,
    "1 learned detector after registration",
  );
  assert(amygdala.getDetectors().length === 5, "5 total detectors (4 built-in + 1 learned)");

  // Scan with a communicate intention — learned detector should fire
  const commIntention = createIntention(
    "intent-comm-1",
    "task-1",
    "Send status update to Parsifal",
    "communicate",
    [
      {
        target: { kind: "parsifal", channel: "chat" },
        effect: { type: "send", message: "Build is 50% complete", urgency: "normal" },
      },
    ],
  );

  const result = amygdala.scanIntentions([commIntention], 0.8);
  assert(result !== null, "Learned detector fires on communicate intention");
  if (result) {
    assert(
      result.threats.some((t) => t.detectorId === "learned:no-communicate-during-build"),
      "Threat came from learned detector",
    );
  }
}

// ─── 11. Detector removal ────────────────────────────────────────

console.log("\n11. Detector removal");
{
  const amygdala = new Amygdala();
  assert(amygdala.getDetectors().length === 4, "Starts with 4 detectors");

  const removed = amygdala.removeDetector("built-in:scope-violation");
  assert(removed === true, "removeDetector returns true for existing detector");
  assert(amygdala.getDetectors().length === 3, "3 detectors after removal");

  const removedAgain = amygdala.removeDetector("built-in:scope-violation");
  assert(removedAgain === false, "removeDetector returns false for non-existent");

  // The removed detector no longer fires (scope-violation is a no-op anyway,
  // but verify it's gone from the list)
  assert(
    !amygdala.getDetectors().some((d) => d.id === "built-in:scope-violation"),
    "Removed detector not in list",
  );
}

// ─── 12. Response protocol execution ─────────────────────────────

console.log("\n12. Response protocol execution");
{
  const amygdala = new Amygdala();

  // Emergency response (from Parsifal escalation)
  const assessment = amygdala.receiveParsifalEscalation(
    "Wrong database target",
    { target: "production" },
  );
  const { deps, calls } = makeMockDeps();
  const result = amygdala.executeResponse(assessment, deps);

  assert(result.actions.length >= 3, "At least 3 actions (interrupt, override-ne, question)");
  assert(
    result.actions.some((a) => a.kind === "interrupt-rhythm"),
    "Has interrupt-rhythm action",
  );
  assert(
    result.actions.some((a) => a.kind === "override-ne"),
    "Has override-ne action",
  );
  assert(
    result.actions.some((a) => a.kind === "add-open-question"),
    "Has add-open-question action",
  );
  assert(calls.interrupts.length === 1, "Runner.interrupt called once");
  assert(calls.questions.length === 1, "WM.addQuestion called once");
  assert(result.duration >= 0, "Duration is non-negative");

  // Urgent response (from pre-action gate) — no interrupt
  const amygdala2 = new Amygdala();
  const scanResult = amygdala2.scanIntentions(
    [makeDestructiveIntention("task-1")],
    0.8, // 0.9 * 0.8 = 0.72 → emergency actually, because of the remove effect (0.9 signal)
  );
  // Note: with signal 0.9 * weight 0.8 = 0.72 >= 0.7 → emergency
  if (scanResult) {
    const { deps: deps2, calls: calls2 } = makeMockDeps();
    const result2 = amygdala2.executeResponse(scanResult, deps2);
    assert(
      result2.actions.some((a) => a.kind === "block-intentions"),
      "Pre-action gate response includes block-intentions",
    );
  }
}

// ─── 13. Disabled gate — config toggle ───────────────────────────

console.log("\n13. Disabled pre-action gate");
{
  const amygdala = new Amygdala({ preActionGateEnabled: false });
  const result = amygdala.scanIntentions(
    [makeDestructiveIntention("task-1")],
    0.8,
  );
  assert(result === null, "Disabled gate → scanIntentions returns null");

  // Alarm receiver still works
  const alarm: Alarm = {
    source: "test",
    severity: "urgent",
    description: "test alarm",
    context: {},
  };
  const alarmResult = amygdala.receiveAlarm(alarm);
  assert(alarmResult !== null, "Alarm receiver still works when gate disabled");
}

// ─── 14. getState() serialization ────────────────────────────────

console.log("\n14. getState() serialization");
{
  const amygdala = new Amygdala();
  const state = amygdala.getState();
  assert(state.detectorCount === 4, "State: 4 detectors");
  assert(state.builtInDetectors === 4, "State: 4 built-in");
  assert(state.learnedDetectors === 0, "State: 0 learned");
  assert(state.assessments.length === 0, "State: no assessments initially");
  assert(state.lastAssessment === null, "State: no last assessment initially");

  // After a scan that fires
  amygdala.scanIntentions([makeDestructiveIntention("task-1")], 0.8);
  const state2 = amygdala.getState();
  assert(state2.assessments.length === 1, "State: 1 assessment after scan");
  assert(state2.lastAssessment !== null, "State: lastAssessment populated");
  assert(
    state2.lastAssessment!.trigger === "pre-action-gate",
    "State: lastAssessment trigger correct",
  );
}

// ─── 15. identifyBlockedIntentions pure function ─────────────────

console.log("\n15. identifyBlockedIntentions deduplication");
{
  const threats: DetectedThreat[] = [
    {
      detectorId: "d1",
      intentionId: "i1",
      description: "t1",
      signalStrength: 0.8,
      category: "destructive-operation",
    },
    {
      detectorId: "d2",
      intentionId: "i1", // same intention, different detector
      description: "t2",
      signalStrength: 0.7,
      category: "security-antipattern",
    },
    {
      detectorId: "d1",
      intentionId: "i2",
      description: "t3",
      signalStrength: 0.6,
      category: "destructive-operation",
    },
  ];
  const blocked = identifyBlockedIntentions(threats);
  assert(blocked.length === 2, "2 unique blocked intentions from 3 threats");
  assert(blocked.includes("i1"), "i1 is blocked");
  assert(blocked.includes("i2"), "i2 is blocked");
}

// ─── Results ─────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`Amygdala smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All good.");
