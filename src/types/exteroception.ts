/**
 * Exteroception — External World Perception.
 *
 * The system's ability to perceive the external world independently of the
 * current task. A generic monitoring infrastructure that can watch anything
 * (npm advisories, API changelogs, deploy status, etc.).
 *
 * Two-path signal routing:
 *   Urgent    → Amygdala alarm (bypass store, existing override machinery)
 *   Non-urgent → in-memory signal store → batch-processed at between-tasks
 *
 * A mini cerebellum learns optimal polling cadence per monitor: signals that
 * lead to actions → poll more often; signals that never lead to anything →
 * poll less. Exponential moving average, not cumulative — recent matters more.
 */

// ── Monitor Source (stubbed, extensible) ────────────────────────

/**
 * What a monitor watches. Generic enough for any external signal source.
 * New source kinds can be added without changing monitor infrastructure.
 */
export type MonitorSource =
  | { kind: "npm-advisory"; packageName: string }
  | { kind: "api-changelog"; apiName: string; endpoint?: string }
  | { kind: "deploy-status"; service: string }
  | { kind: "custom"; type: string; config: Record<string, unknown> };

// ── Sentry Result ───────────────────────────────────────────────

/**
 * What the Haiku sentry returns from a single poll of one monitor.
 * The sentry's job: "did anything change?" — not "what should we do?"
 */
export interface SentryResult {
  /** Whether the poll detected a change or signal worth recording. */
  detected: boolean;
  /** Human-readable summary of what was found (or "no change"). */
  summary: string;
  /** Structured data from the poll — schema depends on MonitorSource kind. */
  payload: Record<string, unknown>;
  /** Sentry's urgency assessment. "urgent" bypasses the store. */
  urgency: "none" | "low" | "high" | "urgent";
}

// ── Exteroceptive Signal (stored) ───────────────────────────────

/**
 * A signal from the external world, stored for batch processing.
 * Accumulated between tasks, consumed at rhythm boundaries.
 *
 * Note: "urgent" signals never become ExteroceptiveSignals — they
 * go directly to Amygdala. Only "low" and "high" are stored.
 */
export interface ExteroceptiveSignal {
  id: string;
  monitorId: string;
  /** What was detected. */
  summary: string;
  /** Structured payload from the sentry. */
  payload: Record<string, unknown>;
  /** Sentry-assigned urgency at detection time. */
  urgency: "low" | "high";
  /** Whether batch processing acted on this signal. null = not yet processed. */
  actedUpon: boolean | null;
  /** When the sentry detected this. */
  detectedAt: Date;
  /** When batch processing consumed this. null = pending. */
  processedAt: Date | null;
}

// ── Batch ───────────────────────────────────────────────────────

/**
 * Accumulated signals processed together at a between-tasks boundary.
 */
export interface ExteroceptiveBatch {
  /** Signals being processed in this batch. */
  signals: ExteroceptiveSignal[];
  /** Grouped by monitor for easier processing. */
  byMonitor: Map<string, ExteroceptiveSignal[]>;
  /** When this batch was assembled. */
  assembledAt: Date;
}

// ── Batch Action ────────────────────────────────────────────────

/**
 * What PFC processing produces for one signal.
 * Follows the discriminated union pattern (see ResponseAction in amygdala.ts).
 */
export type BatchAction =
  | { kind: "noted"; signalId: string }
  | { kind: "task-amendment"; signalId: string; description: string }
  | { kind: "alert"; signalId: string; message: string }
  | { kind: "dismissed"; signalId: string; reason: string };

// ── Monitor Cadence (learned) ───────────────────────────────────

/**
 * The learned polling interval for a monitor.
 * The mini cerebellum adjusts intervalMs based on action feedback.
 */
