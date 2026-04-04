/**
 * Command Router — slash command system for the Cortex CLI.
 *
 * Intercepts lines starting with `/` and dispatches to handlers.
 * Each handler receives the Cortex instance and returns formatted
 * output for the terminal.
 */

import type { Cortex } from "../index.js";
import {
  formatHeader,
  formatEmpty,
  formatKV,
  formatVital,
  formatBar,
  formatInsight,
  formatMaxim,
  formatTable,
  formatTree,
  type TreeNode,
} from "./formatters.js";

// ─── ANSI ─────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

// ─── Types ────────────────────────────────────────────────────

export interface CommandHandler {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  execute(args: string[], cortex: Cortex, write: (line: string) => void): void;
}

// ─── Router ───────────────────────────────────────────────────

export class CommandRouter {
  private commands = new Map<string, CommandHandler>();
  private write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.write = write;
    this.registerAll();
  }

  /** Returns true if the line was a command (consumed). */
  tryExecute(line: string, cortex: Cortex): boolean {
    if (!line.startsWith("/")) return false;

    const parts = line.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    const handler = this.commands.get(name);
    if (!handler) {
      this.write(`  ${RED}Unknown command:${RESET} /${name}. Type ${BOLD}/help${RESET} for available commands.`);
      return true;
    }

    try {
      handler.execute(args, cortex, this.write);
    } catch (err) {
      this.write(`  ${RED}Command error:${RESET} ${err}`);
    }

    return true;
  }

  /** Register a command from outside (e.g., CLI wiring). */
  registerExternal(handler: CommandHandler): void {
    this.register(handler);
  }

  private register(handler: CommandHandler): void {
    this.commands.set(handler.name, handler);
    if (handler.aliases) {
      for (const alias of handler.aliases) {
        this.commands.set(alias, handler);
      }
    }
  }

  private registerAll(): void {
    this.register(helpCommand(this.commands));
    this.register(statusCommand);
    this.register(costCommand);
    this.register(clearCommand);
    this.register(quitCommand);
    this.register(pauseCommand);
    this.register(resumeCommand);
    this.register(awarenessCommand);
    this.register(selfCommand);
    this.register(worldCommand);
    this.register(sensesCommand);
    this.register(principlesCommand);
    this.register(referencesCommand);
    this.register(refCommand);
    this.register(vitalsCommand);
    this.register(memoryCommand);
    this.register(planCommand);
    this.register(tasteCommand);
    this.register(configCommand);
    this.register(worldviewCommand);
  }
}

// ─── System Commands ──────────────────────────────────────────

function helpCommand(commands: Map<string, CommandHandler>): CommandHandler {
  return {
    name: "help",
    aliases: ["h", "?"],
    description: "Show available commands",
    execute(_args, _cortex, write) {
      write(formatHeader("Commands"));

      // Deduplicate (aliases point to same handler)
      const seen = new Set<CommandHandler>();
      const unique: CommandHandler[] = [];
      for (const handler of commands.values()) {
        if (!seen.has(handler)) {
          seen.add(handler);
          unique.push(handler);
        }
      }

      // Group by category
      const system = unique.filter((c) =>
        ["help", "status", "cost", "clear", "quit", "pause", "resume"].includes(c.name));
      const cortex = unique.filter((c) => !system.includes(c));

      write(`\n  ${DIM}System${RESET}`);
      for (const cmd of system) {
        const aliases = cmd.aliases?.length ? ` ${DIM}(${cmd.aliases.map((a) => "/" + a).join(", ")})${RESET}` : "";
        write(`  ${CYAN}/${cmd.name.padEnd(14)}${RESET} ${cmd.description}${aliases}`);
      }

      write(`\n  ${DIM}Cortex${RESET}`);
      for (const cmd of cortex) {
        const aliases = cmd.aliases?.length ? ` ${DIM}(${cmd.aliases.map((a) => "/" + a).join(", ")})${RESET}` : "";
        write(`  ${CYAN}/${cmd.name.padEnd(14)}${RESET} ${cmd.description}${aliases}`);
      }
      write("");
    },
  };
}

