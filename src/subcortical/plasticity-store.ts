/**
 * PlasticityStore — runtime storage for all plastic connection weights.
 *
 * Stored centrally, used locally: components read weights to modulate
 * their behavior, dopamine writes to them, rest operations iterate.
 * But the semantics of each weight are defined by the component that
 * reads it — the store just manages values, ranges, normalization,
 * and history.
 *
 * Feature #19 implements the PlasticityStore interface from Feature #20.
 *
 * Key behaviors:
 *   - Registers all PLASTIC_CONNECTIONS at startup
 *   - Expands perEntity templates when entities are provided
 *   - Clamps to declared ranges on every update
 *   - Normalizes relative categories (sum-to-target) after updates
 *   - Maintains a bounded ring buffer of recent deltas per weight
 *   - Decay toward category mean during rest cycles
 *   - Settle volatile weights (high recent variance → pull toward default)
 *   - Computes volatility for the homeostasis vital sign
 *   - Snapshot/restore for cross-session persistence
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PlasticityStore,
  PlasticWeight,
  PlasticConnectionDeclaration,
  ConnectionCategory,
  ConnectionSnapshot,
  DeltaSource,
  WeightDelta,
} from "../types/plasticity.js";
import { CATEGORY_CONFIG, PLASTIC_CONNECTIONS } from "../types/plasticity.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const DEFAULT_PLASTICITY_DIR = join(homedir(), ".agent-cortex", "plasticity");

const log = createLogger("plasticity-store");

/** How many recent deltas to keep per weight. */
const DEFAULT_DELTA_BUFFER_SIZE = 20;

/** Default decay rate toward category mean during rest. */
const DEFAULT_DECAY_RATE = 0.1;

/** Variance threshold above which a weight is considered volatile. */
const DEFAULT_VOLATILITY_THRESHOLD = 0.02;

/** How aggressively to settle volatile weights toward their default. */
const DEFAULT_SETTLE_RATE = 0.15;

export interface PlasticityStoreConfig {
  deltaBufferSize: number;
  decayRate: number;
  volatilityThreshold: number;
  settleRate: number;
}

export const DEFAULT_PLASTICITY_STORE_CONFIG: PlasticityStoreConfig = {
  deltaBufferSize: DEFAULT_DELTA_BUFFER_SIZE,
  decayRate: DEFAULT_DECAY_RATE,
  volatilityThreshold: DEFAULT_VOLATILITY_THRESHOLD,
  settleRate: DEFAULT_SETTLE_RATE,
};

export class PlasticityStoreImpl implements PlasticityStore {
  private weights = new Map<string, PlasticWeight>();
  private config: PlasticityStoreConfig;

  constructor(config?: Partial<PlasticityStoreConfig>) {
    this.config = { ...DEFAULT_PLASTICITY_STORE_CONFIG, ...config };
  }

  // ── Initialization ──────────────────────────────────────────

  /**
   * Register all built-in plastic connections.
   * Call once at startup. For perEntity templates, pass entity names
   * to expand (e.g. active sense IDs for evaluator.sense-weight).
   *
   * Safe to call multiple times — register() is a no-op for existing IDs.
   */
  registerAll(entityMap?: Map<string, string[]>): void {
    for (const decl of PLASTIC_CONNECTIONS) {
      if ("perEntity" in decl && decl.perEntity && entityMap) {
        const entities = entityMap.get(decl.id);
        if (entities && entities.length > 0) {
          this.expandTemplate(decl, entities);
          continue;
        }
      }
      // Non-template or no entities provided — register as-is
      this.register(decl);
    }

    log.info("Registered all connections", {
      total: this.weights.size,
      categories: this.getCategoryCounts(),
    });

    emit("plasticity:initialized", {
      total: this.weights.size,
    });
  }

  /**
   * Expand a perEntity template into one connection per entity.
   * For relative categories, values are normalized to sum to target.
   */
  expandTemplate(
    declaration: PlasticConnectionDeclaration,
    entities: string[],
  ): void {
    const config = CATEGORY_CONFIG[declaration.category];

    for (const entity of entities) {
      const id = `${declaration.id}.${entity}`;
      if (this.weights.has(id)) continue;

      let value = declaration.defaultValue;

      // For relative categories: pre-normalization value → each gets equal share
      if (config.normalization === "relative" && config.target !== undefined) {
        value = config.target / entities.length;
      }

      // Clamp to range
      value = Math.max(declaration.range[0], Math.min(declaration.range[1], value));

      this.weights.set(id, {
        connectionId: id,
        value,
        defaultValue: value,
        range: [...declaration.range] as [number, number],
        category: declaration.category,
        recentDeltas: [],
        lastModified: new Date(),
      });
    }

    log.debug("Template expanded", {
      template: declaration.id,
      entities: entities.length,
    });
  }

  // ── PlasticityStore interface ───────────────────────────────

  get size(): number {
    return this.weights.size;
  }

  get(connectionId: string): PlasticWeight | undefined {
    return this.weights.get(connectionId);
  }

  getByCategory(category: ConnectionCategory): PlasticWeight[] {
    return [...this.weights.values()].filter((w) => w.category === category);
  }

