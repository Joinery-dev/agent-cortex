/**
 * Peripheral Nervous System — the brain's interface with the world.
 *
 * Three responsibilities:
 * 1. Capability registry — what Cortex can perceive and do (queried by Thalamus)
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
  ToolBinding,
  ActivatedToolSet,
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
/** Who is consuming the tools — shapes which capabilities are activated. */
export type ToolConsumer = "builder" | "evaluator" | "observer";

export interface NeurotransmitterSignals {
  /** Norepinephrine: arousal/thoroughness level [0-1] */
  norepinephrine: number;
  /** Cerebellum's prediction confidence for this intention [0-1] */
  predictionConfidence?: number;
}

export class PeripheralNervousSystem {
  private capabilities = new Map<string, Capability>();
  private checkpointPolicy: CheckpointPolicy;
  /** Maps Agent SDK tool name → capability ID for innate tools. */
  private sdkToolMap = new Map<string, string>();

  constructor(policy: CheckpointPolicy = DEFAULT_CHECKPOINT_POLICY) {
    this.checkpointPolicy = policy;
    this.registerInnateCapabilities();
  }

  // ── Innate Capability Registration ────────────────────────────
  // The body's built-in appendages — always available.
  // Agent SDK built-in tools registered as Capabilities with ToolBindings.

  private registerInnateCapabilities(): void {
    const innate: Array<{
      sdkName: string;
      name: string;
      description: string;
      direction: "afferent" | "efferent";
      category: CapabilityCategory;
    }> = [
      { sdkName: "Read", name: "Read File", description: "Read file contents from disk", direction: "afferent", category: "tool_output" },
      { sdkName: "Glob", name: "File Search", description: "Find files by glob pattern", direction: "afferent", category: "tool_output" },
      { sdkName: "Grep", name: "Content Search", description: "Search file contents with regex", direction: "afferent", category: "tool_output" },
      { sdkName: "Write", name: "Write File", description: "Create or overwrite files on disk", direction: "efferent", category: "file_system" },
      { sdkName: "Edit", name: "Edit File", description: "Modify existing files with targeted edits", direction: "efferent", category: "file_system" },
      { sdkName: "Bash", name: "Shell Command", description: "Run shell commands (build, test, install, git)", direction: "efferent", category: "tool_use" },
      { sdkName: "WebSearch", name: "Web Search", description: "Search the web for information", direction: "afferent", category: "tool_output" },
      { sdkName: "WebFetch", name: "Web Fetch", description: "Fetch content from a URL", direction: "afferent", category: "tool_output" },
      { sdkName: "Agent", name: "Sub-Agent", description: "Spawn a sub-agent for parallel or specialized work", direction: "efferent", category: "tool_use" },
      { sdkName: "AskUserQuestion", name: "Ask Parsifal", description: "Escalate a question or decision to the Parsifal", direction: "efferent", category: "parsifal_communication" },
      { sdkName: "NotebookEdit", name: "Notebook Edit", description: "Create or modify Jupyter notebook cells", direction: "efferent", category: "file_system" },
    ];

    for (const def of innate) {
      const id = `innate:${def.sdkName.toLowerCase()}`;
      const binding: ToolBinding = {
        kind: "agent-sdk",
        toolName: def.sdkName,
        innate: true,
      };

      const capability: Capability = {
        id,
        name: def.name,
        description: def.description,
        direction: def.direction,
        category: def.category,
        available: true,
        toolBinding: binding,
      };

      this.capabilities.set(id, capability);
      this.sdkToolMap.set(def.sdkName, id);
    }

    log.info("Innate capabilities registered", {
      count: innate.length,
      tools: innate.map((d) => d.sdkName),
    });
  }

  // ── Tool Activation ───────────────────────────────────────────
  // Curates which tools a consumer gets for a given task.
  // NE-modulated: low NE = conservative, high NE = full set.
  // Consumer-aware: builder gets read+write, evaluator gets read-only.
  // Amygdala constraints remove specific tools from the active set.

