/**
 * Plasticity Types — fixed vs. plastic connections.
 *
 * Two kinds of wiring:
 *   Fixed (→)   — structural. Results always flow to Working Memory.
 *                  Thalamus always routes. These ARE the architecture.
 *   Plastic (🧬) — influence weights that reshape with experience.
 *                  How much Hippocampus shapes a briefing. How aggressive
 *                  the Basal Ganglia is. How much each sense's evaluation matters.
 *
 * Fixed connections define what CAN happen.
 * Plastic connections define what TENDS to happen.
 *
 * Plastic connections have meaningful defaults — reset them and the system
 * works fine, it just hasn't formed an identity yet. The collection of all
 * plastic weights at a point in time is the system's identity portrait.
 *
 * Feature #20 defines the map. Feature #19 implements the runtime store.
 */

// ─── Delta Sources ──────────────────────────────────────────────

/**
 * What can cause a plastic weight to change.
 *   dopamine      — prediction error signal from cerebellum
 *   satisfaction   — human approval/correction (Feature #25)
 *   decay          — rest-cycle reversion toward category mean
 *   settle         — rest-cycle convergence of volatile weights
 *   registration   — initial value set when a connection is registered
 */
export type DeltaSource =
  | "dopamine"
  | "satisfaction"
  | "decay"
  | "settle"
  | "registration";

// ─── Connection Categories ──────────────────────────────────────

/**
 * Normalization group. Connections in the same category share a
 * normalization rule (relative sum-to-target, or independent).
 */
export type ConnectionCategory =
  | "evaluation-influence"
  | "routing-intensity"
  | "threshold"
  | "selection-weight"
  | "routine-strength";

/**
 * How a category normalizes its weights.
 *   relative    — weights sum to `target`. Adjusting one adjusts others.
 *   independent — each weight is independent. No cross-weight effects.
 */
export type NormalizationBehavior = "relative" | "independent";

export interface CategoryConfig {
  normalization: NormalizationBehavior;
  /** For 'relative' categories: what the weights should sum to. Ignored for 'independent'. */
  target?: number;
}

export const CATEGORY_CONFIG: Readonly<Record<ConnectionCategory, CategoryConfig>> = {
  "evaluation-influence": { normalization: "relative", target: 1.0 },
  "routing-intensity": { normalization: "independent" },
  threshold: { normalization: "independent" },
  "selection-weight": { normalization: "relative", target: 1.0 },
  "routine-strength": { normalization: "independent" },
};

// ─── Connection Declarations ────────────────────────────────────

/**
 * What a plastic connection IS — its identity, not its runtime state.
 * The connection library is an array of these. Feature #19's PlasticityStore
 * uses this as the schema for each weight it manages.
 *
 * Hierarchical ID format: `{region}.{role}.{specifics}`
 * Coarse connections drop the last segment (e.g. `evaluator.sense-weight`).
 * When the data warrants splitting, register fine-grained connections and
 * the coarse one becomes their default.
 */
export interface PlasticConnectionDeclaration {
  /** Hierarchical ID. e.g. "thalamus.routing.hippocampus" */
  id: string;
  /** Brain region this connection belongs to. */
  region: string;
  /** Human-readable description of what this weight controls. */
  description: string;
  /** Default value — starting point and decay reference. */
  defaultValue: number;
  /** Allowed range [min, max]. Clamped during updates. */
  range: [min: number, max: number];
  /** Which normalization group this belongs to. */
  category: ConnectionCategory;
  /**
   * Whether the ID is a template that gets instantiated per-entity.
   * e.g. evaluator.sense-weight is per-sense — instantiated as
   * evaluator.sense-weight.DESIGN, evaluator.sense-weight.PERFORMANCE, etc.
   * Feature #19 expands templates at registration time.
   *
   * For templates in a 'relative' category: defaultValue is the
   * pre-normalization weight. When instantiated for N entities,
   * each gets defaultValue/N after normalization.
   */
  perEntity?: boolean;
}

// ─── Runtime State ──────────────────────────────────────────────

