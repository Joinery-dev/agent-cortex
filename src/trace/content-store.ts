/**
 * Content store — records and indexes all substantive content flowing through the system.
 * Persists to disk so content survives across restarts during development.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { ContentEntry, ContentBlock, ContentKind } from "./types.js";

export type { ContentBlock } from "./types.js";

const PERSIST_PATH = "/tmp/cortex-trace-content.json";

export class ContentStore {
  private entries: ContentEntry[] = [];
  private nextId = 1;
  private maxEntries: number;

  // ── Indexes ─────────────────────────────────────────────────────
  private byTask = new Map<string, number[]>();
  private byKind = new Map<ContentKind, number[]>();
  private byEventSeq = new Map<number, number[]>();

  constructor(maxEntries = 5_000) {
    this.maxEntries = maxEntries;
  }

  // ── Record ──────────────────────────────────────────────────────

  record(entry: Omit<ContentEntry, "id">): number {
    const id = this.nextId++;
    const full: ContentEntry = { ...entry, id };
    this.entries.push(full);
    this.index(full);

    // Rotate if over capacity
    if (this.entries.length > this.maxEntries) {
      this.rotate();
    }

    this.persist();
    return id;
  }

  // ── Link to event ─────────────────────────────────────────────

  linkToEvent(contentId: number, eventSeq: number): void {
    const entry = this.entries.find((e) => e.id === contentId);
    if (!entry) return;
    entry.eventSeq = eventSeq;

    // Update eventSeq index
    const existing = this.byEventSeq.get(eventSeq) ?? [];
    if (!existing.includes(contentId)) {
      existing.push(contentId);
      this.byEventSeq.set(eventSeq, existing);
    }
    this.persist();
  }

  // ── Queries ───────────────────────────────────────────────────

  get(id: number): ContentEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  getByEventSeq(seq: number): ContentEntry[] {
    const ids = this.byEventSeq.get(seq) ?? [];
    return ids.map((id) => this.entries.find((e) => e.id === id)!).filter(Boolean);
  }

  getForTask(taskId: string): ContentEntry[] {
    const ids = this.byTask.get(taskId) ?? [];
    return ids.map((id) => this.entries.find((e) => e.id === id)!).filter(Boolean);
  }

  getByKind(kind: ContentKind): ContentEntry[] {
    const ids = this.byKind.get(kind) ?? [];
    return ids.map((id) => this.entries.find((e) => e.id === id)!).filter(Boolean);
  }

  getAll(): ContentEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  // ── Summary ───────────────────────────────────────────────────

  getSummary(): {
    total: number;
    byKind: Record<string, number>;
    totalInputBytes: number;
    totalOutputBytes: number;
    tasks: string[];
  } {
    const byKind: Record<string, number> = {};
    let totalInputBytes = 0;
    let totalOutputBytes = 0;
    const tasks = new Set<string>();

    for (const entry of this.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      for (const block of entry.inputs) totalInputBytes += block.bytes;
      for (const block of entry.outputs) totalOutputBytes += block.bytes;
      if (entry.taskId) tasks.add(entry.taskId);
    }

    return {
      total: this.entries.length,
      byKind,
      totalInputBytes,
      totalOutputBytes,
      tasks: [...tasks],
    };
  }

  // ── Reset ─────────────────────────────────────────────────────

  reset(): void {
    this.entries = [];
    this.nextId = 1;
    this.byTask.clear();
    this.byKind.clear();
    this.byEventSeq.clear();
  }

  // ── Buffer rotation ─────────────────────────────────────────

  private rotate(): void {
    const keep = Math.floor(this.maxEntries / 2);
    this.entries = this.entries.slice(-keep);

    // Rebuild indexes from surviving entries
    this.byTask.clear();
    this.byKind.clear();
    this.byEventSeq.clear();
    for (const entry of this.entries) {
      this.index(entry);
    }
  }

  // ── Persistence ───────────────────────────────────────────────

  persist(): void {
    try {
      writeFileSync(PERSIST_PATH, JSON.stringify(this.entries, null, 2));
    } catch {
      // Silently fail — persistence is best-effort for development
    }
  }

  loadFromDisk(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, "utf-8");
      const data = JSON.parse(raw) as ContentEntry[];
      if (!Array.isArray(data)) return;

      this.entries = data;
      this.nextId = data.reduce((max, e) => Math.max(max, e.id + 1), 1);

      // Rebuild indexes
      this.byTask.clear();
      this.byKind.clear();
      this.byEventSeq.clear();
      for (const entry of this.entries) {
        this.index(entry);
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  // ── Internal ──────────────────────────────────────────────────

  private index(entry: ContentEntry): void {
    // Task index
    if (entry.taskId) {
      const existing = this.byTask.get(entry.taskId) ?? [];
      existing.push(entry.id);
      this.byTask.set(entry.taskId, existing);
    }

    // Kind index
    const kindList = this.byKind.get(entry.kind) ?? [];
    kindList.push(entry.id);
    this.byKind.set(entry.kind, kindList);

    // Event seq index
    if (entry.eventSeq != null) {
      const seqList = this.byEventSeq.get(entry.eventSeq) ?? [];
      seqList.push(entry.id);
      this.byEventSeq.set(entry.eventSeq, seqList);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let singleton: ContentStore | null = null;

export function getContentStore(): ContentStore {
  if (!singleton) {
    singleton = new ContentStore();
    singleton.loadFromDisk();
  }
  return singleton;
}

export function resetContentStore(): void {
  if (singleton) singleton.reset();
  singleton = null;
}

// ─── Helper ─────────────────────────────────────────────────────

export function contentBlock(
  label: string,
  text: string,
  structured?: unknown,
): ContentBlock {
  return {
    label,
    text,
    bytes: Buffer.byteLength(text, "utf-8"),
    structured,
  };
}
