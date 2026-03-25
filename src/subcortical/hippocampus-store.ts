/**
 * Hippocampus Store — file-based JSON persistence.
 *
 * The hippocampus is the first component in Agent Cortex that
 * persists across project sessions. Episodes are project-scoped;
 * principles are cross-project. Both live on disk.
 *
 * Storage layout:
 *   {storageDir}/
 *     principles.json           — all principles (cross-project)
 *     meta.json                 — sequence counter, timestamps
 *     episodes/
 *       {projectId}.json        — episodes for one project
 *
 * Writes are atomic: write to .tmp, then rename. This prevents
 * corruption if the process dies mid-write.
 */

import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  Episode,
  Principle,
  HippocampusMeta,
} from "../types/hippocampus.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("hippocampus-store");

const DEFAULT_STORAGE_DIR = join(homedir(), ".agent-cortex", "hippocampus");

export class HippocampusStore {
  private dir: string;

  constructor(storageDir?: string) {
    this.dir = storageDir || DEFAULT_STORAGE_DIR;
  }

  /** Resolved storage directory path. */
  getStorageDir(): string {
    return this.dir;
  }

  // ── Episodes ────────────────────────────────────────────────

  async loadEpisodes(projectId: string): Promise<Episode[]> {
    const path = this.episodePath(projectId);
    const raw = await this.readJsonFile<SerializedEpisode[]>(path);
    if (!raw) return [];

    return raw.map(deserializeEpisode);
  }

  async saveEpisodes(projectId: string, episodes: Episode[]): Promise<void> {
    const path = this.episodePath(projectId);
    const serialized = episodes.map(serializeEpisode);
    await this.writeJsonFile(path, serialized);

    log.debug("Saved episodes", { projectId, count: episodes.length });
  }

  async loadAllEpisodes(): Promise<Map<string, Episode[]>> {
    const episodesDir = join(this.dir, "episodes");
    const result = new Map<string, Episode[]>();

    let files: string[];
    try {
      files = await readdir(episodesDir);
    } catch {
      return result; // Directory doesn't exist yet
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const projectId = file.replace(/\.json$/, "");
      const episodes = await this.loadEpisodes(projectId);
      if (episodes.length > 0) {
        result.set(projectId, episodes);
      }
    }

    log.debug("Loaded all episodes", {
      projects: result.size,
      totalEpisodes: [...result.values()].reduce((s, e) => s + e.length, 0),
    });

    return result;
  }

  // ── Principles ──────────────────────────────────────────────

  async loadPrinciples(): Promise<Principle[]> {
    const path = join(this.dir, "principles.json");
    const raw = await this.readJsonFile<SerializedPrinciple[]>(path);
    if (!raw) return [];

    return raw.map(deserializePrinciple);
  }

  async savePrinciples(principles: Principle[]): Promise<void> {
    const path = join(this.dir, "principles.json");
    const serialized = principles.map(serializePrinciple);
    await this.writeJsonFile(path, serialized);

    log.debug("Saved principles", { count: principles.length });
  }

  // ── Meta ────────────────────────────────────────────────────

  async loadMeta(): Promise<HippocampusMeta> {
    const path = join(this.dir, "meta.json");
    const raw = await this.readJsonFile<SerializedMeta>(path);
    if (!raw) {
      return { sequenceCounter: 0 };
    }

    return {
      sequenceCounter: raw.sequenceCounter,
      lastPotentiationAt: raw.lastPotentiationAt
        ? new Date(raw.lastPotentiationAt)
        : undefined,
      lastSaveAt: raw.lastSaveAt ? new Date(raw.lastSaveAt) : undefined,
    };
  }

  async saveMeta(meta: HippocampusMeta): Promise<void> {
    const path = join(this.dir, "meta.json");
    const serialized: SerializedMeta = {
      sequenceCounter: meta.sequenceCounter,
      lastPotentiationAt: meta.lastPotentiationAt?.toISOString(),
      lastSaveAt: new Date().toISOString(),
    };
    await this.writeJsonFile(path, serialized);
  }

  // ── Internal I/O ────────────────────────────────────────────

  private episodePath(projectId: string): string {
    // Sanitize projectId for filesystem safety
    const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, "episodes", `${safe}.json`);
  }

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

// ─── Serialization helpers ──────────────────────────────────────

// Dates must be ISO strings on disk, Date objects in memory.
// These helpers handle the conversion.

interface SerializedMeta {
  sequenceCounter: number;
  lastPotentiationAt?: string;
  lastSaveAt?: string;
}

/** Episode with Dates as ISO strings for JSON serialization. */
type SerializedEpisode = Omit<Episode, "recordedAt" | "fadedAt"> & {
  recordedAt: string;
  fadedAt?: string;
};

function serializeEpisode(episode: Episode): SerializedEpisode {
  return {
    ...episode,
    recordedAt: episode.recordedAt.toISOString(),
    fadedAt: episode.fadedAt?.toISOString(),
  };
}

function deserializeEpisode(raw: SerializedEpisode): Episode {
  return {
    ...raw,
    recordedAt: new Date(raw.recordedAt),
    fadedAt: raw.fadedAt ? new Date(raw.fadedAt) : undefined,
  };
}

/** Principle with Dates as ISO strings for JSON serialization. */
type SerializedPrinciple = Omit<
  Principle,
  "extractedAt" | "lastUpdated" | "supportingEvidence" | "contradictingEvidence"
> & {
  extractedAt: string;
  lastUpdated: string;
  supportingEvidence: SerializedEvidenceRef[];
  contradictingEvidence: SerializedEvidenceRef[];
};

type SerializedEvidenceRef = Omit<
  Principle["supportingEvidence"][0],
  "addedAt"
> & {
  addedAt: string;
};

function serializePrinciple(principle: Principle): SerializedPrinciple {
  const {
    extractedAt,
    lastUpdated,
    supportingEvidence,
    contradictingEvidence,
    ...rest
  } = principle;

  return {
    ...rest,
    extractedAt: extractedAt.toISOString(),
    lastUpdated: lastUpdated.toISOString(),
    supportingEvidence: supportingEvidence.map((e) => ({
      episodeId: e.episodeId,
      projectId: e.projectId,
      taskId: e.taskId,
      relevance: e.relevance,
      addedAt: e.addedAt.toISOString(),
    })),
    contradictingEvidence: contradictingEvidence.map((e) => ({
      episodeId: e.episodeId,
      projectId: e.projectId,
      taskId: e.taskId,
      relevance: e.relevance,
      addedAt: e.addedAt.toISOString(),
    })),
  };
}

function deserializePrinciple(raw: SerializedPrinciple): Principle {
  const {
    extractedAt,
    lastUpdated,
    supportingEvidence,
    contradictingEvidence,
    ...rest
  } = raw;

  return {
    ...rest,
    extractedAt: new Date(extractedAt),
    lastUpdated: new Date(lastUpdated),
    supportingEvidence: supportingEvidence.map((e) => ({
      episodeId: e.episodeId,
      projectId: e.projectId,
      taskId: e.taskId,
      relevance: e.relevance,
      addedAt: new Date(e.addedAt),
    })),
    contradictingEvidence: contradictingEvidence.map((e) => ({
      episodeId: e.episodeId,
      projectId: e.projectId,
      taskId: e.taskId,
      relevance: e.relevance,
      addedAt: new Date(e.addedAt),
    })),
  };
}

// ─── Util ───────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
