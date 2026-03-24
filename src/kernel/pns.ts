/**
 * Peripheral Nervous System — the brain's interface with the world.
 *
 * Three responsibilities:
 * 1. Capability registry — what the system can perceive and do (queried by Thalamus)
 * 2. Intention execution — translates Motor Cortex intentions to tool calls
 * 3. Afferent routing — receives unsolicited signals from the world
 *
 * Checkpoint frequency is modulated by neurotransmitter signals (Norepinephrine,
 * Cerebellum confidence) rather than hardcoded — this is where the neurotransmitter
 * architecture first becomes load-bearing.
 *
 * Design: Option B (Motor Cortex emits intentions, PNS translates),
 * implemented pragmatically through Option A (PNS configures Agent SDK tools).
 * The abstraction is real; the implementation uses existing infrastructure.
 */

import type {
  Intention,
  Perception,
  Capability,
  CapabilityCategory,
  CheckpointPolicy,
  PerceptionSource,
  ArtifactRef,
  Operation,
  SideEffect,
} from "../types/pns.js";
import { DEFAULT_CHECKPOINT_POLICY } from "../types/pns.js";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("pns");

/**
 * Neurotransmitter signals that modulate PNS behavior.
 * Passed in from other brain regions at execution time.
 */
export interface NeurotransmitterSignals {
  /** Norepinephrine: arousal/thoroughness level [0-1] */
  norepinephrine: number;
  /** Cerebellum's prediction confidence for this intention [0-1] */
  predictionConfidence?: number;
}

export class PeripheralNervousSystem {
  private capabilities = new Map<string, Capability>();
  private checkpointPolicy: CheckpointPolicy;

  constructor(policy: CheckpointPolicy = DEFAULT_CHECKPOINT_POLICY) {
    this.checkpointPolicy = policy;
  }

  // ── Capability Registry ─────────────────────────────────────
  // The Thalamus queries this to include available capabilities
  // in Motor Cortex briefings. Capabilities can be scoped per-project
  // (static site has different tools than an API project).

  registerCapability(capability: Capability): void {
    this.capabilities.set(capability.id, capability);

    emit("pns:capability-registered", {
      id: capability.id,
      name: capability.name,
      direction: capability.direction,
      category: capability.category,
    });

    log.info("Capability registered", {
      id: capability.id,
      name: capability.name,
    });
  }

  removeCapability(id: string): void {
    const cap = this.capabilities.get(id);
    if (cap) {
      this.capabilities.delete(id);
      emit("pns:capability-removed", { id, name: cap.name });
    }
  }

  getCapabilities(filter?: {
    direction?: "afferent" | "efferent";
    category?: CapabilityCategory;
    availableOnly?: boolean;
  }): Capability[] {
    let caps = Array.from(this.capabilities.values());

    if (filter?.direction) {
      caps = caps.filter((c) => c.direction === filter.direction);
    }
    if (filter?.category) {
      caps = caps.filter((c) => c.category === filter.category);
    }
    if (filter?.availableOnly !== false) {
      caps = caps.filter((c) => c.available);
    }

    return caps;
  }

  /**
   * Natural-language summary of available capabilities for inclusion
   * in Thalamus-assembled briefings.
   */
  describeCapabilities(filter?: {
    direction?: "afferent" | "efferent";
  }): string {
    const caps = this.getCapabilities({ ...filter, availableOnly: true });
    if (caps.length === 0) return "No capabilities available.";

    const afferent = caps.filter((c) => c.direction === "afferent");
    const efferent = caps.filter((c) => c.direction === "efferent");
    const lines: string[] = [];

    if (afferent.length > 0 && filter?.direction !== "efferent") {
      lines.push("Can perceive:");
      for (const cap of afferent) {
        lines.push(`  - ${cap.name}: ${cap.description}`);
      }
    }

    if (efferent.length > 0 && filter?.direction !== "afferent") {
      lines.push("Can do:");
      for (const cap of efferent) {
        lines.push(`  - ${cap.name}: ${cap.description}`);
      }
    }

    return lines.join("\n");
  }

  // ── Intention Execution ─────────────────────────────────────
  // Translates intentions to tool calls and returns perceptions.
  //
  // Phase 1: skeleton — records intended effects, returns structured
  //          perceptions. No real tool execution yet.
  // Phase 2: Motor Cortex becomes agentic — operations resolve to
  //          Agent SDK tool calls via abstract tool definitions.

