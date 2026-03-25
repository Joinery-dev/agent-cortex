/**
 * Gate — multiple decision strategies, selected by signal landscape.
 *
 * Strategies are pure functions. The selector picks one based on
 * available signals (NE is the first; BG, amygdala, cerebellum
 * plug in later without changing the interface).
 *
 * Both the strategies and the selector are replaceable — Plasticity
 * can learn better versions from experience.
 */

import type {
  Gate,
  GateInput,
  GateOutput,
  GateStrategy,
  SignalLandscape,
  StrategySelector,
} from "../types/gate.js";
import type { WeightedEvaluation } from "./evaluation-weighter.js";
import { emit } from "../events.js";

// ─── Helper ──────────────────────────────────────────────────────

/**
 * Sort evaluations by impact: stake * (10 - score), descending.
 * The highest-impact problems come first.
 */
function sortByImpact(evals: WeightedEvaluation[]): WeightedEvaluation[] {
  return [...evals].sort(
    (a, b) => b.adjustedStake * (10 - b.score) - a.adjustedStake * (10 - a.score),
  );
}

/**
 * Check if a tension involves high-stake senses (above the mean).
 */
function isRelevantTension(
  tension: { senseA: { stake?: number }; senseB: { stake?: number } },
  meanStake: number,
): boolean {
  const stakeA = tension.senseA.stake ?? 0;
  const stakeB = tension.senseB.stake ?? 0;
  return Math.max(stakeA, stakeB) > meanStake;
}

// ─── Built-in strategies ─────────────────────────────────────────

/**
 * Deliberative — consensus among invested senses.
 *
 * The cautious mode. Used when NE is high (novel, risky, complex tasks).
 * Any sense above meanStake that marks the work unacceptable blocks.
 * Any tension between high-stake senses blocks.
 */
export const deliberativeStrategy: GateStrategy = (input: GateInput): GateOutput => {
  const { composite, tensions } = input;
  const { meanStake, evaluations } = composite;

  // Any above-mean-stake sense marking unacceptable blocks
  const highStakeRejections = evaluations.filter(
    (e) => e.adjustedStake > meanStake && !e.acceptable,
  );

  if (highStakeRejections.length > 0) {
    return {
      accept: false,
      reason: `Deliberative: ${highStakeRejections.length} invested sense(s) find the work unacceptable`,
      strategy: "deliberative",
      rejectionDrivers: sortByImpact(highStakeRejections),
    };
  }

  // Weighted majority must still agree
  if (composite.weightedAcceptability <= 0.5) {
    const rejections = evaluations.filter((e) => !e.acceptable);
    return {
      accept: false,
      reason: `Deliberative: weighted acceptability ${composite.weightedAcceptability.toFixed(2)} ≤ 0.5 — majority of stake-weighted opinion says unacceptable`,
      strategy: "deliberative",
      rejectionDrivers: sortByImpact(rejections),
    };
  }

  // Any relevant tension blocks (be thorough, resolve everything)
  const relevantTensions = tensions.filter((t) => isRelevantTension(t, meanStake));
  if (relevantTensions.length > 0) {
    return {
      accept: false,
      reason: `Deliberative: ${relevantTensions.length} tension(s) between invested senses need resolution`,
      strategy: "deliberative",
      rejectionDrivers: [],
    };
  }

  return {
    accept: true,
    reason: `Deliberative: all invested senses accept, weighted acceptability ${composite.weightedAcceptability.toFixed(2)}, no relevant tensions`,
    strategy: "deliberative",
    rejectionDrivers: [],
  };
};

/**
 * Democratic — weighted vote.
 *
 * The balanced mode. Used for standard tasks (moderate NE).
 * Majority of stake-weighted opinion must accept.
 * Only high-severity tensions between invested senses block.
 */
