/**
 * Rich Terminal Transport — Claude Code-quality terminal UI for Claus.
 *
 * Visual features:
 *   - Pixelated brain ASCII art on startup
 *   - Framed message blocks (box-drawing characters)
 *   - Spinner animation while thinking
 *   - Clean input area with separator
 *   - Status bar in terminal title
 *   - Syntax-aware markdown rendering
 *   - Compact narration with phase indicators
 *   - Tool call display blocks
 */

import { createInterface, type Interface } from "readline";
import type {
  ConversationTransport,
  ConversationMessage,
  NarrationItem,
  SystemStatus,
  PlanSnapshot,
  ArtifactItem,
} from "../types/conversation.js";

// ─── ANSI ─────────────────────────────────────────────────────

const R = "\x1b[0m";       // reset
const B = "\x1b[1m";       // bold
const D = "\x1b[2m";       // dim
const I = "\x1b[3m";       // italic
const UL = "\x1b[4m";      // underline

const BLK = "\x1b[30m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YLW = "\x1b[33m";
const BLU = "\x1b[34m";
const MAG = "\x1b[35m";
const CYN = "\x1b[36m";
const WHT = "\x1b[37m";
const GRY = "\x1b[90m";

const BG_BLU = "\x1b[44m";
const BG_GRN = "\x1b[42m";
const BG_YLW = "\x1b[43m";
const BG_RED = "\x1b[41m";
const BG_MAG = "\x1b[45m";
const BG_CYN = "\x1b[46m";

const CLR = "\r\x1b[K";

// ─── Welcome Context ──────────────────────────────────────────

export interface WelcomeContext {
  gitContext?: { branch: string; recentCommits: string[]; isDirty: boolean } | null;
  lastSession?: { prompt: string; startedAt: string } | null;
  selfMaxims: string[];
  selfNarratives: string[];
  principleCount: number;
  episodeCount: number;
  referenceCount: number;
  tasteName?: string;
  preamble?: string;
}

// ─── Brain ASCII Art ──────────────────────────────────────────

const BRAIN = `
${D}        ██████████          ${R}
${D}      ██${R}${MAG}░░░░░░░░░░${R}${D}██        ${R}
${D}    ██${R}${MAG}░░${R}${D}██${R}${MAG}░░░░${R}${D}██${R}${MAG}░░${R}${D}██      ${R}
${D}   ██${R}${MAG}░░${R}${D}██${R}${MAG}░░░░░░${R}${D}██${R}${MAG}░░${R}${D}██     ${R}
${D}  ██${R}${MAG}░░░░░░░░${R}${D}██${R}${MAG}░░░░░░${R}${D}██    ${R}
${D}  ██${R}${MAG}░░░░░░${R}${D}██${R}${MAG}░░░░░░░░${R}${D}██    ${R}
${D}  ██${R}${MAG}░░░░${R}${D}██${R}${MAG}░░░░░░${R}${D}██${R}${MAG}░░${R}${D}██    ${R}
${D}   ██${R}${MAG}░░░░░░░░░░${R}${D}██${R}${MAG}░░${R}${D}██     ${R}
${D}    ██${R}${MAG}░░░░░░░░░░░░${R}${D}██      ${R}
${D}      ██${R}${MAG}░░░░░░░░${R}${D}██        ${R}
${D}        ██████████          ${R}`;

// ─── Box Drawing ──────────────────────────────────────────────

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  ltee: "├", rtee: "┤",
};

function boxTop(label: string, color: string, width: number): string {
  const labelStr = ` ${label} `;
  const lineLen = Math.max(0, width - labelStr.length - 4);
  return `  ${color}${BOX.tl}${BOX.h}${R}${color}${B}${labelStr}${R}${color}${BOX.h.repeat(lineLen)}${BOX.tr}${R}`;
}

function boxLine(text: string, color: string, width: number): string {
  const stripped = stripAnsi(text);
  const pad = Math.max(0, width - stripped.length - 6);
  return `  ${color}${BOX.v}${R} ${text}${" ".repeat(pad)} ${color}${BOX.v}${R}`;
}

function boxBottom(color: string, width: number): string {
  return `  ${color}${BOX.bl}${BOX.h.repeat(width - 4)}${BOX.br}${R}`;
}

function boxWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 100) - 2;
}

// ─── Markdown-ish Formatting ──────────────────────────────────

