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

// ─── Arg parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);

const flags = {
  autonomous: false,
  dashboard: false,
  dashboardPort: 3000,
  logLevel: "warn" as "info" | "warn" | "debug",
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
  } else if (arg === "--debug") {
    flags.logLevel = "debug";
  } else if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (!arg.startsWith("-")) {
    positional.push(arg);
  }
}

if (flags.help || positional.length === 0) {
  console.log(`
  Agent Cortex — a software engineer that solves problems.

  Usage:
    cortex "fix the auth bug"              Run a task interactively
    cortex --autonomous "build the API"    Run without human input
    cortex --dashboard "build the hero"    Run with live dashboard

  Options:
    -a, --autonomous   Run without Parsifal input (bounded autonomy)
    -d, --dashboard    Start the live dashboard
    -p, --port <n>     Dashboard port (default 3000)
    -v, --verbose      Show info-level logs
    --debug            Show debug-level logs
    -h, --help         Show this help
  `);
  process.exit(flags.help ? 0 : 1);
}

const taskDescription = positional.join(" ");

// ─── Minimal intent + taste ─────────────────────────────────

const intent: ProjectIntent = {
  id: newId(),
  summary: taskDescription,
  audience: "",
  successCriteria: [],
  constraints: [],
  vision: "",
  keyDecisions: [],
  driftLog: [],
};

const taste: TasteProfile = {
  id: "cli-defaults",
  name: "CLI defaults",
  visual: "",
  decisionStyle: "Prefers simple over clever. Ships good over perfects great.",
  communication: "Terse updates. Don't over-explain.",
  patterns: "",
  raw: {},
};

// ─── Run ──────────────────────────────────────────────────────

async function main() {
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const CYAN = "\x1b[36m";

  console.log(`\n${BOLD}cortex${RESET} ${DIM}—${RESET} ${taskDescription}\n`);

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

  // Run
  const startTime = Date.now();

  try {
    const result = await cortex.run(taskDescription);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n${BOLD}Done${RESET} ${DIM}(${elapsed}s, ${result.cycles} cycle(s), ${(result.confidence * 100).toFixed(0)}% confidence)${RESET}`);
    console.log(`${DIM}Status: ${result.status}${RESET}`);

    if (result.evaluations.length > 0) {
      console.log(`${DIM}Senses: ${result.evaluations.length} evaluated, ${result.tensions.length} tension(s)${RESET}`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n${BOLD}Failed${RESET} ${DIM}(${elapsed}s)${RESET}: ${err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
