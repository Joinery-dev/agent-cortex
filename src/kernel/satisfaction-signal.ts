/**
 * Satisfaction Signal — Parsifal Partnership Feature #25.
 *
 * Receives Parsifal input (approval, correction, override) and translates
 * it into plasticity weight updates. This is Goodhart's law protection:
 * Cortex can't just optimize its own internal scores. The Parsifal's
 * actual satisfaction anchors learning to reality.
 *
 * Two processing paths:
 *
 *   processTasteResponse() — maps a taste proposal response to specific
 *     plasticity operations. Each of the four response types has a
 *     distinct learning contract:
 *       "update"   → system was right to deviate from stated preference
 *       "keep"     → stated preference is intentional, scores were misleading
 *       "nuanced"  → conversation produced better preference than either party had
 *       "deferred" → no learning yet, repropose later if divergence persists
 *
 *   processTaskSignal() — maps task-level approval/correction to
 *     evaluation-influence weight adjustments. Smaller deltas than
 *     taste signals — individual task feedback is less informative
 *     than persistent divergence patterns.
 *
 * All plasticity writes use DeltaSource = "satisfaction".
 */

import type {
  SatisfactionResponse,
  SatisfactionSignal,
  PlasticityMapping,
  PlasticityUpdate,
  TasteUpdate,
  SatisfactionSignalConfig,
} from "../types/satisfaction-signal.js";
import { DEFAULT_SATISFACTION_CONFIG } from "../types/satisfaction-signal.js";
import type { TasteProposal } from "../types/taste-feedback.js";
import type { TasteProfile } from "../types/intent.js";
import type { PlasticityStore } from "../types/plasticity.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("satisfaction-signal");

// ─── Constants ──────────────────────────────────────────────────

const TASTE_ROUTING_WEIGHT = "thalamus.routing.taste";
const SENSE_WEIGHT_PREFIX = "evaluator.sense-weight.";

// ─── Core: Taste Response Processing ─────────────────────────────

/**
 * Map a taste proposal response to plasticity operations.
 *
 * This is the heart of the learning loop. Given the Parsifal's response
 * to a taste divergence proposal, compute which weights change and
 * whether the taste profile should be mutated.
 *
 * The caller is responsible for:
 *   - Applying weight updates via PlasticityStore.update()
 *   - Applying taste mutations via Thalamus.updateProject()
 *   - Marking the proposal as responded
 */
export function processTasteResponse(
  response: SatisfactionResponse,
  proposal: TasteProposal,
  config: SatisfactionSignalConfig = DEFAULT_SATISFACTION_CONFIG,
): PlasticityMapping {
  switch (response.type) {
    case "update":
      return processUpdate(response, proposal, config);
    case "keep":
      return processKeep(response, proposal, config);
    case "nuanced":
      return processNuanced(response, proposal, config);
    case "deferred":
      return processDeferred();
  }
}

/**
 * "Yes, update" — taste was wrong, system's interpretation was better.
 *
 * Plasticity: push thalamus.routing.taste DOWN. The system learned that
 * deviating from stated preferences led to better outcomes, so give it
 * more interpretive freedom.
 *
 * TasteProfile: mutate each divergent dimension to the demonstrated value.
 */
function processUpdate(
  _response: SatisfactionResponse,
  proposal: TasteProposal,
  config: SatisfactionSignalConfig,
): PlasticityMapping {
  const delta = computeDelta(config, proposal.proposalStrength);
  const updates: PlasticityUpdate[] = [];
  const tasteUpdates: TasteUpdate[] = [];

  // Push taste routing weight DOWN — system earned interpretive freedom
  updates.push({
    connectionId: TASTE_ROUTING_WEIGHT,
    delta: -delta,
    context: `taste-update:${proposal.dimensions.join(",")}`,
  });

  // Collect taste profile mutations — each divergent dimension
  // adopts the demonstrated preference
  for (const div of proposal.divergences) {
    tasteUpdates.push({
      dimension: div.dimension,
      oldValue: div.stated,
      newValue: div.demonstrated,
    });
  }

  log.info("Processing 'update' response", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    delta: -delta,
    tasteUpdates: tasteUpdates.length,
  });

  emit("satisfaction:taste-updated", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    routingDelta: -delta,
  });

  return {
    updates,
    // Return the first taste update — proposals typically cover
    // one dimension. Multi-dimension proposals produce multiple
    // taste updates but we return the primary one.
    tasteUpdate: tasteUpdates[0],
  };
}

/**
 * "No, keep it" — stated preference is intentional. Goodhart case.
 *
 * The system's internal scores were misleading for this dimension —
 * high scores didn't mean high satisfaction.
 *
 * Plasticity: push thalamus.routing.taste UP (be more faithful to
 * stated preferences). This is Cortex learning to trust the
 * Parsifal's stated preference over its own measurements.
 */
function processKeep(
  _response: SatisfactionResponse,
  proposal: TasteProposal,
  config: SatisfactionSignalConfig,
): PlasticityMapping {
  const delta = computeDelta(config, proposal.proposalStrength);

  const updates: PlasticityUpdate[] = [
    {
      connectionId: TASTE_ROUTING_WEIGHT,
      delta: +delta,
      context: `taste-keep:${proposal.dimensions.join(",")}`,
    },
  ];

  log.info("Processing 'keep' response — Goodhart case", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    delta: +delta,
  });

  emit("satisfaction:keep-affirmed", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    routingDelta: +delta,
  });

  return { updates };
}