const statusCommand: CommandHandler = {
  name: "status",
  aliases: ["s"],
  description: "Current state — phase, task, NE, conviction, vitals",
  execute(_args, cortex, write) {
    const status = cortex.getBrainstem().getConversationCortex().getStatus();
    const vitals = cortex.getVitals();

    write(formatHeader("Status"));
    write(formatKV("Project", status.projectState ?? "idle"));
    write(formatKV("Phase", status.phase ?? "—"));
    write(formatKV("Task", status.task ?? "—"));
    if (status.cycle != null) write(formatKV("Cycle", String(status.cycle)));
    if (status.ne != null) write(formatKV("NE (arousal)", `${(status.ne * 100).toFixed(0)}%`));

    write(`\n  ${DIM}Vitals${RESET}`);
    write(formatVital("WM Load", vitals.workingMemoryLoad));
    write(formatVital("Prediction Accuracy", vitals.predictionAccuracy, { inverse: true }));
    write(formatVital("Budget Utilization", vitals.budgetUtilization));
    write(formatVital("Tonic Dopamine", vitals.tonicDopamine, { inverse: true }));
    write(formatVital("Learning Signal", vitals.learningSignalHealth, { inverse: true }));
    write("");
  },
};

const costCommand: CommandHandler = {
  name: "cost",
  aliases: ["$"],
  description: "Token usage and cost breakdown",
  execute(_args, cortex, write) {
    const summary = cortex.getCostSummary();
    const usage = cortex.getTokenUsage();

    write(formatHeader("Cost"));

    if (summary) {
      write(formatKV("Budget", `$${summary.budget.total.toFixed(2)}`));
      write(formatKV("Spent", `$${summary.spent.toFixed(4)}`));
      write(formatKV("Remaining", `$${summary.remaining.toFixed(4)}`));
      write(formatBar(summary.spent, summary.budget.total, 20, { label: "Utilization" }));
      write(formatKV("Total calls", String(summary.totalCalls)));
    } else {
      write(formatEmpty("No budget set."));
    }

    if (usage) {
      write(`\n  ${DIM}Token Usage${RESET}`);
      const entries = Object.entries(usage as Record<string, unknown>);
      if (entries.length > 0) {
        for (const [key, val] of entries) {
          if (typeof val === "number") {
            write(formatKV(key, val.toLocaleString()));
          }
        }
      }
    }
    write("");
  },
};

const clearCommand: CommandHandler = {
  name: "clear",
  description: "Clear the terminal screen",
  execute(_args, _cortex, write) {
    process.stdout.write("\x1b[2J\x1b[H");
  },
};

const quitCommand: CommandHandler = {
  name: "quit",
  aliases: ["q", "exit"],
  description: "Exit gracefully",
  execute(_args, _cortex, write) {
    write(`  ${DIM}Goodbye.${RESET}\n`);
    process.exit(0);
  },
};

const pauseCommand: CommandHandler = {
  name: "pause",
  description: "Pause the current rhythm",
  execute(_args, cortex, write) {
    const runner = cortex.getBrainstem().getRunner();
    const rhythms = runner.getActiveRhythms();

    if (rhythms.length === 0) {
      write(formatEmpty("Nothing running to pause."));
      return;
    }

    runner.interrupt(rhythms[rhythms.length - 1], {
      mode: "hard",
      source: "cli-command",
      reason: "Paused via /pause command",
      context: { command: "pause" },
    });
    write(`  ${YELLOW}Paused.${RESET} Use ${BOLD}/resume${RESET} to continue.`);
  },
};

const resumeCommand: CommandHandler = {
  name: "resume",
  description: "Resume from pause",
  execute(_args, cortex, write) {
    const handler = cortex.getBrainstem().getEscalationHandler();
    const active = handler.getActive();

    if (active.length === 0) {
      write(formatEmpty("Nothing paused to resume."));
      return;
    }

    handler.resolve(active[0].id, {
      answer: "Resumed via /resume command",
      resolvedAt: new Date(),
    });
    write(`  ${GREEN}Resumed.${RESET}`);
  },
};

// ─── Cortex Commands ──────────────────────────────────────────

