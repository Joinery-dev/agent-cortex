/**
 * Background Agent — spawn a sibling Cortex to answer a question
 * while the main agent continues working.
 *
 * Ctrl+B queues the current input as a background task. A new
 * ConversationSession is created with shared project context
 * but independent conversation state. Results display in the
 * terminal with distinct visual treatment.
 */

import { ConversationSession } from "../kernel/conversation-session.js";
import type { PeripheralNervousSystem } from "../kernel/pns.js";
import type { WorldModel } from "../kernel/world-model.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { Worldview } from "../types/worldview.js";
import { createLogger } from "../util/logger.js";
import { newId } from "../util/ids.js";

const log = createLogger("background-agent");

// ─── ANSI ─────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const BLU = "\x1b[34m";
const GRY = "\x1b[90m";

const BOX_TL = "╭";
const BOX_TR = "╮";
const BOX_BL = "╰";
const BOX_BR = "╯";
const BOX_H = "─";
const BOX_V = "│";

// ─── Types ────────────────────────────────────────────────────

export interface BackgroundTask {
  id: string;
  query: string;
  status: "queued" | "running" | "complete" | "failed";
  startedAt: Date;
  completedAt?: Date;
  response?: string;
}

// ─── Manager ──────────────────────────────────────────────────

export class BackgroundAgentManager {
  private tasks: BackgroundTask[] = [];
  private pns: PeripheralNervousSystem;
  private worldModel?: WorldModel;
  private thalamus: Thalamus;
  private worldview?: Worldview;
  private write: (line: string) => void;

  constructor(deps: {
    pns: PeripheralNervousSystem;
    worldModel?: WorldModel;
    thalamus: Thalamus;
    worldview?: Worldview;
    write: (line: string) => void;
  }) {
    this.pns = deps.pns;
    this.worldModel = deps.worldModel;
    this.thalamus = deps.thalamus;
    this.worldview = deps.worldview;
    this.write = deps.write;
  }

  /**
   * Spawn a background agent to handle a query.
   * Runs in parallel — doesn't block the main conversation.
   */
  spawn(query: string): BackgroundTask {
    const task: BackgroundTask = {
      id: newId().slice(0, 8),
      query,
      status: "queued",
      startedAt: new Date(),
    };

    this.tasks.push(task);

    this.write(`\n  ${BLU}${B}⊕ Background agent #${task.id}${R}`);
    this.write(`  ${BLU}${BOX_V}${R} ${D}${query}${R}`);
    this.write(`  ${BLU}${BOX_V}${R} ${D}working...${R}\n`);

    // Run asynchronously — don't await
    this.runAgent(task).catch((err) => {
      log.warn("Background agent failed", { id: task.id, error: String(err) });
    });

    return task;
  }

  /** Get all background tasks. */
  getTasks(): BackgroundTask[] {
    return [...this.tasks];
  }

  /** Get active (running) tasks. */
  getActive(): BackgroundTask[] {
    return this.tasks.filter((t) => t.status === "running" || t.status === "queued");
  }

  // ─── Private ────────────────────────────────────────────

  private async runAgent(task: BackgroundTask): Promise<void> {
    task.status = "running";

    // Create an independent conversation session for this background query.
    // Shares the same PNS/WorldModel/Thalamus (reads same project state)
    // but has its own conversation history.
    const session = new ConversationSession({
      pns: this.pns,
      worldModel: this.worldModel,
      thalamus: this.thalamus,
      worldview: this.worldview,
    });

    try {
      const result = await session.respond(task.query);

      task.status = "complete";
      task.completedAt = new Date();
      task.response = result.message ?? "No response.";

      const elapsed = ((task.completedAt.getTime() - task.startedAt.getTime()) / 1000).toFixed(1);

      // Display result in a blue box
      this.write("");
      this.renderResult(task, elapsed);
    } catch (err) {
      task.status = "failed";
      task.completedAt = new Date();
      task.response = `Error: ${String(err)}`;

      this.write(`\n  ${BLU}${B}⊕ Background #${task.id} failed${R}: ${String(err)}\n`);
    }
  }

  private renderResult(task: BackgroundTask, elapsed: string): void {
    const width = Math.min(process.stdout.columns ?? 80, 100) - 2;
    const response = task.response ?? "";

    // Header
    this.write(`  ${BLU}${BOX_TL}${BOX_H}${R}${BLU}${B} ⊕ background #${task.id} ${R}${D}(${elapsed}s)${R}${BLU}${BOX_H.repeat(Math.max(0, width - 25 - elapsed.length))}${BOX_TR}${R}`);

    // Query
    this.write(`  ${BLU}${BOX_V}${R} ${D}Q: ${task.query}${R}`);
    this.write(`  ${BLU}${BOX_V}${R}`);

    // Response lines
    for (const line of response.split("\n")) {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      const pad = Math.max(0, width - stripped.length - 6);
      this.write(`  ${BLU}${BOX_V}${R} ${line}${" ".repeat(pad)} ${BLU}${BOX_V}${R}`);
    }

    // Footer
    this.write(`  ${BLU}${BOX_BL}${BOX_H.repeat(width - 4)}${BOX_BR}${R}`);
    this.write("");
  }
}
