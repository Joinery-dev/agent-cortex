/**
 * Gate types — the decision architecture.
 *
 * Multiple gate strategies interpret evaluation data at different
 * strictness levels. The signal landscape determines which strategy
 * activates. Both strategies and the selector are extensible and
 * replaceable (Plasticity can learn a better selector in Phase 3).
 */

import type { WeightedComposite, WeightedEvaluation } from "../kernel/evaluation-weighter.js";
import type { Tension } from "./tension.js";

// ─── Signal Landscape ────────────────────────────────────────────

/**
 * Extensible bag of signals available to gate strategies and the
 * strategy selector. New signals plug in as optional fields —
 * no interface changes required.
 */
export interface SignalLandscape {
  /** Norepinephrine arousal level. 0–1. From Attention Scheduler. */
  ne?: number;
  /** Basal ganglia routine confidence. 0–1. Phase 3. */
  routineConfidence?: number;
  /** Amygdala urgency flag. Phase 4. */
  urgency?: boolean;
  /** Cerebellum prediction accuracy. 0–1. Phase 3. */
  predictionAccuracy?: number;
  /** Recent dopamine signal magnitude. Phase 3. */
  recentDopamine?: number;
  /** Working memory load. 0–1. From brainstem homeostasis. */
  wmLoad?: number;
  /** Allow arbitrary future signals without interface changes. */
  [key: string]: unknown;
}

// ─── Gate I/O ────────────────────────────────────────────────────

/** Everything a gate strategy needs to make its decision. */
export interface GateInput {
  composite: WeightedComposite;
  tensions: Tension[];
  cycle: number;
  signals: SignalLandscape;
}

/** The gate's decision. */
export interface GateOutput {
  accept: boolean;
  reason: string;
  /** Which strategy produced this decision. */
  strategy: string;
  /** Evaluations that drove rejection, sorted by impact (highest first). */
  rejectionDrivers: WeightedEvaluation[];
}

// ─── Strategy types ──────────────────────────────────────────────

/** A gate strategy is a pure function: input → decision. */
export type GateStrategy = (input: GateInput) => GateOutput;

/**
 * Picks a strategy given the current signal landscape.
 * Returns the strategy name and function.
 * Replaceable by Plasticity — the meta-decision can be learned.
 */
export type StrategySelector = (
  signals: SignalLandscape,
  strategies: Map<string, GateStrategy>,
) => { name: string; strategy: GateStrategy };

/** The gate: a bound selector + strategy map. */
export interface Gate {
  evaluate(input: GateInput): GateOutput;
  /** Expose for introspection / testing. */
  readonly strategies: ReadonlyMap<string, GateStrategy>;
}
