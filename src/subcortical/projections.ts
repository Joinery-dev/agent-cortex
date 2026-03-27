/**
 * Dopamine Projections — pure transform functions.
 *
 * Same phasic signal + tonic state in → per-consumer projection out.
 * These are the "receptor types" — D1/D2 in the striatum, encoding
 * modulation in the hippocampus, gating in the prefrontal cortex.
 *
 * No state, no side effects. Each function takes the raw signal and
 * current tonic, returns a typed projection that the consumer knows
 * how to interpret.
 */

import type { DopamineSignal, ReceptorDopamine } from "../types/cerebellum.js";
import type {
  TonicDopamine,
  HippocampalProjection,
  StriatalProjection,
  PlasticityProjection,
  PrefrontalProjection,
  ReceptorWeightDelta,
  DopamineProjections,
} from "../types/dopamine.js";

// ─── Hippocampal Projection ──────────────────────────────────────

/**
 * How the hippocampus should interpret this dopamine signal.
 *
 * encodingStrength: from |aggregate|, saturates at 1.0 for |agg| >= 3.
 *   Replaces the ad-hoc `Math.min(1, abs(dopamine) / 3)` from episode-builder.
 *   Same formula, but now it lives here — one source of truth.
 *
 * consolidationUrgency: from tonic level. Negative tonic = project going
 *   badly → extract lessons faster. Mapped from tonic.level:
 *   - tonic >= 0 → low urgency (0.1 baseline)
 *   - tonic <= -2 → max urgency (1.0)
 */
export function projectToHippocampus(
  signal: DopamineSignal,
  tonic: TonicDopamine,
): HippocampalProjection {
  // encodingStrength: |aggregate| / 3, clamped to [0, 1]
  const encodingStrength = Math.min(1, Math.abs(signal.aggregate) / 3);

  // consolidationUrgency: maps negative tonic to urgency
  // tonic 0 → 0.1, tonic -1 → 0.55, tonic -2 → 1.0
  const rawUrgency = tonic.level < 0
    ? Math.min(1, 0.1 + Math.abs(tonic.level) * 0.45)
    : 0.1;

  return {
    encodingStrength,
    consolidationUrgency: rawUrgency,
  };
}

// ─── Striatal Projection ─────────────────────────────────────────

/**
 * How the basal ganglia should interpret this dopamine signal.
 *
 * reinforcement: maps aggregate to [-1, +1]. Positive = strengthen
 *   the sense-activation pattern, negative = weaken it.
 *   Uses tanh for smooth saturation.
 *
 * explorationBias: from tonic level. Low/negative tonic = explore more.
 *   Positive tonic = leverage what's working.
 *   - tonic <= -1 → bias 0.9 (heavy exploration)
 *   - tonic == 0 → bias 0.5 (balanced)
 *   - tonic >= +1 → bias 0.1 (heavy leveraging)
 */
export function projectToStriatum(
  signal: DopamineSignal,
  tonic: TonicDopamine,
): StriatalProjection {
  // Reinforcement: tanh gives smooth [-1, +1] mapping
  // aggregate of ±2 → reinforcement of ±0.96
  const reinforcement = Math.tanh(signal.aggregate);

  // Exploration bias: linear map from tonic, clamped to [0.1, 0.9]
  // tonic -1 → 0.9, tonic 0 → 0.5, tonic +1 → 0.1
  const rawBias = 0.5 - tonic.level * 0.4;
  const explorationBias = Math.max(0.1, Math.min(0.9, rawBias));

  return {
    reinforcement,
    explorationBias,
  };
}

// ─── Plasticity Projection ───────────────────────────────────────

/**
 * How the plasticity system should interpret this dopamine signal.
 *
 * learningRate: replaces the hardcoded 0.05 from applyDopamineToWeights.
 *   Derived from |aggregate| × confidence. Bigger surprises → more learning.
 *   Capped at 0.15 to prevent wild swings.
 *
 * perReceptor: each entry carries the direction and magnitude of
 *   the weight change, plus the prediction confidence as a modulator.
 *   Preserves the existing logic: delta × confidenceModulator / 10.
 */
export function projectToPlasticity(
  signal: DopamineSignal,
  _tonic: TonicDopamine,
): PlasticityProjection {
  // Learning rate scales with surprise magnitude and confidence
  // |aggregate| of 0 → 0, |aggregate| of 3 → ~0.15
  const baseLearningRate = Math.min(
    0.15,
    Math.abs(signal.aggregate) * signal.predictionConfidence * 0.05,
  );

  const perReceptor: ReceptorWeightDelta[] = signal.perReceptor.map(
    (rd: ReceptorDopamine) => {
      // Confidence-modulated: confident wrong predictions → bigger correction
      const confidenceModulator = 0.5 + 0.5 * rd.confidence;
      // Normalize from 1-10 scale to roughly [-1, +1]
      const delta = (rd.delta * confidenceModulator) / 10;

      return {
        receptorId: rd.receptorId,
        delta,
        predictionConfidence: rd.confidence,
      };
    },
  );

  return {
    learningRate: baseLearningRate,
    perReceptor,
  };
}

// ─── Prefrontal Projection ───────────────────────────────────────

/**
 * How the prefrontal cortex should interpret this dopamine signal.
 *
 * wmGateStrength: large |phasic| → "update working memory, new info
 *   is important." Small |phasic| → "maintain current contents."
 *   Same saturation curve as encoding strength but with a lower baseline.
 */
export function projectToPrefrontal(
  signal: DopamineSignal,
  _tonic: TonicDopamine,
): PrefrontalProjection {
  // |aggregate| / 3, clamped to [0, 1], with a 0.2 baseline
  // (some WM gating always happens, even on unsurprising tasks)
  const raw = Math.min(1, Math.abs(signal.aggregate) / 3);
  const wmGateStrength = 0.2 + 0.8 * raw;

  return { wmGateStrength };
}

// ─── Composite ───────────────────────────────────────────────────

/**
 * Compute all four projections from a phasic signal + tonic state.
 * Called once per task, result distributed to each consumer.
 */
export function computeProjections(
  signal: DopamineSignal,
  tonic: TonicDopamine,
): DopamineProjections {
  return {
    taskId: signal.taskId,
    phasicAggregate: signal.aggregate,
    tonic,
    hippocampal: projectToHippocampus(signal, tonic),
    striatal: projectToStriatum(signal, tonic),
    plasticity: projectToPlasticity(signal, tonic),
    prefrontal: projectToPrefrontal(signal, tonic),
  };
}
