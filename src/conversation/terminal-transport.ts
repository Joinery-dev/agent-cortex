/**
 * Terminal transport — conversation in the terminal.
 *
 * Renders narration (left-pane content) and conversation messages
 * to stdout with visual formatting. Always-listening readline for
 * Parsifal input.
 *
 * This is the fallback transport. The primary experience is the
 * webapp (WebSocket transport), but terminal works for development
 * and headless operation.
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

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// ─── Transport ─────────────────────────────────────────────────

export class TerminalTransport implements ConversationTransport {
  private rl: Interface;
  private handler: ((text: string) => void) | null = null;
  private closed = false;

  constructor(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
    this.rl = createInterface({
      input: opts?.input ?? process.stdin,
      output: opts?.output ?? process.stdout,
      prompt: "",
    });

    // Always-listening: every line is a message
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

    const time = formatTime(msg.timestamp);

    if (msg.role === "parsifal") {
      // User's own messages — show them reflected
      this.write(`${DIM}${time}${RESET}  ${GREEN}◂ you${RESET}  ${msg.text}`);
      return;
    }

    // Cortex messages
    switch (msg.kind) {
      case "acknowledgment":
        this.write(`${DIM}${time}${RESET}  ${CYAN}▸${RESET} ${DIM}${msg.text}${RESET}`);
        break;

      case "question":
        this.write("");
        this.write(`${DIM}${time}${RESET}  ${MAGENTA}▸ cortex asks:${RESET} ${BOLD}${msg.text}${RESET}`);
        this.write("");
        break;

      case "proactive":
        this.write(`${DIM}${time}${RESET}  ${YELLOW}▸${RESET} ${msg.text}`);
        break;

      default:
        this.write(`${DIM}${time}${RESET}  ${CYAN}▸${RESET} ${msg.text}`);
        break;
    }
  }

  sendNarration(item: NarrationItem): void {
    if (this.closed) return;

    const time = formatTime(item.timestamp);
    const prefix = item.level === "major" ? BOLD : item.level === "minor" ? DIM : "";
    const suffix = prefix ? RESET : "";

    this.write(`${DIM}${time}${RESET}  ${prefix}${item.headline}${suffix}`);

    if (item.children) {
      for (const child of item.children) {
        const severityColor = child.severity === "warn" ? YELLOW
          : child.severity === "success" ? GREEN : DIM;
        this.write(`${DIM}${time}${RESET}    ${severityColor}├─ ${child.label}: ${child.value}${RESET}`);
      }
    }
  }

  sendStatus(_status: SystemStatus): void {
    // Terminal doesn't have a persistent status bar (yet).
  }

  sendPlan(_plan: PlanSnapshot): void {
    // Plan tab is webapp-only — terminal shows plan events via narration.
  }

  sendArtifact(_artifact: ArtifactItem): void {
    // Artifacts tab is webapp-only — terminal shows completion via narration.
  }

  onReceive(handler: (text: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    this.rl.close();
  }

  /** Get the underlying readline for pre-conversation use (worldview setup). */
  getReadline(): Interface {
    return this.rl;
  }

  // ─── Internal ──────────────────────────────────────────────

  private write(line: string): void {
    // Clear current input line, write output, restore prompt position
    process.stdout.write(`\r\x1b[K${line}\n`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
