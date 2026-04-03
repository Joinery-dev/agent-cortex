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
import type { Worldview } from "./types/worldview.js";
import {
  SHAELA_WORLDVIEW, PROJECT_WORLDVIEW, HYBRID_WORLDVIEW,
  COVENANT_WORLDVIEW, GROOVE_WORLDVIEW, ECOSYSTEM_WORLDVIEW,
  DIALECTIC_WORLDVIEW, CARTOGRAPH_WORLDVIEW, SCULPTOR_WORLDVIEW,
  NARRATIVE_WORLDVIEW,
} from "./types/worldview.js";
import { RichTerminalTransport } from "./conversation/rich-terminal-transport.js";
import { HumanParsifal } from "./kernel/human-parsifal.js";
import { AutonomousParsifal } from "./kernel/autonomous-parsifal.js";
import { newId } from "./util/ids.js";
import { discoverProjectContext } from "./cli/project-context.js";
import { persistSession, loadSession, clearSession } from "./session/state.js";
import { CommandRouter } from "./cli/commands.js";
import { CheckpointStore } from "./trace/checkpoint-store.js";

// ─── Arg parsing ──────────────────────────────────────────────

const args = process.argv.slice(2);

const flags = {
  autonomous: false,
  dashboard: false,
  dashboardPort: 3000,
  logLevel: "warn" as "info" | "warn" | "debug",
  resume: false,
  worldview: "" as string,
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
  } else if (arg === "--worldview" || arg === "-w") {
    flags.worldview = args[++i] ?? "";
  } else if (arg === "--debug") {
    flags.logLevel = "debug";
  } else if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (!arg.startsWith("-")) {
    positional.push(arg);
  }
}

if (flags.help) {
  console.log(`
  Agent Cortex — a software engineer that solves problems.

  Usage:
    cortex                                 Start interactive session
    cortex "fix the auth bug"              Run a task interactively
    cortex --autonomous "build the API"    Run without human input
    cortex --dashboard "build the hero"    Run with live dashboard
    cortex --resume                        Resume from last checkpoint

  Options:
    -a, --autonomous   Run without Parsifal input (bounded autonomy)
    -d, --dashboard    Start the live dashboard
    -r, --resume       Resume from the latest checkpoint
    -w, --worldview <name>  Set worldview (shaela, project, hybrid, groove, etc.)
    -p, --port <n>     Dashboard port (default 3000)
    -v, --verbose      Show info-level logs
    --debug            Show debug-level logs
    -h, --help         Show this help
  `);
  process.exit(0);
}

