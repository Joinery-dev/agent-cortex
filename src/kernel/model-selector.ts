/**
 * Model Selector — picks the model tier for each LLM call.
 *
 * LEARNED, NOT HARDCODED. The selector asks the Cerebellum:
 * "for this purpose × task type, what quality do I predict from
 * each model tier?" Then picks the cheapest model whose predicted
 * quality exceeds an NE-modulated quality threshold.
 *
 * Cold start (training wheels): when the Cerebellum has no model-quality
 * data, the selector uses the configured default from CortexConfig.
 * This is conservative — the system starts expensive and learns to
 * economize as episodes accumulate.
 *
 * Budget pressure doesn't hardcode downgrade rules. It lowers the
 * quality threshold the prediction must exceed — making cheaper
 * models viable without encoding which specific purposes can downgrade.
 */

import type { Purpose } from "../llm/client.js";
import { MODEL_PRICING } from "../types/cost.js";
import { createLogger } from "../util/logger.js";
import { emitInfo } from "../events.js";

const log = createLogger("model-selector");

// ─── Model tiers ordered by cost (cheapest first) ───────────────

export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Map a full model ID to its tier. */
export function toTier(model: string): ModelTier {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  return "sonnet";
}

/** Get the cost per 1M input tokens for a tier. For comparison only. */
function tierCost(tier: ModelTier): number {
  const pricing = MODEL_PRICING.find((p) => p.modelPattern === tier);
  return pricing?.inputPer1M ?? 3.0; // default to sonnet pricing
}

// ─── Quality predictor interface ────────────────────────────────

/**
 * Interface for the Cerebellum's quality prediction by model tier.
 * The Cerebellum implements this once it has enough episode data
 * with model tier metadata.
 */
export interface ModelQualityPredictor {
  /**
   * Predict quality (0–10) if we use this model tier for this purpose.
   * Returns null on cold start (insufficient episodes with this tier).
   */
  predictQualityByModel(
    purpose: Purpose,
    modelTier: ModelTier,
  ): number | null;
}

// ─── Selector ───────────────────────────────────────────────────

export interface ModelSelectionContext {
  /** What this LLM call is for. */
  purpose: Purpose;
  /** NE level (0–1). Higher = demand higher quality = prefer expensive model. */
  neLevel: number;
  /** Budget pressure (0–1). Higher = accept lower quality = cheaper models viable. */
  budgetPressure: number;
  /** The configured default model from CortexConfig. Used on cold start. */
  configuredModel: string;
}

export interface ModelSelectionResult {
  /** The model to use (full ID or tier alias). */
  model: string;
  /** Whether this was a cold-start default or a learned selection. */
  source: "learned" | "cold-start";
  /** If learned: the predicted quality for the selected model. */
  predictedQuality?: number;
  /** If learned and different from configured: the tier we downgraded from. */
  downgradedFrom?: ModelTier;
}

/**
 * Select the best model for a given purpose and context.
 *
 * When a predictor is available and has data:
 *   1. Compute quality threshold from NE + budget pressure
 *   2. For each tier (cheapest first), check if predicted quality exceeds threshold
 *   3. Pick the cheapest model that passes
 *
 * When no predictor or cold start:
 *   Return the configured default model (training wheels).
 */
export function selectModel(
  context: ModelSelectionContext,
  predictor?: ModelQualityPredictor,
): ModelSelectionResult {
  const { purpose, neLevel, budgetPressure, configuredModel } = context;
  const configuredTier = toTier(configuredModel);

  // ── Cold start: no predictor or no data ─────────────────────
  if (!predictor) {
    return { model: configuredModel, source: "cold-start" };
  }

  // ── Quality threshold: NE pushes up, budget pressure pushes down ──
  // Base threshold: 5.0 (acceptable quality on a 1-10 scale)
  // NE range: +0 to +2.0 (high NE demands quality up to 7.0)
  // Budget pressure: -0 to -2.0 (high pressure accepts down to 3.0)
  const baseThreshold = 5.0;
  const neBoost = neLevel * 2.0;
  const budgetDiscount = budgetPressure * 2.0;
  const qualityThreshold = Math.max(
    2.0,
    Math.min(8.0, baseThreshold + neBoost - budgetDiscount),
  );

  // ── Try each tier from cheapest to most expensive ───────────
  for (const tier of MODEL_TIERS) {
    const predicted = predictor.predictQualityByModel(purpose, tier);

    if (predicted === null) {
      // No data for this tier — skip (don't guess)
      continue;
    }

    if (predicted >= qualityThreshold) {
      // This tier meets the quality bar
      const downgraded = tierCost(tier) < tierCost(configuredTier);

      if (downgraded) {
        emitInfo("cost:model-downgrade", {
          purpose,
          from: configuredTier,
          to: tier,
          predictedQuality: predicted,
          qualityThreshold,
          neLevel,
          budgetPressure,
        });

        log.info("Model downgraded", {
          purpose,
          from: configuredTier,
          to: tier,
          predictedQuality: predicted.toFixed(1),
          qualityThreshold: qualityThreshold.toFixed(1),
        });
      }

      return {
        model: tier,
        source: "learned",
        predictedQuality: predicted,
        downgradedFrom: downgraded ? configuredTier : undefined,
      };
    }
  }

  // ── No tier had prediction data, or none met the threshold ──
  // Fall back to configured default
  return { model: configuredModel, source: "cold-start" };
}