const awarenessCommand: CommandHandler = {
  name: "awareness",
  aliases: ["a", "stream"],
  description: "Stream of awareness — what Claus has noticed",
  execute(_args, cortex, write) {
    const insights = cortex.getBrainstem().getThalamus().getAwareness();

    write(formatHeader("Stream of Awareness"));

    if (insights.length === 0) {
      write(formatEmpty("No awareness insights yet. The stream fills as the system works."));
      write("");
      return;
    }

    write(`  ${DIM}${insights.length} insight(s)${RESET}\n`);
    for (const insight of insights.slice(-15)) {
      write(formatInsight(insight));
    }
    write("");
  },
};

const selfCommand: CommandHandler = {
  name: "self",
  aliases: ["identity", "who"],
  description: "Self-model — what Claus knows about itself",
  execute(_args, cortex, write) {
    const wm = cortex.getBrainstem().getWorldModel();
    const maxims = wm?.getSelfMaxims() ?? [];
    const narratives = wm?.getSelfNarratives() ?? [];

    write(formatHeader("Self-Knowledge"));

    if (maxims.length === 0 && narratives.length === 0) {
      write(formatEmpty("No self-knowledge yet. Identity develops through experience."));
      write("");
      return;
    }

    if (maxims.length > 0) {
      write(`\n  ${DIM}Maxims (${maxims.length})${RESET}`);
      for (let i = 0; i < maxims.length; i++) {
        write(formatMaxim({
          statement: maxims[i].statement,
          cognitive: maxims[i].cognitive,
          axiological: maxims[i].axiological,
          volitional: maxims[i].volitional,
          confidence: maxims[i].confidence,
        }, i));
      }
    }

    if (narratives.length > 0) {
      write(`\n  ${DIM}Narratives (${narratives.length})${RESET}`);
      for (const n of narratives) {
        write(`  ${MAGENTA}│${RESET} ${n.narrative}`);
      }
    }
    write("");
  },
};

const worldCommand: CommandHandler = {
  name: "world",
  aliases: ["w", "maxims"],
  description: "World model — Cortex's understanding",
  execute(_args, cortex, write) {
    const wm = cortex.getBrainstem().getWorldModel();
    const welt = wm?.getWeltanschauung();

    write(formatHeader("World Model"));

    if (!welt) {
      write(formatEmpty("No world model synthesized yet."));
      write("");
      return;
    }

    if (welt.crossProject.length > 0) {
      write(`\n  ${DIM}Cross-Project (${welt.crossProject.length})${RESET}`);
      for (let i = 0; i < welt.crossProject.length; i++) {
        write(formatMaxim(welt.crossProject[i], i));
      }
    }

    if (welt.perProject.length > 0) {
      write(`\n  ${DIM}Per-Project (${welt.perProject.length})${RESET}`);
      for (let i = 0; i < welt.perProject.length; i++) {
        write(formatMaxim(welt.perProject[i], i));
      }
    }

    write(`\n  ${DIM}Last synthesized: ${welt.synthesizedAt.toLocaleString()} (trigger: ${welt.trigger})${RESET}`);
    write("");
  },
};

const sensesCommand: CommandHandler = {
  name: "senses",
  description: "Active senses and recent trends",
  execute(_args, cortex, write) {
    const library = cortex.getLibrary();
    const senses = library.getSenses();
    const trends = cortex.getWorkingMemory().getSenseTrends();

    write(formatHeader("Senses"));

    const rows: string[][] = [];
    for (const sense of senses) {
      const trend = trends.find((t) => t.id === sense.id || t.label === sense.name);
      const dir = trend ? (
        trend.direction === "up" ? `${GREEN}↑${RESET}` :
        trend.direction === "down" ? `${RED}↓${RESET}` :
        `${DIM}→${RESET}`
      ) : `${DIM}—${RESET}`;
      const mean = trend ? trend.currentMean.toFixed(1) : "—";
      rows.push([sense.name, dir, mean, `${DIM}${sense.id}${RESET}`]);
    }

    write(formatTable(rows, ["Sense", "Trend", "Mean", "ID"]));
    write("");
  },
};

