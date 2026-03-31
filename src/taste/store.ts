/**
 * Taste Profile Store — persist and load the Parsifal's taste profile.
 *
 * Storage: ~/.agent-cortex/taste-profile.json
 * Atomic writes (tmp + rename) to prevent corruption on kill.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { TasteProfile } from "../types/intent.js";

const CORTEX_DIR = join(homedir(), ".agent-cortex");
const TASTE_FILE = join(CORTEX_DIR, "taste-profile.json");

function ensureDir(): void {
  if (!existsSync(CORTEX_DIR)) {
    mkdirSync(CORTEX_DIR, { recursive: true });
  }
}

/** Fallback taste profile when none is configured. */
export const DEFAULT_TASTE: TasteProfile = {
  id: "taste-craftsman",
  name: "User",
  visual: "Clean, modern, purposeful",
  decisionStyle: "Pragmatic — simplest thing that works, then iterate",
  communication: "Direct and concise",
  patterns: "Best practices for the technology stack",
  raw: {},
};

/**
 * Persist the taste profile to disk. Called after initial setup
 * and after feedback-loop mutations.
 */
export function persistTasteProfile(taste: TasteProfile): void {
  ensureDir();
  const content = JSON.stringify(taste, null, 2);
  const tmpPath = join(CORTEX_DIR, `.taste-profile.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, TASTE_FILE);
}

/** Clear the persisted taste profile. Next boot will prompt fresh. */
export function clearTasteProfile(): void {
  try { if (existsSync(TASTE_FILE)) unlinkSync(TASTE_FILE); } catch { /* ignore */ }
}

/**
 * Load the persisted taste profile. Returns null if no file exists
 * or if the file is corrupt.
 */
export function loadTasteProfile(): TasteProfile | null {
  try {
    if (!existsSync(TASTE_FILE)) return null;
    return JSON.parse(readFileSync(TASTE_FILE, "utf-8")) as TasteProfile;
  } catch {
    return null;
  }
}
