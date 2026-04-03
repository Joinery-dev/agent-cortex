/**
 * Consciousness Wiring — smoke tests for the Claus capabilities.
 *
 * Verifies end-to-end wiring WITHOUT LLM calls:
 *   - Awareness buffer accumulates from events
 *   - Self-knowledge flows to briefings
 *   - Proactive surfacing triggers on critical insights
 *   - Reference store persists and flows to briefings
 *   - ParsifaInterface implementations work
 *   - CortexParsifal resolves questions
 *
 * These tests use the event bus and Thalamus directly —
 * no Cortex instance, no API keys needed.
 */

import { test, expect } from "@playwright/test";
import { Thalamus } from "../src/kernel/thalamus.js";
import { WorkingMemory } from "../src/kernel/working-memory.js";
import { ReferenceStore } from "../src/kernel/reference-store.js";
import { AutonomousParsifal } from "../src/kernel/autonomous-parsifal.js";
import { emit, bus } from "../src/events.js";
import type { AwarenessInsight } from "../src/types/thalamus.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ─── Awareness Buffer ─────────────────────────────────────────

test.describe("Awareness Buffer", () => {
  let thalamus: Thalamus;
  let wm: WorkingMemory;

  test.beforeEach(() => {
    wm = new WorkingMemory("test-project");
    thalamus = new Thalamus({ wm });
  });

  test.afterEach(() => {
    thalamus.disposeAwareness();
  });

  test("digests flexibility:assessment into insight", () => {
    emit("flexibility:assessment", {
      taskId: "task-1",
      diagnosis: "tension-evasion",
      shouldReset: true,
      shouldEscalate: false,
    });

    const insights = thalamus.getAwareness();
    expect(insights.length).toBe(1);
    expect(insights[0].source).toBe("flexibility");
    expect(insights[0].summary).toContain("tension-evasion");
    expect(insights[0].severity).toBe("warn");
  });

  test("ignores non-significant events", () => {
    // flexibility:assessment with shouldReset=false, shouldEscalate=false → ignored
    emit("flexibility:assessment", {
      taskId: "task-1",
      diagnosis: "execution-problem",
      shouldReset: false,
      shouldEscalate: false,
    });

    expect(thalamus.getAwareness().length).toBe(0);
  });

  test("digests drift-monitor:level-changed", () => {
    emit("drift-monitor:level-changed", {
      threshold: 0.5,
      previousLevel: 0.4,
      newLevel: 0.55,
      direction: "crossed-above",
    });

    const insights = thalamus.getAwareness();
    expect(insights.length).toBe(1);
    expect(insights[0].source).toBe("drift");
    expect(insights[0].summary).toContain("Drift crossed 0.5");
  });

  test("ignores drift crossing below", () => {
    emit("drift-monitor:level-changed", {
      threshold: 0.3,
      previousLevel: 0.35,
      newLevel: 0.25,
      direction: "crossed-below",
    });

    expect(thalamus.getAwareness().length).toBe(0);
  });

  test("digests world-model:maxim-evolved as identity insight", () => {
    emit("world-model:maxim-evolved", {
      scope: "self",
      oldId: "old-1",
      oldStatement: "I tend to over-engineer",
      newStatement: "I balance simplicity with thoroughness",
    });

    const insights = thalamus.getAwareness();
    expect(insights.length).toBe(1);
    expect(insights[0].source).toBe("identity");
    expect(insights[0].summary).toContain("Understanding shifted");
  });

  test("digests escalation:created", () => {
    emit("escalation:created", {
      id: "esc-1",
      source: "cognitive-flexibility",
      severity: "blocking",
      summary: "Task graph deadlocked",
      rhythmId: "rhythm-1",
    });

    const insights = thalamus.getAwareness();
    expect(insights.length).toBe(1);
    expect(insights[0].source).toBe("escalation");
    expect(insights[0].summary).toContain("Escalated to Parsifal");
  });

  test("prunes by severity when buffer exceeds max", () => {
    // Fill buffer with info-level insights
    for (let i = 0; i < 55; i++) {
      emit("hippocampus:principle-extracted", {
        principleId: `p-${i}`,
        statement: `Principle ${i}`,
        confidence: 0.8,
        senses: [],
        episodeCount: 3,
        trigger: "density",
      });
    }

    const insights = thalamus.getAwareness();
    // Should be capped at 50
    expect(insights.length).toBeLessThanOrEqual(50);
  });

  test("getAwarenessSummaries returns string array", () => {
    emit("vitals:reflex", {
      actions: [{ type: "trigger-rest", reason: "cumulative NE high" }],
      diagnosticLoad: 0.5,
    });

    const summaries = thalamus.getAwarenessSummaries();
    expect(summaries.length).toBe(1);
    expect(typeof summaries[0]).toBe("string");
    expect(summaries[0]).toContain("trigger-rest");
  });

  test("getAwarenessForTask filters by taskId", () => {
    emit("gate:failure-classified", {
      taskId: "task-A",
      failureMode: "local-logic",
    });
    emit("gate:failure-classified", {
      taskId: "task-B",
      failureMode: "integration",
    });

    const forA = thalamus.getAwarenessForTask("task-A");
    expect(forA.length).toBe(1);
    expect(forA[0].summary).toContain("local-logic");
  });

  test("clearAwareness empties the buffer", () => {
    emit("hippocampus:principle-extracted", {
      statement: "Test principle",
    });

    expect(thalamus.getAwareness().length).toBe(1);
    thalamus.clearAwareness();
    expect(thalamus.getAwareness().length).toBe(0);
  });
});