export interface MonitorCadence {
  /** Current polling interval in milliseconds. */
  intervalMs: number;
  /** Minimum interval — never poll faster than this. */
  floorMs: number;
  /** Maximum interval — never poll slower than this. */
  ceilingMs: number;
  /** Exponential moving average of "led to action" fraction (0–1). */
  actionRate: number;
  /** How many polls have completed for this monitor. */
  totalPolls: number;
  /** How many polls led to a detected signal. */
  totalDetections: number;
  /** How many signals led to an action. */
  totalActions: number;
  /** Last time this monitor was polled. */
  lastPolledAt: Date | null;
}

// ── Cadence Episode (mini cerebellum feedback) ──────────────────

/**
 * One feedback event for the cadence learning loop.
 * Per-signal: did this signal lead to an action?
 */
export interface CadenceEpisode {
  monitorId: string;
  signalId: string;
  /** Did batch processing act on this signal? */
  ledToAction: boolean;
  /** Monotonically increasing for recency weighting. */
  sequenceNumber: number;
  recordedAt: Date;
}

// ── Monitor ─────────────────────────────────────────────────────

/**
 * A registered monitor — what to watch and how to check it.
 * Infrastructure-generic: any async function that returns a SentryResult.
 */
export interface ExteroceptiveMonitor {
  id: string;
  /** Human-readable name for observability. */
  name: string;
  /** What this monitor watches. */
  source: MonitorSource;
  /** The poll function — called by the sentry at the learned cadence. */
  poll: () => Promise<SentryResult>;
  /** Current cadence (learned by mini cerebellum). */
  cadence: MonitorCadence;
  /** Whether this monitor is currently active. */
  enabled: boolean;
  /** When this monitor was registered. */
  registeredAt: Date;
}

// ── Config ──────────────────────────────────────────────────────

export interface ExteroceptionConfig {
  /** Enable/disable the entire sentry loop. */
  enabled: boolean;
  /** Default polling interval for new monitors (ms). */
  defaultIntervalMs: number;
  /** Minimum polling interval floor (ms). Prevents runaway polling. */
  globalFloorMs: number;
  /** Maximum polling interval ceiling (ms). */
  globalCeilingMs: number;
  /** EMA decay factor for action rate (0–1). Higher = more weight on recent. */
  emaAlpha: number;
  /** Action rate threshold: below this, increase interval. */
  cooldownThreshold: number;
  /** Action rate threshold: above this, decrease interval. */
  warmupThreshold: number;
  /** Factor by which to multiply interval when cooling down. */
  cooldownFactor: number;
  /** Factor by which to multiply interval when warming up. */
  warmupFactor: number;
  /** Maximum signals to store before oldest are pruned. */
  maxStoredSignals: number;
  /** Maximum cadence episodes to store per monitor. */
  maxCadenceEpisodes: number;
}

export const DEFAULT_EXTEROCEPTION_CONFIG: ExteroceptionConfig = {
  enabled: true,
  defaultIntervalMs: 60_000,     // 1 minute default
  globalFloorMs: 10_000,          // never faster than 10 seconds
  globalCeilingMs: 600_000,       // never slower than 10 minutes
  emaAlpha: 0.3,                  // recent signals weigh ~30%
  cooldownThreshold: 0.1,         // below 10% action rate → slow down
  warmupThreshold: 0.5,           // above 50% action rate → speed up
  cooldownFactor: 1.5,            // 50% slower when cooling
  warmupFactor: 0.7,              // 30% faster when warming
  maxStoredSignals: 200,
  maxCadenceEpisodes: 50,         // per monitor, matching cerebellum's maxEpisodes
};

// ── State (serializable snapshot) ───────────────────────────────

/**
 * Serializable state for dashboard/debugging.
 * Follows the AmygdalaState pattern.
 */
export interface ExteroceptionState {
  enabled: boolean;
  running: boolean;
  monitorCount: number;
  activeMonitors: number;
  pendingSignals: number;
  totalSignalsProcessed: number;
  monitors: Array<{
    id: string;
    name: string;
    sourceKind: string;
    enabled: boolean;
    intervalMs: number;
    actionRate: number;
    totalPolls: number;
    lastPolledAt: string | null;
  }>;
}
