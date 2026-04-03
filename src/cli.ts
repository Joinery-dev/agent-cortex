#!/usr/bin/env node
/**
 * cortex — CLI entry point for Agent Cortex.
 *
 * Usage:
 *   cortex "fix the auth bug"              — run a single task interactively
 *   cortex --autonomous "fix the auth bug" — run without human input
 *   cortex --dashboard "build the homepage" — run with live dashboard
 *
 * The CLI constructs a minimal intent from the command-line task
 * description, sets up a terminal transport for conversation, and
 * runs the Cortex. For richer configuration (taste profiles, worldviews,
 * multi-task projects), use the programmatic API.
 */

import { Cortex } from "./index.js";
import type { ProjectIntent, TasteProfile } from "./index.js";
import { TerminalTransport } from "./conversation/terminal-transport.js";
import { HumanParsifal } from "./kernel/human-parsifal.js";
import { AutonomousParsifal } from "./kernel/autonomous-parsifal.js";
import { newId } from "./util/ids.js";
import { discoverProjectContext } from "./cli/project-context.js";
import { persistSession, loadSession, clearSession } from "./session/state.js";
import { CheckpointStore } from "./trace/checkpoint-store.js";

// ─── Arg parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);

const flags = {
  autonomous: false,
  dashboard: false,
  dashboardPort: 3000,
  logLevel: "warn" as "info" | "warn" | "debug",
  resume: false,
  help: false,
};

const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--autonomous" || arg === "-a") {
    flags.autonomous = true;
  } else if (arg === "--dashboard" || arg === "-d") {
    flags.dashboard = true;
  } else if (arg === "--port" || arg === "-p") {
    flags.dashboardPort = parseInt(args[++i], 10) || 3000;
  } else if (arg === "--verbose" || arg === "-v") {
    flags.logLevel = "info";
  } else if (arg === "--resume" || arg === "-r") {
    flags.resume = true;
  } else if (arg === "--debug") {
    flags.logLevel = "debug";
  } else if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (!arg.startsWith("-")) {
    positional.push(arg);
  }
}

if (flags.help || (positional.length === 0 && !flags.resume)) {
  console.log(`
  Agent Cortex — a software engineer that solves problems.

  Usage:
    cortex "fix the auth bug"              Run a task interactively
    cortex --autonomous "build the API"    Run without human input
    cortex --dashboard "build the hero"    Run with live dashboard
    cortex --resume                        Resume from last checkpoint

  Options:
    -a, --autonomous   Run without Parsifal input (bounded autonomy)
    -d, --dashboard    Start the live dashboard
    -r, --resume       Resume from the latest checkpoint
    -p, --port <n>     Dashboard port (default 3000)
    -v, --verbose      Show info-level logs
    --debug            Show debug-level logs
    -h, --help         Show this help
  `);
  process.exit(flags.help ? 0 : 1);
}

const taskDescription = positional.join(" ");

// ─── Run ──────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

const DEFAULT_TASTE: TasteProfile = {
  id: "cli-defaults",
  name: "CLI defaults",
  visual: "",
  decisionStyle: "Prefers simple over clever. Ships good over perfects great.",
  communication: "Terse updates. Don't over-explain.",
  patterns: "",
  raw: {},
};

