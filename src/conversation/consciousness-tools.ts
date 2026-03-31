/**
 * Consciousness tool executor — the hands of the conscious agent.
 *
 * Eight tools that let consciousness observe and steer Cortex:
 *
 * Observation:
 *   read_system_state    — WM summary, NE, conviction, load
 *   read_task_details    — Current task gestalt from Thalamus
 *   read_conviction_history — Full conviction trajectory
 *   read_event_digest    — Recent narrated events
 *
 * Action:
 *   add_observation      — Inject a fact into WM
 *   send_interrupt       — Soft interrupt on active rhythm
 *   raise_alarm          — Alert the Amygdala (triggers response protocol)
 *   send_message         — Send a message to the Parsifal mid-thought
 */

import type { WorkingMemory } from "../kernel/working-memory.js";
import type { RhythmRunnerImpl } from "../brainstem/runner.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { Amygdala } from "../subcortical/amygdala.js";
import type { Alarm } from "../types/amygdala.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { ConversationTransport } from "../types/conversation.js";
import { getLastNE } from "../kernel/norepinephrine.js";
import { newId } from "../util/ids.js";
import { emit } from "../events.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("consciousness-tools");

// ─── Tool call types ───────────────────────────────────────────

export type ConsciousnessToolCall =
  | { tool: "read_system_state" }
  | { tool: "read_task_details"; taskId?: string }
  | { tool: "read_conviction_history" }
  | { tool: "read_event_digest" }
  | { tool: "add_observation"; fact: string }
  | { tool: "send_interrupt"; reason: string }
  | { tool: "raise_alarm"; description: string; severity: "urgent" | "emergency" }
  | { tool: "send_message"; text: string };

// ─── Digest entry (shared with consciousness agent) ────────────

export interface DigestEntry {
  timestamp: Date;
  summary: string;
  priority?: "normal" | "high";
}

// ─── Tool executor ─────────────────────────────────────────────

export interface ConsciousnessToolDeps {
  wm: WorkingMemory;
  runner: RhythmRunnerImpl;
  thalamus: Thalamus;
  amygdala: Amygdala;
  transports: ConversationTransport[];
}

export class ConsciousnessToolExecutor {
  private deps: ConsciousnessToolDeps;

  constructor(deps: ConsciousnessToolDeps) {
    this.deps = deps;
  }

  /** Update the transports reference (they may be added after construction). */
  setTransports(transports: ConversationTransport[]): void {
    this.deps.transports = transports;
  }

  /**
   * Execute a tool call and return the result as a string.
   * All results are formatted as human-readable text for the LLM.
   */
  async execute(
    call: ConsciousnessToolCall,
    digest?: DigestEntry[],
  ): Promise<string> {
    switch (call.tool) {
      case "read_system_state":
        return this.readSystemState();
      case "read_task_details":
        return this.readTaskDetails(call.taskId);
      case "read_conviction_history":
        return this.readConvictionHistory();
      case "read_event_digest":
        return this.readEventDigest(digest ?? []);
      case "add_observation":
        return this.addObservation(call.fact);
      case "send_interrupt":
        return this.sendInterrupt(call.reason);
      case "raise_alarm":
        return this.raiseAlarm(call.description, call.severity);
      case "send_message":
        return this.sendMessage(call.text);
    }
  }

  // ─── Observation tools ─────────────────────────────────────

