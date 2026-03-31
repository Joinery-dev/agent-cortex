/**
 * Guidance Store — versioned, tracked failure preemption guidance.
 *
 * Replaces the hardcoded guidance strings in the Thalamus with
 * a persistent store of guidance variants that can evolve via
 * reflective mutation during rest cycles.
 *
 * Each variant tracks how often it's been used and how often it
 * successfully preempted the predicted failure. Underperforming
 * variants trigger reflective evolution during rest.
 *
 * A/B testing: when a mutation is proposed, the store alternates
 * between control (current) and challenger (proposed) variants.
 * After sufficient data, the winner is promoted.
 */

import type { FailureCategory } from "../types/motor-cortex.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("guidance-store");

// ─── Types ─────────────────────────────────────────────────────

export interface GuidanceVariant {
  id: string;
  category: FailureCategory;
  consumer: "consultation" | "motor";
  text: string;
  version: number;
  parentId: string | null;
  stats: {
    timesUsed: number;
    timesPreempted: number;
    timesFailed: number;
    preemptionRate: number;
  };
  createdAt: Date;
  active: boolean;
}

export interface PendingAB {
  controlId: string;
  challengerId: string;
  controlResults: boolean[];
  challengerResults: boolean[];
  startedAt: Date;
  /** How many tasks have been routed since the A/B started. */
  tasksRouted: number;
}

type GuidanceKey = `${FailureCategory}:${"consultation" | "motor"}`;

// ─── Default guidance texts (seed variants) ────────────────────

const DEFAULT_CONSULTATION_GUIDANCE: Partial<Record<FailureCategory, string>> = {
  "specification-gap":
    "Tasks like this historically fail because senses and builder disagree on what 'done' means. " +
    "Be explicit about your acceptance criteria: state concrete pass/fail conditions, not just directional preferences. " +
    "For each evaluator you activate, describe the specific observable evidence that would satisfy it.",
  "integration":
    "Tasks like this historically fail because sense tensions collapse into capitulation instead of synthesis. " +
    "State your hard boundaries: the non-negotiable minimums for your dimension. " +
    "The builder needs pre-resolved constraints, not competing aspirations that will conflict during evaluation.",
  "execution-problem":
    "Tasks like this historically fail because the builder couldn't execute its plan — " +
    "tool permissions, missing dependencies, or environment issues blocked execution. " +
    "State any environment prerequisites explicitly: what must be installed, what commands must succeed.",
};

const DEFAULT_MOTOR_GUIDANCE: Record<FailureCategory, string> = {
  "specification-gap":
    "Historical pattern: builder and senses disagree on 'done.' " +
    "The acceptance criteria below are extracted from each sense's consultation. " +
    "Build to satisfy these specific expectations, not a general interpretation of the task.",
  "integration":
    "Historical pattern: sense tensions collapse into capitulation. " +
    "Build within the ceiling constraints below. " +
    "Satisfy each sense's minimum rather than maximizing one at the expense of another.",
  "approach-bottleneck":
    "Historical pattern: this approach class hits a performance ceiling below the task's requirements. " +
    "Consider a fundamentally different strategy rather than optimizing the current one.",
  "local-logic":
    "Historical pattern: similar tasks fail on specific logic issues in a small number of senses. " +
    "Pay extra attention to edge cases and boundary conditions in the areas flagged by high-stake senses.",
  "execution-problem":
    "Historical pattern: builder plans well but execution is blocked by tooling or environment issues. " +
    "Verify all required tools are available and permissions are granted before building. " +
    "If a command fails, diagnose the root cause before retrying.",
};

// ─── Store ─────────────────────────────────────────────────────

export class GuidanceStore {
  private variants: Map<string, GuidanceVariant> = new Map();
  private pendingABs: Map<GuidanceKey, PendingAB> = new Map();
  private nextId = 1;

  constructor() {
    this.seed();
  }

  /** Seed with default hardcoded texts as version 0 variants. */
  private seed(): void {
    for (const [category, text] of Object.entries(DEFAULT_CONSULTATION_GUIDANCE)) {
      this.addVariant(category as FailureCategory, "consultation", text, 0, null, true);
    }
    for (const [category, text] of Object.entries(DEFAULT_MOTOR_GUIDANCE)) {
      this.addVariant(category as FailureCategory, "motor", text, 0, null, true);
    }
  }

