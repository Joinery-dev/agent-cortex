/**
 * Claus Hook Registry — the attention policy of consciousness.
 *
 * Hooks replace the heartbeat. Claus sleeps until a hook fires.
 * Each hook specifies: what triggers it, what model to use, and
 * what context to provide. Zero cost when nothing is happening.
 *
 * Three sources:
 *   system  — built-in hooks that are always present
 *   claus   — self-set by Claus via the set_hook tool
 *   parsifal — set by the Parsifal via conversation
 *
 * Triggers:
 *   event:<type>    — fire on a specific event type (supports * wildcard)
 *   interval:<sec>  — fire every N seconds
 *
 * Conditions (optional, evaluated deterministically):
 *   "<field> <op> <value>" where op is <, >, ==, !=, >=, <=
 *   e.g. "level < 0.5", "action == escalate", "tensionCount > 2"
 */

import type { CortexEvent } from "../events.js";
import type { Thalamus } from "../kernel/thalamus.js";
import type { WorkingMemory } from "../kernel/working-memory.js";
import { bus } from "../events.js";
import { getLastNE } from "../kernel/norepinephrine.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("claus-hooks");

// ─── Types ─────────────────────────────────────────────────────

export type HookModel = "haiku" | "sonnet" | "opus";
export type HookSource = "system" | "claus" | "parsifal";

export interface ClausHook {
  name: string;
  /** Event trigger pattern: "event:<type>" or "interval:<seconds>" */
  trigger: string;
  /** Optional condition: "<field> <op> <value>". Evaluated against event.data. */
  condition?: string;
  /** Which model tier to wake Claus with. */
  model: HookModel;
  /** Context string passed to Claus when woken. */
  context: string;
  /** Persists after firing (true) or one-shot (false). */
  persistent: boolean;
  /** Who set this hook. */
  source: HookSource;
  /** When this hook was created. */
  createdAt: Date;
}

export interface HookFired {
  hook: ClausHook;
  event?: CortexEvent;
  timestamp: Date;
}

// ─── Default system hooks ──────────────────────────────────────

const SYSTEM_HOOKS: Omit<ClausHook, "createdAt">[] = [
  {
    name: "parsifal-message",
    trigger: "event:conversation:received",
    model: "sonnet",
    context: "The Parsifal sent a message. Respond naturally.",
    persistent: true,
    source: "system",
  },
  {
    name: "escalation",
    trigger: "event:escalation:created",
    model: "sonnet",
    context: "An escalation needs to be communicated to the Parsifal.",
    persistent: true,
    source: "system",
  },
  {
    name: "amygdala-threat",
    trigger: "event:amygdala:threat-detected",
    model: "sonnet",
    context: "The amygdala detected a threat. Assess and communicate urgency.",
    persistent: true,
    source: "system",
  },
  {
    name: "amygdala-alarm",
    trigger: "event:amygdala:alarm-received",
    model: "sonnet",
    context: "An alarm was received by the amygdala. Communicate to the Parsifal.",
    persistent: true,
    source: "system",
  },
  {
    name: "gate-decision",
    trigger: "event:rhythm:gate-decision",
    model: "haiku",
    context: "A gate decision was made. Check if anything is worth mentioning.",
    persistent: true,
    source: "system",
  },
  {
    name: "task-complete",
    trigger: "event:task:complete",
    model: "haiku",
    context: "A task completed. Update the Parsifal on progress.",
    persistent: true,
    source: "system",
  },
  {
    name: "conviction-change",
    trigger: "event:conviction:result",
    model: "haiku",
    context: "Conviction was assessed. Check if the trajectory is notable.",
    persistent: true,
    source: "system",
  },
  {
    name: "tension-detected",
    trigger: "event:tension:detection-complete",
    condition: "tensionCount > 0",
    model: "haiku",
    context: "Tensions were detected between senses. Decide if worth surfacing.",
    persistent: true,
    source: "system",
  },
  {
    name: "project-start",
    trigger: "event:project:start",
    model: "sonnet",
    context: "The project is starting. Orient the Parsifal.",
    persistent: true,
    source: "system",
  },
  {
    name: "project-complete",
    trigger: "event:project:complete",
    model: "sonnet",
    context: "The project completed. Reflect and summarize for the Parsifal.",
    persistent: true,
    source: "system",
  },
];

// ─── Condition evaluator ───────────────────────────────────────

/**
 * Evaluate a simple condition against event data.
 * Format: "<field> <op> <value>"
 * Returns true if condition is met, false otherwise.
 * Returns true if no condition specified (unconditional hook).
 */
