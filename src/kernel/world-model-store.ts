/**
 * World Model Store — file-based JSON persistence for cross-project maxims.
 *
 * Only cross-project maxims persist (they're Cortex's identity).
 * Per-project maxims live in memory and die with the project.
 *
 * Storage layout:
 *   {storageDir}/
 *     cross-project.json   — cross-project Maxim[]
 *     meta.json             — last synthesis timestamp
 *
 * Follows the HippocampusStore pattern: atomic writes (tmp + rename),
 * Date serialization helpers, graceful handling of missing files.
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Maxim } from "../types/world-model.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("world-model-store");

const DEFAULT_STORAGE_DIR = join(homedir(), ".agent-cortex", "world-model");

// ─── Serialization types ────────────────────────────────────────

type SerializedMaxim = Omit<Maxim, "synthesizedAt"> & {
  synthesizedAt: string;
};

interface SerializedMeta {
  lastSynthesisAt?: string;
  lastSaveAt?: string;
}

export interface WorldModelMeta {
  lastSynthesisAt?: Date;
  lastSaveAt?: Date;
}

// ─── Store ──────────────────────────────────────────────────────

export class WorldModelStore {
  private dir: string;

  constructor(storageDir?: string) {
    this.dir = storageDir || DEFAULT_STORAGE_DIR;
  }

  getDir(): string {
    return this.dir;
  }

  // ── Cross-project maxims ────────────────────────────────────

  async loadMaxims(): Promise<Maxim[]> {
    const path = join(this.dir, "cross-project.json");
    const raw = await this.readJsonFile<SerializedMaxim[]>(path);
    if (!raw) return [];

    return raw.map(deserializeMaxim);
  }

  async saveMaxims(maxims: Maxim[]): Promise<void> {
    const path = join(this.dir, "cross-project.json");
    const serialized = maxims.map(serializeMaxim);
    await this.writeJsonFile(path, serialized);

    log.debug("Saved cross-project maxims", { count: maxims.length });
  }

  // ── Meta ────────────────────────────────────────────────────

  async loadMeta(): Promise<WorldModelMeta> {
    const path = join(this.dir, "meta.json");
    const raw = await this.readJsonFile<SerializedMeta>(path);
    if (!raw) {
      return {};
    }

    return {
      lastSynthesisAt: raw.lastSynthesisAt
        ? new Date(raw.lastSynthesisAt)
        : undefined,
      lastSaveAt: raw.lastSaveAt ? new Date(raw.lastSaveAt) : undefined,
    };
  }

  async saveMeta(meta: WorldModelMeta): Promise<void> {
    const path = join(this.dir, "meta.json");
    const serialized: SerializedMeta = {
      lastSynthesisAt: meta.lastSynthesisAt?.toISOString(),
      lastSaveAt: new Date().toISOString(),
    };
    await this.writeJsonFile(path, serialized);
  }

  // ── Internal I/O ────────────────────────────────────────────

  private async readJsonFile<T>(path: string): Promise<T | null> {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as T;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return null; // File doesn't exist yet — normal for fresh systems
      }
      log.error("Failed to read file", { path, error: String(err) });
      throw err;
    }
  }

  private async writeJsonFile(path: string, data: unknown): Promise<void> {
    const tmpPath = path + ".tmp";
    try {
      await mkdir(dirname(path), { recursive: true });

      // Atomic write: write to .tmp, then rename
      const content = JSON.stringify(data, null, 2);
      await writeFile(tmpPath, content, "utf-8");
      await rename(tmpPath, path);
    } catch (err) {
      log.error("Failed to write file", { path, error: String(err) });

      // Clean up orphaned .tmp file
      try {
        await unlink(tmpPath);
      } catch {
        // .tmp file may not exist if write itself failed — ignore
      }

      throw err;
    }
  }
}

// ─── Serialization helpers ──────────────────────────────────────

function serializeMaxim(maxim: Maxim): SerializedMaxim {
  return {
    ...maxim,
    synthesizedAt: maxim.synthesizedAt.toISOString(),
  };
}

function deserializeMaxim(raw: SerializedMaxim): Maxim {
  return {
    ...raw,
    synthesizedAt: new Date(raw.synthesizedAt),
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