const principlesCommand: CommandHandler = {
  name: "principles",
  aliases: ["p", "learned"],
  description: "Learned principles from experience",
  execute(_args, cortex, write) {
    const hippocampus = cortex.getBrainstem().getHippocampus();
    const principles = hippocampus.getActivePrinciples();

    write(formatHeader("Principles"));

    if (principles.length === 0) {
      write(formatEmpty("No principles crystallized yet. Learning happens through experience."));
      write("");
      return;
    }

    write(`  ${DIM}${principles.length} principle(s)${RESET}\n`);
    for (const p of principles) {
      const conf = `${DIM}(${(p.confidence * 100).toFixed(0)}%)${RESET}`;
      const senses = p.relevantSenses.length > 0
        ? `${DIM}[${p.relevantSenses.join(", ")}]${RESET}` : "";
      write(`  ${BOLD}•${RESET} ${p.statement} ${conf} ${senses}`);
    }
    write("");
  },
};

const referencesCommand: CommandHandler = {
  name: "references",
  aliases: ["refs"],
  description: "External system references",
  execute(_args, cortex, write) {
    const store = cortex.getBrainstem().getReferenceStore();
    const refs = store.getAll();

    write(formatHeader("References"));

    if (refs.length === 0) {
      write(formatEmpty("No references stored. Use /ref add <label> <value> to add one."));
      write("");
      return;
    }

    const rows = refs.map((r) => [
      `${CYAN}${r.category}${RESET}`,
      r.label,
      r.value,
      r.detail ?? "",
    ]);
    write(formatTable(rows, ["Category", "Label", "Value", "Detail"]));
    write("");
  },
};

const refCommand: CommandHandler = {
  name: "ref",
  description: "Manage references: /ref add <label> <value> [category]",
  usage: "/ref add \"Bug Tracker\" https://linear.app issue-tracker",
  execute(args, cortex, write) {
    if (args.length < 1) {
      write(`  Usage: ${BOLD}/ref add <label> <value> [category]${RESET}`);
      write(`  Usage: ${BOLD}/ref remove <label>${RESET}`);
      return;
    }

    const subcommand = args[0].toLowerCase();
    const store = cortex.getBrainstem().getReferenceStore();

    if (subcommand === "add") {
      if (args.length < 3) {
        write(`  Usage: ${BOLD}/ref add <label> <value> [category]${RESET}`);
        return;
      }
      const label = args[1];
      const value = args[2];
      const category = (args[3] ?? "other") as import("../kernel/reference-store.js").ReferenceCategory;
      store.add(label, value, category, "api");
      write(`  ${GREEN}Added:${RESET} ${label} → ${value} [${category}]`);
    } else if (subcommand === "remove" || subcommand === "rm") {
      const label = args.slice(1).join(" ");
      const refs = store.getAll();
      const match = refs.find((r) => r.label.toLowerCase() === label.toLowerCase());
      if (match) {
        store.remove(match.id);
        write(`  ${YELLOW}Removed:${RESET} ${match.label}`);
      } else {
        write(formatEmpty(`No reference found matching "${label}".`));
      }
    } else {
      write(`  Unknown subcommand: ${subcommand}. Use ${BOLD}add${RESET} or ${BOLD}remove${RESET}.`);
    }
  },
};

const vitalsCommand: CommandHandler = {
  name: "vitals",
  aliases: ["v", "health"],
  description: "All vital signs with thresholds",
  execute(_args, cortex, write) {
    const vitals = cortex.getVitals();

    write(formatHeader("Vital Signs"));
    write(formatVital("Working Memory Load", vitals.workingMemoryLoad));
    write(formatVital("Prediction Accuracy", vitals.predictionAccuracy, { inverse: true }));
    write(formatVital("Context Capacity", vitals.contextCapacity));
    write(formatVital("Budget Utilization", vitals.budgetUtilization));
    write(formatVital("Learning Signal", vitals.learningSignalHealth, { inverse: true }));
    write(formatVital("Weight Volatility", vitals.weightVolatility));
    write(formatVital("Weight Displacement", vitals.weightDisplacement));
    write(formatVital("Tonic Dopamine", vitals.tonicDopamine, { inverse: true }));
    write("");
  },
};

