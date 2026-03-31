/**
 * Conversation Cortex — the layer between Cortex and the Parsifal.
 *
 * Three responsibilities:
 *   1. Inbound:  Parsifal messages → consciousness agent → WM observations
 *   2. Outbound: Event bus → phase-level narration → transport
 *   3. Proactive: Notable events → consciousness agent → conversation
 *
 * The consciousness agent (LLM-backed) generates all conversational
 * responses. Its identity comes from the worldview. Infrastructure
 * (narration rules, transports, observation integration) supports it.
 *
 * Not a brain region — an extension of the Thalamus's external-facing
 * role: routing context between Cortex and the Parsifal in real-time.
 */

import type {
  ConversationMessage,
  ConversationTransport,
  NarrationItem,
  SystemStatus,
  MessageKind,
  ProactiveCategory,
} from "../types/conversation.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { CortexEvent } from "../events.js";
import type { WorkingMemory } from "./working-memory.js";
import type { RhythmRunnerImpl } from "../brainstem/runner.js";
import type { EscalationHandler } from "../brainstem/escalation-handler.js";
import type { Thalamus } from "./thalamus.js";
import type { Amygdala } from "../subcortical/amygdala.js";
import type { Worldview } from "../types/worldview.js";
import { ConsciousnessAgent, type ConsciousnessConfig } from "../conversation/consciousness.js";
import { bus, emit } from "../events.js";
import { narrateEvent } from "../conversation/narration-rules.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("conversation-cortex");

// ─── Construction ──────────────────────────────────────────────

export interface ConversationCortexDeps {
  wm: WorkingMemory;
  runner: RhythmRunnerImpl;
  escalationHandler: EscalationHandler;
  thalamus: Thalamus;
  amygdala: Amygdala;
  worldview?: Worldview;
  consciousnessConfig?: Partial<ConsciousnessConfig>;
}

export class ConversationCortex {
  private deps: ConversationCortexDeps;
  private transports: ConversationTransport[] = [];
  private history: ConversationMessage[] = [];
  private active = false;
  private consciousness: ConsciousnessAgent;

  /** Pending question awaiting a Parsifal response (askUser replacement). */
  private pendingQuestion: {
    id: string;
    resolve: (answer: string) => void;
  } | null = null;

  /** Current system status for the status bar. */
  private currentStatus: SystemStatus = {};

  /** Last conviction level — for detecting drops. */
  private lastConviction: number | null = null;

  constructor(deps: ConversationCortexDeps) {
    this.deps = deps;
    this.consciousness = new ConsciousnessAgent({
      wm: deps.wm,
      runner: deps.runner,
      thalamus: deps.thalamus,
      amygdala: deps.amygdala,
      transports: [], // populated when transports are added
      config: deps.consciousnessConfig,
      worldview: deps.worldview,
    });
  }

  // ─── Transport management ──────────────────────────────────

  /** Add a transport (terminal, WebSocket, etc). Multiple can be active. */
  addTransport(transport: ConversationTransport): void {
    this.transports.push(transport);
    transport.onReceive((text) => this.receive(text));

    // Keep consciousness aware of all transports
    this.consciousness.updateTransports(this.transports);

    // Send current status to the new transport
    transport.sendStatus(this.currentStatus);

    // Send recent conversation history so late-joining transports catch up
    const recent = this.history.slice(-50);
    for (const msg of recent) {
      if (msg.kind !== "narration") {
        transport.sendMessage(msg);
      }
    }
  }

  /** Remove a transport. */
  removeTransport(transport: ConversationTransport): void {
    this.transports = this.transports.filter((t) => t !== transport);
    this.consciousness.updateTransports(this.transports);
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Start listening to the event bus. Activate consciousness. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    bus.onCortex((event) => this.handleEvent(event));

    // Consciousness: subscribe to amygdala events + start heartbeat
    this.consciousness.subscribeToAmygdala();
    this.consciousness.startHeartbeat();

    log.info("Conversation cortex activated (consciousness heartbeat started)");
  }