async function main() {
  console.log(`\n${BOLD}cortex${RESET} ${DIM}—${RESET} ${taskDescription}\n`);

  // ── Discover project context (no LLM calls) ──────────
  const discovered = await discoverProjectContext(process.cwd());

  if (discovered.configFound) {
    console.log(`${DIM}Config: .cortex/config.json${RESET}`);
  }
  if (discovered.techStack.length > 0) {
    console.log(`${DIM}Stack:  ${discovered.techStack.join(", ")}${RESET}`);
  }
  if (discovered.gitContext) {
    console.log(`${DIM}Branch: ${discovered.gitContext.branch}${discovered.gitContext.isDirty ? " (dirty)" : ""}${RESET}`);
  }

  // ── Build intent from discovery + CLI args ────────────
  const intent: ProjectIntent = {
    id: newId(),
    summary: taskDescription,
    audience: discovered.intent.audience ?? "",
    successCriteria: discovered.intent.successCriteria ?? [],
    constraints: discovered.intent.constraints ?? [],
    vision: discovered.intent.vision ?? "",
    keyDecisions: [],
    driftLog: [],
  };

  // Enrich summary with config summary if task is generic
  if (discovered.intent.summary && taskDescription.split(" ").length <= 3) {
    intent.summary = `${taskDescription} — ${discovered.intent.summary}`;
  }

  // Use saved taste if available, else defaults
  const taste: TasteProfile = discovered.taste ?? DEFAULT_TASTE;

  // Set up Parsifal
  const cortexOpts: ConstructorParameters<typeof Cortex>[0] = {
    intent,
    taste,
    logLevel: flags.logLevel,
  };

  if (flags.autonomous) {
    cortexOpts.parsifa = new AutonomousParsifal(5);
    console.log(`${DIM}Mode: autonomous (budget: 5 escalations)${RESET}\n`);
  }

  const cortex = new Cortex(cortexOpts);

  // Load references from config into the reference store
  if (discovered.references?.length) {
    const refStore = cortex.getBrainstem().getReferenceStore();
    for (const ref of discovered.references) {
      refStore.add(ref.label, ref.value, ref.category as import("./kernel/reference-store.js").ReferenceCategory, "config", ref.detail);
    }
    console.log(`${DIM}Refs:   ${discovered.references.length} loaded from config${RESET}`);
  }

  console.log("");

  // Terminal transport for interactive mode
  if (!flags.autonomous) {
    const terminal = new TerminalTransport();
    const humanParsifal = new HumanParsifal(
      cortex.getBrainstem().getConversationCortex(),
      [terminal],
    );
    cortex.getBrainstem().setParsifal(humanParsifal);
    console.log(`${DIM}Mode: interactive (type to give direction)${RESET}\n`);
  }

  // Dashboard
  if (flags.dashboard) {
    const url = await cortex.startDashboard(flags.dashboardPort);
    console.log(`${CYAN}Dashboard:${RESET} ${url}\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ── Resume or Run ──────────────────────────────────────
  const startTime = Date.now();

  if (flags.resume) {
    // Resume from latest checkpoint
    const checkpointStore = new CheckpointStore();
    const checkpoint = await checkpointStore.latest();

    if (!checkpoint) {
      console.error(`${BOLD}No checkpoints found.${RESET} Run a task first.\n`);
      process.exit(1);
    }

    // Restore session context
    const session = loadSession();
    console.log(`${DIM}Resuming from checkpoint: ${checkpoint.label}${RESET}`);
    console.log(`${DIM}Task: ${checkpoint.taskDescription}${RESET}`);
    if (session) {
      console.log(`${DIM}Original prompt: ${session.prompt}${RESET}`);
    }
    console.log("");

    try {
      const result = await cortex.getBrainstem().runFromCheckpoint(checkpoint);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`\n${BOLD}Resumed${RESET} ${DIM}(${elapsed}s)${RESET}`);
      if ("gateDecision" in result) {
        console.log(`${DIM}Gate: ${result.gateDecision.action}${RESET}`);
      }

      clearSession();
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\n${BOLD}Resume failed${RESET} ${DIM}(${elapsed}s)${RESET}: ${err}`);
      process.exit(1);
    }
  } else {
    // Fresh run — save session for potential resume
    persistSession({
      prompt: taskDescription,
      intent,
      taste,
      worldviewName: "default",
      startedAt: new Date().toISOString(),
    });

    try {
      const result = await cortex.run(taskDescription);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`\n${BOLD}Done${RESET} ${DIM}(${elapsed}s, ${result.cycles} cycle(s), ${(result.confidence * 100).toFixed(0)}% confidence)${RESET}`);
      console.log(`${DIM}Status: ${result.status}${RESET}`);

      if (result.evaluations.length > 0) {
        console.log(`${DIM}Senses: ${result.evaluations.length} evaluated, ${result.tensions.length} tension(s)${RESET}`);
      }

      clearSession();
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\n${BOLD}Failed${RESET} ${DIM}(${elapsed}s)${RESET}: ${err}`);
      console.log(`${DIM}Session saved. Use --resume to continue from last checkpoint.${RESET}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