const memoryCommand: CommandHandler = {
  name: "memory",
  aliases: ["m", "wm"],
  description: "Working memory — load, patterns, questions",
  execute(_args, cortex, write) {
    const wm = cortex.getWorkingMemory();
    const patterns = wm.getPatterns();
    const questions = wm.getOpenQuestions();
    const completed = wm.getCompletedSummaries();

    write(formatHeader("Working Memory"));
    write(formatBar(wm.getLoad(), 1, 20, { label: "Load" }));
    write(formatKV("Tasks completed", String(completed.length)));
    write(formatKV("Open questions", String(questions.filter((q: any) => !q.resolved).length)));
    write(formatKV("Patterns", String(patterns.length)));

    if (patterns.length > 0) {
      write(`\n  ${DIM}Patterns${RESET}`);
      for (const p of patterns.slice(-5)) {
        write(`  ${DIM}•${RESET} ${p.description} ${DIM}(${(p.confidence * 100).toFixed(0)}%)${RESET}`);
      }
    }

    if (questions.length > 0) {
      const unresolved = questions.filter((q: any) => !q.resolved);
      if (unresolved.length > 0) {
        write(`\n  ${DIM}Open Questions${RESET}`);
        for (const q of unresolved.slice(-5)) {
          write(`  ${YELLOW}?${RESET} ${q.question}`);
        }
      }
    }
    write("");
  },
};

const planCommand: CommandHandler = {
  name: "plan",
  description: "Current task graph / plan",
  execute(_args, cortex, write) {
    const wm = cortex.getWorkingMemory();
    const tasks = wm.getTasks();

    write(formatHeader("Plan"));

    if (tasks.length === 0) {
      write(formatEmpty("No tasks in the plan."));
      write("");
      return;
    }

    const nodes: TreeNode[] = tasks.map((t: any) => ({
      label: t.description || t.id,
      status: t.status === "complete" ? "complete"
        : t.status === "failed" ? "escalated"
        : t.id === wm.getCurrentTaskId() ? "active"
        : "pending",
    }));

    write(formatTree(nodes));
    write("");
  },
};

const tasteCommand: CommandHandler = {
  name: "taste",
  description: "Current taste profile (aesthetic preferences)",
  execute(_args, cortex, write) {
    const taste = cortex.getTaste();

    write(formatHeader("Taste Profile"));
    write(formatKV("Name", taste.name));
    if (taste.visual) write(formatKV("Visual", taste.visual));
    if (taste.decisionStyle) write(formatKV("Decisions", taste.decisionStyle));
    if (taste.communication) write(formatKV("Communication", taste.communication));
    if (taste.patterns) write(formatKV("Patterns", taste.patterns));

    const rawEntries = Object.entries(taste.raw);
    if (rawEntries.length > 0) {
      write(`\n  ${DIM}Custom fields${RESET}`);
      for (const [key, val] of rawEntries) {
        write(formatKV(key, val));
      }
    }
    write("");
  },
};

const configCommand: CommandHandler = {
  name: "config",
  description: "Current Cortex configuration",
  execute(_args, cortex, write) {
    const config = cortex.getConfig();

    write(formatHeader("Configuration"));
    write(formatKV("Max cycles", String(config.maxCycles)));
    write(formatKV("Max outer cycles", String(config.maxOuterCycles)));
    write(formatKV("Improvement thresh", config.improvementThreshold.toFixed(2)));
    write(formatKV("Delegation", config.enableDelegation ? "enabled" : "disabled"));

    write(`\n  ${DIM}Models${RESET}`);
    write(formatKV("Consultation", config.models.consultation));
    write(formatKV("Motor", config.models.motorCortex));
    write(formatKV("Evaluation", config.models.evaluation));
    if (config.models.premotor) write(formatKV("Premotor", config.models.premotor));
    write("");
  },
};

// ─── Worldview Command ────────────────────────────────────────

const WORLDVIEW_DESCRIPTIONS: Record<string, string> = {
  shaela: "Questions to be lived — hermeneutic epistemology",
  project: "Forces to be resolved — engineering epistemology",
  hybrid: "Engineering questions with deliverable answers — pragmatic",
  covenant: "Commitments honored — relational epistemology",
  groove: "Play seriously — improvisational epistemology",
  ecosystem: "Cultivate living systems — ecological epistemology",
  dialectic: "Contradiction drives progress — dialectical epistemology",
  cartograph: "Map unknown territory — exploratory epistemology",
  sculptor: "Remove what doesn't belong — subtractive epistemology",
  narrative: "Tell the story — narrative epistemology",
};