  update(
    connectionId: string,
    delta: number,
    source: DeltaSource,
    context?: string,
  ): number {
    const weight = this.weights.get(connectionId);
    if (!weight) {
      log.warn("Update for unregistered connection", { connectionId });
      return NaN;
    }

    const oldValue = weight.value;
    const newValue = Math.max(
      weight.range[0],
      Math.min(weight.range[1], weight.value + delta),
    );
    weight.value = newValue;

    // Record delta
    const record: WeightDelta = {
      timestamp: new Date(),
      delta,
      source,
      context,
    };
    weight.recentDeltas.unshift(record);
    if (weight.recentDeltas.length > this.config.deltaBufferSize) {
      weight.recentDeltas.length = this.config.deltaBufferSize;
    }
    weight.lastModified = new Date();

    // Normalize relative categories
    const catConfig = CATEGORY_CONFIG[weight.category];
    if (catConfig.normalization === "relative" && catConfig.target !== undefined) {
      this.normalizeCategory(weight.category, catConfig.target);
    }

    emit("plasticity:update", {
      connectionId,
      oldValue,
      newValue: weight.value,
      delta,
      source,
      context,
    });

    return weight.value;
  }

  register(declaration: PlasticConnectionDeclaration): void {
    if (this.weights.has(declaration.id)) return;

    this.weights.set(declaration.id, {
      connectionId: declaration.id,
      value: declaration.defaultValue,
      defaultValue: declaration.defaultValue,
      range: [...declaration.range] as [number, number],
      category: declaration.category,
      recentDeltas: [],
      lastModified: new Date(),
    });
  }

  snapshot(label?: string): ConnectionSnapshot {
    return {
      weights: [...this.weights.values()].map((w) => ({
        ...w,
        range: [...w.range] as [number, number],
        recentDeltas: [...w.recentDeltas],
      })),
      capturedAt: new Date(),
      label,
    };
  }

  restore(snap: ConnectionSnapshot): void {
    this.weights.clear();
    for (const w of snap.weights) {
      this.weights.set(w.connectionId, {
        ...w,
        range: [...w.range] as [number, number],
        recentDeltas: [...w.recentDeltas],
      });
    }

    log.info("Restored from snapshot", {
      label: snap.label,
      weights: this.weights.size,
    });

    emit("plasticity:restored", {
      label: snap.label,
      weights: this.weights.size,
    });
  }

  *all(): IterableIterator<PlasticWeight> {
    yield* this.weights.values();
  }

  // ── Rest-cycle operations ───────────────────────────────────

  /**
   * Decay all weights toward their category mean.
   *
   * For independent categories: decay toward the mean of all weights
   * in that category. For relative categories: decay toward equal
   * share (target / count). The farther from the mean, the more decay.
   *
   * Returns the number of weights that actually changed.
   */
  decay(): number {
    let decayed = 0;

    // Group by category
    const byCategory = new Map<ConnectionCategory, PlasticWeight[]>();
    for (const weight of this.weights.values()) {
      const list = byCategory.get(weight.category) ?? [];
      list.push(weight);
      byCategory.set(weight.category, list);
    }

    for (const [category, weights] of byCategory) {
      const catConfig = CATEGORY_CONFIG[category];

      // Compute target for each weight
      let target: number;
      if (catConfig.normalization === "relative" && catConfig.target !== undefined) {
        // Equal share
        target = catConfig.target / weights.length;
      } else {
        // Mean of current values
        target = weights.reduce((s, w) => s + w.value, 0) / weights.length;
      }

      for (const weight of weights) {
        const delta = (target - weight.value) * this.config.decayRate;
        if (Math.abs(delta) < 0.0001) continue;

        const oldValue = weight.value;
        weight.value = Math.max(
          weight.range[0],
          Math.min(weight.range[1], weight.value + delta),
        );

        weight.recentDeltas.unshift({
          timestamp: new Date(),
          delta,
          source: "decay",
        });
        if (weight.recentDeltas.length > this.config.deltaBufferSize) {
          weight.recentDeltas.length = this.config.deltaBufferSize;
        }
        weight.lastModified = new Date();
        decayed++;
      }
    }

    log.info("Decay complete", { decayed, total: this.weights.size });
    emit("plasticity:decay", { decayed });

    return decayed;
  }

  /**
   * Settle volatile weights — weights with high recent delta variance
   * get pulled toward their default value. This stabilizes identity
   * when learning signals are noisy.
   *
   * Returns the number of weights settled.
   */
  settle(): number {
    let settled = 0;

    for (const weight of this.weights.values()) {
      const variance = this.computeDeltaVariance(weight);
      if (variance < this.config.volatilityThreshold) continue;

      const delta = (weight.defaultValue - weight.value) * this.config.settleRate;
      if (Math.abs(delta) < 0.0001) continue;

      weight.value = Math.max(
        weight.range[0],
        Math.min(weight.range[1], weight.value + delta),
      );

      weight.recentDeltas.unshift({
        timestamp: new Date(),
        delta,
        source: "settle",
      });
      if (weight.recentDeltas.length > this.config.deltaBufferSize) {
        weight.recentDeltas.length = this.config.deltaBufferSize;
      }
      weight.lastModified = new Date();
      settled++;
    }

    log.info("Settle complete", { settled, total: this.weights.size });
    emit("plasticity:settle", { settled });

    return settled;
  }

