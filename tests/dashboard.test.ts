import { test, expect } from "@playwright/test";
import { Cortex } from "../src/index.js";
import type { ProjectIntent, TasteProfile } from "../src/index.js";

const intent: ProjectIntent = {
  id: "mikes-painting",
  summary:
    "A website for Mike's Painting, a residential painting contractor in Columbus, Ohio. 15 years in business, reputation-driven.",
  audience:
    "Homeowners in suburban Columbus considering painting. Age 35-65. Need someone trustworthy.",
  successCriteria: [
    "Visitor feels this is legitimate within 3 seconds",
    "Easy path to requesting a free estimate",
    "Works well on mobile",
  ],
  constraints: ["Mobile-first", "Must feel trustworthy"],
  vision:
    "A warm, professional online presence that feels like a trusted neighbor.",
  keyDecisions: [],
  driftLog: [],
};

const taste: TasteProfile = {
  id: "test-taste",
  name: "Test taste",
  visual: "Warm earth tones — rust, forest green, cream. Rounded corners.",
  decisionStyle: "Simple over clever. Ship good over perfect.",
  communication: "Terse updates.",
  patterns: "Prominent contact CTA.",
  raw: {},
};

test("dashboard displays cortex events in real-time", async ({ page }) => {
  test.setTimeout(600_000); // 10 min — Agent SDK calls are slow

  // Start the cortex with dashboard
  const cortex = new Cortex({
    intent,
    taste,
    logLevel: "warn",
  });

  const url = await cortex.startDashboard(3456);
  console.log(`Dashboard at ${url}`);

  // Navigate to dashboard
  await page.goto(url);

  // Log all browser console messages for diagnostics
  page.on("console", (msg) => {
    if (msg.type() !== "log") return;
    console.log(`[browser] ${msg.text()}`);
  });

  // Log all SSE events received by the page
  await page.evaluate(() => {
    const origHandler = (window as any).handleEvent;
    (window as any).handleEvent = function (event: any) {
      console.log(`SSE event: ${event.type}`);
      origHandler(event);
    };
  });

  // Verify initial state
  await expect(page.locator("#status")).toHaveText("Waiting");

  // Start the cortex in background
  const cortexPromise = cortex.run("Build the homepage hero section");

  // Wait for status to change to Running (events are flowing)
  console.log("Waiting for Running status...");
  await expect(page.locator("#status")).toHaveText("Running", {
    timeout: 60_000,
  });
  console.log("Status: Running");

  // Wait for events to appear in the stream
  await expect(page.locator(".event").first()).toBeVisible({ timeout: 30_000 });
  const eventCount = await page.locator(".event").count();
  console.log(`Events visible: ${eventCount}`);

  // Wait for consultation section — Agent SDK calls can be slow
  console.log("Waiting for consultation...");
  await expect(page.locator("#consultation-section")).toBeVisible({
    timeout: 180_000,
  });
  console.log("Consultation section visible");

  // Should have sense cards in the council
  const senseCount = await page.locator("#council-perspectives .sense-card").count();
  console.log(`Sense perspectives: ${senseCount}`);

  // Wait for work product
  console.log("Waiting for build...");
  await expect(page.locator("#work-section")).toBeVisible({
    timeout: 180_000,
  });
  console.log("Work section visible");

  // Check preview iframe exists
  const iframe = page.locator("#work-iframe");
  await expect(iframe).toBeVisible();

  // Check code tab works
  await page.locator('.work-tab:text("Code")').click();
  await expect(page.locator("#work-code")).toBeVisible();
  const code = await page.locator("#work-code").textContent();
  console.log(`Code length: ${code!.length}`);

  // Switch back to preview
  await page.locator('.work-tab:text("Preview")').click();
  await expect(page.locator("#work-preview")).toBeVisible();

  // Wait for evaluations
  console.log("Waiting for evaluations...");
  await expect(page.locator("#evaluation-section")).toBeVisible({
    timeout: 180_000,
  });
  // Radar canvas should be present
  await expect(page.locator("#radar-canvas")).toBeVisible({ timeout: 30_000 });
  console.log("Radar chart rendered");

  // Wait for cortex to complete
  console.log("Waiting for cortex to finish...");
  const result = await cortexPromise;

  // Status should update
  await expect(page.locator("#status")).toHaveText(/Complete|Needs Human/, {
    timeout: 30_000,
  });

  console.log(`\nCortex completed: ${result.status}`);
  console.log(`Cycles: ${result.cycles}`);
  console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log(`Evaluations: ${result.evaluations.length}`);
  console.log(`Tensions: ${result.tensions.length}`);
  console.log(`Resolutions: ${result.resolutions.length}`);

  // Verify result integrity
  expect(result.work.length).toBeGreaterThan(0);
  expect(result.evaluations.length).toBeGreaterThan(0);
  expect(result.cycles).toBeGreaterThanOrEqual(1);

  // Take a screenshot for the record
  await page.screenshot({ path: "test-results/dashboard-final.png", fullPage: true });
  console.log("Screenshot saved to test-results/dashboard-final.png");
});