  activateToolsForTask(
    taskDescription: string,
    neLevel: number,
    consumer: ToolConsumer = "builder",
    constraints?: string[],
  ): ActivatedToolSet {
    const excluded = new Set(constraints ?? []);

    // Gather all capabilities with tool bindings
    const bound = Array.from(this.capabilities.values()).filter(
      (c) => c.available && c.toolBinding && !excluded.has(c.toolBinding.toolName),
    );

    let activated: Capability[];
    let allowedTools: string[];

    // AskUserQuestion: always available for any consumer — escalation is never wrong
    const alwaysAvailable = new Set(["AskUserQuestion"]);

    if (consumer === "evaluator") {
      // ── Evaluator activation: read-only. Never Write/Edit/NotebookEdit/Agent. ──
      const forbiddenForEval = new Set(["Write", "Edit", "NotebookEdit", "Agent"]);
      const readOnlyBound = bound.filter(
        (c) => !forbiddenForEval.has(c.toolBinding!.toolName),
      );

      if (neLevel < 0.3) {
        // Low NE: file-reading only + escalation. No Bash, no web.
        activated = readOnlyBound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output" && !c.name.startsWith("Web"))
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      } else if (neLevel <= 0.7) {
        // Medium NE: file-reading + Bash + escalation
        activated = readOnlyBound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output" && !c.name.startsWith("Web"))
          || c.toolBinding!.toolName === "Bash"
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      } else {
        // High NE: file-reading + Bash + WebFetch + escalation
        activated = readOnlyBound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output")
          || c.toolBinding!.toolName === "Bash"
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      }

      // Evaluator auto-allows: read-only always, Bash at medium+
      const readOnly = ["Read", "Glob", "Grep"];
      allowedTools = neLevel >= 0.3 ? [...readOnly, "Bash"] : readOnly;
    } else if (consumer === "observer") {
      // ── Observer activation: can start processes + perceive, but NEVER modify artifacts. ──
      // The nursery's runtime exercise mode. Bash is always available (must start servers,
      // run load tests, check resource usage). Write/Edit/NotebookEdit/Agent/WebSearch forbidden.
      const forbiddenForObserver = new Set(["Write", "Edit", "NotebookEdit", "Agent", "WebSearch"]);
      const observerBound = bound.filter(
        (c) => !forbiddenForObserver.has(c.toolBinding!.toolName),
      );

      if (neLevel < 0.3) {
        // Low NE: file-reading + Bash + escalation. No web.
        activated = observerBound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output" && !c.name.startsWith("Web"))
          || c.toolBinding!.toolName === "Bash"
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      } else {
        // Medium/High NE: file-reading + Bash + WebFetch + escalation.
        // WebFetch lets the observer hit HTTP endpoints under test.
        activated = observerBound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output")
          || c.toolBinding!.toolName === "Bash"
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      }

      // Observer auto-allows: read-only + Bash always (essential for starting/stopping processes)
      allowedTools = ["Read", "Glob", "Grep", "Bash"];
    } else {
      // ── Builder activation: full read+write. ──
      // Agent only at high NE (spawning sub-agents is expensive).
      const highNEOnly = new Set(["Agent", "WebSearch"]);

      if (neLevel < 0.3) {
        // Low NE: read-only afferent + basic file writes + escalation. No shell, no web, no sub-agents.
        activated = bound.filter((c) =>
          (c.direction === "afferent" && c.category === "tool_output" && !c.name.startsWith("Web"))
          || c.category === "file_system"
          || alwaysAvailable.has(c.toolBinding!.toolName),
        );
      } else if (neLevel <= 0.7) {
        // Medium NE: all innate tools except Agent and WebSearch
        activated = bound.filter((c) =>
          c.toolBinding!.innate && !highNEOnly.has(c.toolBinding!.toolName),
        );
      } else {
        // High NE: full innate set including Agent and WebSearch
        activated = bound.filter((c) => c.toolBinding!.innate);
      }

      // Builder auto-allows: read-only always, Write/Edit/NotebookEdit at medium+
      const readOnly = ["Read", "Glob", "Grep"];
      allowedTools = neLevel >= 0.3 ? [...readOnly, "Write", "Edit", "NotebookEdit"] : readOnly;
    }

    // Also include any non-innate (acquired) capabilities that passed filtering
    const acquired = bound.filter(
      (c) => c.toolBinding && !c.toolBinding.innate && !activated.includes(c),
    );
    activated = activated.concat(acquired);

    const tools = activated
      .filter((c) => c.toolBinding!.kind === "agent-sdk")
      .map((c) => c.toolBinding!.toolName);

    // Build natural language summary
    const afferent = activated.filter((c) => c.direction === "afferent");
    const efferent = activated.filter((c) => c.direction === "efferent");
    const lines: string[] = [];
    if (afferent.length > 0) {
      lines.push("You can perceive: " + afferent.map((c) => c.name).join(", "));
    }
    if (efferent.length > 0) {
      lines.push("You can act: " + efferent.map((c) => c.name).join(", "));
    }
    if (consumer === "evaluator") {
      lines.push("You MUST NOT modify any files — you are an evaluator");
    } else if (consumer === "observer") {
      lines.push("You can start and exercise processes but MUST NOT modify any artifacts — you are a nursery observer");
    }
    const systemContext = lines.join(". ") + ".";

    emit("pns:tools-activated", {
      taskDescription,
      neLevel,
      consumer,
      toolCount: tools.length,
      tools,
      constraintsApplied: constraints?.length ?? 0,
    });

    log.info("Tools activated for task", {
      consumer,
      neLevel,
      toolCount: tools.length,
      tools,
    });

    return {
      tools,
      allowedTools: allowedTools.filter((t) => tools.includes(t)),
      systemContext,
      activatedCapabilityIds: activated.map((c) => c.id),
    };
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
    signals: NeurotransmitterSignals,
    signal?: AbortSignal,
  ): Promise<Perception> {
    const startTime = Date.now();

    // Respect brainstem AbortSignal — if already aborted, bail immediately
    if (signal?.aborted) {
      intention.status = "failed";
      return {
        id: newId(),
        intentionId: intention.id,
        taskId: intention.taskId,
        success: false,
        result: "Aborted before execution",
        sideEffects: [],
        summary: `Aborted: ${intention.description}`,
        source: { kind: "efferent", intentionId: intention.id },
        timestamp: new Date(),
        duration: 0,
      };
    }

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
      // Communicate intentions targeting the Parsifal: warn that delivery is unimplemented.
      // The type system supports this path (ArtifactRef "parsifal" + Effect "send"),
      // but PNS.execute() doesn't yet translate it into an AskUserQuestion call.
      if (intention.category === "communicate") {
        const parsifalOps = intention.operations.filter(
          (op) => op.target.kind === "parsifal" && op.effect.type === "send",
        );
        if (parsifalOps.length > 0) {
          log.warn("Communicate intention targets Parsifal but PNS delivery is not yet implemented", {
            intentionId: intention.id,
            taskId: intention.taskId,
            parsifalOps: parsifalOps.length,
            description: intention.description,
          });
          emit("pns:communicate-unimplemented", {
            intentionId: intention.id,
            taskId: intention.taskId,
            parsifalOps: parsifalOps.length,
          });
        }
      }

      const sideEffects: SideEffect[] = [];

      for (const op of intention.operations) {
        // Check abort between operations — allows cancellation mid-intention
        if (signal?.aborted) {
          intention.status = "failed";
          return {
            id: newId(),
            intentionId: intention.id,
            taskId: intention.taskId,
            success: false,
            result: "Aborted mid-execution",
            sideEffects,
            summary: `Aborted mid-execution: ${intention.description}`,
            source: { kind: "efferent", intentionId: intention.id },
            timestamp: new Date(),
            duration: Date.now() - startTime,
          };
        }

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
  // Unsolicited signals from the world: Parsifal feedback arrives,
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
    case "parsifal":
      return `parsifal:${ref.channel}`;
  }
}
