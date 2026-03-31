/**
 * Consciousness tool executor — the hands of the conscious agent.
 *
 * 14 tools that let consciousness observe and steer Cortex:
 *
 * Observation (read-only):
 *   read_system_state      — WM summary, NE, conviction, load
 *   read_task_details      — Current task gestalt from Thalamus
 *   read_conviction_history — Full conviction trajectory
 *   read_event_digest      — Recent narrated events
 *
 * Action (side effects):
 *   add_observation        — Inject a fact into WM
 *   send_interrupt         — Soft interrupt on active rhythm
 *   raise_alarm            — Alert the Amygdala
 *   send_message           — Send a message to the Parsifal mid-thought
 *
 * Steering (modify system behavior):
 *   update_taste           — Change taste profile dimensions
 *   inhibit_sense          — Suppress a sense
 *   uninhibit_sense        — Reactivate a sense
 *   adjust_budget          — Allocate task budget or return unspent
 *   modify_task            — Amend a pending task's description
 *   update_worldview_frame — Change a worldview cognitive frame at runtime
 */

import type { WorkingMemory } from "../kernel/working-memory.js";
import type { RhythmRunnerImpl } from "../brainstem/runner.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { Amygdala } from "../subcortical/amygdala.js";
import type { Alarm } from "../types/amygdala.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { TasteProfile } from "../types/intent.js";
import type { ConversationTransport } from "../types/conversation.js";
import type { Worldview, WorldviewFrames } from "../types/worldview.js";
import type { CostTracker } from "../brainstem/cost-tracker.js";
import type { ClausHookRegistry, HookModel } from "./claus-hooks.js";
import { getLastNE } from "../kernel/norepinephrine.js";
import { newId } from "../util/ids.js";
import { emit } from "../events.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("claus-tools");

// ─── Tool call types ───────────────────────────────────────────

export type ClausToolCall =
  // Observation
  | { tool: "read_system_state" }
  | { tool: "read_task_details"; taskId?: string }
  | { tool: "read_conviction_history" }
  | { tool: "read_event_digest" }
  // Action
  | { tool: "add_observation"; fact: string }
  | { tool: "send_interrupt"; reason: string }
  | { tool: "raise_alarm"; description: string; severity: "urgent" | "emergency" }
  | { tool: "send_message"; text: string }
  // Steering
  | { tool: "update_taste"; dimension: string; value: string }
  | { tool: "inhibit_sense"; senseId: string; reason: string }
  | { tool: "uninhibit_sense"; senseId: string }
  | { tool: "adjust_budget"; action: "allocate" | "return_unspent"; taskId: string; amount?: number }
  | { tool: "modify_task"; taskId: string; description: string; context?: Record<string, unknown> }
  | { tool: "update_worldview_frame"; frame: string; content: string }
  // Hooks (self-modifying attention)
  | { tool: "set_hook"; name: string; trigger: string; model: "haiku" | "sonnet" | "opus"; context: string; persistent?: boolean; condition?: string }
  | { tool: "remove_hook"; name: string }
  | { tool: "list_hooks" }
  | { tool: "schedule_wakeup"; seconds: number; context: string; model?: "haiku" | "sonnet" | "opus" };

// ─── Digest entry (shared with consciousness agent) ────────────

export interface DigestEntry {
  timestamp: Date;
  summary: string;
  priority?: "normal" | "high";
}

// ─── Tool executor ─────────────────────────────────────────────

export interface ClausToolDeps {
  /** All system deps are optional — Claus can boot before the system is ready. */
  wm?: WorkingMemory;
  runner?: RhythmRunnerImpl;
  thalamus?: Thalamus;
  amygdala?: Amygdala;
  transports: ConversationTransport[];
  costTracker?: CostTracker | null;
  worldview?: Worldview;
  hookRegistry?: ClausHookRegistry;
}

export class ClausToolExecutor {
  private deps: ClausToolDeps;

  constructor(deps: ClausToolDeps) {
    this.deps = deps;
  }

  /** Update the transports reference (they may be added after construction). */
  setTransports(transports: ConversationTransport[]): void {
    this.deps.transports = transports;
  }

  /** Wire system deps after boot (when Brainstem comes online). */
  wireSystem(deps: {
    wm: WorkingMemory;
    runner: RhythmRunnerImpl;
    thalamus: Thalamus;
    amygdala: Amygdala;
    costTracker?: CostTracker | null;
  }): void {
    this.deps.wm = deps.wm;
    this.deps.runner = deps.runner;
    this.deps.thalamus = deps.thalamus;
    this.deps.amygdala = deps.amygdala;
    if (deps.costTracker !== undefined) this.deps.costTracker = deps.costTracker;
  }

