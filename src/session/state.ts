/**
 * Session State — persist startup inputs across kill/resume.
 *
 * Captures the prompt, intent, taste, and worldview name immediately
 * when the user provides them, so nothing is lost even if the process
 * dies before the first checkpoint.
 *
 * Storage: ~/.agent-cortex/session.json
 * Cleared on project completion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ProjectIntent, TasteProfile } from "../types/intent.js";

const CORTEX_DIR = join(homedir(), ".agent-cortex");
const SESSION_FILE = join(CORTEX_DIR, "session.json");

export interface SessionState {
  /** The user's original prompt text. */
  prompt: string;
  /** Full project intent derived from the prompt. */
  intent: ProjectIntent;
  /** Taste profile active for this session. */
  taste: TasteProfile;
  /** Worldview name (for display — worldview-selection.json is authoritative). */
  worldviewName: string;
  /** When the session started. */
  startedAt: string;
}

function ensureDir(): void {
  if (!existsSync(CORTEX_DIR)) {
    mkdirSync(CORTEX_DIR, { recursive: true });
  }
}

/**
 * Persist session state immediately after startup inputs are collected.
 * Uses atomic write (tmp + rename).
 */
export function persistSession(state: SessionState): void {
  ensureDir();
  const content = JSON.stringify(state, null, 2);
  const tmpPath = join(CORTEX_DIR, `.session.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, SESSION_FILE);
}

/**
 * Load persisted session state, if any.
 */
export function loadSession(): SessionState | null {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as SessionState;
  } catch {
    return null;
  }
}

/**
 * Clear session state (e.g., on project completion or explicit new start).
 */
export function clearSession(): void {
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch { /* ignore */ }
}