  // ── Volatility for homeostasis ──────────────────────────────

  /**
   * Compute overall weight volatility (0–1).
   * Ratio of volatile weights (high recent delta variance) to total.
   */
  getVolatility(): number {
    if (this.weights.size === 0) return 0;

    let volatileCount = 0;
    for (const weight of this.weights.values()) {
      if (this.computeDeltaVariance(weight) >= this.config.volatilityThreshold) {
        volatileCount++;
      }
    }

    return volatileCount / this.weights.size;
  }

  // ── Displacement for homeostasis ────────────────────────────

  /**
   * Compute overall weight displacement (0–1).
   * Mean normalized distance of each weight from its default value.
   * 0 = all weights at their defaults, 1 = all weights at range extremes.
   */
  getDisplacement(): number {
    if (this.weights.size === 0) return 0;

    let totalDisplacement = 0;
    for (const weight of this.weights.values()) {
      const rangeSpan = weight.range[1] - weight.range[0];
      if (rangeSpan <= 0) continue;
      // Normalize distance from default to 0–1 relative to the weight's range
      const distance = Math.abs(weight.value - weight.defaultValue) / rangeSpan;
      totalDisplacement += distance;
    }

    return totalDisplacement / this.weights.size;
  }

  // ── Dashboard state ─────────────────────────────────────────

  getState(): {
    total: number;
    categories: Record<string, number>;
    volatility: number;
    recentUpdates: Array<{
      connectionId: string;
      value: number;
      lastDelta?: { delta: number; source: string; context?: string };
    }>;
  } {
    // Most recently modified weights first
    const sorted = [...this.weights.values()].sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime(),
    );

    return {
      total: this.weights.size,
      categories: this.getCategoryCounts(),
      volatility: this.getVolatility(),
      recentUpdates: sorted.slice(0, 10).map((w) => ({
        connectionId: w.connectionId,
        value: w.value,
        lastDelta: w.recentDeltas[0]
          ? {
              delta: w.recentDeltas[0].delta,
              source: w.recentDeltas[0].source,
              context: w.recentDeltas[0].context,
            }
          : undefined,
      })),
    };
  }

  // ── Disk persistence ────────────────────────────────────────

  /**
   * Save current weights to disk as a ConnectionSnapshot.
   * Atomic write: .tmp then rename. Dates serialized as ISO strings.
   */
  async saveToDisk(dir?: string): Promise<void> {
    const storageDir = dir ?? DEFAULT_PLASTICITY_DIR;
    await mkdir(storageDir, { recursive: true });

    const snap = this.snapshot("disk-persist");
    const serialized = JSON.stringify(snap, (_, value) => {
      if (value instanceof Date) return value.toISOString();
      return value;
    }, 2);

    const path = join(storageDir, "snapshot.json");
    const tmpPath = path + ".tmp";
    await writeFile(tmpPath, serialized, "utf-8");
    await rename(tmpPath, path);

    log.info("Saved to disk", { weights: this.weights.size, path });
  }

  /**
   * Load weights from disk snapshot. Returns true if loaded, false if
   * no snapshot found (fresh install). Dates are revived from ISO strings.
   */
  async loadFromDisk(dir?: string): Promise<boolean> {
    const storageDir = dir ?? DEFAULT_PLASTICITY_DIR;
    const path = join(storageDir, "snapshot.json");

    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      log.info("No persisted snapshot found — starting fresh", { path });
      return false;
    }

    const snap = JSON.parse(raw, (key, value) => {
      // Revive known date fields from ISO strings
      if (
        typeof value === "string" &&
        (key === "capturedAt" || key === "lastModified" || key === "timestamp") &&
        /^\d{4}-\d{2}-\d{2}T/.test(value)
      ) {
        return new Date(value);
      }
      return value;
    }) as ConnectionSnapshot;

    this.restore(snap);
    log.info("Loaded from disk", { weights: this.weights.size, label: snap.label });
    return true;
  }

  // ── Private helpers ─────────────────────────────────────────

  /** Re-normalize a relative category so weights sum to target. */
  private normalizeCategory(category: ConnectionCategory, target: number): void {
    const siblings = this.getByCategory(category);
    const sum = siblings.reduce((s, w) => s + w.value, 0);
    if (sum <= 0) return;

    const scale = target / sum;
    for (const w of siblings) {
      w.value = Math.max(w.range[0], Math.min(w.range[1], w.value * scale));
    }
  }

  /** Variance of recent deltas for a weight. */
  private computeDeltaVariance(weight: PlasticWeight): number {
    const deltas = weight.recentDeltas;
    if (deltas.length < 2) return 0;

    const values = deltas.map((d) => d.delta);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance =
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;

    return variance;
  }

  /** Count of weights per category. */
  private getCategoryCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const weight of this.weights.values()) {
      counts[weight.category] = (counts[weight.category] ?? 0) + 1;
    }
    return counts;
  }
}