  private readSystemState(): string {
    const wm = this.deps.wm;
    const ne = getLastNE();
    const patterns = wm.getPatterns();
    const decisions = wm.getDecisions();
    const openQuestions = wm.getOpenQuestions();
    const load = wm.getLoad();
    const conviction = wm.getConvictionTrajectory();
    const tasks = wm.getTasks();
    const senseTrends = wm.getSenseTrends();

    const activeTasks = tasks.filter((t) => t.status === "active");
    const completedTasks = tasks.filter((t) => t.status === "complete");

    const parts: string[] = [];

    // Tasks
    parts.push(`## Tasks`);
    parts.push(`Active: ${activeTasks.length}, Completed: ${completedTasks.length}, Total: ${tasks.length}`);
    for (const t of activeTasks) {
      parts.push(`  - [active] ${t.description}`);
    }

    // NE
    if (ne) {
      parts.push(`\n## Norepinephrine (arousal)`);
      parts.push(`Level: ${ne.ne.toFixed(2)}`);
      const comps = ne.components;
      parts.push(`Components: maturity: ${comps.maturityComponent.toFixed(2)}, risk: ${comps.riskComponent.toFixed(2)}, novelty: ${comps.noveltyComponent.toFixed(2)}`);
    }

    // Conviction
    parts.push(`\n## Conviction`);
    parts.push(`Direction: ${conviction.direction}, Current: ${conviction.currentLevel?.toFixed(2) ?? "none"}`);
    if (conviction.levels.length > 0) {
      const recent = conviction.levels.slice(-3);
      parts.push(`Recent: ${recent.map((l) => l.toFixed(2)).join(" → ")}`);
    }

    // Patterns
    if (patterns.length > 0) {
      parts.push(`\n## Patterns (${patterns.length})`);
      for (const p of patterns.slice(-5)) {
        parts.push(`  - ${p.description} (confidence: ${p.confidence.toFixed(2)})`);
      }
    }

    // Decisions
    if (decisions.length > 0) {
      parts.push(`\n## Key decisions (${decisions.length})`);
      for (const d of decisions.slice(-5)) {
        parts.push(`  - ${d.description} (confidence: ${d.confidence.toFixed(2)})`);
      }
    }

    // Open questions
    if (openQuestions.length > 0) {
      parts.push(`\n## Open questions (${openQuestions.length})`);
      for (const q of openQuestions) {
        parts.push(`  - ${q.question}`);
      }
    }

    // Sense trends
    if (senseTrends.length > 0) {
      parts.push(`\n## Sense trends`);
      for (const t of senseTrends.slice(0, 6)) {
        parts.push(`  - ${t.id}: ${t.direction} (current mean: ${t.currentMean.toFixed(1)})`);
      }
    }

    // Load
    parts.push(`\n## System load: ${(load * 100).toFixed(0)}%`);

    return parts.join("\n");
  }

  private readTaskDetails(taskId?: string): string {
    const thalamus = this.deps.thalamus;
    const runner = this.deps.runner;

    // Find the current task if no ID provided
    let gestaltId = taskId;
    if (!gestaltId) {
      const activeRhythms = runner.getActiveRhythms();
      if (activeRhythms.length > 0) {
        // Try each rhythm to find one with a gestalt
        for (const rid of activeRhythms) {
          const state = runner.getState(rid);
          if (state) {
            const ctx = state.initialContext as Record<string, unknown>;
            const task = ctx?.task as { id?: string } | undefined;
            if (task?.id) {
              const g = thalamus.getGestalt(task.id);
              if (g) {
                gestaltId = task.id;
                break;
              }
            }
          }
        }
      }
    }

    if (!gestaltId) {
      return "No active task with gestalt found.";
    }

    const gestalt = thalamus.getGestalt(gestaltId);
    if (!gestalt) {
      return `No gestalt found for task ${gestaltId}.`;
    }

    const parts: string[] = [];
    parts.push(`## Task: ${gestalt.task.description}`);
    parts.push(`ID: ${gestalt.task.id}`);
    parts.push(`Mode: ${gestalt.mode}`);
    if (gestalt.neLevel != null) parts.push(`NE at assembly: ${gestalt.neLevel.toFixed(2)}`);

    if (gestalt.prediction) {
      parts.push(`\nPrediction: ${JSON.stringify(gestalt.prediction, null, 2).slice(0, 300)}`);
    }

    if (gestalt.speedOfLight) {
      parts.push(`\nSpeed of light ceilings: ${JSON.stringify(gestalt.speedOfLight, null, 2).slice(0, 300)}`);
    }

    if (gestalt.efferenceCopy) {
      parts.push(`\nEfference copy (builder feasibility): ${JSON.stringify(gestalt.efferenceCopy, null, 2).slice(0, 300)}`);
    }

    return parts.join("\n");
  }

  private readConvictionHistory(): string {
    const history = this.deps.wm.getConvictionHistory();
    if (history.length === 0) return "No conviction history yet.";

    const parts = [`## Conviction history (${history.length} entries)`];
    for (const entry of history.slice(-10)) {
      parts.push(`  Level: ${entry.level.toFixed(2)}, Delta: ${entry.delta.toFixed(2)}, Step: ${entry.decidingStep}, Verdict: ${entry.verdict}`);
    }
    return parts.join("\n");
  }

