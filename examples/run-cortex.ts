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
 *   --resume[=ID]   Resume from a checkpoint (latest or specific ID)
 *   --list-checkpoints  List available checkpoints and exit
 *   --no-checkpoint Disable automatic checkpointing
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
import { CheckpointStore } from "../src/trace/checkpoint-store.js";
import { createInterface } from "readline";

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
const listCheckpoints = flags.includes("--list-checkpoints");
const noCheckpoint = flags.includes("--no-checkpoint");
const resumeFlag = flags.find((f) => f.startsWith("--resume"));
const resumeMode = !!resumeFlag;
const resumeId = resumeFlag?.includes("=") ? resumeFlag.split("=")[1] : null;

// ─── --list-checkpoints: print and exit ─────────────────────────

if (listCheckpoints) {
  const store = new CheckpointStore();
  const index = await store.list();
  if (index.length === 0) {
    console.log("No checkpoints available.");
  } else {
    console.log(`\n  Available checkpoints (${index.length}):\n`);
    for (const entry of index) {
      const age = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 60000);
      console.log(`  ${entry.id}  ${entry.label}  (${age}m ago, ${(entry.sizeBytes / 1024).toFixed(0)}KB)`);
    }
    console.log();
  }
  process.exit(0);
}

if (!prompt && !replayAll && replayFromId === null && !resumeMode) {
  console.error(`
Usage: npx tsx examples/run-cortex.ts "Your prompt here" [flags]

Flags:
  --step              Pause before each LLM call and phase transition
  --replay            Replay all cached responses (no real LLM calls)
  --replay-from=N     Replay up to content ID N, then go live
  --resume[=ID]       Resume from a checkpoint (latest or specific ID)
  --list-checkpoints  List available checkpoints and exit
  --no-checkpoint     Disable automatic checkpointing
  --port=N            Dashboard port (default 3456)

Examples:
  npx tsx examples/run-cortex.ts "Build a personal website with a landing page and about page"
  npx tsx examples/run-cortex.ts "Build a hello world HTML page" --step
  npx tsx examples/run-cortex.ts --replay-from=42
  npx tsx examples/run-cortex.ts --resume
  npx tsx examples/run-cortex.ts --resume=abc123
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
if (resumeMode) console.log(`  Mode: resume from checkpoint${resumeId ? ` ${resumeId}` : " (latest)"}`);
if (noCheckpoint) console.log("  Checkpointing: disabled");

// Start dashboard
const url = await startDashboard(port);
console.log(`  Dashboard: ${url}/trace\n`);

// ─── Create Brainstem ───────────────────────────────────────────

resetUsage();
const library = SensoryCortex.withDefaults();
const brainstem = new Brainstem(DEFAULT_CONFIG, library);

// Disable checkpointing if requested
if (noCheckpoint) {
  brainstem.getRunner().setCheckpointConfig({ enabled: false });
}

// Wire user interaction — inquiry questions and vision approval go through stdin/stdout.
const rl = createInterface({ input: process.stdin, output: process.stdout });
brainstem.setAskUser((question: string) => {
  return new Promise((resolve) => {
    console.log("\n" + "─".repeat(60));
    console.log(question);
    console.log("─".repeat(60));
    rl.question("\n> ", (answer) => {
      resolve(answer);
    });
  });
});

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
const startTime = Date.now();

if (resumeMode) {
  // ── Resume from checkpoint ──────────────────────────────────
  const cpStore = new CheckpointStore();
  const checkpoint = resumeId
    ? await cpStore.load(resumeId)
    : await cpStore.latest("pre-integrate");

  if (!checkpoint) {
    console.error(resumeId
      ? `  Checkpoint ${resumeId} not found.`
      : "  No checkpoints available. Run a project first to create one.");
    process.exit(1);
  }

  console.log(`  Resuming from checkpoint: ${checkpoint.label}`);
  console.log(`  Task: ${checkpoint.taskId}`);
  console.log(`  Git commit at checkpoint: ${checkpoint.gitCommit?.slice(0, 8) ?? "unknown"}`);
  console.log();

  try {
    const { integrated, gateDecision } = await brainstem.runFromCheckpoint(checkpoint);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n" + "═".repeat(60));
    console.log(`  CHECKPOINT RESUME COMPLETE (${elapsed}s)`);
    console.log(`  Gate decision: ${gateDecision.action}`);
    if ("reason" in gateDecision && gateDecision.reason) {
      console.log(`  Reason: ${gateDecision.reason}`);
    }
    if (gateDecision.action === "complete" && gateDecision.result) {
      const result = gateDecision.result as Record<string, unknown>;
      if (typeof result.confidence === "number") {
        console.log(`  Confidence: ${(result.confidence as number).toFixed(2)}`);
      }
    }
    console.log("═".repeat(60));
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n  CHECKPOINT RESUME FAILED (${elapsed}s):`, err);
  }
} else {
  // ── Normal project run ──────────────────────────────────────
  console.log("  Starting project...\n");

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
