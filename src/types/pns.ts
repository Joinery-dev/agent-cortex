/**
 * Peripheral Nervous System — I/O Boundary types.
 *
 * The PNS is the brain's interface with the world. It defines what the system
 * can perceive (afferent) and do (efferent), and provides the intention→execution
 * pipeline that decouples cognition from tool implementation.
 *
 * The Intention type serves five consumers:
 *   PNS          — structural layer: what to execute
 *   Cerebellum   — semantic layer: what to predict against
 *   Hippocampus  — semantic layer: what to record
 *   Basal Ganglia — category + novelty: what routine to match
 *   Evaluators   — both layers: what was attempted vs. achieved
 */

// ── Intention ───────────────────────────────────────────────────
// What the brain wants to do in the world.

export interface Intention {
  id: string;
  taskId: string;

  // Semantic layer — feeds Cerebellum, Hippocampus, Basal Ganglia
  description: string;
  category: IntentionCategory;

  // Structural layer — feeds PNS executor
  operations: Operation[];
  dependencies: string[]; // intention IDs that must complete first
  checkpoint: boolean; // Motor Cortex explicitly requests proprioception pause

  // Signal metadata — feeds Dopamine, learning systems
  confidence: number; // [0-1] Motor Cortex self-assessment
  novelty: number; // [0-1] 0 = routine reuse, 1 = unprecedented

  // Lifecycle
  status: IntentionStatus;
  createdAt: Date;
  completedAt?: Date;
}

export type IntentionCategory =
  | "build" // create or modify artifacts
  | "observe" // read state without changing it
  | "communicate" // interact with human
  | "control"; // meta: undo, retry, pause

export type IntentionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export function createIntention(
  id: string,
  taskId: string,
  description: string,
  category: IntentionCategory,
  operations: Operation[],
  opts?: Partial<
    Pick<
      Intention,
      "dependencies" | "checkpoint" | "confidence" | "novelty"
    >
  >
): Intention {
  return {
    id,
    taskId,
    description,
    category,
    operations,
    dependencies: opts?.dependencies ?? [],
    checkpoint: opts?.checkpoint ?? false,
    confidence: opts?.confidence ?? 0.5,
    novelty: opts?.novelty ?? 0.5,
    status: "pending",
    createdAt: new Date(),
  };
}

// ── Operation ───────────────────────────────────────────────────
// A concrete step within an intention. The PNS translates these
// to actual tool calls. Motor Cortex thinks in effects on artifacts;
// the PNS figures out the mechanics.

export interface Operation {
  target: ArtifactRef;
  effect: Effect;
}

export type ArtifactRef =
  | { kind: "file"; path: string }
  | { kind: "deployment"; target: string }
  | { kind: "api"; endpoint: string; method?: string }
  | { kind: "environment"; aspect: string }
  | { kind: "human"; channel: string };

export type Effect =
  | { type: "create"; content: string }
  | { type: "modify"; description: string; delta?: string }
  | { type: "remove" }
  | { type: "verify"; condition: string }
  | { type: "query"; question: string }
  | { type: "send"; message: string; urgency: "normal" | "urgent" };

// ── Perception ──────────────────────────────────────────────────
// What comes back from the world. Either a response to an intention
// (efferent feedback) or an unsolicited signal (afferent input).
//
// The intentionId link is what lets Dopamine close the loop:
// intention → prediction → execution → perception → evaluation → prediction error

export interface Perception {
  id: string;
  intentionId?: string; // absent for unsolicited afferent signals
  taskId: string;

  // What happened — PNS, Proprioception
  success: boolean;
  result: unknown;
  sideEffects: SideEffect[];

  // What it means — Evaluators, Hippocampus (natural language)
  summary: string;

  // Origin — Thalamus uses this for routing decisions
  source: PerceptionSource;
  timestamp: Date;
  duration?: number; // ms, for efferent response times
}

export interface SideEffect {
  artifact: ArtifactRef;
  change: "created" | "modified" | "removed" | "unchanged";
  summary: string;
}

export type PerceptionSource =
  | { kind: "efferent"; intentionId: string }
  | {
      kind: "human";
      type: "feedback" | "approval" | "correction" | "answer";
    }
  | { kind: "environment"; type: "change" | "alert" | "event" }
  | { kind: "tool"; type: "result" | "error" };

// ── Capability ──────────────────────────────────────────────────
// What the system can perceive and do. The Thalamus queries the PNS
// capability registry to tell Motor Cortex what's available.

export interface Capability {
  id: string;
  name: string;
  description: string;
  direction: "afferent" | "efferent";
  category: CapabilityCategory;
  available: boolean; // can change per-project or per-task
  constraints?: string[];
  /** Links this capability to a concrete tool implementation. */
  toolBinding?: ToolBinding;
}

// ── Tool Binding ─────────────────────────────────────────────────
// Maps a Capability to its concrete implementation. The PNS uses
// these bindings to translate capability activations into Agent SDK
// tool configurations.

export interface ToolBinding {
  /** How this tool is provided. */
  kind: "agent-sdk" | "mcp" | "shell";
  /** Agent SDK tool name (e.g., "Read", "Bash") or MCP tool name. */
  toolName: string;
  /** MCP server name, when kind === "mcp". */
  serverName?: string;
  /** Innate capabilities are always available; acquired ones enter through tasks. */
  innate: boolean;
}

// ── Activated Tool Set ───────────────────────────────────────────
// The PNS curates which tools the Motor Cortex gets per-task,
// modulated by Norepinephrine level and Amygdala constraints.

export interface ActivatedToolSet {
  /** SDK tool names to pass to query().options.tools. */
  tools: string[];
  /** SDK tool names to auto-allow without permission prompt. */
  allowedTools: string[];
  /** Natural language summary for the motor cortex prompt. */
  systemContext: string;
  /** Capability IDs that were activated (for tracing). */
  activatedCapabilityIds: string[];
}

export type AfferentCategory =
  | "project_input" // briefs, taste, intent — arrives once at intake
  | "human_feedback" // approvals, corrections — event-driven, async
  | "tool_output" // file contents, API responses — request-response
  | "environment_state"; // what exists, what's deployed — pull-based

export type EfferentCategory =
  | "artifact_generation" // code, markup, config
  | "file_system" // read, write, create, modify
  | "tool_use" // API calls, shell commands, deployments
  | "human_communication"; // escalations, proposals, questions

export type CapabilityCategory = AfferentCategory | EfferentCategory;

// ── Checkpoint Policy ───────────────────────────────────────────
// Checkpoint frequency is modulated by neurotransmitter signals,
// not hardcoded by Motor Cortex. This is where Norepinephrine and
// Cerebellum first become load-bearing in the architecture.
//
// shouldCheckpoint =
//   intention.checkpoint                    (Motor Cortex explicit request)
//   || norepinephrine > arousalThreshold    (high thoroughness mode)
//   || predictionConfidence < uncertaintyThreshold  (cerebellum unsure)
//   || intention.novelty > noveltyThreshold (new territory)

export interface CheckpointPolicy {
  /** Norepinephrine above this → always checkpoint */
  arousalThreshold: number;
  /** Cerebellum confidence below this → checkpoint */
  uncertaintyThreshold: number;
  /** Intention novelty above this → checkpoint */
  noveltyThreshold: number;
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  arousalThreshold: 0.7,
  uncertaintyThreshold: 0.4,
  noveltyThreshold: 0.6,
};
