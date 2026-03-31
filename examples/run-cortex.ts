/**
 * Run Agent Cortex — persistent agent entry point.
 *
 * The agent boots once (worldview, brainstem, dashboard), then cycles
 * through projects. Kill/restart resumes seamlessly via session state
 * and checkpoints. Learning accumulates across projects.
 *
 * Usage:
 *   npx tsx examples/run-cortex.ts "Build a personal website"
 *   npx tsx examples/run-cortex.ts "Build a landing page" --step
 *   npx tsx examples/run-cortex.ts --resume
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
import type { DashboardHandle } from "../src/dashboard/server.js";
import { getTraceCollector, resetTraceCollector } from "../src/trace/collector.js";
import { getContentStore, resetContentStore } from "../src/trace/content-store.js";
import { getStepBarrier } from "../src/trace/step-barrier.js";
import { buildReplayCache, enableReplay, disableReplay } from "../src/llm/replay-interceptor.js";
import { ExecutionController, registerExecutionController } from "../src/trace/execution-controller.js";
import { Brainstem } from "../src/brainstem/index.js";
import { SensoryCortex } from "../src/senses/cortex.js";
import { DEFAULT_CONFIG } from "../src/types/orchestrator.js";
import { getUsage, resetUsage } from "../src/llm/client.js";
import { newId } from "../src/util/ids.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { ProjectContext } from "../src/types/brainstem.js";
import { CheckpointStore } from "../src/trace/checkpoint-store.js";
import { setupWorldview } from "../src/worldview/generator.js";
import { loadExistingWorldview } from "../src/worldview/store.js";
import { DEFAULT_WORLDVIEW } from "../src/types/worldview.js";
import type { Worldview } from "../src/types/worldview.js";
import { persistSession, loadSession, clearSession } from "../src/session/state.js";
import { TerminalTransport } from "../src/conversation/terminal-transport.js";
import { setupTaste } from "../src/taste/setup.js";
import { loadTasteProfile, DEFAULT_TASTE } from "../src/taste/store.js";

// ─── Parse arguments ────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

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
  const cpStore = new CheckpointStore();
  const index = await cpStore.list();
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

// ─── Agent-level state (persists across projects) ───────────────

let taste: TasteProfile;
let brainstem: Brainstem;
let worldview: Worldview;
let terminalTransport: TerminalTransport;
let askUser: (question: string) => Promise<string>;
let dashboardUrl: string;
let shuttingDown = false;

const sessionStats = {
  projectsCompleted: 0,
  projectsFailed: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  startTime: Date.now(),
};

// ─── Helpers ────────────────────────────────────────────────────

function buildIntent(prompt: string): ProjectIntent {
  return {
    id: `project-${newId().slice(0, 8)}`,
    summary: prompt,
    audience: "General",
    successCriteria: [`Deliver: ${prompt}`],
    constraints: [],
    vision: prompt,
    keyDecisions: [],
    driftLog: [],
  };
}

function accumulateAndResetUsage(): void {
  const usage = getUsage();
  for (const u of Object.values(usage)) {
    sessionStats.totalInputTokens += u.inputTokens;
    sessionStats.totalOutputTokens += u.outputTokens;
  }
}

function printProjectSummary(projectNumber: number, startTime: number, status: "COMPLETE" | "FAILED", err?: unknown): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const store = getContentStore();
  const usage = getUsage();
  let tokensIn = 0, tokensOut = 0;
  for (const u of Object.values(usage)) {
    tokensIn += u.inputTokens;
    tokensOut += u.outputTokens;
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  PROJECT ${projectNumber} ${status} (${elapsed}s)`);
  if (err) console.error(`  Error:`, err);
  console.log(`  Content: ${store.size} entries`);
  console.log(`  Tokens: ${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out`);
  console.log(`  Dashboard: ${dashboardUrl}/trace`);
  console.log("═".repeat(60));
}

function printFinalSummary(): void {
  const totalSecs = Math.round((Date.now() - sessionStats.startTime) / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;

  console.log(`
  ── Agent Session Summary ──────────────────────────────────
  Projects completed: ${sessionStats.projectsCompleted}
  Projects failed:    ${sessionStats.projectsFailed}
  Total tokens:       ${sessionStats.totalInputTokens.toLocaleString()} in / ${sessionStats.totalOutputTokens.toLocaleString()} out
  Total runtime:      ${mins}m ${secs}s
  ──────────────────────────────────────────────────────────
`);
}

function resetBetweenProjects(intentId: string): void {
  accumulateAndResetUsage();
  resetUsage();
  resetContentStore();
  resetTraceCollector();
  getTraceCollector(); // re-create + re-subscribe to event bus
  clearSession();
  getStepBarrier().disable();
  disableReplay();
  brainstem.prepareForNewProject(intentId);
}

async function acquirePrompt(isFirstIteration: boolean): Promise<string | null> {
  if (shuttingDown) return null;

  if (isFirstIteration) {
    // CLI arg takes priority
    if (positional[0]) return positional[0];

    // Check for existing session (crash recovery)
    const existingSession = loadSession();
    if (existingSession) {
      const answer = await askUser(
        `Previous session found: "${existingSession.prompt}"\n\n` +
        `  1. **Continue** with this prompt\n` +
        `  2. **Start fresh** with a new prompt\n\n` +
        `(Choose 1 or 2)`
      );
      if (answer.trim() === "1" || answer.trim().toLowerCase().includes("continue")) {
        return existingSession.prompt;
      }
      clearSession();
    }
  }

  // Ask for a prompt
  const question = isFirstIteration
    ? "What would you like to build?"
    : "What would you like to build next? (or 'exit' to quit)";
  const answer = await askUser(question);
  if (!answer?.trim()) return null;
  const trimmed = answer.trim();
  if (!isFirstIteration && /^(exit|quit|q)$/i.test(trimmed)) return null;
  return trimmed;
}

// ─── Boot (one-time agent setup) ────────────────────────────────

async function boot(): Promise<void> {
  // Clear previous trace data (unless replaying)
  if (!replayAll && replayFromId === null) {
    resetContentStore();
  }

  getTraceCollector();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   Agent Cortex                                               ║
╚══════════════════════════════════════════════════════════════╝
`);

  if (stepMode) console.log("  Mode: step-by-step");
  if (replayAll) console.log(`  Mode: full replay (${getContentStore().size} entries)`);
  if (replayFromId !== null) console.log(`  Mode: replay from content ID ${replayFromId}`);
  if (resumeMode) console.log(`  Mode: resume from checkpoint${resumeId ? ` ${resumeId}` : " (latest)"}`);
  if (noCheckpoint) console.log("  Checkpointing: disabled");

  // Dashboard (stays running across projects)
  const dashboard = await startDashboard(port, undefined, { returnHandle: true }) as DashboardHandle;
  dashboardUrl = dashboard.url;
  console.log(`  Dashboard: ${dashboardUrl}/trace`);
  console.log(`  Conversation: ${dashboardUrl}/conversation\n`);

  // Sensory library + terminal transport
  resetUsage();
  const library = SensoryCortex.withDefaults();
  terminalTransport = new TerminalTransport();

  askUser = (question: string): Promise<string> => {
    const rl = terminalTransport.getReadline();
    return new Promise((resolve) => {
      console.log("\n" + "─".repeat(60));
      console.log(question);
      console.log("─".repeat(60));
      rl.question("\n> ", (answer) => {
        resolve(answer);
      });
    });
  };

  // Worldview (one-time — persisted selection means no re-prompting)
  if (resumeMode) {
    worldview = loadExistingWorldview() ?? DEFAULT_WORLDVIEW;
  } else {
    worldview = await setupWorldview(askUser, { model: "opus" });
  }
  console.log(`  Worldview: ${worldview.name}`);

  // Taste profile (one-time — persisted, refined by feedback loop over time)
  if (resumeMode) {
    taste = loadTasteProfile() ?? DEFAULT_TASTE;
  } else {
    taste = await setupTaste(askUser);
  }
  console.log(`  Taste: ${taste.id} (working for ${taste.name})\n`);

  // Brainstem (single instance, reused across projects)
  brainstem = new Brainstem(DEFAULT_CONFIG, library, undefined, undefined, undefined, undefined, undefined, undefined, undefined, worldview);

  if (noCheckpoint) {
    brainstem.getRunner().setCheckpointConfig({ enabled: false });
  }

  // Wire conversation transports
  brainstem.setConversationTransport(terminalTransport);
  brainstem.setConversationTransport(dashboard.wsTransport);

  // First-project modes (step, replay)
  if (stepMode) {
    getStepBarrier().enable();
    console.log("  Step barrier enabled.\n");
  }

  if (replayAll || replayFromId !== null) {
    const upTo = replayFromId ?? undefined;
    const cache = buildReplayCache(getContentStore(), upTo ?? null);
    if (cache.total > 0) {
      enableReplay(cache, "replay");
      getStepBarrier().setMode("replaying");
      console.log(`  Replay cache: ${cache.total} responses loaded.\n`);
    } else {
      console.log("  Warning: no cached responses found. Running live.\n");
    }
  }

  // Graceful shutdown
  process.on("SIGINT", () => {
    if (shuttingDown) {
      console.log("\n  Force exit.");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\n  Shutting down after current project... (Ctrl+C again to force)");
    try { terminalTransport.getReadline().close(); } catch { /* ignore */ }
  });
}