  private addVariant(
    category: FailureCategory,
    consumer: "consultation" | "motor",
    text: string,
    version: number,
    parentId: string | null,
    active: boolean,
  ): GuidanceVariant {
    const id = `gv-${this.nextId++}`;
    const variant: GuidanceVariant = {
      id,
      category,
      consumer,
      text,
      version,
      parentId,
      stats: { timesUsed: 0, timesPreempted: 0, timesFailed: 0, preemptionRate: 0 },
      createdAt: new Date(),
      active,
    };
    this.variants.set(id, variant);
    return variant;
  }

  // ─── Query ───────────────────────────────────────────────────

  /**
   * Get the active variant for a category + consumer pair.
   * When an A/B test is running, alternates between control and challenger.
   * Returns null if no variant exists for this pair (e.g., no consultation
   * guidance for approach-bottleneck).
   */
  getActive(category: FailureCategory, consumer: "consultation" | "motor"): GuidanceVariant | null {
    const key: GuidanceKey = `${category}:${consumer}`;
    const ab = this.pendingABs.get(key);

    if (ab) {
      // A/B active: alternate between control and challenger
      ab.tasksRouted++;
      const useChallenger = ab.tasksRouted % 2 === 0;
      const id = useChallenger ? ab.challengerId : ab.controlId;
      return this.variants.get(id) ?? null;
    }

    // No A/B: return the active variant
    for (const v of this.variants.values()) {
      if (v.category === category && v.consumer === consumer && v.active) {
        return v;
      }
    }
    return null;
  }

  /** Get all variants for a category + consumer (for inspection). */
  getVariants(category: FailureCategory, consumer: "consultation" | "motor"): GuidanceVariant[] {
    return [...this.variants.values()].filter(
      (v) => v.category === category && v.consumer === consumer,
    );
  }

  /**
   * Get underperforming variants: preemption rate below threshold
   * after sufficient uses. These are candidates for reflective evolution.
   */
  getUnderperformers(threshold: number, minUses = 5): GuidanceVariant[] {
    return [...this.variants.values()].filter(
      (v) => v.active && v.stats.timesUsed >= minUses && v.stats.preemptionRate < threshold,
    );
  }

  // ─── Record outcomes ─────────────────────────────────────────

  /**
   * Record the outcome of a task where guidance was injected.
   * Updates stats on whichever variant was active (or the A/B variant used).
   */
  record(
    category: FailureCategory,
    consumer: "consultation" | "motor",
    taskId: string,
    preempted: boolean,
  ): void {
    const key: GuidanceKey = `${category}:${consumer}`;
    const ab = this.pendingABs.get(key);

    // Find which variant was used for this task
    let variant: GuidanceVariant | undefined;

    if (ab) {
      // During A/B: figure out which variant this task used
      // Even-numbered routed tasks got challenger, odd got control
      const wasChallenger = ab.tasksRouted % 2 === 0;
      const id = wasChallenger ? ab.challengerId : ab.controlId;
      variant = this.variants.get(id);

      // Record A/B result
      if (wasChallenger) {
        ab.challengerResults.push(preempted);
      } else {
        ab.controlResults.push(preempted);
      }

      // Check if A/B is ready to resolve
      this.resolveABIfReady(key, ab);
    } else {
      // Normal: find active variant
      for (const v of this.variants.values()) {
        if (v.category === category && v.consumer === consumer && v.active) {
          variant = v;
          break;
        }
      }
    }

    if (!variant) return;

    variant.stats.timesUsed++;
    if (preempted) {
      variant.stats.timesPreempted++;
    } else {
      variant.stats.timesFailed++;
    }
    variant.stats.preemptionRate =
      variant.stats.timesUsed > 0
        ? variant.stats.timesPreempted / variant.stats.timesUsed
        : 0;

    log.debug("Guidance outcome recorded", {
      variantId: variant.id,
      category,
      consumer,
      taskId,
      preempted,
      preemptionRate: variant.stats.preemptionRate.toFixed(2),
    });
  }

  // ─── Mutation proposals ──────────────────────────────────────

