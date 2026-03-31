/**
 * Narration rules — deterministic event-to-narrative templates.
 *
 * These drive the left pane (system activity feed). Each rule matches
 * a CortexEvent by type and extracts a human-readable NarrationItem.
 *
 * No LLM calls. Fast, predictable, and testable.
 * The right pane (consciousness) handles interpretation.
 */

import type { CortexEvent } from "../events.js";
import type { NarrationItem, NarrationChild } from "../types/conversation.js";
import { newId } from "../util/ids.js";

// ─── Rule definition ───────────────────────────────────────────

interface NarrationRule {
  /** Event type pattern. Exact match or prefix with wildcard (*). */
  match: string;
  /** Extract a NarrationItem from the event, or null to skip. */
  narrate: (event: CortexEvent) => NarrationItem | null;
}

// ─── Helpers ───────────────────────────────────────────────────

function item(
  headline: string,
  event: CortexEvent,
  level: NarrationItem["level"] = "normal",
  children?: NarrationChild[],
): NarrationItem {
  return {
    id: newId(),
    timestamp: new Date(event.timestamp),
    headline,
    level,
    children: children?.length ? children : undefined,
    rhythmContext: event.rhythmContext
      ? {
          rhythmType: event.rhythmContext.rhythmType,
          phase: event.rhythmContext.phase,
          cycle: event.rhythmContext.cycle,
          taskId: event.rhythmContext.taskId,
        }
      : undefined,
  };
}

function child(label: string, value: string, severity?: NarrationChild["severity"]): NarrationChild {
  return { label, value, severity };
}

// ─── Rules ─────────────────────────────────────────────────────