const taskDescription = positional.join(" ");
const interactiveMode = !taskDescription && !flags.resume;

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
  // Set log level FIRST — before anything creates loggers
  const { setLogLevel } = await import("./util/logger.js");
  setLogLevel(flags.logLevel);

  // ── Discover project context (no LLM calls) ──────────
  const discovered = await discoverProjectContext(process.cwd());

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

  // Resolve worldview
  const WORLDVIEWS: Record<string, Worldview> = {
    shaela: SHAELA_WORLDVIEW, project: PROJECT_WORLDVIEW, hybrid: HYBRID_WORLDVIEW,
    covenant: COVENANT_WORLDVIEW, groove: GROOVE_WORLDVIEW, ecosystem: ECOSYSTEM_WORLDVIEW,
    dialectic: DIALECTIC_WORLDVIEW, cartograph: CARTOGRAPH_WORLDVIEW, sculptor: SCULPTOR_WORLDVIEW,
    narrative: NARRATIVE_WORLDVIEW,
  };

  const worldview = flags.worldview
    ? WORLDVIEWS[flags.worldview.toLowerCase()]
    : undefined;

  if (flags.worldview && !worldview) {
    console.error(`${BOLD}Unknown worldview:${RESET} ${flags.worldview}`);
    console.error(`${DIM}Available: ${Object.keys(WORLDVIEWS).join(", ")}${RESET}`);
    process.exit(1);
  }

  if (worldview) {
    console.log(`${DIM}Worldview: ${worldview.name}${RESET}`);
  }

  // Set up Parsifal
  const cortexOpts: ConstructorParameters<typeof Cortex>[0] = {
    intent,
    taste,
    logLevel: flags.logLevel,
    worldview,
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

  // ── Load persistent stores early for warm greeting ──────
  const brainstem = cortex.getBrainstem();
  await brainstem.getHippocampus().load();
  await brainstem.getWorldModel().load();
  await brainstem.getReferenceStore().load();

  // ── Gather context for greeting ────────────────────────
  const hippocampus = brainstem.getHippocampus();
  const worldModel = brainstem.getWorldModel();
  const selfMaxims = worldModel.getSelfMaxims();
  const selfNarratives = worldModel.getSelfNarratives();
  const principles = hippocampus.getActivePrinciples();
  const episodeCount = hippocampus.getEpisodeCount();
  const lastSession = loadSession();
  const refs = brainstem.getReferenceStore().getAll();

  // Terminal transport + command router for interactive mode
  if (!flags.autonomous) {
    const terminal = new RichTerminalTransport();

    // Welcome screen with brain + context-aware greeting
    terminal.showWelcome(worldview?.name, discovered.techStack, {
      gitContext: discovered.gitContext,
      lastSession,
      selfMaxims: selfMaxims.map((m) => m.statement),
      selfNarratives: selfNarratives.map((n) => n.narrative),
      principleCount: principles.length,
      episodeCount,
      referenceCount: refs.length,
      tasteName: taste.name,
      preamble: worldview?.preamble,
    });

    // Command router intercepts /commands before they reach conversation
    const router = new CommandRouter((line) => {
      process.stdout.write(`\r\x1b[K${line}\n`);
    });

    // Wrap the transport's receive handler to intercept commands
    const conversationCortex = cortex.getBrainstem().getConversationCortex();
    terminal.onReceive((text) => {
      if (text.startsWith("/") && router.tryExecute(text, cortex)) {
        return; // Command consumed
      }
      conversationCortex.receive(text);
    });

    const humanParsifal = new HumanParsifal(conversationCortex, [terminal]);
    cortex.getBrainstem().setParsifal(humanParsifal);

    // Ctrl+C → soft interrupt
    process.on("SIGINT", () => {
      const runner = cortex.getBrainstem().getRunner();
      const rhythms = runner.getActiveRhythms();
      if (rhythms.length > 0) {
        runner.interrupt(rhythms[rhythms.length - 1], {
          mode: "soft",
          source: "cli-sigint",
          reason: "Ctrl+C pressed",
          context: { signal: "SIGINT" },
        });
        console.log(`\n${DIM}  Interrupting... (press again to force quit)${RESET}`);

        // Second Ctrl+C → hard exit
        process.once("SIGINT", () => {
          console.log(`\n${DIM}  Force quit.${RESET}`);
          process.exit(130);
        });
      } else {
        console.log(`\n${DIM}  Goodbye.${RESET}`);
        process.exit(0);
      }
    });
  }

  // Dashboard
  if (flags.dashboard) {
    const url = await cortex.startDashboard(flags.dashboardPort);
    console.log(`${CYAN}Dashboard:${RESET} ${url}\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ── Interactive, Resume, or Run ─────────────────────────
  const startTime = Date.now();

  if (interactiveMode) {
    // No task — just start up and wait for direction.
    // The Parsifal types, Claus responds, commands work.
    console.log(`  ${DIM}Type a task to start working, or /help for commands.${RESET}\n`);

    // Keep the process alive — readline keeps the event loop open.
    // When the user types a task, it flows through ConversationCortex
    // as a Parsifal message. For now, they can also use /quit to exit.
    await new Promise<void>(() => {
      // Never resolves — process stays alive until /quit or Ctrl+C
    });
  } else if (flags.resume) {
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
      worldviewName: worldview?.name ?? "default",
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