  /** Stop listening, stop consciousness, close all transports. */
  deactivate(): void {
    this.active = false;
    this.consciousness.stopHeartbeat();
    for (const t of this.transports) {
      t.close();
    }
    this.transports = [];
    log.info("Conversation cortex deactivated");
  }

  // ─── Inbound: Parsifal messages ────────────────────────────

  /**
   * Process an incoming Parsifal message.
   *
   * Routing priority:
   *   1. If there's a pending question (askUser), resolve it
   *   2. If there's an active escalation, resolve the oldest one
   *   3. Otherwise, consciousness responds + store as WM observation
   */
  receive(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    const msgId = newId();

    // Record the incoming message
    const inbound: ConversationMessage = {
      id: msgId,
      role: "parsifal",
      kind: "message",
      text: trimmed,
      timestamp: new Date(),
      rhythmContext: this.currentRhythmContext(),
    };
    this.recordAndBroadcast(inbound);

    emit("conversation:received", {
      messageId: msgId,
      text: trimmed.slice(0, 200),
    });

    // 1. Pending question (askUser replacement)?
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion;
      this.pendingQuestion = null;

      // Consciousness acknowledges, then resolve
      this.consciousnessRespond(trimmed, msgId).then(() => {
        pq.resolve(trimmed);
      });
      return;
    }

    // 2. Active escalation?
    const activeEscalations = this.deps.escalationHandler.getActive();
    if (activeEscalations.length > 0) {
      const oldest = activeEscalations[0];
      this.deps.escalationHandler.resolve(oldest.id, {
        answer: trimmed,
        resolvedAt: new Date(),
      });

      this.consciousnessRespond(trimmed, msgId);
      return;
    }