const worldviewCommand: CommandHandler = {
  name: "worldview",
  aliases: ["wv"],
  description: "Current worldview + list available worldviews",
  usage: "/worldview — show current. /worldview list — show all. /worldview set <name> — change (next run).",
  execute(args, cortex, write) {
    const current = cortex.getWorldview();

    if (args.length === 0 || args[0] === "show") {
      // Show current worldview
      write(formatHeader("Worldview: " + current.name));
      write(formatKV("Name", current.name));
      if (current.description) write(formatKV("Description", current.description));
      write(formatKV("System name", current.systemName));
      write(formatKV("Entity name", current.entityName));
      write(formatKV("Voice name", current.voiceName));

      write(`\n  ${DIM}Vocabulary${RESET}`);
      write(formatKV("Top unit", `${current.vocabulary.topUnit.singular} / ${current.vocabulary.topUnit.plural}`));
      write(formatKV("Leaf unit", `${current.vocabulary.leafUnit.singular} / ${current.vocabulary.leafUnit.plural}`));
      write(formatKV("Artifact", `${current.vocabulary.artifact.singular} / ${current.vocabulary.artifact.plural}`));
      write(formatKV("Decompose verb", current.vocabulary.decomposeVerb));

      write(`\n  ${DIM}Preamble${RESET}`);
      // Wrap preamble to reasonable width
      const preambleLines = current.preamble.split(/\s+/).reduce((lines: string[], word) => {
        const last = lines[lines.length - 1];
        if (last && last.length + word.length + 1 <= 70) {
          lines[lines.length - 1] = `${last} ${word}`;
        } else {
          lines.push(word);
        }
        return lines;
      }, []);
      for (const line of preambleLines) {
        write(`  ${DIM}${line}${RESET}`);
      }

      // Show loaded frames
      const frameNames = Object.keys(current.frames).filter(
        (k) => !!(current.frames as Record<string, string>)[k],
      );
      if (frameNames.length > 0) {
        write(`\n  ${DIM}Frames loaded (${frameNames.length}):${RESET} ${frameNames.join(", ")}`);
      }
      write("");
      return;
    }

    if (args[0] === "list" || args[0] === "ls") {
      write(formatHeader("Available Worldviews"));
      write("");

      for (const [name, desc] of Object.entries(WORLDVIEW_DESCRIPTIONS)) {
        const marker = name === current.name ? `${GREEN}▸${RESET}` : " ";
        const label = name === current.name ? `${BOLD}${name}${RESET}` : name;
        write(`  ${marker} ${label.padEnd(name === current.name ? name.length + 8 : 14)} ${DIM}${desc}${RESET}`);
      }

      write(`\n  ${DIM}To change: restart with --worldview <name>${RESET}`);
      write(`  ${DIM}Or set in .cortex/config.json: { "worldview": "<name>" }${RESET}`);
      write("");
      return;
    }

    if (args[0] === "set") {
      const name = args[1]?.toLowerCase();
      if (!name || !WORLDVIEW_DESCRIPTIONS[name]) {
        write(`  ${RED}Unknown worldview:${RESET} ${name ?? "(none)"}`);
        write(`  ${DIM}Available: ${Object.keys(WORLDVIEW_DESCRIPTIONS).join(", ")}${RESET}`);
        return;
      }

      // Can't change mid-session — worldview is structural
      write(`  ${YELLOW}Worldview cannot be changed mid-session${RESET} — it shapes every cognitive act.`);
      write(`  To use the ${BOLD}${name}${RESET} worldview, restart with:`);
      write(`    ${CYAN}cortex --worldview ${name} "your task"${RESET}`);
      write(`  Or set in .cortex/config.json: ${CYAN}{ "worldview": "${name}" }${RESET}`);
      write("");
      return;
    }

    write(`  Unknown subcommand: ${args[0]}. Use ${BOLD}/worldview${RESET}, ${BOLD}/worldview list${RESET}, or ${BOLD}/worldview set <name>${RESET}.`);
  },
};