  async execute(
    intention: Intention,
    signals: NeurotransmitterSignals
  ): Promise<Perception> {
    const startTime = Date.now();

    emit("pns:execute-start", {
      intentionId: intention.id,
      category: intention.category,
      operationCount: intention.operations.length,
      description: intention.description,
    });

    log.info("Executing intention", {
      id: intention.id,
      category: intention.category,
      operations: intention.operations.length,
    });

    intention.status = "executing";

    try {
      const sideEffects: SideEffect[] = [];

      for (const op of intention.operations) {
        // Phase 2: resolve each operation to a concrete tool call.
        // For now, record the intended effect.
        sideEffects.push({
          artifact: op.target,
          change: effectToChange(op.effect.type),
          summary: describeOperation(op),
        });
      }

      intention.status = "completed";
      intention.completedAt = new Date();

      const perception: Perception = {
        id: newId(),
        intentionId: intention.id,
        taskId: intention.taskId,
        success: true,
        result: null,
        sideEffects,
        summary: `Executed: ${intention.description}`,
        source: { kind: "efferent", intentionId: intention.id },
        timestamp: new Date(),
        duration: Date.now() - startTime,
      };

      emit("pns:execute-complete", {
        intentionId: intention.id,
        success: true,
        duration: perception.duration,
        sideEffects: sideEffects.length,
      });

      return perception;
    } catch (err) {
      intention.status = "failed";

      const perception: Perception = {
        id: newId(),
        intentionId: intention.id,
        taskId: intention.taskId,
        success: false,
        result: String(err),
        sideEffects: [],
        summary: `Failed: ${intention.description} — ${String(err)}`,
        source: { kind: "efferent", intentionId: intention.id },
        timestamp: new Date(),
        duration: Date.now() - startTime,
      };

      emit("pns:execute-failed", {
        intentionId: intention.id,
        error: String(err),
      });

      log.error("Intention execution failed", {
        id: intention.id,
        error: String(err),
      });

      return perception;
    }
  }

  // ── Checkpoint Resolution ───────────────────────────────────
  // The Motor Cortex can request a checkpoint explicitly, but the
  // system also injects checkpoints based on neurotransmitter state.
  // This is the proprioception gate: should we pause and look at
  // what just happened before continuing?

  shouldCheckpoint(
    intention: Intention,
    signals: NeurotransmitterSignals
  ): boolean {
    // Motor Cortex explicitly requested — always respect
    if (intention.checkpoint) return true;

    const { norepinephrine, predictionConfidence } = signals;
    const p = this.checkpointPolicy;

    // High arousal → more checkpoints (being thorough)
    if (norepinephrine > p.arousalThreshold) return true;

    // Low prediction confidence → checkpoint (cerebellum is uncertain)
    if (
      predictionConfidence !== undefined &&
      predictionConfidence < p.uncertaintyThreshold
    ) {
      return true;
    }

    // Novel intention → checkpoint (haven't done this before)
    if (intention.novelty > p.noveltyThreshold) return true;

    return false;
  }

  // ── Afferent Signal Reception ───────────────────────────────
  // Unsolicited signals from the world: human feedback arrives,
  // environment changes, something breaks. These become Perceptions
  // with no intentionId — the Thalamus routes them to the right
  // consumer (Amygdala for urgent, Attention Scheduler for new input).

  receiveAfferent(
    taskId: string,
    source: PerceptionSource,
    data: unknown,
    summary: string
  ): Perception {
    const perception: Perception = {
      id: newId(),
      taskId,
      success: true,
      result: data,
      sideEffects: [],
      summary,
      source,
      timestamp: new Date(),
    };

    emit("pns:afferent", {
      perceptionId: perception.id,
      sourceKind: perception.source.kind,
      summary,
    });

    log.info("Afferent signal received", {
      id: perception.id,
      sourceKind: perception.source.kind,
      summary,
    });

    return perception;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function effectToChange(
  effectType: string
): SideEffect["change"] {
  switch (effectType) {
    case "create":
      return "created";
    case "modify":
      return "modified";
    case "remove":
      return "removed";
    default:
      return "unchanged";
  }
}

function describeOperation(op: Operation): string {
  const target = describeArtifact(op.target);
  switch (op.effect.type) {
    case "create":
      return `Create ${target}`;
    case "modify":
      return `Modify ${target}: ${op.effect.description}`;
    case "remove":
      return `Remove ${target}`;
    case "verify":
      return `Verify ${target}: ${op.effect.condition}`;
    case "query":
      return `Query ${target}: ${op.effect.question}`;
    case "send":
      return `Send to ${target}: ${op.effect.message}`;
  }
}

function describeArtifact(ref: ArtifactRef): string {
  switch (ref.kind) {
    case "file":
      return ref.path;
    case "deployment":
      return `deployment:${ref.target}`;
    case "api":
      return `${ref.method ?? "GET"} ${ref.endpoint}`;
    case "environment":
      return `env:${ref.aspect}`;
    case "human":
      return `human:${ref.channel}`;
  }
}