export const democraticStrategy: GateStrategy = (input: GateInput): GateOutput => {
  const { composite, tensions } = input;

  if (composite.weightedAcceptability <= 0.5) {
    const rejections = composite.evaluations.filter((e) => !e.acceptable);
    return {
      accept: false,
      reason: `Democratic: weighted acceptability ${composite.weightedAcceptability.toFixed(2)} ≤ 0.5 — majority rejects`,
      strategy: "democratic",
      rejectionDrivers: sortByImpact(rejections),
    };
  }

  // Only high-severity tensions between invested senses block
  const relevantHighTensions = tensions.filter(
    (t) => t.severity === "high" && isRelevantTension(t, composite.meanStake),
  );
  if (relevantHighTensions.length > 0) {
    return {
      accept: false,
      reason: `Democratic: ${relevantHighTensions.length} high-severity tension(s) between invested senses`,
      strategy: "democratic",
      rejectionDrivers: [],
    };
  }

  return {
    accept: true,
    reason: `Democratic: weighted acceptability ${composite.weightedAcceptability.toFixed(2)} > 0.5, no blocking tensions`,
    strategy: "democratic",
    rejectionDrivers: [],
  };
};

/**
 * Expedient — quick check.
 *
 * The fast mode. Used for routine tasks (low NE, strong BG match).
 * Accept if at least some support exists and nothing is catastrophic.
 * Catastrophic = score < 3, which is "fundamentally fails" per the
 * existing 1–10 scale definition.
 */
export const expedientStrategy: GateStrategy = (input: GateInput): GateOutput => {
  const { composite } = input;

  // Any evaluation scoring < 3 is catastrophic regardless of stake
  const catastrophic = composite.evaluations.filter((e) => e.score < 3);
  if (catastrophic.length > 0) {
    return {
      accept: false,
      reason: `Expedient: ${catastrophic.length} catastrophic score(s) (< 3)`,
      strategy: "expedient",
      rejectionDrivers: sortByImpact(catastrophic),
    };
  }

  // Need at least some stake-weighted support
  if (composite.weightedAcceptability <= 0) {
    const rejections = composite.evaluations.filter((e) => !e.acceptable);
    return {
      accept: false,
      reason: `Expedient: zero stake-weighted acceptability — no sense supports this work`,
      strategy: "expedient",
      rejectionDrivers: sortByImpact(rejections),
    };
  }

  return {
    accept: true,
    reason: `Expedient: no catastrophic scores, weighted acceptability ${composite.weightedAcceptability.toFixed(2)} > 0`,
    strategy: "expedient",
    rejectionDrivers: [],
  };
};

// ─── Default selector ────────────────────────────────────────────

/**
 * Default strategy selector — reads NE from the signal landscape.
 *
 * No NE or high NE (> 0.7) → deliberative (be thorough)
 * Moderate NE (0.3–0.7)    → democratic (balanced)
 * Low NE (< 0.3)           → expedient (fast-track)
 *
 * When NE is absent, we default to deliberative — cautious is the
 * safe prior. As more signals come online (BG routines, cerebellum
 * accuracy), the selector can be replaced by a learned function.
 */
export const defaultSelector: StrategySelector = (
  signals: SignalLandscape,
  strategies: Map<string, GateStrategy>,
): { name: string; strategy: GateStrategy } => {
  const ne = signals.ne;

  if (ne === undefined || ne > 0.7) {
    return { name: "deliberative", strategy: strategies.get("deliberative")! };
  }
  if (ne < 0.3) {
    return { name: "expedient", strategy: strategies.get("expedient")! };
  }
  return { name: "democratic", strategy: strategies.get("democratic")! };
};

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a gate with the given strategies and selector.
 * Defaults provided for both — override for custom behavior or testing.
 */
export function createGate(
  customStrategies?: Map<string, GateStrategy>,
  selector: StrategySelector = defaultSelector,
): Gate {
  const strategies = customStrategies ?? new Map<string, GateStrategy>([
    ["deliberative", deliberativeStrategy],
    ["democratic", democraticStrategy],
    ["expedient", expedientStrategy],
  ]);

  return {
    evaluate(input: GateInput): GateOutput {
      const { name, strategy } = selector(input.signals, strategies);

      emit("gate:strategy-selected", {
        strategy: name,
        ne: input.signals.ne,
        cycle: input.cycle,
      });

      const output = strategy(input);

      emit("gate:decision", {
        accept: output.accept,
        reason: output.reason,
        strategy: output.strategy,
        weightedMean: input.composite.weightedMean,
        weightedAcceptability: input.composite.weightedAcceptability,
        confidence: input.composite.confidence,
        cycle: input.cycle,
      });

      return output;
    },
    get strategies() {
      return strategies;
    },
  };
}
