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

interface ItemOpts {
  level?: NarrationItem["level"];
  children?: NarrationChild[];
  summary?: string;
}

function item(
  headline: string,
  event: CortexEvent,
  opts: ItemOpts = {},
): NarrationItem {
  const { level = "normal", children, summary } = opts;
  return {
    id: newId(),
    timestamp: new Date(event.timestamp),
    headline,
    summary,
    rawData: event.data,
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
    narrate: (e) => {
      const desc = str(e, "description") || "new project";
      const count = str(e, "shaelCount");
      return item(`Project started: ${desc}`, e, {
        level: "major",
        summary: `Beginning work on "${desc}".`
          + (count ? ` The plan contains ${count} top-level task(s).` : ""),
        children: [
          ...(count ? [child("Tasks", count)] : []),
        ],
      });
    },
  },
  {
    match: "project:complete",
    narrate: (e) => {
      const tasks = str(e, "totalTasks");
      const cycles = str(e, "totalCycles");
      return item("Project complete", e, {
        level: "major",
        summary: "All tasks have been completed and the project is finished."
          + (tasks ? ` ${tasks} task(s) were completed` : "")
          + (cycles ? ` across ${cycles} total build cycle(s).` : "."),
        children: [
          ...(tasks ? [child("Tasks completed", tasks)] : []),
          ...(cycles ? [child("Total cycles", cycles)] : []),
        ],
      });
    },
  },

  // ── Planning ─────────────────────────────────────────────────

  {
    match: "planner:phase-a-start",
    narrate: (e) => item("Planning: exploring the vision", e, {
      summary: "The planner is exploring the high-level vision — asking clarifying questions and building an understanding of what needs to be built before committing to a plan.",
    }),
  },
  {
    match: "planner:inquiry-converged",
    narrate: (e) => {
      const rounds = str(e, "rounds") || "?";
      return item(`Inquiry complete after ${rounds} round(s)`, e, {
        summary: `The planner's clarifying questions have converged after ${rounds} round(s). Enough understanding has been gathered to proceed with vision synthesis.`,
      });
    },
  },
  {
    match: "planner:phase-a-approved",
    narrate: (e) => item("Vision approved", e, {
      summary: "The manifested future (what the system is building toward) has been reviewed and approved. Planning will now proceed to task decomposition.",
    }),
  },
  {
    match: "planner:phase-a-complete",
    narrate: (e) => item("Vision crystallized", e, {
      level: "major",
      summary: `The vision has been fully formed and crystallized with ${pct(e, "confidence")} confidence. This is the manifested future that all subsequent work will aim to realize.`,
      children: [
        ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
      ],
    }),
  },
  {
    match: "planner:phase-b-start",
    narrate: (e) => item("Decomposing into tasks", e, {
      summary: "The planner is breaking the vision down into concrete tasks — identifying what needs to be built, in what order, and what depends on what.",
    }),
  },
  {
    match: "planner:phase-b-complete",
    narrate: (e) => {
      const tasks = str(e, "shaelCount") || "?";
      const edges = str(e, "edgeCount");
      const groups = str(e, "affinityGroupCount");
      return item(`Plan ready: ${tasks} tasks`, e, {
        summary: `Decomposition complete. The plan contains ${tasks} task(s)`
          + (edges ? ` with ${edges} dependency edge(s)` : "")
          + (groups ? ` organized into ${groups} affinity group(s)` : "")
          + ". Ready to begin execution.",
        children: [
          ...(edges ? [child("Dependencies", edges)] : []),
          ...(groups ? [child("Groups", groups)] : []),
        ],
      });
    },
  },

  // ── Task dispatch ────────────────────────────────────────────

  {
    match: "dispatch:task-selected",
    narrate: (e) => {
      const desc = str(e, "description") || str(e, "taskId") || "?";
      const mode = str(e, "mode");
      const ne = str(e, "neLevel");
      return item(`Starting task: ${desc}`, e, {
        level: "major",
        summary: `The dispatcher selected "${desc}" as the next task to work on.`
          + (mode ? ` Running in ${mode} mode.` : "")
          + (ne ? ` Norepinephrine (arousal/thoroughness) is at ${ne}.` : ""),
        children: [
          ...(mode ? [child("Mode", mode)] : []),
          ...(ne ? [child("NE", num(e, "neLevel").toFixed(2))] : []),
        ],
      });
    },
  },
  {
    match: "task:start",
    narrate: (e) => {
      const desc = str(e, "description") || str(e, "taskId") || "task";
      return item(`Working on: ${desc}`, e, {
        summary: `The sensory cortex has begun working on "${desc}". Senses will consult, the motor cortex will build, and evaluators will assess the result.`,
      });
    },
  },
  {
    match: "task:complete",
    narrate: (e) => {
      const conf = str(e, "confidence");
      const cycles = str(e, "totalCycles");
      return item("Task complete", e, {
        summary: "The task has been accepted by the evaluation gate."
          + (conf ? ` Final confidence: ${pct(e, "confidence")}.` : "")
          + (cycles ? ` Took ${cycles} build cycle(s).` : ""),
        children: [
          ...(conf ? [child("Confidence", pct(e, "confidence"))] : []),
          ...(cycles ? [child("Cycles", cycles)] : []),
        ],
      });
    },
  },

  // ── Sensory cortex ───────────────────────────────────────────

  {
    match: "ne:novelty-enriched",
    narrate: (e) => {
      const ne = num(e, "finalNe").toFixed(2);
      const novelty = str(e, "noveltyContribution");
      return item(`Arousal set: NE ${ne}`, e, {
        level: "minor",
        summary: `Norepinephrine level set to ${ne} after novelty enrichment.`
          + (novelty ? ` Novelty contributed ${novelty} to the final level.` : "")
          + " Higher NE means more senses consulted and tighter evaluation thresholds.",
        children: [
          ...(novelty ? [child("Novelty", novelty)] : []),
        ],
      });
    },
  },

  // ── Motor cortex ─────────────────────────────────────────────

  {
    match: "motor:plan-complete",
    narrate: (e) => {
      const steps = str(e, "stepCount");
      const approach = str(e, "approach");
      return item("Build plan ready", e, {
        summary: "The motor cortex's premotor region has produced a build plan."
          + (steps ? ` It contains ${steps} step(s).` : "")
          + (approach ? ` Approach: ${approach}` : ""),
        children: [
          ...(steps ? [child("Steps", steps)] : []),
          ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
          ...(approach ? [child("Approach", truncate(approach, 80))] : []),
        ],
      });
    },
  },
  {
    match: "motor:build-complete",
    narrate: (e) => {
      const files = str(e, "filesModified");
      const lines = str(e, "linesChanged");
      return item("Build complete", e, {
        summary: "The motor cortex has finished producing code."
          + (files ? ` ${files} file(s) were modified` : "")
          + (lines ? ` with ${lines} line(s) changed.` : "."),
        children: [
          ...(files ? [child("Files", files)] : []),
          ...(lines ? [child("Lines", lines)] : []),
        ],
      });
    },
  },
  {
    match: "motor:proprioception-complete",
    narrate: (e) => item(`Self-assessment: adherence ${pct(e, "adherence")}`, e, {
      level: "minor",
      summary: `The motor cortex reviewed its own output against the build plan. Adherence to the plan: ${pct(e, "adherence")}. Low adherence triggers revision before evaluation.`,
    }),
  },
  {
    match: "motor:efference-copy",
    narrate: (e) => item(`Builder feasibility: ${pct(e, "feasibility")}`, e, {
      level: "minor",
      summary: `Before building, the motor cortex assessed feasibility at ${pct(e, "feasibility")}. This calibrates evaluator expectations — if feasibility is low, senses know to expect gaps.`,
    }),
  },

  // ── Evaluation & tension ─────────────────────────────────────

  {
    match: "tension:detection-complete",
    narrate: (e) => {
      const count = num(e, "tensionCount");
      if (count === 0) return null; // skip if no tensions
      return item(`${count} tension(s) detected`, e, {
        summary: `${count} tension(s) were found between competing sense evaluations. Tensions are contradictions between what different senses value — they get resolved through synthesis, not averaging.`,
      });
    },
  },

  // ── Conviction ───────────────────────────────────────────────

  {
    match: "conviction:result",
    narrate: (e) => {
      const level = str(e, "level") || pct(e, "conviction");
      const delta = str(e, "delta");
      const deciding = str(e, "decidingStep");
      return item(`Conviction: ${level}`, e, {
        summary: `The conviction loop assessed the current state at "${level}".`
          + (delta ? ` Change from last check: ${delta}.` : "")
          + (deciding ? ` The deciding factor was: ${deciding}` : ""),
        children: [
          ...(delta ? [child("Delta", delta)] : []),
          ...(deciding ? [child("Deciding factor", truncate(deciding, 60))] : []),
        ],
      });
    },
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
          {
            summary: `The gate decided to continue iterating into cycle ${cycle + 1}.`
              + (reason ? ` Reason: ${reason}` : " The evaluation hasn't converged yet."),
          },
        );
      }
      if (action === "complete") {
        return item(
          `${rhythmType || "Rhythm"} complete after ${cycle + 1} cycle(s)`,
          e,
          {
            summary: `The ${rhythmType || "rhythm"} has converged and been accepted after ${cycle + 1} build cycle(s). Moving on.`,
          },
        );
      }
      if (action === "escalate") {
        return item(
          `Escalating: ${reason || "needs input"}`,
          e,
          {
            level: "major",
            summary: `The system cannot proceed without external input. ${reason || "The gate could not resolve the current state autonomously."}`,
          },
        );
      }
      if (action === "pause") {
        return item(
          `Paused: ${reason || "awaiting input"}`,
          e,
          {
            level: "major",
            summary: `Work is paused. ${reason || "Waiting for the Parsifal to provide input before continuing."}`,
          },
        );
      }
      return null;
    },
  },

  // ── Build cycle ──────────────────────────────────────────────

  {
    match: "cycle:start",
    narrate: (e) => {
      const cycle = str(e, "cycle") || "?";
      const max = str(e, "maxCycles");
      return item(`Build cycle ${cycle}`, e, {
        level: "minor",
        summary: `Starting build cycle ${cycle}`
          + (max ? ` of ${max} maximum.` : ".")
          + " Each cycle: plan → build → self-assess → evaluate → gate decision.",
      });
    },
  },
  {
    match: "gate:failure-classified",
    narrate: (e) => {
      const mode = str(e, "failureMode") || "unknown";
      return item(`Failure classified: ${mode}`, e, {
        summary: `The gate classified the failure as "${mode}". This determines the revision strategy — whether to amend the current approach or re-plan from scratch.`,
        children: [
          ...(str(e, "confidence") ? [child("Confidence", pct(e, "confidence"))] : []),
        ],
      });
    },
  },
  {
    match: "ne:recomputed",
    narrate: (e) => {
      const ne = num(e, "ne").toFixed(2);
      return item(`NE updated: ${ne}`, e, {
        level: "minor",
        summary: `Norepinephrine recalculated to ${ne} based on the current cycle's results. This adjusts the system's thoroughness for the next iteration.`,
      });
    },
  },

  // ── Escalation ───────────────────────────────────────────────

  {
    match: "escalation:created",
    narrate: (e) => {
      const summary_ = str(e, "summary") || "needs input";
      const severity = str(e, "severity");
      const source = str(e, "source");
      return item(`Escalation: ${summary_}`, e, {
        level: "major",
        summary: `The system needs input: "${summary_}".`
          + (severity ? ` Severity: ${severity}.` : "")
          + (source ? ` Raised by: ${source}.` : ""),
        children: [
          ...(severity ? [child("Severity", severity, severity === "critical" ? "warn" : "info")] : []),
          ...(source ? [child("Source", source)] : []),
        ],
      });
    },
  },
  {
    match: "escalation:resolved",
    narrate: (e) => item("Escalation resolved — resuming", e, {
      summary: "The escalation has been resolved and work is resuming from where it paused.",
    }),
  },

  // ── Between-tasks ────────────────────────────────────────────

  {
    match: "dispatch:between-tasks",
    narrate: (e) => {
      const activity = str(e, "activity") || "consolidating";
      return item(`Between tasks: ${activity}`, e, {
        level: "minor",
        summary: `Between-tasks phase: ${activity}. The system consolidates learning, checks for observations, and prepares context for the next task.`,
      });
    },
  },
  {
    match: "rest:start",
    narrate: (e) => item("Rest cycle — consolidating memory", e, {
      level: "minor",
      summary: "The hippocampus is consolidating recent experiences into long-term memory. Episodes may crystallize into principles.",
    }),
  },
  {
    match: "rest:complete",
    narrate: (e) => item("Rest complete", e, {
      level: "minor",
      summary: "Memory consolidation is done. The system is ready for the next task.",
    }),
  },

  // ── Phase gate ───────────────────────────────────────────────

  {
    match: "dispatch:phase-gate-check",
    narrate: (e) => item("Phase gate: checking cross-task coherence", e, {
      summary: "A phase gate is running — evaluating whether the completed tasks in this phase work together coherently, not just individually. This is a detector, not a diagnoser.",
    }),
  },

  // ── Rhythm lifecycle (high-level only) ───────────────────────

  {
    match: "rhythm:paused",
    narrate: (e) => item(`Paused: ${str(e, "reason") || "awaiting input"}`, e, {
      level: "major",
      summary: `The current rhythm has been paused. ${str(e, "reason") || "Waiting for input to continue."}`,
    }),
  },
  {
    match: "rhythm:resumed",
    narrate: (e) => item("Resumed", e, {
      summary: "The rhythm has resumed after being paused.",
    }),
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