// ─── Project loop ───────────────────────────────────────────────

async function runProjectLoop(): Promise<void> {
  let isFirstIteration = true;
  let projectNumber = 0;

  while (!shuttingDown) {
    projectNumber++;
    const startTime = Date.now();

    // ── Resume mode (first iteration only) ──────────────────
    if (isFirstIteration && resumeMode) {
      const cpStore = new CheckpointStore();
      const checkpoint = resumeId
        ? await cpStore.load(resumeId)
        : await cpStore.latest();

      if (!checkpoint) {
        const session = loadSession();
        if (session) {
          console.error("  No checkpoint available yet, but your session is saved.");
          console.error(`  Restart without --resume to continue: "${session.prompt}"`);
        } else {
          console.error(resumeId
            ? `  Checkpoint ${resumeId} not found.`
            : "  No checkpoints available. Run a project first to create one.");
        }
        process.exit(1);
      }

      console.log("─".repeat(60));
      console.log(`  Resuming from checkpoint: ${checkpoint.label}`);
      console.log(`  Kind: ${checkpoint.kind}`);
      console.log(`  Task: ${checkpoint.taskId}`);
      console.log(`  Git commit: ${checkpoint.gitCommit?.slice(0, 8) ?? "unknown"}\n`);

      try {
        const result = await brainstem.runFromCheckpoint(checkpoint);
        clearSession();

        if ("gateDecision" in result) {
          const gd = result.gateDecision;
          console.log(`  Gate decision: ${gd.action}`);
          if ("reason" in gd && gd.reason) console.log(`  Reason: ${gd.reason}`);
          if (gd.action === "complete" && gd.result) {
            const res = gd.result as Record<string, unknown>;
            if (typeof res.confidence === "number") {
              console.log(`  Confidence: ${(res.confidence as number).toFixed(2)}`);
            }
          }
        } else {
          const pr = result as Record<string, unknown>;
          if (pr.completedTasks && Array.isArray(pr.completedTasks)) {
            console.log(`  Tasks completed: ${(pr.completedTasks as string[]).length}`);
          }
          if (pr.escalatedTasks && Array.isArray(pr.escalatedTasks)) {
            console.log(`  Tasks escalated: ${(pr.escalatedTasks as string[]).length}`);
          }
        }

        accumulateAndResetUsage();
        sessionStats.projectsCompleted++;
        printProjectSummary(projectNumber, startTime, "COMPLETE");
      } catch (err) {
        accumulateAndResetUsage();
        sessionStats.projectsFailed++;
        printProjectSummary(projectNumber, startTime, "FAILED", err);
      }

      isFirstIteration = false;
      continue;
    }

    // ── Acquire prompt ──────────────────────────────────────
    const prompt = await acquirePrompt(isFirstIteration);
    if (prompt === null) break;

    // ── Reset between projects (skip first) ─────────────────
    if (!isFirstIteration) {
      const tempId = `project-${newId().slice(0, 8)}`;
      resetBetweenProjects(tempId);
    }

    // ── Build context + persist ──────────────────────────────
    const intent = buildIntent(prompt);
    const projectContext: ProjectContext = { intent, taste, tasks: [] };

    persistSession({
      prompt,
      intent,
      taste,
      worldviewName: worldview.name,
      startedAt: new Date().toISOString(),
    });

    registerExecutionController(new ExecutionController(brainstem, projectContext));

    // ── Run project ─────────────────────────────────────────
    console.log("─".repeat(60));
    console.log(`  Starting project: "${prompt}"\n`);

    try {
      await brainstem.runProject(projectContext);
      clearSession();
      accumulateAndResetUsage();
      sessionStats.projectsCompleted++;
      printProjectSummary(projectNumber, startTime, "COMPLETE");
    } catch (err) {
      accumulateAndResetUsage();
      sessionStats.projectsFailed++;
      printProjectSummary(projectNumber, startTime, "FAILED", err);
    }

    isFirstIteration = false;
  }
}

// ─── Main ───────────────────────────────────────────────────────

await boot();
await runProjectLoop();
printFinalSummary();
process.exit(0);
