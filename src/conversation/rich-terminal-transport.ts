/**
 * Rich Terminal Transport — conversational terminal experience for Claus.
 *
 * A proper terminal UI that makes the conversation feel like a partnership:
 *   - Clear visual hierarchy: Claus speaks, system narrates, you direct
 *   - Persistent status line showing current phase + task + awareness
 *   - Markdown-like formatting (bold, code, lists)
 *   - Narration collapsed into compact phase indicators
 *   - Questions and escalations visually prominent
 *   - Your input always at the bottom
 *
 * Replaces the basic TerminalTransport for the CLI experience.
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

// ─── ANSI helpers ──────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

const BLACK = "\x1b[30m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

const BG_BLUE = "\x1b[44m";
const BG_YELLOW = "\x1b[43m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";

const CLEAR_LINE = "\r\x1b[K";
const SAVE_CURSOR = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";

// ─── Formatting helpers ────────────────────────────────────────

/** Simple markdown-like formatting for terminal output. */
function formatText(text: string): string {
  return text
    // Code blocks (``` ... ```) → dim
    .replace(/```[\s\S]*?```/g, (match) => `${DIM}${match.slice(3, -3).trim()}${RESET}`)
    // Inline code (`...`) → dim
    .replace(/`([^`]+)`/g, `${DIM}$1${RESET}`)
    // Bold (**...**) → bold
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
    // Italic (*...*) → italic
    .replace(/\*([^*]+)\*/g, `${ITALIC}$1${RESET}`)
    // Bullet lists (- ...) → indented with marker
    .replace(/^- (.+)$/gm, `  ${DIM}•${RESET} $1`);
}

/** Wrap text to terminal width. */
function wrap(text: string, width: number, indent = 0): string {
  const prefix = " ".repeat(indent);
  const maxLen = width - indent;
  if (maxLen <= 20) return text; // Don't wrap narrow terminals

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= maxLen) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line.length + word.length + 1 > maxLen) {
        lines.push(line);
        line = prefix + word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

// ─── Status bar ────────────────────────────────────────────────

interface StatusState {
  phase?: string;
  task?: string;
  cycle?: number;
  projectState?: string;
  ne?: number;
  awarenessCount?: number;
}

function renderStatusBar(status: StatusState): string {
  const parts: string[] = [];

  if (status.projectState) {
    const stateColors: Record<string, string> = {
      inquiry: BG_BLUE + WHITE,
      planning: BG_BLUE + WHITE,
      executing: BG_GREEN + BLACK,
      evaluating: BG_YELLOW + BLACK,
      complete: BG_GREEN + BLACK,
      escalated: BG_RED + WHITE,
    };
    const color = stateColors[status.projectState] ?? DIM;
    parts.push(`${color} ${status.projectState} ${RESET}`);
  }

  if (status.phase) {
    parts.push(`${DIM}${status.phase}${RESET}`);
  }

  if (status.cycle != null) {
    parts.push(`${DIM}cycle ${status.cycle}${RESET}`);
  }

  if (status.task) {
    const truncated = status.task.length > 40 ? status.task.slice(0, 37) + "..." : status.task;
    parts.push(`${CYAN}${truncated}${RESET}`);
  }

  if (status.ne != null) {
    parts.push(`${DIM}NE: ${(status.ne * 100).toFixed(0)}%${RESET}`);
  }

  return parts.length > 0 ? parts.join(`${DIM} │ ${RESET}`) : "";
}

// ─── Transport ─────────────────────────────────────────────────

export class RichTerminalTransport implements ConversationTransport {
  private rl: Interface;
  private handler: ((text: string) => void) | null = null;
  private closed = false;
  private status: StatusState = {};
  private lastNarrationLevel: string | null = null;
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
    });
  }

  sendMessage(msg: ConversationMessage): void {
    if (this.closed) return;

    if (msg.role === "parsifal") {
      // User's own message — brief acknowledgment
      this.write(`  ${GREEN}you ▸${RESET} ${msg.text}`);
      return;
    }

    // Cortex messages — visual treatment by kind
    switch (msg.kind) {
      case "question": {
        // Questions are the most prominent — they need a response
        this.write("");
        this.write(`  ${MAGENTA}${BOLD}? claus${RESET}`);
        const formatted = formatText(msg.text);
        for (const line of formatted.split("\n")) {
          this.write(`  ${MAGENTA}│${RESET} ${line}`);
        }
        this.write(`  ${MAGENTA}│${RESET}`);
        this.write(`  ${MAGENTA}└─${RESET} ${DIM}(type your answer)${RESET}`);
        this.write("");
        break;
      }

      case "proactive": {
        // Proactive insights — Claus volunteering something
        this.write("");
        this.write(`  ${YELLOW}${BOLD}💡 claus${RESET}`);
        const formatted = formatText(msg.text);
        for (const line of formatted.split("\n")) {
          this.write(`  ${YELLOW}│${RESET} ${line}`);
        }
        this.write("");
        break;
      }

      case "acknowledgment": {
        // Responses to Parsifal — conversational
        this.write(`  ${CYAN}claus ▸${RESET} ${formatText(msg.text)}`);
        break;
      }

      default: {
        // General Cortex messages
        this.write(`  ${CYAN}claus ▸${RESET} ${formatText(msg.text)}`);
        break;
      }
    }
  }

  sendNarration(item: NarrationItem): void {
    if (this.closed) return;

    // Compact narration — major events get full treatment, minor get one line
    switch (item.level) {
      case "major": {
        this.write("");
        this.write(`  ${DIM}──${RESET} ${BOLD}${item.headline}${RESET}`);
        if (item.children) {
          for (const child of item.children) {
            const color = child.severity === "warn" ? YELLOW
              : child.severity === "success" ? GREEN : DIM;
            this.write(`  ${DIM}  ${color}${child.label}:${RESET} ${color}${child.value}${RESET}`);
          }
        }
        break;
      }

      case "normal": {
        // Collapse consecutive normal narrations into compact form
        this.write(`  ${DIM}· ${item.headline}${RESET}`);
        break;
      }

      case "minor": {
        // Minor narrations only show if previous was also minor (grouping)
        if (this.lastNarrationLevel === "minor") {
          this.write(`  ${DIM}  ${item.headline}${RESET}`);
        }
        break;
      }
    }

    this.lastNarrationLevel = item.level;
  }

  sendStatus(status: SystemStatus): void {
    if (this.closed) return;

    const prevState = this.status.projectState;
    const prevPhase = this.status.phase;

    // Update internal status state
    if (status.phase) this.status.phase = status.phase;
    if (status.task) this.status.task = status.task;
    if (status.projectState) this.status.projectState = status.projectState;
    if (status.cycle != null) this.status.cycle = status.cycle;
    if (status.ne != null) this.status.ne = status.ne;

    // Render status bar to terminal title
    const bar = renderStatusBar(this.status);
    if (bar) {
      process.stdout.write(`\x1b]0;cortex: ${stripAnsi(bar)}\x07`);
    }

    // Print visible status line on significant transitions
    if (status.projectState && status.projectState !== prevState) {
      const stateLabel = status.projectState.charAt(0).toUpperCase() + status.projectState.slice(1);
      this.write(`  ${DIM}── ${stateLabel} ──${RESET}`);
    } else if (status.phase && status.phase !== prevPhase && status.phase !== prevState) {
      // Phase change within same project state — subtle indicator
      this.write(`  ${DIM}· ${status.phase}${status.cycle != null ? ` (cycle ${status.cycle})` : ""}${RESET}`);
    }
  }

  sendPlan(plan: PlanSnapshot): void {
    if (this.closed) return;

    // Show plan as compact tree when it first arrives
    if (plan.nodes.length > 0 && plan.nodes.some((n) => n.status === "pending")) {
      this.write("");
      this.write(`  ${DIM}── Plan ──${RESET}`);
      for (const node of plan.nodes.slice(0, 8)) {
        const icon = node.status === "complete" ? `${GREEN}✓${RESET}`
          : node.status === "active" ? `${CYAN}▸${RESET}`
          : node.status === "escalated" ? `${RED}!${RESET}`
          : `${DIM}○${RESET}`;
        const indent = node.parentId ? "    " : "  ";
        this.write(`${indent}${icon} ${node.description}`);
      }
      if (plan.nodes.length > 8) {
        this.write(`  ${DIM}  ... and ${plan.nodes.length - 8} more${RESET}`);
      }
      this.write("");
    }
  }

  sendArtifact(artifact: ArtifactItem): void {
    if (this.closed) return;

    this.write("");
    this.write(`  ${GREEN}${BOLD}✓ Artifact:${RESET} ${artifact.title}`);
    if (artifact.confidence != null) {
      this.write(`  ${DIM}  confidence: ${(artifact.confidence * 100).toFixed(0)}%${RESET}`);
    }
    this.write("");
  }

  onReceive(handler: (text: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    this.rl.close();
  }

  /** Get the underlying readline. */
  getReadline(): Interface {
    return this.rl;
  }

  // ─── Internal ──────────────────────────────────────────────

  private write(line: string): void {
    process.stdout.write(`${CLEAR_LINE}${line}\n`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