function evaluateCondition(condition: string | undefined, data: Record<string, unknown>): boolean {
  if (!condition) return true;

  const match = condition.match(/^(\w+(?:\.\w+)*)\s*(<=?|>=?|==|!=)\s*(.+)$/);
  if (!match) {
    log.warn("Invalid hook condition", { condition });
    return true; // fail open
  }

  const [, field, op, rawValue] = match;
  const actual = getNestedField(data, field);
  if (actual === undefined) return false;

  // Parse value — try number first, then string
  const value = isNaN(Number(rawValue)) ? rawValue.trim().replace(/^["']|["']$/g, "") : Number(rawValue);
  const numActual = typeof actual === "number" ? actual : Number(actual);
  const isNumeric = typeof value === "number" && !isNaN(numActual);

  switch (op) {
    case "<": return isNumeric && numActual < (value as number);
    case ">": return isNumeric && numActual > (value as number);
    case "<=": return isNumeric && numActual <= (value as number);
    case ">=": return isNumeric && numActual >= (value as number);
    case "==": return String(actual) === String(value);
    case "!=": return String(actual) !== String(value);
    default: return true;
  }
}

function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Hook Registry ─────────────────────────────────────────────

export class ClausHookRegistry {
  private hooks = new Map<string, ClausHook>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private onFire: ((fired: HookFired) => void) | null = null;
  private subscribed = false;

  constructor() {
    // Register system hooks
    for (const h of SYSTEM_HOOKS) {
      this.hooks.set(h.name, { ...h, createdAt: new Date() });
    }
  }

  /** Set the callback for when a hook fires. */
  setHandler(handler: (fired: HookFired) => void): void {
    this.onFire = handler;
  }

  /** Start listening to the event bus and activate interval hooks. */
  activate(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    // Subscribe to event bus
    bus.onCortex((event) => this.checkEvent(event));

    // Start interval hooks
    for (const hook of this.hooks.values()) {
      this.startIntervalIfNeeded(hook);
    }

    log.info("Hook registry activated", { hookCount: this.hooks.size });
  }

  /** Stop all interval hooks. */
  deactivate(): void {
    for (const timer of this.intervals.values()) {
      clearInterval(timer);
    }
    this.intervals.clear();
  }

  // ─── Hook management ────────────────────────────────────────

  /** Add or replace a hook. */
  set(hook: Omit<ClausHook, "createdAt">): void {
    const full: ClausHook = { ...hook, createdAt: new Date() };
    this.hooks.set(hook.name, full);

    // Start interval if needed
    if (this.subscribed) {
      this.startIntervalIfNeeded(full);
    }

    log.info("Hook set", { name: hook.name, trigger: hook.trigger, model: hook.model, source: hook.source });
  }

  /** Remove a hook by name. System hooks can't be removed. */
  remove(name: string): boolean {
    const hook = this.hooks.get(name);
    if (!hook) return false;
    if (hook.source === "system") {
      log.warn("Cannot remove system hook", { name });
      return false;
    }

    this.hooks.delete(name);

    // Clear interval if any
    const timer = this.intervals.get(name);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(name);
    }

    log.info("Hook removed", { name });
    return true;
  }

  /** List all active hooks. */
  list(): ClausHook[] {
    return [...this.hooks.values()];
  }

  /** Get a hook by name. */
  get(name: string): ClausHook | undefined {
    return this.hooks.get(name);
  }

  /** Reset non-system hooks (between projects). */
  resetCustomHooks(): void {
    for (const [name, hook] of this.hooks) {
      if (hook.source !== "system") {
        this.remove(name);
      }
    }
  }

  // ─── Event matching ─────────────────────────────────────────

  private checkEvent(event: CortexEvent): void {
    for (const hook of this.hooks.values()) {
      if (!hook.trigger.startsWith("event:")) continue;

      const pattern = hook.trigger.slice(6); // remove "event:"
      if (!this.matchPattern(pattern, event.type)) continue;
      if (!evaluateCondition(hook.condition, event.data)) continue;

      // Hook fires
      this.fire(hook, event);

      // Remove one-shot hooks
      if (!hook.persistent) {
        this.hooks.delete(hook.name);
      }
    }
  }

  private matchPattern(pattern: string, eventType: string): boolean {
    if (pattern === eventType) return true;
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return eventType.startsWith(prefix);
    }
    return false;
  }

  private fire(hook: ClausHook, event?: CortexEvent): void {
    if (!this.onFire) return;

    this.onFire({
      hook,
      event,
      timestamp: new Date(),
    });
  }

  // ─── Interval hooks ─────────────────────────────────────────

  private startIntervalIfNeeded(hook: ClausHook): void {
    if (!hook.trigger.startsWith("interval:")) return;

    // Clear existing interval for this hook
    const existing = this.intervals.get(hook.name);
    if (existing) clearInterval(existing);

    const seconds = parseInt(hook.trigger.slice(9), 10);
    if (isNaN(seconds) || seconds <= 0) {
      log.warn("Invalid interval trigger", { name: hook.name, trigger: hook.trigger });
      return;
    }

    const timer = setInterval(() => {
      this.fire(hook);
      if (!hook.persistent) {
        clearInterval(timer);
        this.intervals.delete(hook.name);
        this.hooks.delete(hook.name);
      }
    }, seconds * 1000);

    this.intervals.set(hook.name, timer);
    log.info("Interval hook started", { name: hook.name, seconds });
  }
}