/** A single change to a plastic weight. Audit trail for debugging + visualization. */
export interface WeightDelta {
  timestamp: Date;
  /** The change amount (can be positive or negative). */
  delta: number;
  /** What caused this change. */
  source: DeltaSource;
  /** Optional context (e.g. taskId for dopamine, "rest-cycle-3" for decay). */
  context?: string;
}

/**
 * Runtime state of a single plastic weight.
 * Managed by PlasticityStore (Feature #19).
 */
export interface PlasticWeight {
  /** Matches a PlasticConnectionDeclaration.id (possibly with entity suffix). */
  connectionId: string;
  /** Current value, always within the declaration's range. */
  value: number;
  /** Default from the declaration (for decay-toward-mean reference). */
  defaultValue: number;
  /** Range from the declaration (for clamping). */
  range: [min: number, max: number];
  /** Category from the declaration (for normalization lookup). */
  category: ConnectionCategory;
  /** Recent deltas — bounded ring buffer, newest first. Feature #19 decides buffer size. */
  recentDeltas: WeightDelta[];
  /** Timestamp of last modification. */
  lastModified: Date;
}

// ─── Identity Snapshots ─────────────────────────────────────────

/**
 * All plastic weights at a point in time — the identity portrait.
 * Used for:
 *   - Snapshot before rest (compare after)
 *   - Serialization / restore across sessions
 *   - Visualization in the dashboard
 *
 * If you save and load a ConnectionSnapshot, you're saving and loading
 * the system's personality.
 */
export interface ConnectionSnapshot {
  weights: PlasticWeight[];
  /** When this snapshot was taken. */
  capturedAt: Date;
  /** Optional label (e.g. "pre-rest", "session-start", "after-project-X"). */
  label?: string;
}

// ─── PlasticityStore Interface ──────────────────────────────────

/**
 * Central storage for all plastic weights.
 * Stored centrally, used locally: components read from it, dopamine writes
 * to it, rest operations iterate over it. But the semantics of each weight
 * are defined by the component that reads it.
 *
 * Feature #19 implements this. Feature #20 defines the contract.
 */
export interface PlasticityStore {
  /**
   * Get a single weight by connection ID.
   * Returns undefined if not registered.
   */
  get(connectionId: string): PlasticWeight | undefined;

  /**
   * Get all weights in a category.
   * For normalized categories, these are the weights that sum to the target.
   */
  getByCategory(category: ConnectionCategory): PlasticWeight[];

  /**
   * Apply a delta to a weight. Clamps to range. Triggers normalization
   * for relative categories. Records the delta in the weight's history.
   * Returns the new value after clamping and normalization.
   */
  update(
    connectionId: string,
    delta: number,
    source: DeltaSource,
    context?: string,
  ): number;

  /**
   * Register a new connection at runtime. Used by Phase 4/5 components
   * and by Basal Ganglia for dynamic routine-strength connections.
   * No-op if the connectionId already exists.
   */
  register(declaration: PlasticConnectionDeclaration): void;

  /** Take a snapshot of all current weights. */
  snapshot(label?: string): ConnectionSnapshot;

  /** Restore weights from a snapshot. Overwrites current values. */
  restore(snapshot: ConnectionSnapshot): void;

  /** Iterate over all weights. For rest-cycle decay/settle operations. */
  all(): IterableIterator<PlasticWeight>;

  /** Number of registered weights. */
  readonly size: number;
}

// ─── Fixed Connections ──────────────────────────────────────────

/**
 * A structural connection — documentation-as-code.
 * Not runtime-manipulated. Exists for:
 *   - Visualization (dashboard wiring diagram)
 *   - Reasoning (LLMs can reference the connection map)
 *   - Architecture validation
 */
export interface FixedConnection {
  /** Source component/region. */
  source: string;
  /** Target component/region. */
  target: string;
  /** Human-readable description of what flows along this connection. */
  dataFlowing: string;
}

// ─── Connection Libraries ───────────────────────────────────────

/**
 * All structural (fixed) connections in the system.
 * These ARE the architecture — removing one breaks the system.
 */