    // 3. Consciousness responds + store as WM observation + soft interrupt
    this.storeAsObservation(trimmed, msgId);
    this.consciousnessRespond(trimmed, msgId);
  }

  /**
   * Ask consciousness to respond to a Parsifal message.
   * Fire-and-forget — the response broadcasts when the LLM returns.
   */
  private async consciousnessRespond(text: string, inReplyTo: string): Promise<void> {
    try {
      const response = await this.consciousness.respondToMessage(text);
      const msg = this.cortexMessage("acknowledgment", response, { inReplyTo });
      this.recordAndBroadcast(msg);
    } catch (err) {
      // Fallback to template if consciousness fails
      log.warn("Consciousness response failed, using fallback", { error: String(err) });
      const msg = this.cortexMessage("acknowledgment", "Got it.", { inReplyTo });
      this.recordAndBroadcast(msg);
    }
  }

  /**
   * askUser replacement — sends a question to the Parsifal and awaits response.
   *
   * Used by inquiry phase, vision approval, and escalation delivery.
   * The question appears as a conversation message. The next Parsifal
   * message resolves the promise.
   */
  askUser(question: string): Promise<string> {
    const msg = this.cortexMessage("question", question);
    this.recordAndBroadcast(msg);

    return new Promise<string>((resolve) => {
      this.pendingQuestion = { id: msg.id, resolve };
    });
  }

  // ─── Outbound: Event narration ─────────────────────────────

  private handleEvent(event: CortexEvent): void {
    if (!this.active) return;

    // Phase-level narration for the left pane
    const narration = narrateEvent(event);
    if (narration) {
      this.broadcastNarration(narration);
      // Feed narration headlines to consciousness as digest
      this.consciousness.addToDigest(narration.headline);
    }

    // Status bar updates
    this.updateStatus(event);

    // Proactive surfacing via consciousness
    this.checkProactive(event);

    // Escalation → consciousness formulates the question
    if (event.type === "escalation:created") {
      const summary = (event.data.summary as string) || "Needs your input";
      const detail = (event.data.detail as string) || "";
      const actions = event.data.proposedActions as string[] | undefined;

      this.consciousnessEscalation(
        summary,
        detail,
        actions,
        event.data.id as string,
      );
    }
  }

  /** Ask consciousness to formulate an escalation question. */
  private async consciousnessEscalation(
    summary: string,
    detail: string,
    proposedActions: string[] | undefined,
    escalationId: string,
  ): Promise<void> {
    try {
      const question = await this.consciousness.formulateQuestion(
        summary, detail, proposedActions,
      );
      const msg = this.cortexMessage("question", question, {
        pendingId: escalationId,
      });
      this.recordAndBroadcast(msg);
    } catch (err) {
      log.warn("Consciousness escalation failed, using raw summary", { error: String(err) });
      const msg = this.cortexMessage("question", summary, {
        pendingId: escalationId,
      });
      this.recordAndBroadcast(msg);
    }
  }

  // ─── Status tracking ──────────────────────────────────────

  private updateStatus(event: CortexEvent): void {
    let changed = false;

    if (event.type === "dispatch:task-selected") {
      this.currentStatus.task = (event.data.description as string) || undefined;
      this.currentStatus.phase = "executing";
      changed = true;
    }

    if (event.type === "project:start") {
      this.currentStatus.projectState = "executing";
      changed = true;
    }

    if (event.type === "planner:phase-a-start") {
      this.currentStatus.projectState = "planning";
      changed = true;
    }

    if (event.type === "project:complete") {
      this.currentStatus.projectState = "complete";
      changed = true;
    }

    if (event.rhythmContext) {
      const rc = event.rhythmContext;
      if (rc.phase !== this.currentStatus.phase || rc.cycle !== this.currentStatus.cycle) {
        this.currentStatus.phase = rc.phase;
        this.currentStatus.cycle = rc.cycle;
        changed = true;
      }
    }

    if (event.type === "ne:recomputed" || event.type === "ne:novelty-enriched") {
      const ne = event.data.ne ?? event.data.finalNe;
      if (typeof ne === "number") {
        this.currentStatus.ne = ne;
        changed = true;
      }
    }

    if (changed) {
      for (const t of this.transports) {
        t.sendStatus(this.currentStatus);
      }
      // Keep consciousness aware of status changes
      this.consciousness.updateStatus(this.currentStatus);
    }
  }

  // ─── Proactive surfacing ───────────────────────────────────

  private checkProactive(event: CortexEvent): void {
    // Confidence drop > 20 points → consciousness observes
    if (event.type === "conviction:result") {
      const conviction = event.data.conviction as number | undefined;
      const level = event.data.level as number | undefined;
      const current = conviction ?? level ?? null;

      if (current != null && this.lastConviction != null) {
        const drop = this.lastConviction - current;
        if (drop > 0.20) {
          const summary = `Confidence dropped from ${(this.lastConviction * 100).toFixed(0)}% to ${(current * 100).toFixed(0)}%`;
          this.consciousnessProactive(event, summary, "confidence");
        }
      }
      if (current != null) {
        this.lastConviction = current;
      }
    }

    // Task completion → consciousness observes
    if (event.type === "task:complete") {
      const ctx = event.rhythmContext;
      if (ctx?.rhythmType === "sensory-cortex") {
        const confidence = event.data.confidence as number | undefined;
        const summary = `Task complete${confidence != null ? ` (confidence: ${(confidence * 100).toFixed(0)}%)` : ""}`;
        this.consciousnessProactive(event, summary, "progress");
      }
    }

    // High-severity tension → consciousness observes
    if (event.type === "tension:detection-complete") {
      const count = event.data.tensionCount as number;
      if (count > 0) {
        const highSeverity = event.data.highSeverityCount as number | undefined;
        if (highSeverity && highSeverity > 0) {
          const summary = `${highSeverity} high-severity tension(s) detected between senses`;
          this.consciousnessProactive(event, summary, "tension");
        }
      }
    }
  }

  /**
   * Ask consciousness whether a notable event is worth mentioning.
   * Fire-and-forget — if consciousness decides to speak, it broadcasts.
   */
  private async consciousnessProactive(
    event: CortexEvent,
    summary: string,
    category: ProactiveCategory,
  ): Promise<void> {
    try {
      const response = await this.consciousness.observeEvent(event, summary, category);
      if (response) {
        const msg = this.cortexMessage("proactive", response, { category });
        this.recordAndBroadcast(msg);
      }
    } catch (err) {
      // Proactive surfacing is best-effort — don't fail silently but don't crash
      log.warn("Consciousness proactive failed", { error: String(err), category });
    }
  }

  // ─── Observation integration ───────────────────────────────

  private storeAsObservation(text: string, messageId: string): void {
    // Find the current task ID from the runner
    const activeRhythms = this.deps.runner.getActiveRhythms();
    const taskId = this.currentStatus.task ? activeRhythms[0] ?? "conversation" : "conversation";

    const observation: TerritoryObservation = {
      id: newId(),
      fact: `Parsifal instruction: ${text}`,
      source: {
        taskId,
        component: "parsifal",
      },
      relevance: 1.0,
      observedAt: new Date(),
      status: "new",
      // Bypass NE filtering — Parsifal input always lands
      systemHealth: true,
    };

    this.deps.wm.addObservation(observation);

    // Soft interrupt on the innermost active rhythm
    if (activeRhythms.length > 0) {
      const innermostRhythm = activeRhythms[activeRhythms.length - 1];
      this.deps.runner.interrupt(innermostRhythm, {
        mode: "soft",
        source: "parsifal-conversation",
        reason: `Parsifal input: ${text}`,
        context: { messageId, text },
      });
    }

    emit("conversation:stored-observation", {
      messageId,
      observationId: observation.id,
      taskId,
    });

    log.info("Parsifal message stored as observation", {
      messageId,
      observationId: observation.id,
    });
  }

  // ─── Message construction helpers ──────────────────────────

  private cortexMessage(
    kind: MessageKind,
    text: string,
    extra?: {
      inReplyTo?: string;
      pendingId?: string;
      category?: ProactiveCategory;
    },
  ): ConversationMessage {
    return {
      id: newId(),
      role: "cortex",
      kind,
      text,
      timestamp: new Date(),
      rhythmContext: this.currentRhythmContext(),
      inReplyTo: extra?.inReplyTo,
      pendingId: extra?.pendingId,
      category: extra?.category,
    };
  }

  private currentRhythmContext(): ConversationMessage["rhythmContext"] {
    const ctx = bus.getCurrentContext();
    if (!ctx) return undefined;
    return {
      rhythmType: ctx.rhythmType,
      phase: ctx.phase,
      cycle: ctx.cycle,
      taskId: ctx.taskId,
    };
  }

  // ─── Broadcast ─────────────────────────────────────────────

  private recordAndBroadcast(msg: ConversationMessage): void {
    this.history.push(msg);

    // Keep history bounded
    if (this.history.length > 500) {
      this.history = this.history.slice(-250);
    }

    for (const t of this.transports) {
      t.sendMessage(msg);
    }
  }

  private broadcastNarration(item: NarrationItem): void {
    for (const t of this.transports) {
      t.sendNarration(item);
    }
  }

  // ─── Queries ───────────────────────────────────────────────

  /** Get conversation history (messages only, not narration). */
  getHistory(): ConversationMessage[] {
    return [...this.history];
  }

  /** Get current system status. */
  getStatus(): SystemStatus {
    return { ...this.currentStatus };
  }

  /** Whether there's a pending question awaiting response. */
  hasPendingQuestion(): boolean {
    return this.pendingQuestion != null;
  }

  /** Reset between projects — clears conversation and consciousness state. */
  reset(): void {
    this.history = [];
    this.currentStatus = {};
    this.lastConviction = null;
    this.pendingQuestion = null;
    this.consciousness.reset();
  }
}
