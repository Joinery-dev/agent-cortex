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
import { bus } from "../events.js";
import type { CortexEvent } from "../events.js";

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

    // Direct event bus subscription for real-time activity indicators.
    // These show compact status lines as the system works — the user
    // sees what's happening without waiting for narration.
    bus.onCortex((event) => this.handleActivityEvent(event));
  }

  /** Map raw events to compact activity indicators. */
  private handleActivityEvent(event: CortexEvent): void {
    if (this.closed) return;

    const statusText = this.eventToStatus(event);
    if (statusText) {
      this.spinner.update(statusText);
      if (!this.thinkingActive) {
        this.startThinking(statusText);
      }
    }
  }

  /** Convert events to spinner text. Returns null for irrelevant events. */
  private eventToStatus(event: CortexEvent): string | null {
    // ── Tier 1: Explicit mappings for high-value events ──

    switch (event.type) {
      // ── LLM calls (the most visible activity) ──
      case "llm:call-start": {
        const purposeLabels: Record<string, string> = {
          consultation: "consulting senses",
          motorCortex: "building",
          premotor: "planning approach",
          proprioception: "self-assessing",
          evaluation: "evaluating",
          resolution: "resolving tensions",
          inhibition: "selecting senses",
          potentiation: "crystallizing learning",
          weltanschauung: "synthesizing understanding",
          "cognitive-flexibility": "diagnosing stuck state",
          "drift-analysis": "analyzing drift",
          planner: "planning",
          explore: "exploring approaches",
          "efference-copy": "predicting feasibility",
          reconsultation: "re-consulting senses",
          agenticMotor: "building with tools",
          "integration-check": "checking cross-task coherence",
          simulation: "simulating scenarios",
          communication: "formulating response",
          "taste-proposal": "preparing taste observation",
          "sense-question": "answering builder question",
          "approach-classification": "classifying failure",
          "collapse-detection": "detecting collapse",
          "prospective-matching": "matching prospective triggers",
          "project-diagnostics": "running diagnostics",
        };
        const label = purposeLabels[event.data.purpose as string] ?? "thinking";
        return `calling intelligence — ${label}`;
      }
      case "llm:retry-success":
        return "retried successfully";
      case "llm:agentic-complete":
        return "agentic session complete";
      case "llm:schema-validation-failed":
        return "response validation failed — retrying";

      // ── Project lifecycle ──
      case "project:start":
        return "project starting";
      case "project:complete":
        return "project complete";
      case "project:greeting":
        return "greeting the Parsifal";

      // ── Inquiry ──
      case "planner:inquiry-start":
        return "senses asking questions";
      case "planner:inquiry-round":
        return `inquiry round ${event.data.round ?? "?"}`;
      case "planner:inquiry-converged":
        return `inquiry converged after ${event.data.rounds ?? "?"} rounds`;
      case "planner:inquiry-synthesized":
        return "synthesizing questions";

      // ── Vision / Manifestation ──
      case "planner:phase-a-start":
        return "exploring the vision";
      case "planner:phase-a-redirect":
        return "redirecting vision based on feedback";
      case "planner:phase-a-approved":
        return "vision approved";
      case "planner:phase-a-complete":
        return "vision crystallized";
      case "manifestation:start":
        return "senses manifesting the future";
      case "manifestation:sense-complete":
        return `sense manifested: ${event.data.senseName ?? ""}`;
      case "manifestation:synthesis-complete":
        return "vision synthesized";
      case "manifestation:evaluation-complete":
        return "vision evaluated";

      // ── Decomposition / Planning ──
      case "planner:phase-b-start":
        return "decomposing into tasks";
      case "planner:phase-b-complete":
        return "decomposition complete";
      case "planner:phase-c-start":
        return "reviewing the plan";
      case "planner:phase-c-complete":
        return "plan reviewed";
      case "planner:graph-build-start":
        return "building dependency graph";
      case "planner:graph-build-complete":
        return "graph built";
      case "planner:pfc-review":
        return "PFC reviewing plan";

      // ── Task dispatch ──
      case "dispatch:task-selected":
        return `starting: ${(event.data.description as string)?.slice(0, 50) ?? "next task"}`;
      case "dispatch:between-tasks":
        return "between tasks — consolidating";
      case "dispatch:phase-gate-check":
        return `checking phase gate: ${event.data.phaseGroup ?? ""}`;
      case "dispatch:observed":
        return "observing territory";
      case "dispatch:calibration-check":
        return "calibrating predictions";
      case "dispatch:rest-requested":
        return "rest requested";

      // ── Attention scheduler ──
      case "attention-budget:computed":
        return "computing attention budget";
      case "ne:enriched":
      case "ne:novelty-enriched":
        return "computing arousal level";
      case "ne:recomputed":
        return "recomputing arousal";

      // ── Sensory cortex ──
      case "task:start":
        return "beginning task";
      case "task:complete":
        return `task complete (${event.data.status ?? "done"})`;
      case "sensory-cortex:gate":
        return `outer cycle ${event.data.outerCycle ?? "?"} — ${event.data.action ?? "evaluating"}`;
      case "sensory-cortex:double-expected":
        return "taking longer than predicted";

      // ── Thalamus briefing ──
      case "thalamus:briefing": {
        const labels: Record<string, string> = {
          consultation: "assembling sense briefing",
          motor: "briefing the builder",
          evaluation: "briefing evaluator",
          scheduling: "briefing scheduler",
          escalation: "assembling escalation briefing",
          inhibition: "briefing inhibition gate",
          "integration-check": "briefing integration checker",
        };
        return labels[event.data.consumer as string] ?? null;
      }
      case "thalamus:gestalt-assembled":
        return "context snapshot assembled";
      case "thalamus:awareness-insight":
        return null; // Don't show awareness digestion in spinner
      case "thalamus:forward-briefing-set":
        return "forward briefing prepared";

      // ── Inhibition / Sense selection ──
      case "inhibition:result":
        return `${event.data.inhibitedCount ?? 0} sense(s) inhibited`;
      case "basal-ganglia:routine-match":
        return "routine match found";
      case "basal-ganglia:routine-formed":
        return "new routine learned";
      case "basal-ganglia:collapse-detected":
        return "collapse detected — broadening search";

      // ── Consultation ──
      case "consultation:complete":
        return "consultation complete";
      case "consultation:sense-complete":
        return `consulted: ${event.data.senseName ?? "sense"}`;

      // ── Explore phase ──
      case "explore:start":
        return "exploring alternative approaches";
      case "explore:path-selected":
        return `approach selected: ${(event.data.approach as string)?.slice(0, 40) ?? ""}`;
      case "explore:complete":
        return "exploration complete";

      // ── Efference copy ──
      case "motor:efference-copy":
        return "predicting build feasibility";

      // ── Build cycle ──
      case "cycle:start":
        return `build cycle ${event.data.cycle ?? "?"}`;
      case "motor:start":
        return event.data.isRevision ? "revising approach" : "planning the build";
      case "motor:plan-complete":
        return event.data.requiresAgentic ? "building with tools" : "building";
      case "motor:text-only-shortcut":
        return "text-only build (no tools needed)";
      case "motor:build-complete":
        return "build complete";
      case "motor:proprioception-complete": {
        const adh = event.data.planAdherence as number;
        return adh > 0.7
          ? "self-assessment: on track"
          : `self-assessment: drifted (${((adh ?? 0) * 100).toFixed(0)}% adherence)`;
      }
      case "motor:question-asked":
        return "builder asking sense for clarification";
      case "motor:question-answered":
        return "clarification received";
      case "motor:complete":
        return "motor cycle complete";

      // ── Delegation ──
      case "motor:delegation-start":
        return `delegating to child cortex (depth ${event.data.depth ?? "?"})`;
      case "motor:delegation-complete":
        return "child cortex completed";
      case "motor:delegation-failed":
        return "delegation failed — falling back";
      case "motor:delegation-learning":
        return "ingesting child experience";

      // ── Sandbox ──
      case "sandbox:created":
        return "created sandbox branch";
      case "sandbox:accepted":
        return "merging sandbox";
      case "sandbox:discarded":
        return "discarding sandbox";

      // ── Evaluation ──
      case "evaluation:start":
        return `evaluating: ${event.data.senseName ?? "sense"}`;
      case "evaluation:receptor-complete":
        return `scored: ${event.data.receptorName ?? "receptor"}`;
      case "evaluation:sense-complete":
        return `sense complete: ${event.data.senseName ?? ""}`;

      // ── Tension ──
      case "tension:detection-complete":
        return `${event.data.tensionCount ?? 0} tension(s) detected`;
      case "tension:resolution-start":
        return "resolving tensions";
      case "tension:resolution-complete":
        return "tensions resolved";

      // ── Gate decision ──
      case "conviction:start":
        return "testing conviction";
      case "conviction:result": {
        const v = event.data.verdict as string;
        return v === "proceed" ? "conviction: proceeding"
          : v === "reshape" ? "conviction: reshaping approach"
          : v === "escalate" ? "conviction: needs help"
          : `conviction: ${v}`;
      }
      case "gate:decision":
        return event.data.accept ? "gate: accepted ✓" : "gate: revising";
      case "gate:failure-classified":
        return `failure: ${event.data.failureMode ?? event.data.category ?? "classified"}`;
      case "gate:strategy-selected":
        return `gate strategy: ${event.data.strategy ?? "evaluating"}`;

      // ── Cognitive flexibility ──
      case "flexibility:assessment":
        return `flexibility: ${event.data.diagnosis ?? "diagnosing"}`;
      case "flexibility:dispatch-assessment":
        return `dispatch flexibility: ${event.data.diagnosis ?? "diagnosing"}`;
      case "flexibility:reset":
        return "strategy reset — starting fresh";

      // ── Communication ──
      case "communication:message":
        return null; // Messages handled by sendMessage
      case "cortex-parsifal:resolved":
        return "parent resolved child question";

      // ── Escalation ──
      case "escalation:created":
        return "escalating to Parsifal";
      case "escalation:resolved":
        return "Parsifal responded";

      // ── Parsifal actions ──
      case "parsifal-action:pause":
        return "pausing";
      case "parsifal-action:resume":
        return "resuming";
      case "parsifal-action:redirect":
        return "redirecting approach";
      case "parsifal-action:revert":
        return "reverting work";
      case "parsifal-action:skip":
        return "skipping task";
      case "parsifal-action:add-task":
        return "adding task to plan";

      // ── Dopamine / Reward ──
      case "dopamine:distributed":
        return "processing reward signal";
      case "dopamine:tonic-update":
        return `baseline motivation: ${event.data.trend ?? "stable"}`;

      // ── Hippocampus / Learning ──
      case "hippocampus:loaded":
        return "loading memory";
      case "hippocampus:episode-recorded":
        return "recording experience";
      case "hippocampus:potentiation-complete":
        return `learning: ${event.data.principlesExtracted ?? 0} principle(s) extracted`;
      case "hippocampus:principle-extracted":
        return "crystallized a principle";
      case "hippocampus:principle-refined":
        return "refined a principle";
      case "hippocampus:principle-replaced":
        return "understanding changed";
      case "hippocampus:simulation":
        return "simulating future scenarios";
      case "hippocampus:simulation-outcome":
        return "simulation outcome recorded";
      case "hippocampus:child-episodes-ingested":
        return "learning from child experience";
      case "hippocampus:child-principles-ingested":
        return "inheriting child principles";

      // ── Plasticity ──
      case "plasticity:updated":
        return "updating connection weights";
      case "plasticity:fixation-window":
        return "weight fixation window active";

      // ── World model ──
      case "world-model:loaded":
        return "loading world model";
      case "world-model:rebuilt":
        return "rebuilding understanding";
      case "world-model:maxim-evolved":
        return "understanding shifted";
      case "world-model:maxim-dropped":
        return "dropped a maxim";
      case "world-model:narratives-updated":
        return "self-narratives evolved";
      case "world-model:project-bound":
        return "bound to project";

      // ── Drift ──
      case "drift-monitor:quick-check":
        return "checking alignment";
      case "drift-monitor:deep-analysis":
        return "deep drift analysis";
      case "drift-monitor:level-changed":
        return `drift level changed: ${event.data.direction ?? ""}`;

      // ── Homeostasis ──
      case "vitals:update":
        return null; // Too frequent
      case "vitals:reflex":
        return `health reflex: ${(event.data.actions as Array<{type: string}>)?.map(a => a.type).join(", ") ?? ""}`;
      case "vitals:cumulative-ne":
        return null; // Too frequent

      // ── Rest ──
      case "rest:start":
        return "resting — consolidating memory";
      case "rest:potentiation":
        return "rest: extracting principles";
      case "rest:wm-prune":
        return "rest: pruning working memory";
      case "rest:complete":
        return "rest complete";

      // ── Graph surgery ──
      case "surgery:insert":
        return "inserting new task";
      case "surgery:amend":
        return "amending task";
      case "surgery:rework":
        return "reopening task for rework";
      case "surgery:reorder":
        return "reordering dependencies";
      case "surgery:complete":
        return "plan updated";

      // ── Nursery ──
      case "nursery:start":
        return "stress-testing completed phase";
      case "nursery:graduate":
        return "phase graduated from nursery";
      case "nursery:fix-task-inserted":
        return "nursery found issue — fix task added";

      // ── Quick triage / Deep synthesis ──
      case "quick-triage:complete":
        return "observations triaged";
      case "deep-synthesis:complete":
        return "deep synthesis complete";
      case "deep-synthesis:surgery-proposed":
        return "synthesis proposed plan changes";

      // ── Prospective memory ──
      case "prospective-memory:trigger-fired":
        return `triggered: ${(event.data.description as string)?.slice(0, 40) ?? "prospective memory"}`;
      case "prospective-memory:registered":
        return "registered future intention";

      // ── Exteroception ──
      case "exteroception:signal-stored":
        return "external signal detected";
      case "exteroception:urgent-signal":
        return "urgent external signal!";
      case "exteroception:cadence-adjusted":
        return "monitoring cadence adjusted";

      // ── Checkpoints ──
      case "checkpoint:created":
        return "checkpoint saved";

      // ── PNS ──
      case "pns:tools-activated":
        return `${event.data.toolCount ?? "?"} tool(s) activated`;
      case "pns:capability-acquired":
        return "new capability acquired";

      // ── Amygdala ──
      case "amygdala:alarm":
        return "threat detected!";
      case "amygdala:alarm-resolved":
        return "threat resolved";

      // ── References ──
      case "references:loaded":
        return "references loaded";
      case "references:added":
        return `reference added: ${event.data.label ?? ""}`;

      // ── Taste feedback ──
      case "taste-feedback:divergence-detected":
        return "taste divergence detected";
      case "taste-feedback:proposal-generated":
        return "taste proposal ready";
      case "taste-feedback:response-received":
        return "taste feedback received";

      // ── Integration check ──
      case "integration-check:complete":
        return event.data.passed ? "integration check passed" : "integration issues found";
    }

    // ── Tier 2: Namespace-based fallback ──
    // For the ~200 events not explicitly mapped, use the namespace
    const ns = event.type.split(":")[0];
    const fallbacks: Record<string, string | null> = {
      exec: "controlling execution",
      llm: "calling intelligence",
      planner: "planning",
      motor: "building",
      evaluation: "evaluating",
      gate: "gate decision",
      conviction: "testing conviction",
      consultation: "consulting",
      thalamus: "routing context",
      wm: "updating memory",
      hippocampus: "learning",
      plasticity: "updating weights",
      dispatch: "dispatching",
      project: "project",
      task: "working",
      "drift-monitor": "monitoring drift",
      vitals: null, // Too noisy
      "world-model": "synthesizing",
      flexibility: "diagnosing",
      rest: "resting",
      surgery: "updating plan",
      nursery: "stress-testing",
      exteroception: "monitoring",
      amygdala: "threat assessment",
      cerebellum: "predicting",
      dopamine: "processing reward",
      "basal-ganglia": "checking routines",
    };
    return fallbacks[ns] ?? null;
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
