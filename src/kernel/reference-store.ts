/**
 * Reference Store — persistent lookup for external system pointers.
 *
 * Unlike the learning stack (hippocampus, world model, plasticity),
 * references are deterministic facts that don't evolve from experience.
 * "Bugs are tracked in Linear project INGEST" is either right or wrong —
 * it's not a hypothesis to be refined.
 *
 * References persist across sessions and don't decay. The Thalamus
 * includes relevant references in briefings when a task touches
 * the reference's domain.
 *
 * Storage layout:
 *   ~/.agent-cortex/references.json
 *
 * Sources:
 *   - Parsifal tells Cortex during inquiry ("bugs are in Linear")
 *   - Project config files (discovered by ProjectDiscovery)
 *   - Explicit registration via API
 */

import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

const log = createLogger("reference-store");

const DEFAULT_STORAGE_PATH = join(homedir(), ".agent-cortex", "references.json");

// ─── Types ────────────────────────────────────────────────────

export type ReferenceCategory =
  | "issue-tracker"     // Where bugs/tasks are tracked (Linear, Jira, GitHub Issues)
  | "monitoring"        // Dashboards, alerting (Grafana, Datadog, Sentry)
  | "documentation"     // Internal docs, wikis, READMEs
  | "deployment"        // CI/CD, staging URLs, production URLs
  | "communication"     // Slack channels, email lists, team contacts
  | "repository"        // Related repos, monorepo structure
  | "api"               // External API endpoints, keys location
  | "convention"        // Project conventions that aren't learnable (tool choices, naming)
  | "other";            // Anything that doesn't fit

export interface Reference {
  id: string;
  /** What this reference is about. */
  label: string;
  /** The actual pointer — URL, project name, command, path, etc. */
  value: string;
  /** Category for filtering. */
  category: ReferenceCategory;
  /** Optional detail — when/how to use this reference. */
  detail?: string;
  /** When this reference was stored. */
  storedAt: Date;
  /** Where this reference came from. */
  source: "parsifal" | "discovery" | "config" | "api";
}

// ─── Store ────────────────────────────────────────────────────

export class ReferenceStore {
  private refs: Reference[] = [];
  private storagePath: string;
  private loaded = false;

  constructor(storagePath?: string) {
    this.storagePath = storagePath || DEFAULT_STORAGE_PATH;
  }

  /** Load from disk. Call once at startup. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.storagePath, "utf-8");
      const parsed = JSON.parse(raw) as SerializedReference[];
      this.refs = parsed.map((r) => ({
        ...r,
        storedAt: new Date(r.storedAt),
      }));
      this.loaded = true;

      log.info("References loaded", { count: this.refs.length });
      emit("references:loaded", { count: this.refs.length });
    } catch {
      // No file yet — start empty
      this.refs = [];
      this.loaded = true;
      log.debug("No references file — starting fresh");
    }
  }

  /** Persist to disk. */
  async save(): Promise<void> {
    const dir = dirname(this.storagePath);
    await mkdir(dir, { recursive: true });

    const serialized: SerializedReference[] = this.refs.map((r) => ({
      ...r,
      storedAt: r.storedAt.toISOString(),
    }));

    const tmp = this.storagePath + ".tmp";
    await writeFile(tmp, JSON.stringify(serialized, null, 2));
    await rename(tmp, this.storagePath);
  }

  // ─── Write ──────────────────────────────────────────────────

  /** Add a reference. Deduplicates by label (case-insensitive). */
  add(
    label: string,
    value: string,
    category: ReferenceCategory,
    source: Reference["source"],
    detail?: string,
  ): Reference {
    // Deduplicate — update existing if same label
    const existing = this.refs.find(
      (r) => r.label.toLowerCase() === label.toLowerCase(),
    );
    if (existing) {
      existing.value = value;
      existing.category = category;
      existing.detail = detail ?? existing.detail;
      existing.storedAt = new Date();
      existing.source = source;

      emit("references:updated", { id: existing.id, label, category });
      log.info("Reference updated", { label, category });

      this.save().catch((err) => log.warn("Failed to persist reference update", { error: String(err) }));
      return existing;
    }

    const ref: Reference = {
      id: newId(),
      label,
      value,
      category,
      detail,
      storedAt: new Date(),
      source,
    };

    this.refs.push(ref);

    emit("references:added", { id: ref.id, label, category });
    log.info("Reference added", { label, category });

    this.save().catch((err) => log.warn("Failed to persist new reference", { error: String(err) }));
    return ref;
  }

  /** Remove a reference by ID. */
  remove(id: string): boolean {
    const idx = this.refs.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const removed = this.refs.splice(idx, 1)[0];

    emit("references:removed", { id, label: removed.label });
    this.save().catch((err) => log.warn("Failed to persist reference removal", { error: String(err) }));
    return true;
  }

  // ─── Read ───────────────────────────────────────────────────

  /** All references. */
  getAll(): Reference[] {
    return [...this.refs];
  }

  /** References by category. */
  getByCategory(category: ReferenceCategory): Reference[] {
    return this.refs.filter((r) => r.category === category);
  }

  /** Search references by keyword (matches label, value, or detail). */
  search(keyword: string): Reference[] {
    const lower = keyword.toLowerCase();
    return this.refs.filter(
      (r) =>
        r.label.toLowerCase().includes(lower) ||
        r.value.toLowerCase().includes(lower) ||
        (r.detail?.toLowerCase().includes(lower) ?? false),
    );
  }

  /** Get references as summary strings for briefing inclusion. */
  getSummaries(keyword?: string): string[] {
    const refs = keyword ? this.search(keyword) : this.refs;
    return refs.map((r) =>
      `[${r.category}] ${r.label}: ${r.value}${r.detail ? ` — ${r.detail}` : ""}`,
    );
  }

  /** Number of stored references. */
  get count(): number {
    return this.refs.length;
  }
}

// ─── Serialization ────────────────────────────────────────────

type SerializedReference = Omit<Reference, "storedAt"> & {
  storedAt: string;
};