export const FIXED_CONNECTIONS = [
  // Results flow
  { source: "TaskResults", target: "WorkingMemory", dataFlowing: "Scores, patterns, decisions, task summaries" },
  // Thalamus sources (always reads from all available)
  { source: "WorkingMemory", target: "Thalamus", dataFlowing: "Accumulated context: scores, trends, patterns, inhibitions" },
  { source: "ProjectIntent", target: "Thalamus", dataFlowing: "Goals, constraints, success criteria" },
  { source: "TasteProfile", target: "Thalamus", dataFlowing: "Human preferences and style" },
  { source: "PNS", target: "Thalamus", dataFlowing: "Available capabilities and tool outputs" },
  // Thalamus routes to consumers
  { source: "Thalamus", target: "Consultation", dataFlowing: "ConsultationBriefing: task + enrichment + meta" },
  { source: "Thalamus", target: "MotorCortex", dataFlowing: "MotorBriefing: task + builder context + capabilities" },
  { source: "Thalamus", target: "Evaluation", dataFlowing: "EvaluationBriefing: task + score trends + council stakes" },
  { source: "Thalamus", target: "BasalGanglia", dataFlowing: "InhibitionBriefing: sense library + current inhibitions + trends" },
  { source: "Thalamus", target: "AttentionScheduler", dataFlowing: "SchedulingBriefing: task graph + signals + state" },
  // Sensory cortex pipeline
  { source: "Consultation", target: "Evaluation", dataFlowing: "Stakes, evaluation plan, sense perspectives" },
  { source: "Evaluation", target: "Gate", dataFlowing: "WeightedComposite: scores, tensions, acceptability" },
  { source: "Gate", target: "Rhythm", dataFlowing: "GateDecision: continue / complete / escalate / pause" },
  // Motor pathway
  { source: "BasalGanglia", target: "SenseActivation", dataFlowing: "Suppression and reactivation decisions" },
  { source: "MotorCortex", target: "PNS", dataFlowing: "Intentions → translated to tool calls" },
  // Dopamine distribution (always flows to all learning systems)
  { source: "Dopamine", target: "Hippocampus", dataFlowing: "Episode significance — what to remember" },
  { source: "Dopamine", target: "Cerebellum", dataFlowing: "Prediction error → self-calibration" },
  { source: "Dopamine", target: "PlasticityStore", dataFlowing: "Weight update signal + direction" },
  // Structural rhythm
  { source: "Brainstem", target: "PhaseHandlers", dataFlowing: "Rhythm lifecycle: prepare → execute → integrate → gate" },
  // Homeostasis
  { source: "VitalSigns", target: "Homeostasis", dataFlowing: "WM load, prediction accuracy, context capacity, weight volatility" },
  // Human partnership
  { source: "Escalation", target: "Human", dataFlowing: "Questions, proposals, drift alerts, urgent issues" },
  // Drift → scheduling
  { source: "DriftMonitor", target: "AttentionScheduler", dataFlowing: "Drift level and trajectory summary" },
] as const satisfies readonly FixedConnection[];

/**
 * All plastic connections in the system — the identity map.
 * Each weight starts at its default. Over time, dopamine + satisfaction
 * signals reshape them. The collection at any point IS the system's
 * learned personality.
 *
 * Decay toward category mean during rest — bland but stable.
 */