function formatMd(text: string): string {
  return text
    // Code blocks → dim with language hint
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const header = lang ? `${GRY}── ${lang} ──${R}\n` : "";
      return `${header}${D}${code.trim()}${R}`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, `${CYN}${D}$1${R}`)
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`)
    // Italic
    .replace(/\*([^*]+)\*/g, `${I}$1${R}`)
    // Bullets
    .replace(/^- (.+)$/gm, `  ${GRY}•${R} $1`)
    // Headers
    .replace(/^### (.+)$/gm, `${B}$1${R}`)
    .replace(/^## (.+)$/gm, `\n${B}$1${R}`)
    .replace(/^# (.+)$/gm, `\n${B}${UL}$1${R}`);
}

// ─── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private message: string;

  constructor(message = "thinking") {
    this.message = message;
  }

  start(): void {
    if (this.interval) return;
    this.frame = 0;
    this.interval = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      process.stdout.write(`${CLR}  ${MAG}${f}${R} ${D}${this.message}${R}`);
      this.frame++;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write(`${CLR}`);
    }
  }
}

// ─── Status State ─────────────────────────────────────────────

interface StatusState {
  phase?: string;
  task?: string;
  cycle?: number;
  projectState?: string;
  ne?: number;
}

// ─── Transport ────────────────────────────────────────────────

export class RichTerminalTransport implements ConversationTransport {
  private rl: Interface;
  private handler: ((text: string) => void) | null = null;
  private closed = false;
  private status: StatusState = {};
  private spinner = new Spinner();
  private thinkingActive = false;
  private output: NodeJS.WritableStream;

  constructor(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
    this.output = opts?.output ?? process.stdout;

    this.rl = createInterface({
      input: opts?.input ?? process.stdin,
      output: this.output,
      prompt: "",
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (this.handler) {
        this.handler(trimmed);
      }
    });

    this.rl.on("close", () => {
      this.closed = true;
      this.spinner.stop();
    });
  }

  /** Print the brain logo and context-aware greeting. */
  showWelcome(worldviewName?: string, techStack?: string[], context?: WelcomeContext): void {
    for (const line of BRAIN.split("\n")) {
      this.write(line);
    }
    this.write("");
    this.write(`  ${B}Agent Cortex${R}`);

    // Subtitle line — worldview + stack
    const subtitle: string[] = [];
    if (worldviewName) subtitle.push(worldviewName);
    if (techStack && techStack.length > 0) subtitle.push(techStack.join(", "));
    if (subtitle.length > 0) {
      this.write(`  ${D}${subtitle.join(" · ")}${R}`);
    }
    this.write("");

    // ── Context-aware greeting ────────────────────────
    if (context) {
      // Time-of-day greeting
      const hour = new Date().getHours();
      const timeGreeting = hour < 6 ? "Late night."
        : hour < 12 ? "Good morning."
        : hour < 17 ? "Good afternoon."
        : hour < 21 ? "Good evening."
        : "Late night.";

      // Git awareness
      const gitLine = context.gitContext
        ? `${D}On ${B}${context.gitContext.branch}${R}${D}${context.gitContext.isDirty ? ` with uncommitted changes` : ""}${context.gitContext.recentCommits.length > 0 ? `. Last commit: ${context.gitContext.recentCommits[0]}` : ""}.${R}`
        : null;

      // Session recall
      const sessionLine = context.lastSession
        ? `${D}Last session: "${context.lastSession.prompt}"${R}`
        : null;

      // Self-knowledge summary
      const selfLine = context.selfMaxims.length > 0
        ? `${D}I know ${context.selfMaxims.length} thing${context.selfMaxims.length === 1 ? "" : "s"} about myself${context.principleCount > 0 ? ` and ${context.principleCount} principle${context.principleCount === 1 ? "" : "s"} from experience` : ""}.${R}`
        : context.episodeCount > 0
          ? `${D}${context.episodeCount} episode${context.episodeCount === 1 ? "" : "s"} from past work.${R}`
          : null;

      // Most prominent self-maxim
      const topMaxim = context.selfMaxims.length > 0
        ? `${D}${I}"${context.selfMaxims[0]}"${R}`
        : null;

      // Render greeting block
      this.write(`  ${timeGreeting}`);
      if (gitLine) this.write(`  ${gitLine}`);
      if (sessionLine) this.write(`  ${sessionLine}`);
      if (selfLine) this.write(`  ${selfLine}`);
      if (topMaxim) this.write(`  ${topMaxim}`);

      if (context.referenceCount > 0) {
        this.write(`  ${D}${context.referenceCount} reference${context.referenceCount === 1 ? "" : "s"} loaded.${R}`);
      }
    }

    this.write("");
    this.write(`  ${D}/help for commands${R}`);
    this.write("");
    this.writeSeparator();
  }

  sendMessage(msg: ConversationMessage): void {
    if (this.closed) return;
    this.stopThinking();

    if (msg.role === "parsifal") {
      // Don't display — readline already showed the input
      return;
    }

    const w = boxWidth();

    switch (msg.kind) {
      case "question": {
        // Questions get a prominent framed box
        this.write("");
        this.write(boxTop("claus asks", MAG, w));
        for (const line of formatMd(msg.text).split("\n")) {
          this.write(boxLine(line, MAG, w));
        }
        this.write(boxLine("", MAG, w));
        this.write(boxLine(`${D}(type your answer below)${R}`, MAG, w));
        this.write(boxBottom(MAG, w));
        this.write("");
        break;
      }

      case "proactive": {
        // Proactive insights — yellow box
        this.write("");
        this.write(boxTop("💡 claus noticed", YLW, w));
        for (const line of formatMd(msg.text).split("\n")) {
          this.write(boxLine(line, YLW, w));
        }
        this.write(boxBottom(YLW, w));
        this.write("");
        break;
      }

      case "acknowledgment":
      default: {
        // Regular responses — cyan box
        this.write("");
        this.write(boxTop("claus", CYN, w));
        for (const line of formatMd(msg.text).split("\n")) {
          this.write(boxLine(line, CYN, w));
        }
        this.write(boxBottom(CYN, w));
        this.write("");
        break;
      }
    }
  }

  sendNarration(item: NarrationItem): void {
    if (this.closed) return;

    switch (item.level) {
      case "major": {
        this.stopThinking();
        this.write("");
        this.write(`  ${D}━━${R} ${B}${item.headline}${R}`);
        if (item.children) {
          for (const child of item.children) {
            const color = child.severity === "warn" ? YLW
              : child.severity === "success" ? GRN : GRY;
            this.write(`  ${D}   ${color}${child.label}${R}${D}: ${child.value}${R}`);
          }
        }
        // Start thinking spinner after major events
        this.startThinking(item.headline);
        break;
      }

      case "normal": {
        this.spinner.update(item.headline);
        break;
      }

      case "minor": {
        // Minor narrations update the spinner message
        this.spinner.update(item.headline);
        break;
      }
    }
  }

  sendStatus(status: SystemStatus): void {
    if (this.closed) return;

    const prevState = this.status.projectState;

    if (status.phase) this.status.phase = status.phase;
    if (status.task) this.status.task = status.task;
    if (status.projectState) this.status.projectState = status.projectState;
    if (status.cycle != null) this.status.cycle = status.cycle;
    if (status.ne != null) this.status.ne = status.ne;

    // Terminal title
    const parts: string[] = [];
    if (this.status.projectState) parts.push(this.status.projectState);
    if (this.status.phase) parts.push(this.status.phase);
    if (this.status.task) {
      const t = this.status.task.length > 30 ? this.status.task.slice(0, 27) + "..." : this.status.task;
      parts.push(t);
    }
    if (parts.length > 0) {
      process.stdout.write(`\x1b]0;cortex │ ${parts.join(" │ ")}\x07`);
    }

    // Show significant state transitions
    if (status.projectState && status.projectState !== prevState) {
      this.stopThinking();
      this.write(`  ${D}── ${status.projectState} ──${R}`);
    }
  }

  sendPlan(plan: PlanSnapshot): void {
    if (this.closed) return;
    if (plan.nodes.length === 0) return;

    this.stopThinking();
    const w = boxWidth();

    this.write("");
    this.write(boxTop("plan", BLU, w));
    for (const node of plan.nodes.slice(0, 10)) {
      const icon = node.status === "complete" ? `${GRN}✓${R}`
        : node.status === "active" ? `${CYN}▸${R}`
        : node.status === "escalated" ? `${RED}!${R}`
        : `${GRY}○${R}`;
      const indent = node.parentId ? "  " : "";
      this.write(boxLine(`${indent}${icon} ${node.description}`, BLU, w));
    }
    if (plan.nodes.length > 10) {
      this.write(boxLine(`${D}... and ${plan.nodes.length - 10} more${R}`, BLU, w));
    }
    this.write(boxBottom(BLU, w));
    this.write("");
  }

  sendArtifact(artifact: ArtifactItem): void {
    if (this.closed) return;
    this.stopThinking();
    const w = boxWidth();

    this.write("");
    this.write(boxTop("✓ artifact", GRN, w));
    this.write(boxLine(`${B}${artifact.title}${R}`, GRN, w));
    this.write(boxLine(`${D}confidence: ${(artifact.confidence * 100).toFixed(0)}%${R}`, GRN, w));
    this.write(boxBottom(GRN, w));
    this.write("");
  }

  onReceive(handler: (text: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    this.spinner.stop();
    this.rl.close();
  }

  getReadline(): Interface {
    return this.rl;
  }

  // ─── Internal ──────────────────────────────────────────

  private write(line: string): void {
    process.stdout.write(`${CLR}${line}\n`);
  }

  private writeSeparator(): void {
    const w = Math.min(process.stdout.columns ?? 80, 100) - 4;
    this.write(`  ${GRY}${"─".repeat(w)}${R}`);
  }

  private startThinking(context?: string): void {
    if (this.thinkingActive) return;
    this.thinkingActive = true;
    this.spinner.update(context ?? "thinking");
    this.spinner.start();
  }

  private stopThinking(): void {
    if (!this.thinkingActive) return;
    this.thinkingActive = false;
    this.spinner.stop();
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