/**
 * "It's more nuanced — actually Z" — co-creation.
 *
 * The divergence observation sparked a conversation that produced a
 * better understanding than either party had. The new preference is
 * neither the stated nor the demonstrated — it's a synthesis.
 *
 * Plasticity: slight push DOWN on routing weight. The system's instinct
 * to question stated preferences was correct, but the right answer
 * wasn't what the data showed — it was something new. Reward the
 * instinct with slightly more interpretive freedom, but less than
 * a full "update" since Cortex's demonstrated preference wasn't
 * the right answer either.
 *
 * TasteProfile: mutate to the Parsifal's articulated new value.
 */
function processNuanced(
  response: SatisfactionResponse,
  proposal: TasteProposal,
  config: SatisfactionSignalConfig,
): PlasticityMapping {
  // Half the delta of a full "update" — Cortex was right to
  // question but wrong about the answer
  const delta = computeDelta(config, proposal.proposalStrength) * 0.5;

  const updates: PlasticityUpdate[] = [
    {
      connectionId: TASTE_ROUTING_WEIGHT,
      delta: -delta,
      context: `taste-nuanced:${proposal.dimensions.join(",")}`,
    },
  ];

  // The Parsifal's articulated preference replaces the divergent dimensions.
  // For nuanced responses, response.newPreference is the synthesis.
  // If the Parsifal only provided detail but no explicit newPreference,
  // use their detail as the new value.
  const newValue = response.newPreference ?? response.detail ?? proposal.divergences[0]?.demonstrated ?? "";
  const primaryDivergence = proposal.divergences[0];

  const tasteUpdate: TasteUpdate | undefined = primaryDivergence
    ? {
        dimension: primaryDivergence.dimension,
        oldValue: primaryDivergence.stated,
        newValue,
      }
    : undefined;

  log.info("Processing 'nuanced' response — co-creation", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    delta: -delta,
    newValue: newValue.slice(0, 100),
  });

  emit("satisfaction:nuanced-update", {
    proposalId: proposal.id,
    dimensions: proposal.dimensions,
    routingDelta: -delta,
  });

  return { updates, tasteUpdate };
}

/**
 * "Let me think about it" — deferred.
 *
 * No plasticity changes. The proposal stays pending and may be
 * resurfaced at the next deep analysis if divergence persists.
 */
function processDeferred(): PlasticityMapping {
  log.info("Processing 'deferred' response — no learning");

  emit("satisfaction:deferred", {});

  return { updates: [] };
}

// ─── Task-Level Signal Processing ────────────────────────────────

/**
 * Process a task-level approval or correction signal.
 *
 * Task approval validates Cortex's judgment: small positive delta
 * to evaluation-influence weights. Task correction indicates the
 * system's internal scores misled it: small negative delta.
 *
 * These are smaller signals than taste responses — individual task
 * feedback is less informative than persistent divergence patterns.
 *
 * @param signal — the satisfaction signal (must be task-approval or task-correction)
 * @param activeSenseNames — the senses that were active for this task
 * @param config — delta magnitudes
 */
export function processTaskSignal(
  signal: SatisfactionSignal,
  activeSenseNames: string[],
  config: SatisfactionSignalConfig = DEFAULT_SATISFACTION_CONFIG,
): PlasticityMapping {
  if (!signal.taskSignal) {
    return { updates: [] };
  }

  const { taskId, approved } = signal.taskSignal;
  const delta = approved ? +config.taskDelta : -config.taskDelta;
  const direction = approved ? "approval" : "correction";

  const updates: PlasticityUpdate[] = activeSenseNames.map((senseName) => ({
    connectionId: `${SENSE_WEIGHT_PREFIX}${senseName}`,
    delta,
    context: `task-${direction}:${taskId}`,
  }));

  log.info(`Processing task ${direction}`, {
    taskId,
    sensesAffected: activeSenseNames.length,
    delta,
  });

  emit(`satisfaction:task-${direction}`, {
    taskId,
    sensesAffected: activeSenseNames.length,
    delta,
  });

  return { updates };
}

// ─── Applying Mappings ──────────────────────────────────────────

/**
 * Apply a PlasticityMapping to the store.
 *
 * Convenience function that iterates over updates and calls
 * PlasticityStore.update() for each. All writes use DeltaSource
 * = "satisfaction".
 *
 * Returns the mapping unchanged (for chaining).
 */
export function applyMapping(
  mapping: PlasticityMapping,
  store: PlasticityStore,
): PlasticityMapping {
  for (const update of mapping.updates) {
    store.update(update.connectionId, update.delta, "satisfaction", update.context);
  }

  if (mapping.updates.length > 0) {
    emit("satisfaction:applied", {
      updateCount: mapping.updates.length,
      hasTasteUpdate: mapping.tasteUpdate !== undefined,
    });
  }

  return mapping;
}

/**
 * Apply a TasteUpdate to a TasteProfile, returning the mutated profile.
 *
 * Does NOT modify the input — returns a new object. The caller is
 * responsible for propagating via Thalamus.updateProject().
 */
export function applyTasteUpdate(
  taste: TasteProfile,
  update: TasteUpdate,
): TasteProfile {
  const known = ["visual", "decisionStyle", "communication", "patterns"] as const;
  type KnownDimension = (typeof known)[number];

  const isKnown = (d: string): d is KnownDimension =>
    (known as readonly string[]).includes(d);

  if (isKnown(update.dimension)) {
    return { ...taste, [update.dimension]: update.newValue };
  }

  // Unknown dimensions go into the extensible raw map
  return {
    ...taste,
    raw: { ...taste.raw, [update.dimension]: update.newValue },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Compute the delta magnitude for a taste response.
 * Scaled by proposal strength — stronger divergences produce
 * larger adjustments when confirmed by the Parsifal.
 */
function computeDelta(
  config: SatisfactionSignalConfig,
  proposalStrength: number,
): number {
  return config.baseDelta * (1 + config.strengthScaling * proposalStrength);
}