// ─── Reference Store ──────────────────────────────────────────

test.describe("Reference Store", () => {
  let store: ReferenceStore;
  let tmpDir: string;

  test.beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cortex-ref-test-"));
    store = new ReferenceStore(join(tmpDir, "refs.json"));
    await store.load();
  });

  test.afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("add and retrieve by category", () => {
    store.add("Linear INGEST", "https://linear.app/team/INGEST", "issue-tracker", "parsifal");

    const trackers = store.getByCategory("issue-tracker");
    expect(trackers.length).toBe(1);
    expect(trackers[0].label).toBe("Linear INGEST");
    expect(trackers[0].value).toBe("https://linear.app/team/INGEST");
  });

  test("deduplicates by label", () => {
    store.add("Grafana", "https://grafana.old/", "monitoring", "parsifal");
    store.add("Grafana", "https://grafana.new/", "monitoring", "parsifal");

    expect(store.count).toBe(1);
    expect(store.getAll()[0].value).toBe("https://grafana.new/");
  });

  test("search by keyword", () => {
    store.add("API Docs", "https://docs.api.com", "documentation", "config");
    store.add("Sentry Dashboard", "https://sentry.io/org", "monitoring", "config");

    const results = store.search("sentry");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("Sentry Dashboard");
  });

  test("getSummaries returns formatted strings", () => {
    store.add("Linear INGEST", "https://linear.app", "issue-tracker", "parsifal", "Pipeline bugs");

    const summaries = store.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("[issue-tracker]");
    expect(summaries[0]).toContain("Linear INGEST");
    expect(summaries[0]).toContain("Pipeline bugs");
  });

  test("persists and loads from disk", async () => {
    store.add("Test Ref", "https://test.com", "other", "api");

    // Wait for async save
    await new Promise((r) => setTimeout(r, 100));

    // Load fresh instance from same path
    const store2 = new ReferenceStore(join(tmpDir, "refs.json"));
    await store2.load();

    expect(store2.count).toBe(1);
    expect(store2.getAll()[0].label).toBe("Test Ref");
  });
});

// ─── AutonomousParsifal ───────────────────────────────────────

test.describe("AutonomousParsifal", () => {
  test("auto-approves", async () => {
    const parsifa = new AutonomousParsifal(3);
    const answer = await parsifa.ask("Approve this vision?", { kind: "approval" });
    expect(answer).toBe("approved");
  });

  test("skips inquiry", async () => {
    const parsifa = new AutonomousParsifal(3);
    const answer = await parsifa.ask("What font do you prefer?", { kind: "inquiry" });
    expect(answer).toBe("");
  });

  test("self-resolves escalations up to budget", async () => {
    const parsifa = new AutonomousParsifal(2);

    const a1 = await parsifa.ask("Task stuck", { kind: "escalation", severity: "medium" });
    expect(a1).toContain("best judgment");

    const a2 = await parsifa.ask("Still stuck", { kind: "escalation", severity: "medium" });
    expect(a2).toContain("best judgment");

    // Third should throw — budget exhausted
    await expect(
      parsifa.ask("Really stuck", { kind: "escalation", severity: "medium" }),
    ).rejects.toThrow("budget exhausted");
  });

  test("capabilities reflect budget", () => {
    const parsifa = new AutonomousParsifal(5);
    expect(parsifa.capabilities.canInquire).toBe(false);
    expect(parsifa.capabilities.canApprove).toBe(true);
    expect(parsifa.capabilities.canEscalate).toBe(true);
    expect(parsifa.capabilities.autonomyBudget).toBe(5);
  });

  test("resetBudget resets escalation counter", async () => {
    const parsifa = new AutonomousParsifal(1);
    await parsifa.ask("Stuck", { kind: "escalation" });
    await expect(parsifa.ask("Again", { kind: "escalation" })).rejects.toThrow();

    parsifa.resetBudget();
    const answer = await parsifa.ask("Fresh", { kind: "escalation" });
    expect(answer).toContain("best judgment");
  });
});

// ─── forCommunication includes awareness + references ─────────

test.describe("Thalamus forCommunication", () => {
  test("includes awareness and references sections", () => {
    const wm = new WorkingMemory("test");
    const refStore = new ReferenceStore(); // In-memory only, no disk
    const thalamus = new Thalamus({ wm, referenceStore: refStore });

    // Add an awareness insight via event
    emit("hippocampus:principle-extracted", {
      statement: "Code quality matters more than speed",
    });

    // Add a reference
    refStore.add("Bug Tracker", "https://linear.app/bugs", "issue-tracker", "parsifal");

    const briefing = thalamus.forCommunication();

    expect(briefing).toContain("What I've noticed");
    expect(briefing).toContain("Code quality matters");
    expect(briefing).toContain("Known references");
    expect(briefing).toContain("Bug Tracker");

    thalamus.disposeAwareness();
  });
});
