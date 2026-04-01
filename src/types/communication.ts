/**
 * Communication — a cognitive function of the Cortex, not a separate agent.
 *
 * The Cortex IS Claus. When it makes a decision, it can speak from genuine
 * understanding — not because a separate observer read summaries, but because
 * the thing that decided IS the thing that communicates.
 *
 * Communication runs at natural rhythm decision points (gate evaluations,
 * phase transitions, scheduler actions) with FULL context. It can also
 * respond to Parsifal inbound messages with the same full awareness.
 *
 * Silence is the default. Most gate decisions don't warrant a message.
 * The communication function decides what's notable.
 */

// ─── Trigger ───────────────────────────────────────────────────

/** What prompted this communication opportunity. */
export type CommunicationTrigger =
  | "build-cycle-gate"      // After gate accepts/rejects work
  | "task-dispatch-gate"    // After conviction/scheduler decision
  | "phase-transition"      // Phase boundary crossed
  | "project-lifecycle"     // Project start, complete, greeting
  | "parsifal-inbound"      // Parsifal sent a message
  | "escalation"            // System needs Parsifal input
  | "threat-detected";      // Amygdala alarm

// ─── Context ───────────────────────────────────────────────────

/** Everything the communication function knows when deciding whether to speak. */
export interface CommunicationContext {
  /** What triggered this communication opportunity. */
  trigger: CommunicationTrigger;

  // ── Gate/conviction context (build-cycle-gate, task-dispatch-gate) ──

  /** The gate decision, if this is a gate trigger. */
  gateDecision?: {
    accept: boolean;
    strategy: string;
    reason: string;
  };

  /** Conviction state at the moment of decision. */
  conviction?: {
    level: number;
    verdict: string;
    delta: number;
    decidingStep: string;
  };

  /** Evaluation composite from the gate. */
  composite?: {
    weightedMean: number;
    weightedAcceptability: number;
    confidence: number;
  };

  /** Tensions between senses. */
  tensions?: Array<{
    senseA: string;
    senseB: string;
    severity: string;
  }>;

  /** Effective norepinephrine level (arousal/thoroughness). */
  effectiveNE?: number;

  /** Build cycle number (1-based). */
  cycle?: number;

  /** Current task description. */
  taskDescription?: string;

  /** Failure classification from the gate, if rejection occurred. */
  failureClassification?: string;

  /** Number of oscillating receptors. */
  oscillationCount?: number;

  /** Cognitive flexibility diagnosis, if reshape was triggered. */
  flexibilityDiagnosis?: string;

  /** Composite speed-of-light ceiling. */
  speedOfLightCeiling?: number;

  // ── Self-knowledge ──────────────────────────────────────────

  /** Self-model maxim statements — who am I. */
  selfMaxims: string[];

  /** Self-model narratives — identity-shaping stories. */
  selfNarratives: string[];

  /** World model maxim statements — what I understand about the situation. */
  worldMaxims: string[];

  /** Stream of awareness — what I've noticed across the project. */
  awareness?: string[];

  // ── Conversation ────────────────────────────────────────────

  /** Recent conversation history with the Parsifal. */
  recentConversation: Array<{ role: string; text: string }>;

  /** The worldview consciousness frame — shapes the voice. */
  consciousnessFrame: string;

  // ── Parsifal inbound ────────────────────────────────────────

  /** The Parsifal's message, if this is a parsifal-inbound trigger. */
  parsifalMessage?: string;

  // ── Escalation ──────────────────────────────────────────────

  /** Escalation context, if this is an escalation trigger. */
  escalation?: {
    summary: string;
    detail: string;
    proposedActions?: string[];
  };

  // ── Project lifecycle ───────────────────────────────────────

  /** Lifecycle event description (e.g. "project starting", "greeting"). */
  lifecycleEvent?: string;
}

// ─── Result ────────────────────────────────────────────────────

/** What the communication function produces. */
export interface CommunicationResult {
  /** The message to send, or null for silence. */
  message: string | null;
  /** Internal reasoning (for logging, not shown to Parsifal). */
  reasoning?: string;
}