  /** Whether system deps are available (post-boot). */
  get systemReady(): boolean {
    return !!(this.deps.wm && this.deps.runner && this.deps.thalamus && this.deps.amygdala);
  }

  /**
   * Execute a tool call and return the result as a string.
   * All results are formatted as human-readable text for the LLM.
   */
  async execute(
    call: ClausToolCall,
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
      case "update_taste":
        return this.updateTaste(call.dimension, call.value);
      case "inhibit_sense":
        return this.inhibitSense(call.senseId, call.reason);
      case "uninhibit_sense":
        return this.uninhibitSense(call.senseId);
      case "adjust_budget":
        return this.adjustBudget(call.action, call.taskId, call.amount);
      case "modify_task":
        return this.modifyTask(call.taskId, call.description, call.context);
      case "update_worldview_frame":
        return this.updateWorldviewFrame(call.frame, call.content);
      case "set_hook":
        return this.setHook(call.name, call.trigger, call.model, call.context, call.persistent ?? true, call.condition);
      case "remove_hook":
        return this.removeHook(call.name);
      case "list_hooks":
        return this.listHooks();
      case "schedule_wakeup":
        return this.scheduleWakeup(call.seconds, call.context, call.model);
    }
  }

  // ─── Observation tools ─────────────────────────────────────

  private readSystemState(): string {
    if (!this.deps.wm) return "System not ready yet — still booting.";
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
    if (!this.deps.thalamus || !this.deps.runner) return "System not ready yet — still booting.";
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
    if (!this.deps.wm) return "System not ready yet — still booting.";
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
    if (!this.deps.wm || !this.deps.runner) return "System not ready yet — still booting.";
    const runner = this.deps.runner;
    const activeRhythms = runner.getActiveRhythms();
    const taskId = activeRhythms[0] ?? "claus";

    const observation: TerritoryObservation = {
      id: newId(),
      fact: `Claus observation: ${fact}`,
      source: { taskId, component: "parsifal" },
      relevance: 1.0,
      observedAt: new Date(),
      status: "new",
      systemHealth: true,
    };

    this.deps.wm.addObservation(observation);

    emit("claus:observation-added", {
      observationId: observation.id,
      fact: fact.slice(0, 200),
    });

    log.info("Clausadded observation", { fact: fact.slice(0, 100) });
    return `Observation added: "${fact.slice(0, 100)}"`;
  }

  private sendInterrupt(reason: string): string {
    if (!this.deps.runner) return "System not ready yet — still booting.";
    const activeRhythms = this.deps.runner.getActiveRhythms();
    if (activeRhythms.length === 0) {
      return "No active rhythms to interrupt.";
    }

    const targetId = activeRhythms[activeRhythms.length - 1];
    this.deps.runner.interrupt(targetId, {
      mode: "soft",
      source: "claus",
      reason,
      context: { fromConsciousness: true },
    });

    emit("claus:interrupt-sent", {
      rhythmId: targetId,
      reason: reason.slice(0, 200),
    });

    log.info("Claussent soft interrupt", { rhythmId: targetId, reason });
    return `Soft interrupt sent to rhythm ${targetId}: "${reason.slice(0, 100)}"`;
  }

  private raiseAlarm(description: string, severity: "urgent" | "emergency"): string {
    if (!this.deps.amygdala) return "System not ready yet — still booting.";
    const alarm: Alarm = {
      source: "claus",
      severity,
      description,
      context: { fromConsciousness: true },
    };

    const assessment = this.deps.amygdala.receiveAlarm(alarm);

    emit("claus:alarm-raised", {
      assessmentId: assessment.id,
      severity,
      description: description.slice(0, 200),
    });

    log.warn("Clausraised alarm", { severity, description });
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

  // ─── Steering tools ────────────────────────────────────────

  private updateTaste(dimension: string, value: string): string {
    if (!this.deps.thalamus) return "System not ready yet — still booting.";
    const taste = this.deps.thalamus.getTaste();
    if (!taste) return "No taste profile available.";

    const validDimensions = ["visual", "decisionStyle", "communication", "patterns"];
    if (!validDimensions.includes(dimension)) {
      return `Invalid dimension "${dimension}". Valid: ${validDimensions.join(", ")}`;
    }

    const updated: TasteProfile = {
      ...taste,
      [dimension]: value,
    };

    this.deps.thalamus.updateTaste(updated);

    emit("claus:taste-updated", { dimension, value: value.slice(0, 100) });
    log.info("Clausupdated taste", { dimension, value: value.slice(0, 60) });
    return `Taste "${dimension}" updated to: "${value.slice(0, 100)}". All future briefings will reflect this.`;
  }

  private inhibitSense(senseId: string, reason: string): string {
    if (!this.deps.wm) return "System not ready yet — still booting.";
    this.deps.wm.inhibitSense(senseId, reason, "claus", "project");

    emit("claus:sense-inhibited", { senseId, reason });
    log.info("Clausinhibited sense", { senseId, reason });
    return `Sense "${senseId}" inhibited: "${reason}". It won't be consulted or evaluated until uninhibited.`;
  }

  private uninhibitSense(senseId: string): string {
    if (!this.deps.wm) return "System not ready yet — still booting.";
    const removed = this.deps.wm.uninhibitSense(senseId);
    if (!removed) return `Sense "${senseId}" was not inhibited.`;

    emit("claus:sense-uninhibited", { senseId });
    log.info("Clausuninhibited sense", { senseId });
    return `Sense "${senseId}" reactivated. It will be included in future consultation and evaluation.`;
  }

  private adjustBudget(action: "allocate" | "return_unspent", taskId: string, amount?: number): string {
    const tracker = this.deps.costTracker;
    if (!tracker) return "No budget tracking active for this project.";

    if (action === "allocate") {
      if (amount == null || amount <= 0) return "Must specify a positive amount to allocate.";
      const available = tracker.getAllocableBudget();
      if (amount > available) {
        return `Cannot allocate $${amount.toFixed(2)} — only $${available.toFixed(2)} available.`;
      }
      tracker.allocateTaskBudget(taskId, amount);
      emit("claus:budget-allocated", { taskId, amount });
      log.info("Clausallocated budget", { taskId, amount });
      return `Allocated $${amount.toFixed(2)} to task ${taskId}. Remaining allocable: $${(available - amount).toFixed(2)}.`;
    }

    if (action === "return_unspent") {
      const returned = tracker.returnUnspent(taskId);
      emit("claus:budget-returned", { taskId, returned });
      log.info("Clausreturned unspent budget", { taskId, returned });
      return `Returned $${returned.toFixed(2)} unspent budget from task ${taskId} to the pool.`;
    }

    return "Unknown budget action.";
  }

  private modifyTask(taskId: string, description: string, context?: Record<string, unknown>): string {
    if (!this.deps.wm || !this.deps.runner) return "System not ready yet — still booting.";
    // Add a high-priority observation that the system will pick up
    // as a task amendment directive. The task-dispatch rhythm reads
    // observations and can apply graph surgery.
    const directive = context
      ? `TASK AMENDMENT for ${taskId}: ${description}. Context: ${JSON.stringify(context)}`
      : `TASK AMENDMENT for ${taskId}: ${description}`;

    const observation: TerritoryObservation = {
      id: newId(),
      fact: directive,
      source: { taskId, component: "parsifal" },
      relevance: 1.0,
      observedAt: new Date(),
      status: "new",
      systemHealth: true,
    };

    this.deps.wm.addObservation(observation);

    // Also send a soft interrupt so the gate sees the amendment
    const activeRhythms = this.deps.runner.getActiveRhythms();
    if (activeRhythms.length > 0) {
      this.deps.runner.interrupt(activeRhythms[activeRhythms.length - 1], {
        mode: "soft",
        source: "claus",
        reason: `Task amendment: ${description.slice(0, 100)}`,
        context: { taskId, amendment: true },
      });
    }

    emit("claus:task-modified", { taskId, description: description.slice(0, 200) });
    log.info("Clausmodified task", { taskId, description: description.slice(0, 100) });
    return `Task amendment queued for "${taskId}": "${description.slice(0, 100)}". Will be applied at the next gate decision.`;
  }

  private updateWorldviewFrame(frame: string, content: string): string {
    const wv = this.deps.worldview;
    if (!wv) return "No worldview available.";
    if (!wv.frames) return "Worldview has no frames object.";

    const key = frame as keyof WorldviewFrames;
    // Allow updating any frame, including consciousness's own
    (wv.frames as Record<string, string>)[key] = content;

    emit("claus:worldview-frame-updated", { frame, contentLength: content.length });
    log.info("Clausupdated worldview frame", { frame, contentLength: content.length });
    return `Worldview frame "${frame}" updated (${content.length} chars). All future prompts using this frame will reflect the change.`;
  }

  // ─── Hook tools ────────────────────────────────────────────

  private setHook(
    name: string, trigger: string, model: HookModel,
    context: string, persistent: boolean, condition?: string,
  ): string {
    const registry = this.deps.hookRegistry;
    if (!registry) return "Hook registry not available.";

    registry.set({ name, trigger, model, context, persistent, condition, source: "claus" });
    return `Hook "${name}" set: trigger="${trigger}"${condition ? `, condition="${condition}"` : ""}, model=${model}, ${persistent ? "persistent" : "one-shot"}.`;
  }

  private removeHook(name: string): string {
    const registry = this.deps.hookRegistry;
    if (!registry) return "Hook registry not available.";

    const removed = registry.remove(name);
    return removed
      ? `Hook "${name}" removed.`
      : `Hook "${name}" not found or is a system hook (cannot remove).`;
  }

  private listHooks(): string {
    const registry = this.deps.hookRegistry;
    if (!registry) return "Hook registry not available.";

    const hooks = registry.list();
    if (hooks.length === 0) return "No hooks registered.";

    const parts = [`## Active hooks (${hooks.length})`];
    for (const h of hooks) {
      const cond = h.condition ? ` [${h.condition}]` : "";
      const pers = h.persistent ? "persistent" : "one-shot";
      parts.push(`  - **${h.name}** (${h.source}) → ${h.trigger}${cond} | model: ${h.model} | ${pers}`);
    }
    return parts.join("\n");
  }

  private scheduleWakeup(seconds: number, context: string, model?: HookModel): string {
    const registry = this.deps.hookRegistry;
    if (!registry) return "Hook registry not available.";

    const name = `wakeup-${Date.now()}`;
    registry.set({
      name,
      trigger: `interval:${seconds}`,
      model: model ?? "haiku",
      context,
      persistent: false,
      source: "claus",
    });
    return `Wake-up scheduled in ${seconds}s: "${context.slice(0, 80)}" (${model ?? "haiku"}).`;
  }
}

