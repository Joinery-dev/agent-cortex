/**
 * Run Agent Cortex — the real entry point.
 *
 * Give it a prompt, watch it think. The trace dashboard shows
 * every decision, every LLM call, every evaluation, in real-time.
 *
 * Usage:
 *   npx tsx examples/run-cortex.ts "Build a personal website"
 *   npx tsx examples/run-cortex.ts "Build a landing page" --step
 *   npx tsx examples/run-cortex.ts --replay-from=42
 *
 * Flags:
 *   --step          Pause before each LLM call and phase transition
 *   --replay        Replay all cached responses (no real LLM calls)
 *   --replay-from=N Replay up to content ID N, then go live
 *   --port=N        Dashboard port (default 3456)
 */

import { startDashboard } from "../src/dashboard/server.js";
import { getTraceCollector } from "../src/trace/collector.js";
import { getContentStore, resetContentStore } from "../src/trace/content-store.js";
import { getStepBarrier } from "../src/trace/step-barrier.js";
import { buildReplayCache, enableReplay } from "../src/llm/replay-interceptor.js";
import { ExecutionController, registerExecutionController } from "../src/trace/execution-controller.js";
import { Brainstem } from "../src/brainstem/index.js";
import { SensoryCortex } from "../src/senses/cortex.js";
import { DEFAULT_CONFIG } from "../src/types/orchestrator.js";
import { getUsage, resetUsage } from "../src/llm/client.js";
import { newId } from "../src/util/ids.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { ProjectContext } from "../src/types/brainstem.js";

// ─── Parse arguments ────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const prompt = positional[0];
const stepMode = flags.includes("--step");
const replayAll = flags.includes("--replay");
const replayFromFlag = flags.find((f) => f.startsWith("--replay-from="));
const replayFromId = replayFromFlag ? parseInt(replayFromFlag.split("=")[1], 10) : null;
const portFlag = flags.find((f) => f.startsWith("--port="));
const port = portFlag ? parseInt(portFlag.split("=")[1], 10) : 3456;

if (!prompt && !replayAll && replayFromId === null) {
  console.error(`
Usage: npx tsx examples/run-cortex.ts "Your prompt here" [flags]

Flags:
  --step            Pause before each LLM call and phase transition
  --replay          Replay all cached responses (no real LLM calls)
  --replay-from=N   Replay up to content ID N, then go live
  --port=N          Dashboard port (default 3456)

Examples:
  npx tsx examples/run-cortex.ts "Build a personal website with a landing page and about page"
  npx tsx examples/run-cortex.ts "Build a hello world HTML page" --step
  npx tsx examples/run-cortex.ts --replay-from=42
`);
  process.exit(1);
}

// ─── Build project intent from prompt ───────────────────────────

const intent: ProjectIntent = {
  id: `project-${newId().slice(0, 8)}`,
  summary: prompt ?? "(replay — original prompt in cached content)",
  audience: "General",
  successCriteria: prompt ? [`Deliver: ${prompt}`] : [],
  constraints: [],
  vision: prompt ?? "",
  keyDecisions: [],
  driftLog: [],
};

const taste: TasteProfile = {
  id: "default-taste",
  name: "User",
  visual: "Clean, modern, purposeful",
  decisionStyle: "Pragmatic",
  communication: "Direct",
  patterns: "Best practices for the technology stack",
  raw: {},
};

// ─── Initialize system ──────────────────────────────────────────

// Clear previous trace data for a fresh run (unless replaying)
if (!replayAll && replayFromId === null) {
  resetContentStore();
}

const collector = getTraceCollector();
const store = getContentStore();
const barrier = getStepBarrier();

console.log(`
╔══════════════════════════════════════════════════════════════╗
║   Agent Cortex                                               ║
╚══════════════════════════════════════════════════════════════╝
`);

if (prompt) console.log(`  Prompt: "${prompt}"`);
if (stepMode) console.log("  Mode: step-by-step (pausing at each operation)");
if (replayAll) console.log(`  Mode: full replay from cache (${store.size} entries)`);
if (replayFromId !== null) console.log(`  Mode: replay from content ID ${replayFromId}`);

// Start dashboard
const url = await startDashboard(port);
console.log(`  Dashboard: ${url}/trace\n`);

// ─── Create Brainstem ───────────────────────────────────────────

resetUsage();
const library = SensoryCortex.withDefaults();
const brainstem = new Brainstem(DEFAULT_CONFIG, library);

const projectContext: ProjectContext = {
  intent,
  taste,
  tasks: [], // empty = Planner decomposes the prompt
};

// ─── Register execution controller ──────────────────────────────

const controller = new ExecutionController(brainstem, projectContext);
registerExecutionController(controller);

// ─── Configure mode ─────────────────────────────────────────────

if (stepMode) {
  barrier.enable();
  console.log("  Step barrier enabled — system will pause at each operation.");
  console.log("  Use the dashboard or press Step in the UI to advance.\n");
}

if (replayAll || replayFromId !== null) {
  const upTo = replayFromId ?? undefined;
  const cache = buildReplayCache(store, upTo ?? null);
  if (cache.total > 0) {
    enableReplay(cache, "replay");
    barrier.setMode("replaying");
    console.log(`  Replay cache: ${cache.total} responses loaded.\n`);
  } else {
    console.log("  Warning: no cached responses found. Running live.\n");
  }
}

// ─── Run ────────────────────────────────────────────────────────

console.log("─".repeat(60));
console.log("  Starting project...\n");

const startTime = Date.now();

try {
  await brainstem.runProject(projectContext);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "═".repeat(60));
  console.log(`  PROJECT COMPLETE (${elapsed}s)`);
  console.log("═".repeat(60));
} catch (err) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n  PROJECT FAILED (${elapsed}s):`, err);
}

// ─── Summary ────────────────────────────────────────────────────

const contentSummary = store.getSummary();
const usage = getUsage();
let totalIn = 0, totalOut = 0;
for (const u of Object.values(usage)) {
  totalIn += u.inputTokens;
  totalOut += u.outputTokens;
}

console.log(`
  Content captured: ${store.size} entries
  Tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out

  Dashboard: ${url}/trace
  Step through everything in the Narrative tab.
  Press Ctrl+C to stop.
`);

// Keep alive
await new Promise(() => {});
