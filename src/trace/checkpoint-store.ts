/**
 * Checkpoint Store — disk persistence for rhythm state snapshots.
 *
 * Storage layout:
 *   ~/.agent-cortex/checkpoints/
 *     index.json         — lightweight listing (CheckpointIndex[])
 *     {id}.json          — full checkpoint payload
 *
 * Follows the same patterns as HippocampusStore / BasalGangliaStore:
 *   - Atomic writes (write to .tmp, then rename)
 *   - Graceful handling of missing files (fresh install)
 *   - Pruning by max checkpoint count
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Checkpoint, CheckpointIndex, CheckpointKind } from "../types/checkpoint.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("checkpoint-store");

const DEFAULT_DIR = join(homedir(), ".agent-cortex", "checkpoints");

export class CheckpointStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  // ─── Save ──────────────────────────────────────────────────────

  async save(checkpoint: Checkpoint): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    // Serialize the full checkpoint
    const payload = JSON.stringify(checkpoint, null, 2);
    checkpoint.sizeBytes = Buffer.byteLength(payload, "utf-8");

    // Write the full payload atomically
    const fullPath = join(this.dir, `${checkpoint.id}.json`);
    await atomicWrite(fullPath, JSON.stringify(checkpoint, null, 2));

    // Update the index
    await this.updateIndex(checkpoint);

    log.info("Checkpoint saved", {
      id: checkpoint.id,
      kind: checkpoint.kind,
      label: checkpoint.label,
      sizeBytes: checkpoint.sizeBytes,
    });
  }

  // ─── Load ──────────────────────────────────────────────────────

  async load(id: string): Promise<Checkpoint | null> {
    const path = join(this.dir, `${id}.json`);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  // ─── List ──────────────────────────────────────────────────────

  async list(): Promise<CheckpointIndex[]> {
    try {
      const raw = await readFile(join(this.dir, "index.json"), "utf-8");
      return JSON.parse(raw) as CheckpointIndex[];
    } catch {
      return [];
    }
  }

  // ─── Latest ────────────────────────────────────────────────────

  /** Load the most recent checkpoint, optionally filtered by kind. */
  async latest(kind?: CheckpointKind): Promise<Checkpoint | null> {
    const index = await this.list();
    const filtered = kind ? index.filter((e) => e.kind === kind) : index;
    if (filtered.length === 0) return null;

    // Index is sorted newest-first (maintained by updateIndex)
    return this.load(filtered[0].id);
  }

  // ─── Prune ─────────────────────────────────────────────────────

  /** Delete oldest checkpoints beyond maxCount. Returns number pruned. */
  async prune(maxCount: number): Promise<number> {
    const index = await this.list();
    if (index.length <= maxCount) return 0;

    const toRemove = index.slice(maxCount); // oldest are at the end
    for (const entry of toRemove) {
      await this.delete(entry.id);
    }

    // Rewrite index without the pruned entries
    const kept = index.slice(0, maxCount);
    await atomicWrite(join(this.dir, "index.json"), JSON.stringify(kept, null, 2));

    log.info("Checkpoints pruned", { removed: toRemove.length, remaining: kept.length });
    return toRemove.length;
  }

  // ─── Delete ────────────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    const path = join(this.dir, `${id}.json`);
    try {
      await unlink(path);
    } catch {
      // Already gone — fine
    }
  }

  // ─── Internal ──────────────────────────────────────────────────

  private async updateIndex(checkpoint: Checkpoint): Promise<void> {
    const index = await this.list();

    const entry: CheckpointIndex = {
      id: checkpoint.id,
      label: checkpoint.label,
      kind: checkpoint.kind,
      createdAt: checkpoint.createdAt,
      taskId: checkpoint.taskId,
      taskDescription: checkpoint.taskDescription,
      cycle: checkpoint.cycle,
      rhythmType: checkpoint.rhythmType,
      sizeBytes: checkpoint.sizeBytes ?? 0,
    };

    // Remove existing entry with same ID (overwrite)
    const filtered = index.filter((e) => e.id !== checkpoint.id);

    // Insert at front (newest first)
    filtered.unshift(entry);

    await atomicWrite(join(this.dir, "index.json"), JSON.stringify(filtered, null, 2));
  }
}

// ─── Atomic write helper ─────────────────────────────────────────

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
}