  /**
   * Propose a mutated variant as a challenger in an A/B test.
   * The current active variant becomes the control.
   * Returns the new variant, or null if an A/B is already running.
   */
  propose(
    category: FailureCategory,
    consumer: "consultation" | "motor",
    text: string,
  ): GuidanceVariant | null {
    const key: GuidanceKey = `${category}:${consumer}`;

    // Don't start a new A/B if one is already running
    if (this.pendingABs.has(key)) {
      log.debug("A/B already running, skipping proposal", { category, consumer });
      return null;
    }

    // Find current active variant
    let control: GuidanceVariant | undefined;
    for (const v of this.variants.values()) {
      if (v.category === category && v.consumer === consumer && v.active) {
        control = v;
        break;
      }
    }

    if (!control) {
      log.warn("No active variant to challenge", { category, consumer });
      return null;
    }

    // Create challenger
    const challenger = this.addVariant(
      category,
      consumer,
      text,
      control.version + 1,
      control.id,
      false,
    );

    // Start A/B
    this.pendingABs.set(key, {
      controlId: control.id,
      challengerId: challenger.id,
      controlResults: [],
      challengerResults: [],
      startedAt: new Date(),
      tasksRouted: 0,
    });

    emit("guidance:ab-started", {
      category,
      consumer,
      controlId: control.id,
      challengerId: challenger.id,
      controlVersion: control.version,
      challengerVersion: challenger.version,
    });

    log.info("A/B test started for guidance variant", {
      category,
      consumer,
      controlId: control.id,
      challengerId: challenger.id,
    });

    return challenger;
  }

  // ─── A/B resolution ──────────────────────────────────────────

  private resolveABIfReady(key: GuidanceKey, ab: PendingAB): void {
    const minResults = 3;
    const maxTasks = 20;

    // Both need minimum results
    if (ab.controlResults.length >= minResults && ab.challengerResults.length >= minResults) {
      const controlRate = ab.controlResults.filter(Boolean).length / ab.controlResults.length;
      const challengerRate = ab.challengerResults.filter(Boolean).length / ab.challengerResults.length;

      if (challengerRate > controlRate) {
        // Challenger wins — promote
        this.promoteChallenger(key, ab, controlRate, challengerRate);
      } else {
        // Control wins or tie — discard challenger
        this.discardChallenger(key, ab, controlRate, challengerRate);
      }
      return;
    }

    // Timeout: if neither reaches minResults within maxTasks, discard
    if (ab.tasksRouted >= maxTasks) {
      log.info("A/B test timed out — insufficient signal", {
        key,
        controlResults: ab.controlResults.length,
        challengerResults: ab.challengerResults.length,
      });
      this.discardChallenger(key, ab, 0, 0);
    }
  }

  private promoteChallenger(
    key: GuidanceKey,
    ab: PendingAB,
    controlRate: number,
    challengerRate: number,
  ): void {
    const control = this.variants.get(ab.controlId);
    const challenger = this.variants.get(ab.challengerId);
    if (control) control.active = false;
    if (challenger) challenger.active = true;

    this.pendingABs.delete(key);

    emit("guidance:ab-resolved", {
      key,
      winner: "challenger",
      controlRate,
      challengerRate,
      controlId: ab.controlId,
      challengerId: ab.challengerId,
    });

    log.info("A/B resolved: challenger promoted", {
      key,
      controlRate: controlRate.toFixed(2),
      challengerRate: challengerRate.toFixed(2),
    });
  }

  private discardChallenger(
    key: GuidanceKey,
    ab: PendingAB,
    controlRate: number,
    challengerRate: number,
  ): void {
    this.variants.delete(ab.challengerId);
    this.pendingABs.delete(key);

    emit("guidance:ab-resolved", {
      key,
      winner: "control",
      controlRate,
      challengerRate,
      controlId: ab.controlId,
      challengerId: ab.challengerId,
    });

    log.info("A/B resolved: control retained", {
      key,
      controlRate: controlRate.toFixed(2),
      challengerRate: challengerRate.toFixed(2),
    });
  }

  // ─── Snapshot ────────────────────────────────────────────────

  getState(): {
    variants: GuidanceVariant[];
    pendingABs: Array<{ key: string; ab: PendingAB }>;
  } {
    return {
      variants: [...this.variants.values()],
      pendingABs: [...this.pendingABs.entries()].map(([key, ab]) => ({ key, ab })),
    };
  }
}