export const PLASTIC_CONNECTIONS = [
  // ── evaluation-influence (normalized, sum to 1.0) ─────────────
  {
    id: "evaluator.sense-weight",
    region: "Evaluation",
    description:
      "Per-sense evaluation influence — how much each sense's score " +
      "matters in the composite. This is what StakeAdjuster reads. " +
      "Template: instantiated per active sense, normalized to 1/N.",
    defaultValue: 1,
    range: [0, 1] as [number, number],
    category: "evaluation-influence" as const,
    perEntity: true,
  },

  // ── routing-intensity (independent, 0–1) ──────────────────────
  {
    id: "thalamus.routing.hippocampus",
    region: "Thalamus",
    description: "How much episodic and crystallized content shapes briefings.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "routing-intensity" as const,
  },
  {
    id: "thalamus.routing.cerebellum",
    region: "Thalamus",
    description: "How much score predictions appear in briefings.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "routing-intensity" as const,
  },
  {
    id: "thalamus.routing.taste",
    region: "Thalamus",
    description:
      "How literally vs. interpretively taste is rendered in briefings. " +
      "Low = loose interpretation. High = faithful to stated preferences.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "routing-intensity" as const,
  },
  {
    id: "thalamus.routing.basal-ganglia",
    region: "Thalamus",
    description: "How much routine context from Basal Ganglia shows up in briefings.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "routing-intensity" as const,
  },

  // ── threshold (independent, 0–1) ─────────────────────────────
  {
    id: "basal-ganglia.threshold.aggressiveness",
    region: "BasalGanglia",
    description:
      "Eagerness to suppress senses. Higher = suppresses more readily. " +
      "Weakens if suppressed senses would have caught real problems.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "amygdala.threshold.urgency",
    region: "Amygdala",
    description:
      "Signal strength required before urgency interrupt fires. " +
      "High default = high bar for interruption.",
    defaultValue: 0.8,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "cognitive-flexibility.threshold.perseveration",
    region: "CognitiveFlexibility",
    description:
      "How quickly to detect stuck-ness and force a full strategy reset. " +
      "Lower = more patient. Higher = triggers reset sooner.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "drift-monitor.threshold.sensitivity",
    region: "DriftMonitor",
    description:
      "Cumulative trajectory deviation that triggers a drift alert. " +
      "Lower = more tolerant. Higher = alerts sooner.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "motor-cortex.threshold.revision-tolerance",
    region: "MotorCortex",
    description:
      "Patience for revision cycles before escalating. " +
      "Lower = escalates quickly. Higher = more revision attempts.",
    defaultValue: 0.5,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "gate.threshold.deliberative-ne",
    region: "Gate",
    description:
      "NE level above which the deliberative gate strategy activates. " +
      "Matches current hardcoded 0.7 in defaultSelector.",
    defaultValue: 0.7,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "gate.threshold.expedient-ne",
    region: "Gate",
    description:
      "NE level below which the expedient gate strategy activates. " +
      "Matches current hardcoded 0.3 in defaultSelector.",
    defaultValue: 0.3,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "cerebellum.confidence.novel-baseline",
    region: "Cerebellum",
    description:
      "Starting confidence for novel tasks with no similar episodes. " +
      "Low default = appropriately humble predictions for unknowns.",
    defaultValue: 0.3,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },
  {
    id: "basal-ganglia.threshold.exploit",
    region: "BasalGanglia",
    description:
      "Routine confidence needed to skip explore and go straight to exploit. " +
      "High default = requires strong routine match before skipping exploration.",
    defaultValue: 0.7,
    range: [0, 1] as [number, number],
    category: "threshold" as const,
  },

  // ── selection-weight (normalized, sum to 1.0) ─────────────────
  {
    id: "scheduler.selection.phase-group",
    region: "AttentionScheduler",
    description:
      "Weight for batching same-phase tasks together. " +
      "Strengthens for projects that benefit from focused phase work.",
    defaultValue: 0.3,
    range: [0, 1] as [number, number],
    category: "selection-weight" as const,
  },
  {
    id: "scheduler.selection.dependency-unblocking",
    region: "AttentionScheduler",
    description:
      "Weight for prioritizing tasks that unblock downstream dependencies. " +
      "Strengthens for projects with deep dependency chains.",
    defaultValue: 0.4,
    range: [0, 1] as [number, number],
    category: "selection-weight" as const,
  },
  {
    id: "scheduler.selection.trend-response",
    region: "AttentionScheduler",
    description:
      "Weight for responding to declining score trends. " +
      "Strengthens when trend-responsive scheduling leads to better outcomes.",
    defaultValue: 0.3,
    range: [0, 1] as [number, number],
    category: "selection-weight" as const,
  },

  // ── routine-strength (independent per routine, 0–1) ───────────
  // No initial entries. Basal Ganglia registers routines dynamically
  // as patterns are learned. Each gets: id "basal-ganglia.routine.{patternId}",
  // defaultValue 0, range [0, 1], category "routine-strength".
] as const satisfies readonly PlasticConnectionDeclaration[];