  private readEventDigest(digest: DigestEntry[]): string {
    if (digest.length === 0) return "No events since last check.";

    const parts = [`## Recent events (${digest.length})`];
    for (const entry of digest) {
      const time = entry.timestamp.toLocaleTimeString("en-US", {
        hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const priority = entry.priority === "high" ? " ⚠" : "";
      parts.push(`[${time}]${priority} ${entry.summary}`);
    }
    return parts.join("\n");
  }

  // ─── Action tools ──────────────────────────────────────────

  private addObservation(fact: string): string {
    const runner = this.deps.runner;
    const activeRhythms = runner.getActiveRhythms();
    const taskId = activeRhythms[0] ?? "consciousness";

    const observation: TerritoryObservation = {
      id: newId(),
      fact: `Consciousness observation: ${fact}`,
      source: { taskId, component: "parsifal" },
      relevance: 1.0,
      observedAt: new Date(),
      status: "new",
      systemHealth: true,
    };

    this.deps.wm.addObservation(observation);

    emit("consciousness:observation-added", {
      observationId: observation.id,
      fact: fact.slice(0, 200),
    });

    log.info("Consciousness added observation", { fact: fact.slice(0, 100) });
    return `Observation added: "${fact.slice(0, 100)}"`;
  }

  private sendInterrupt(reason: string): string {
    const activeRhythms = this.deps.runner.getActiveRhythms();
    if (activeRhythms.length === 0) {
      return "No active rhythms to interrupt.";
    }

    const targetId = activeRhythms[activeRhythms.length - 1];
    this.deps.runner.interrupt(targetId, {
      mode: "soft",
      source: "consciousness",
      reason,
      context: { fromConsciousness: true },
    });

    emit("consciousness:interrupt-sent", {
      rhythmId: targetId,
      reason: reason.slice(0, 200),
    });

    log.info("Consciousness sent soft interrupt", { rhythmId: targetId, reason });
    return `Soft interrupt sent to rhythm ${targetId}: "${reason.slice(0, 100)}"`;
  }

  private raiseAlarm(description: string, severity: "urgent" | "emergency"): string {
    const alarm: Alarm = {
      source: "consciousness",
      severity,
      description,
      context: { fromConsciousness: true },
    };

    const assessment = this.deps.amygdala.receiveAlarm(alarm);

    emit("consciousness:alarm-raised", {
      assessmentId: assessment.id,
      severity,
      description: description.slice(0, 200),
    });

    log.warn("Consciousness raised alarm", { severity, description });
    return `Alarm raised (${severity}): "${description.slice(0, 100)}". Amygdala response protocol activated.`;
  }

  private sendMessage(text: string): string {
    // Broadcast to all transports as a cortex message
    const msg = {
      id: newId(),
      role: "cortex" as const,
      kind: "proactive" as const,
      text,
      timestamp: new Date(),
    };

    for (const t of this.deps.transports) {
      t.sendMessage(msg);
    }

    return `Message sent to Parsifal: "${text.slice(0, 100)}"`;
  }
}

// ─── Tool descriptions for the system prompt ───────────────────

export const TOOL_DESCRIPTIONS = `## Your tools

You have eight tools. Use them to observe the system and take action. Include tool calls in your response as JSON.

### Observation tools (read-only, no side effects)
- **read_system_state**: Get a full snapshot of working memory, NE level, conviction, patterns, decisions, open questions, sense trends, and load.
- **read_task_details**: Get the current task's gestalt — what the Thalamus assembled for the builder. Optionally pass a taskId.
- **read_conviction_history**: Get the full conviction trajectory — how confidence has changed over time.
- **read_event_digest**: Get the narrated events that have happened since your last invocation.

### Action tools (side effects — use thoughtfully)
- **add_observation**: Inject a fact into working memory. The system will pick it up at the next briefing assembly. Use when you notice something the automated systems missed.
- **send_interrupt**: Send a soft interrupt to the innermost active rhythm. Queued for the next gate decision. Use when the Parsifal's input should influence the current build cycle.
- **raise_alarm**: Alert the Amygdala. This triggers the response protocol — hard interrupts, NE override, escalation. Use only for genuine urgency (threats, irreversible risks, safety).
- **send_message**: Send a message to the Parsifal immediately, before you finish thinking. Use when you need to say something now and continue reasoning.`;
