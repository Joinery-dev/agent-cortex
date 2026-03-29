/**
 * Basal Ganglia Store — file-based JSON persistence for procedural memory.
 *
 * Routines and candidates persist across project sessions. Both are
 * cross-project: a routine learned for "React component at mid NE"
 * is valid regardless of which project taught it. Fingerprint domain
 * keywords naturally prevent cross-contamination.
 *
 * Storage layout:
 *   {storageDir}/
 *     routines.json     — all learned routines (cross-project)
 *     candidates.json   — accumulating candidate patterns (cross-project)
 *     meta.json         — sequence counter, timestamps
 *
 * Follows the same patterns as HippocampusStore:
 *   - Atomic writes (write to .tmp, then rename)
 *   - Date fields as ISO strings on disk, Date objects in memory
 *   - Graceful handling of missing files (fresh install)
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Routine, RoutineFingerprint } from "../types/basal-ganglia.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("basal-ganglia-store");

const DEFAULT_STORAGE_DIR = join(homedir(), ".agent-cortex", "basal-ganglia");

// ─── Serialized shapes (Dates → ISO strings) ──────────────────────

type SerializedRoutine = Omit<Routine, "createdAt" | "lastReinforcedAt"> & {
  createdAt: string;
  lastReinforcedAt: string;
};

interface SerializedCandidate {
  hash: string;
  fingerprint: RoutineFingerprint;
  observations: { activeSenseIds: string[]; suppressedSenseIds: string[] }[];
  firstSeen: string;
  lastSeen: string;
}

interface SerializedMeta {
  totalRoutinesCreated: number;
  totalRoutinesPruned: number;
  lastDecayAt?: string;
  lastSaveAt?: string;
}

// ─── In-memory candidate shape (matches BasalGanglia's internal type) ─

export interface PersistedCandidate {
  hash: string;
  fingerprint: RoutineFingerprint;
  observations: { activeSenseIds: string[]; suppressedSenseIds: string[] }[];
  firstSeen: Date;
  lastSeen: Date;
}

// ─── Meta ──────────────────────────────────────────────────────────

export interface BasalGangliaMeta {
  totalRoutinesCreated: number;
  totalRoutinesPruned: number;
  lastDecayAt?: Date;
}

// ─── Store ─────────────────────────────────────────────────────────

export class BasalGangliaStore {
  private dir: string;

  constructor(storageDir?: string) {
    this.dir = storageDir || DEFAULT_STORAGE_DIR;
  }

  /** Resolved storage directory path. */
  getStorageDir(): string {
    return this.dir;
  }

  // ── Routines ───────────────────────────────────────────────────

  async loadRoutines(): Promise<Routine[]> {
    const path = join(this.dir, "routines.json");
    const raw = await this.readJsonFile<SerializedRoutine[]>(path);
    if (!raw) return [];

    return raw.map(deserializeRoutine);
  }

  async saveRoutines(routines: Routine[]): Promise<void> {
    const path = join(this.dir, "routines.json");
    const serialized = routines.map(serializeRoutine);
    await this.writeJsonFile(path, serialized);

    log.debug("Saved routines", { count: routines.length });
  }

  // ── Candidates ─────────────────────────────────────────────────

  async loadCandidates(): Promise<PersistedCandidate[]> {
    const path = join(this.dir, "candidates.json");
    const raw = await this.readJsonFile<SerializedCandidate[]>(path);
    if (!raw) return [];

    return raw.map(deserializeCandidate);
  }

  async saveCandidates(candidates: PersistedCandidate[]): Promise<void> {
    const path = join(this.dir, "candidates.json");
    const serialized = candidates.map(serializeCandidate);
    await this.writeJsonFile(path, serialized);

    log.debug("Saved candidates", { count: candidates.length });
  }

  // ── Meta ───────────────────────────────────────────────────────

  async loadMeta(): Promise<BasalGangliaMeta> {
    const path = join(this.dir, "meta.json");
    const raw = await this.readJsonFile<SerializedMeta>(path);
    if (!raw) {
      return { totalRoutinesCreated: 0, totalRoutinesPruned: 0 };
    }

    return {
      totalRoutinesCreated: raw.totalRoutinesCreated,
      totalRoutinesPruned: raw.totalRoutinesPruned,
      lastDecayAt: raw.lastDecayAt ? new Date(raw.lastDecayAt) : undefined,
    };
  }

  async saveMeta(meta: BasalGangliaMeta): Promise<void> {
    const path = join(this.dir, "meta.json");
    const serialized: SerializedMeta = {
      totalRoutinesCreated: meta.totalRoutinesCreated,
      totalRoutinesPruned: meta.totalRoutinesPruned,
      lastDecayAt: meta.lastDecayAt?.toISOString(),
      lastSaveAt: new Date().toISOString(),
    };
    await this.writeJsonFile(path, serialized);
  }

  // ── Internal I/O ──────────────────────────────────────────────

  private async readJsonFile<T>(path: string): Promise<T | null> {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as T;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return null; // File doesn't exist yet — normal for fresh installs
      }
      log.error("Failed to read file", { path, error: String(err) });
      throw err;
    }
  }

  private async writeJsonFile(path: string, data: unknown): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(path), { recursive: true });

    // Atomic write: write to .tmp, then rename
    const tmpPath = path + ".tmp";
    const content = JSON.stringify(data, null, 2);
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  }
}

// ─── Serialization helpers ──────────────────────────────────────────

function serializeRoutine(routine: Routine): SerializedRoutine {
  return {
    ...routine,
    createdAt: routine.createdAt.toISOString(),
    lastReinforcedAt: routine.lastReinforcedAt.toISOString(),
  };
}

function deserializeRoutine(raw: SerializedRoutine): Routine {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    lastReinforcedAt: new Date(raw.lastReinforcedAt),
  };
}

function serializeCandidate(candidate: PersistedCandidate): SerializedCandidate {
  return {
    hash: candidate.hash,
    fingerprint: candidate.fingerprint,
    observations: candidate.observations,
    firstSeen: candidate.firstSeen.toISOString(),
    lastSeen: candidate.lastSeen.toISOString(),
  };
}

function deserializeCandidate(raw: SerializedCandidate): PersistedCandidate {
  return {
    hash: raw.hash,
    fingerprint: raw.fingerprint,
    observations: raw.observations,
    firstSeen: new Date(raw.firstSeen),
    lastSeen: new Date(raw.lastSeen),
  };
}

// ─── Util ───────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
