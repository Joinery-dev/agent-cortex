/**
 * Persistent diagnostic log writer.
 *
 * Appends CortexEvents (info+ severity) as JSON lines to:
 *   ~/.agent-cortex/diagnostics/{projectId}/{sessionId}.jsonl
 *
 * One file per session, rotated by project. No explicit rotation
 * logic needed — sessions are finite.
 */

import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { newId } from "../util/ids.js";
import { createLogger } from "../util/logger.js";
import type { CortexEvent, EventSeverity } from "../events.js";
import { bus } from "../events.js";

const log = createLogger("diagnostic-log");

/** Severities that get persisted to disk. */
const PERSISTENT_SEVERITIES: Set<EventSeverity> = new Set([
  "info",
  "warn",
  "error",
  "critical",
]);

export class DiagnosticLogWriter {
  private logDir: string;
  private logFile: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(projectId: string, sessionId?: string) {
    const sid = sessionId ?? newId();
    this.logDir = join(
      homedir(),
      ".agent-cortex",
      "diagnostics",
      projectId,
    );
    this.logFile = join(this.logDir, `${sid}.jsonl`);
  }

  /** Ensure the log directory exists. Idempotent. */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = mkdir(this.logDir, { recursive: true })
      .then(() => {
        this.initialized = true;
      })
      .catch((err) => {
        log.error("Failed to create diagnostic log directory", {
          dir: this.logDir,
          error: String(err),
        });
      });

    return this.initPromise;
  }

  /** Append a single event as a JSON line. Fire-and-forget — never throws. */
  private async append(event: CortexEvent): Promise<void> {
    try {
      await this.ensureDir();
      const line = JSON.stringify(event) + "\n";
      await appendFile(this.logFile, line, "utf-8");
    } catch (err) {
      // Diagnostic logging must never crash Cortex.
      log.error("Failed to write diagnostic event", {
        type: event.type,
        error: String(err),
      });
    }
  }

  /**
   * Start listening on the event bus. Returns a cleanup function
   * to stop listening (for tests or shutdown).
   */
  start(): () => void {
    const listener = (event: CortexEvent) => {
      if (PERSISTENT_SEVERITIES.has(event.severity)) {
        // Fire-and-forget — don't await in the event listener
        void this.append(event);
      }
    };

    bus.onCortex(listener);

    return () => {
      bus.removeListener("cortex", listener);
    };
  }

  /** Get the path to the current log file (for diagnostics dashboard). */
  getLogFile(): string {
    return this.logFile;
  }
}
