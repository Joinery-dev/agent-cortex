/**
 * Conversation Cortex — the layer between Cortex and the Parsifal.
 *
 * Three responsibilities:
 *   1. Inbound:  Parsifal messages → communication function → WM observations
 *   2. Outbound: Event bus → phase-level narration → transport
 *   3. Proactive: Communication events from rhythm gates → conversation
 *
 * Communication is a cognitive function of the Cortex — not a separate
 * agent. The Cortex IS Claus. When it speaks, it speaks from genuine
 * understanding because it was there when the decision was made.
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
  PlanSnapshot,
  PlanNode,
  ArtifactItem,
} from "../types/conversation.js";
import type { TerritoryObservation } from "../types/territory-observation.js";
import type { CortexEvent } from "../events.js";
import type { WorkingMemory } from "./working-memory.js";
import type { RhythmRunnerImpl } from "../brainstem/runner.js";
import type { EscalationHandler } from "../brainstem/escalation-handler.js";
import type { Thalamus } from "./thalamus.js";
import type { Worldview } from "../types/worldview.js";
import type { WorldModel } from "./world-model.js";
import { communicate } from "./communication.js";
import { ConversationSession } from "./conversation-session.js";
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
  worldview?: Worldview;
  worldModel?: WorldModel;
  costTracker?: import("../brainstem/cost-tracker.js").CostTracker | null;
  pns?: import("../kernel/pns.js").PeripheralNervousSystem;
}

export class ConversationCortex {
  private deps: ConversationCortexDeps;
  private transports: ConversationTransport[] = [];
  private history: ConversationMessage[] = [];
  private active = false;
  /** External direction handlers registered by ParsifaInterface implementations. */
  private externalDirectionHandlers: Array<(text: string) => void> = [];
  /** Guard against re-entrant receive() calls. */
  private receiving = false;
  /** Persistent agentic conversation session — maintains context across turns. */
  private session: ConversationSession | null = null;

  /** Pending question awaiting a Parsifal response (askUser replacement). */
  private pendingQuestion: {
    id: string;
    resolve: (answer: string) => void;
  } | null = null;

  /** Current system status for the status bar. */
  private currentStatus: SystemStatus = {};

  /** Last conviction level — for detecting drops. */
  private lastConviction: number | null = null;

  /** Live plan state — maintained from plan events, broadcast to transports. */
  private planNodes = new Map<string, PlanNode>();
  private planVision: string | null = null;
  private planPhases: Array<{ name: string; purpose: string }> = [];

  /** Artifacts produced by completed tasks. */
  private artifacts: ArtifactItem[] = [];

  constructor(deps: ConversationCortexDeps) {
    this.deps = deps;
  }

  // ─── Transport management ──────────────────────────────────

  /** Add a transport (terminal, WebSocket, etc). Multiple can be active. */
  addTransport(transport: ConversationTransport): void {
    this.transports.push(transport);
    transport.onReceive((text) => this.receive(text));

    // Send current status to the new transport
    transport.sendStatus(this.currentStatus);

    // Send recent conversation history so late-joining transports catch up
    const recent = this.history.slice(-50);
    for (const msg of recent) {
      if (msg.kind !== "narration") {
        transport.sendMessage(msg);
      }
    }

    // Send current plan state if we have one
    if (this.planNodes.size > 0) {
      transport.sendPlan({
        kind: "full",
        vision: this.planVision ?? undefined,
        nodes: [...this.planNodes.values()],
        phases: this.planPhases,
      });
    }

    // Send existing artifacts
    for (const artifact of this.artifacts) {
      transport.sendArtifact(artifact);
    }
  }

  /** Remove a transport. */
  removeTransport(transport: ConversationTransport): void {
    this.transports = this.transports.filter((t) => t !== transport);
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /** Start listening to the event bus. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    bus.onCortex((event) => this.handleEvent(event));

    log.info("Conversation cortex activated");
  }

  /** Stop listening, close all transports. */
  deactivate(): void {
    this.active = false;
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

    // Guard against re-entrant calls (external direction handlers can trigger receive)
    if (this.receiving) return;
    this.receiving = true;
    try {
      this.receiveInner(trimmed);
    } finally {
      this.receiving = false;
    }
  }

  private receiveInner(trimmed: string): void {

    const msgId = newId();

    // Record the incoming message in history (but don't broadcast back to
    // transport — readline already showed the user's input)
    const inbound: ConversationMessage = {
      id: msgId,
      role: "parsifal",
      kind: "message",
      text: trimmed,
      timestamp: new Date(),
      rhythmContext: this.currentRhythmContext(),
    };
    this.history.push(inbound);
    if (this.history.length > 500) {
      this.history = this.history.slice(-250);
    }

    emit("conversation:received", {
      messageId: msgId,
      text: trimmed.slice(0, 200),
    });

    // 1. Pending question (askUser replacement)?
    if (this.pendingQuestion) {
      const pq = this.pendingQuestion;
      this.pendingQuestion = null;

      // Respond, then resolve
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

    // 3. Communication function responds + store as WM observation + soft interrupt
    this.storeAsObservation(trimmed, msgId);
    this.consciousnessRespond(trimmed, msgId);

    // Notify external direction handlers (ParsifaInterface consumers)
    for (const handler of this.externalDirectionHandlers) {
      try { handler(trimmed); } catch { /* handler errors don't break receive */ }
    }
  }

  /**
   * The Cortex responds to a Parsifal message — speaking from genuine understanding.
   *
   * Two modes:
   *   - With PNS: persistent agentic session with tools (Read, Grep, Bash).
   *     Claus remembers everything it discovered across turns.
   *   - Without PNS: single-turn structured call (fast, no tools).
   */
  private async consciousnessRespond(text: string, inReplyTo: string): Promise<void> {
    try {
      let result: import("../types/communication.js").CommunicationResult;

      if (this.deps.pns) {
        // Persistent session mode — Claus has tools and remembers across turns
        if (!this.session) {
          this.session = new ConversationSession({
            pns: this.deps.pns,
            worldModel: this.deps.worldModel,
            thalamus: this.deps.thalamus,
            worldview: this.deps.worldview,
          });
        }
        result = await this.session.respond(text);
      } else {
        // Fallback: single-turn structured call (no tools)
        result = await communicate({
          trigger: "parsifal-inbound",
          parsifalMessage: text,
          selfMaxims: this.deps.worldModel?.getSelfMaxims()?.map((m) => m.statement) ?? [],
          selfNarratives: this.deps.worldModel?.getSelfNarratives()?.map((n) => n.narrative) ?? [],
          worldMaxims: this.deps.worldModel?.getMaximsForBriefing() ?? [],
          awareness: this.deps.thalamus.getAwarenessSummaries(),
          recentConversation: this.history.slice(-20).map((m) => ({
            role: m.role,
            text: m.text,
          })),
          consciousnessFrame: this.deps.worldview?.frames?.consciousness ?? "",
        });
      }

      const msg = this.cortexMessage("acknowledgment", result.message ?? "Got it.", { inReplyTo });
      this.recordAndBroadcast(msg);

      // Dispatch action if the communication function detected an action intent
      if (result.action && result.action.type !== "none") {
        this.dispatchAction(result.action);
      }
    } catch (err) {
      log.warn("Communication response failed, using fallback", { error: String(err) });
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
  async askUser(question: string): Promise<string> {
    // Route through communication so the question comes in the Cortex's voice
    let formulated: string;
    try {
      const result = await communicate({
        trigger: "escalation",
        escalation: { summary: question, detail: "" },
        selfMaxims: this.deps.worldModel?.getSelfMaxims()?.map((m) => m.statement) ?? [],
        selfNarratives: this.deps.worldModel?.getSelfNarratives()?.map((n) => n.narrative) ?? [],
        worldMaxims: this.deps.worldModel?.getMaximsForBriefing() ?? [],
        awareness: this.deps.thalamus.getAwarenessSummaries(),
        recentConversation: this.history.slice(-10).map((m) => ({
          role: m.role,
          text: m.text,
        })),
        consciousnessFrame: this.deps.worldview?.frames?.consciousness ?? "",
      });
      formulated = result.message ?? question;
    } catch {
      formulated = question; // fallback to raw question
    }

    const msg = this.cortexMessage("question", formulated);
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
    }

    // Status bar updates
    this.updateStatus(event);

    // Plan + artifact tracking for the right-pane tabs
    this.handlePlanEvent(event);

    // Communication events from rhythm gates → conversation
    if (event.type === "communication:message") {
      const text = event.data.message as string;
      const msg = this.cortexMessage("proactive", text);
      this.recordAndBroadcast(msg);
    }

    // Critical awareness insight → proactive surfacing
    // The communication function decides whether this is worth telling the Parsifal.
    if (event.type === "thalamus:awareness-insight") {
      const severity = event.data.severity as string;
      if (severity === "critical") {
        const summary = event.data.summary as string;
        this.proactiveSurface(summary);
      }
    }

    // Escalation → communication function formulates the question
    if (event.type === "escalation:created") {
      const escalationId = event.data.id as string;

      // Get the full escalation from the handler (has detail, question, proposedActions)
      const active = this.deps.escalationHandler.getActive();
      const escalation = active.find((e) => e.id === escalationId);

      const summary = escalation?.question || escalation?.summary || (event.data.summary as string) || "Needs your input";
      const detail = escalation?.detail || "";
      const actions = escalation?.proposedActions;

      this.consciousnessEscalation(summary, detail, actions, escalationId);
    }
  }

  /** Formulate an escalation question through the communication function. */
  private async consciousnessEscalation(
    summary: string,
    detail: string,
    proposedActions: string[] | undefined,
    escalationId: string,
  ): Promise<void> {
    try {
      const result = await communicate({
        trigger: "escalation",
        escalation: { summary, detail, proposedActions },
        selfMaxims: this.deps.worldModel?.getSelfMaxims()?.map((m) => m.statement) ?? [],
        selfNarratives: this.deps.worldModel?.getSelfNarratives()?.map((n) => n.narrative) ?? [],
        worldMaxims: this.deps.worldModel?.getMaximsForBriefing() ?? [],
        awareness: this.deps.thalamus.getAwarenessSummaries(),
        recentConversation: this.history.slice(-10).map((m) => ({
          role: m.role,
          text: m.text,
        })),
        consciousnessFrame: this.deps.worldview?.frames?.consciousness ?? "",
      });
      const msg = this.cortexMessage("question", result.message ?? summary, {
        pendingId: escalationId,
      });
      this.recordAndBroadcast(msg);
    } catch (err) {
      log.warn("Communication escalation failed, using raw summary", { error: String(err) });
      const msg = this.cortexMessage("question", summary, {
        pendingId: escalationId,
      });
      this.recordAndBroadcast(msg);
    }
  }

  /**
   * Proactively surface a critical awareness insight to the Parsifal.
   * The communication function decides whether this is actually worth saying.
   * Most of the time, even critical insights don't need Parsifal attention —
   * the system handles them internally. But sometimes Claus should speak up.
   */
  private async proactiveSurface(insightSummary: string): Promise<void> {
    try {
      const result = await communicate({
        trigger: "awareness-surfacing",
        taskDescription: insightSummary,
        selfMaxims: this.deps.worldModel?.getSelfMaxims()?.map((m) => m.statement) ?? [],
        selfNarratives: this.deps.worldModel?.getSelfNarratives()?.map((n) => n.narrative) ?? [],
        worldMaxims: this.deps.worldModel?.getMaximsForBriefing() ?? [],
        awareness: this.deps.thalamus.getAwarenessSummaries(),
        recentConversation: this.history.slice(-10).map((m) => ({
          role: m.role,
          text: m.text,
        })),
        consciousnessFrame: this.deps.worldview?.frames?.consciousness ?? "",
      });
      if (result.message) {
        const msg = this.cortexMessage("proactive", result.message);
        this.recordAndBroadcast(msg);
      }
    } catch (err) {
      log.debug("Proactive surfacing failed — silence is fine", { error: String(err) });
    }
  }

  // ─── Parsifal Action Dispatch ────────────────────────────

  /**
   * Execute an action directive from the communication function.
   * The Parsifal's message was interpreted as requesting an action —
   * Claus acts on their behalf.
   */
  private dispatchAction(action: import("../types/communication.js").ParsifaAction): void {
    log.info("Dispatching Parsifal action", { type: action.type });

    switch (action.type) {
      case "pause": {
        // Hard interrupt the innermost active rhythm
        const rhythms = this.deps.runner.getActiveRhythms();
        if (rhythms.length > 0) {
          this.deps.runner.interrupt(rhythms[rhythms.length - 1], {
            mode: "hard",
            source: "parsifal-conversation",
            reason: action.reason,
            context: { parsifaAction: "pause" },
          });
          emit("parsifal-action:pause", { reason: action.reason });
        }
        break;
      }

      case "resume": {
        // Resolve the oldest active escalation with the guidance
        const active = this.deps.escalationHandler.getActive();
        if (active.length > 0) {
          this.deps.escalationHandler.resolve(active[0].id, {
            answer: action.guidance,
            directive: action.guidance,
            resolvedAt: new Date(),
          });
          emit("parsifal-action:resume", { guidance: action.guidance });
        }
        break;
      }

      case "redirect": {
        // Soft interrupt with strategic guidance — the next gate will see it
        const rhythms = this.deps.runner.getActiveRhythms();
        if (rhythms.length > 0) {
          this.deps.runner.interrupt(rhythms[rhythms.length - 1], {
            mode: "soft",
            source: "parsifal-conversation",
            reason: action.guidance,
            context: { parsifaAction: "redirect", guidance: action.guidance },
          });
          emit("parsifal-action:redirect", { guidance: action.guidance });
        }
        break;
      }

      case "revert": {
        // Store as high-priority WM observation — the gate will see it and act
        this.deps.wm.addObservation({
          id: newId(),
          fact: `Parsifal requested revert: ${action.reason}`,
          source: { taskId: "", component: "parsifal" },
          relevance: 1.0,
          observedAt: new Date(),
          status: "new",
          systemHealth: true,
        });
        emit("parsifal-action:revert", { reason: action.reason });
        break;
      }

      case "skip": {
        // Store as observation — task-dispatch will see it at next scheduling decision
        this.deps.wm.addObservation({
          id: newId(),
          fact: `Parsifal requested skip task ${action.taskId}: ${action.reason}`,
          source: { taskId: action.taskId, component: "parsifal" },
          relevance: 1.0,
          observedAt: new Date(),
          status: "new",
          systemHealth: true,
        });
        emit("parsifal-action:skip", { taskId: action.taskId, reason: action.reason });
        break;
      }

      case "add-task": {
        // Store as observation — the next planning/triage cycle will pick it up
        this.deps.wm.addObservation({
          id: newId(),
          fact: `Parsifal requested new task: ${action.description} (reason: ${action.reason})`,
          source: { taskId: "", component: "parsifal" },
          relevance: 1.0,
          observedAt: new Date(),
          status: "new",
          systemHealth: true,
        });
        emit("parsifal-action:add-task", { description: action.description, reason: action.reason });
        break;
      }

      case "run-task": {
        // Start the full cognitive loop — planning, building, evaluating, learning.
        // Emit event so the CLI can pick it up and call cortex.run().
        // ConversationCortex doesn't have access to the Cortex instance directly,
        // so we emit and let the CLI wire the execution.
        emit("parsifal-action:run-task", { description: action.description });
        break;
      }

      case "none":
        break;
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

  // ─── Plan & artifact tracking ───────────────────────────────

  private handlePlanEvent(event: CortexEvent): void {
    // Full plan established (after hierarchical planning + PFC review)
    if (event.type === "plan:established") {
      const nodes = event.data.nodes as PlanNode[];
      const vision = event.data.vision as string;
      const phases = event.data.phases as Array<{ name: string; purpose: string }>;

      this.planNodes.clear();
      for (const node of nodes) {
        this.planNodes.set(node.id, node);
      }
      this.planVision = vision;
      this.planPhases = phases;

      this.broadcastPlan({ kind: "full", vision, nodes, phases });
      return;
    }

    // Shana (leaf tasks) added during JIT per-shael planning
    if (event.type === "plan:nodes-added") {
      const nodes = event.data.nodes as PlanNode[];
      for (const node of nodes) {
        this.planNodes.set(node.id, node);
      }
      this.broadcastPlan({ kind: "update", nodes });
      return;
    }

    // Single node status change (active, complete, escalated)
    if (event.type === "plan:node-update") {
      const id = event.data.id as string;
      const status = event.data.status as PlanNode["status"];
      const confidence = event.data.confidence as number | undefined;
      const existing = this.planNodes.get(id);
      if (existing) {
        existing.status = status;
        if (confidence != null) existing.confidence = confidence;
        this.broadcastPlan({ kind: "update", nodes: [existing] });
      }
      return;
    }

    // Artifact produced by a completed task
    if (event.type === "artifact:produced") {
      const artifact: ArtifactItem = {
        id: event.data.taskId as string,
        title: event.data.title as string,
        work: event.data.work as string,
        confidence: event.data.confidence as number,
        completedAt: new Date(event.timestamp),
        shaelId: event.data.shaelId as string | undefined,
      };
      this.artifacts.push(artifact);
      this.broadcastArtifact(artifact);
    }
  }

  private broadcastPlan(plan: PlanSnapshot): void {
    for (const t of this.transports) {
      t.sendPlan(plan);
    }
  }

  private broadcastArtifact(artifact: ArtifactItem): void {
    for (const t of this.transports) {
      t.sendArtifact(artifact);
    }
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

  // ─── ParsifaInterface support ───────────────────────────────

  /** Broadcast a proactive message to all transports. Used by HumanParsifal.notify(). */
  broadcastProactive(text: string): void {
    const msg = this.cortexMessage("proactive", text);
    this.recordAndBroadcast(msg);
  }

  /** Register handler for external direction. Used by HumanParsifal.onDirection(). */
  onExternalDirection(handler: (text: string) => void): void {
    this.externalDirectionHandlers.push(handler);
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

  /** Reset between projects — clears conversation state. */
  reset(): void {
    this.history = [];
    this.currentStatus = {};
    this.lastConviction = null;
    this.pendingQuestion = null;
    this.planNodes.clear();
    this.planVision = null;
    this.planPhases = [];
    this.artifacts = [];
    this.session?.clear();
    this.session = null;
  }
}