const rules: NarrationRule[] = [
  // ── Project lifecycle ────────────────────────────────────────

  {
    match: "project:start",
    narrate: (e) => item(
      `Project started: ${str(e, "description") || "new project"}`,
      e,
      "major",
      [
        ...(str(e, "shaelCount") ? [child("Tasks", str(e, "shaelCount"))] : []),
      ],
    ),
  },
  {
    match: "project:complete",
    narrate: (e) => item(
      `Project complete`,
      e,
      "major",
      [
        ...(str(e, "totalTasks") ? [child("Tasks completed", str(e, "totalTasks"))] : []),
        ...(str(e, "totalCycles") ? [child("Total cycles", str(e, "totalCycles"))] : []),
      ],
    ),
  },

  // ── Planning ─────────────────────────────────────────────────

  {
    match: "planner:phase-a-start",
    narrate: (e) => item("Planning: exploring the vision", e, "normal"),
  },
  {
    match: "planner:inquiry-converged",
    narrate: (e) => item(
      `Inquiry complete after ${str(e, "rounds") || "?"} round(s)`,
      e,
      "normal",
    ),
  },
  {
    match: "planner:phase-a-approved",
    narrate: (e) => item("Vision approved", e, "normal"),
  },
  {
    match: "planner:phase-a-complete",
    narrate: (e) => item(
      "Vision crystallized",
      e,
      "major",
      [
        ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
      ],
    ),
  },
  {
    match: "planner:phase-b-start",
    narrate: (e) => item("Decomposing into tasks", e, "normal"),
  },
  {
    match: "planner:phase-b-complete",
    narrate: (e) => item(
      `Plan ready: ${str(e, "shaelCount") || "?"} tasks`,
      e,
      "normal",
      [
        ...(str(e, "edgeCount") ? [child("Dependencies", str(e, "edgeCount"))] : []),
        ...(str(e, "affinityGroupCount") ? [child("Groups", str(e, "affinityGroupCount"))] : []),
      ],
    ),
  },

  // ── Task dispatch ────────────────────────────────────────────

  {
    match: "dispatch:task-selected",
    narrate: (e) => item(
      `Starting task: ${str(e, "description") || str(e, "taskId") || "?"}`,
      e,
      "major",
      [
        ...(str(e, "mode") ? [child("Mode", str(e, "mode"))] : []),
        ...(str(e, "neLevel") ? [child("NE", num(e, "neLevel").toFixed(2))] : []),
      ],
    ),
  },
  {
    match: "task:start",
    narrate: (e) => item(
      `Working on: ${str(e, "description") || str(e, "taskId") || "task"}`,
      e,
      "normal",
    ),
  },
  {
    match: "task:complete",
    narrate: (e) => item(
      `Task complete`,
      e,
      "normal",
      [
        ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
        ...(str(e, "totalCycles") ? [child("Cycles", str(e, "totalCycles"))] : []),
      ],
    ),
  },

  // ── Sensory cortex ───────────────────────────────────────────

  {
    match: "ne:novelty-enriched",
    narrate: (e) => item(
      `Arousal set: NE ${num(e, "finalNe").toFixed(2)}`,
      e,
      "minor",
      [
        ...(str(e, "noveltyContribution") ? [child("Novelty", str(e, "noveltyContribution"))] : []),
      ],
    ),
  },

  // ── Motor cortex ─────────────────────────────────────────────

  {
    match: "motor:plan-complete",
    narrate: (e) => item(
      `Build plan ready`,
      e,
      "normal",
      [
        ...(str(e, "stepCount") ? [child("Steps", str(e, "stepCount"))] : []),
        ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
        ...(str(e, "approach") ? [child("Approach", truncate(str(e, "approach"), 80))] : []),
      ],
    ),
  },
  {
    match: "motor:build-complete",
    narrate: (e) => item(
      "Build complete",
      e,
      "normal",
      [
        ...(str(e, "filesModified") ? [child("Files", str(e, "filesModified"))] : []),
        ...(str(e, "linesChanged") ? [child("Lines", str(e, "linesChanged"))] : []),
      ],
    ),
  },
  {
    match: "motor:proprioception-complete",
    narrate: (e) => item(
      `Self-assessment: adherence ${pct(e, "adherence")}`,
      e,
      "minor",
    ),
  },
  {
    match: "motor:efference-copy",
    narrate: (e) => item(
      `Builder feasibility: ${pct(e, "feasibility")}`,
      e,
      "minor",
    ),
  },

  // ── Evaluation & tension ─────────────────────────────────────

  {
    match: "tension:detection-complete",
    narrate: (e) => {
      const count = num(e, "tensionCount");
      if (count === 0) return null; // skip if no tensions
      return item(
        `${count} tension(s) detected`,
        e,
        "normal",
      );
    },
  },

  // ── Conviction ───────────────────────────────────────────────

  {
    match: "conviction:result",
    narrate: (e) => item(
      `Conviction: ${str(e, "level") || pct(e, "conviction")}`,
      e,
      "normal",
      [
        ...(str(e, "delta") ? [child("Delta", str(e, "delta"))] : []),
        ...(str(e, "decidingStep") ? [child("Deciding factor", truncate(str(e, "decidingStep"), 60))] : []),
      ],
    ),
  },

  // ── Gate decisions ───────────────────────────────────────────

  {
    match: "rhythm:gate-decision",
    narrate: (e) => {
      const action = str(e, "action");
      const cycle = num(e, "cycle");
      const rhythmType = str(e, "rhythmType");
      const reason = str(e, "reason");

      if (action === "continue") {
        return item(
          `Iterating${reason ? ` — ${truncate(reason, 60)}` : ""} (cycle ${cycle + 1})`,
          e,
          "normal",
        );
      }
      if (action === "complete") {
        return item(
          `${rhythmType || "Rhythm"} complete after ${cycle + 1} cycle(s)`,
          e,
          "normal",
        );
      }
      if (action === "escalate") {
        return item(
          `Escalating: ${reason || "needs input"}`,
          e,
          "major",
        );
      }
      if (action === "pause") {
        return item(
          `Paused: ${reason || "awaiting input"}`,
          e,
          "major",
        );
      }
      return null;
    },
  },

  // ── Build cycle ──────────────────────────────────────────────

  {
    match: "cycle:start",
    narrate: (e) => item(
      `Build cycle ${str(e, "cycle") || "?"}`,
      e,
      "minor",
    ),
  },
  {
    match: "gate:failure-classified",
    narrate: (e) => item(
      `Failure classified: ${str(e, "failureMode") || "unknown"}`,
      e,
      "normal",
      [
        ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
      ],
    ),
  },
  {
    match: "ne:recomputed",
    narrate: (e) => item(
      `NE updated: ${num(e, "ne").toFixed(2)}`,
      e,
      "minor",
    ),
  },

  // ── Escalation ───────────────────────────────────────────────

  {
    match: "escalation:created",
    narrate: (e) => item(
      `Escalation: ${str(e, "summary") || "needs input"}`,
      e,
      "major",
      [
        ...(str(e, "severity") ? [child("Severity", str(e, "severity"), str(e, "severity") === "critical" ? "warn" : "info")] : []),
        ...(str(e, "source") ? [child("Source", str(e, "source"))] : []),
      ],
    ),
  },
  {
    match: "escalation:resolved",
    narrate: (e) => item(
      "Escalation resolved — resuming",
      e,
      "normal",
    ),
  },

  // ── Between-tasks ────────────────────────────────────────────

  {
    match: "dispatch:between-tasks",
    narrate: (e) => item(
      `Between tasks: ${str(e, "activity") || "consolidating"}`,
      e,
      "minor",
    ),
  },
  {
    match: "rest:start",
    narrate: (e) => item("Rest cycle — consolidating memory", e, "minor"),
  },
  {
    match: "rest:complete",
    narrate: (e) => item("Rest complete", e, "minor"),
  },

  // ── Phase gate ───────────────────────────────────────────────

  {
    match: "dispatch:phase-gate-check",
    narrate: (e) => item(
      `Phase gate: checking cross-task coherence`,
      e,
      "normal",
    ),
  },

  // ── Rhythm lifecycle (high-level only) ───────────────────────

  {
    match: "rhythm:paused",
    narrate: (e) => item(
      `Paused: ${str(e, "reason") || "awaiting input"}`,
      e,
      "major",
    ),
  },
  {
    match: "rhythm:resumed",
    narrate: (e) => item("Resumed", e, "normal"),
  },
];

// ─── Data extraction helpers ───────────────────────────────────

function str(e: CortexEvent, key: string): string {
  const val = e.data[key];
  if (val == null) return "";
  return String(val);
}

function num(e: CortexEvent, key: string): number {
  const val = e.data[key];
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  return 0;
}

function pct(e: CortexEvent, key: string): string {
  const n = num(e, key);
  return `${(n * 100).toFixed(0)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

// ─── Matcher ───────────────────────────────────────────────────

/**
 * Try to narrate a CortexEvent. Returns null if no rule matches
 * or if the matched rule decides to skip this event.
 */
export function narrateEvent(event: CortexEvent): NarrationItem | null {
  for (const rule of rules) {
    if (rule.match === event.type) {
      return rule.narrate(event);
    }
  }
  return null;
}

/**
 * Get all registered event types that have narration rules.
 * Useful for filtering the event bus subscription.
 */
export function getNarratedEventTypes(): string[] {
  return rules.map((r) => r.match);
}