// ─── Tool descriptions for the system prompt ───────────────────

export const TOOL_DESCRIPTIONS = `## Your tools

You have 18 tools. Include tool calls in your response as JSON.

### Observation (read-only)
- **read_system_state**: Full snapshot — WM, NE, conviction, patterns, decisions, open questions, sense trends, load.
- **read_task_details**: Current task's gestalt from the Thalamus. Optionally pass a taskId.
- **read_conviction_history**: Full conviction trajectory over time.
- **read_event_digest**: Narrated events since your last invocation.

### Action (side effects)
- **add_observation**: Inject a fact into working memory. Picked up at next briefing assembly.
- **send_interrupt**: Soft interrupt on the innermost rhythm. Queued for next gate decision.
- **raise_alarm**: Alert the Amygdala — triggers hard interrupts, NE override, escalation. Genuine urgency only.
- **send_message**: Send a message to the Parsifal immediately, before finishing your thought.

### Steering (modify system behavior)
- **update_taste**: Change a taste profile dimension. Params: dimension ("visual", "decisionStyle", "communication", "patterns"), value (string). Immediately affects all future briefings.
- **inhibit_sense**: Suppress a sense. Params: senseId, reason. It won't be consulted or evaluated until uninhibited.
- **uninhibit_sense**: Reactivate a suppressed sense. Params: senseId.
- **adjust_budget**: Manage task budgets. Params: action ("allocate" or "return_unspent"), taskId, amount (for allocate). Controls how much the system spends per task.
- **modify_task**: Amend a task's description. Params: taskId, description, optional context object. Queued as a high-priority observation + soft interrupt for the next gate.
- **update_worldview_frame**: Change a cognitive frame at runtime. Params: frame (e.g. "building", "evaluation", "consciousness"), content (new prose). Reshapes how the system thinks about that cognitive act.

### Hooks (self-modifying attention)
- **set_hook**: Register a hook to wake you up. Params: name, trigger ("event:<type>" or "interval:<seconds>"), model ("haiku"/"sonnet"/"opus"), context (what to do when woken), persistent (default true), optional condition ("<field> <op> <value>"). You control your own attention policy.
- **remove_hook**: Remove a hook you set. Params: name. System hooks can't be removed.
- **list_hooks**: See all active hooks — system and self-set.
- **schedule_wakeup**: One-shot wake-up in N seconds. Params: seconds, context, optional model (default haiku). For "check back on this later."`;

