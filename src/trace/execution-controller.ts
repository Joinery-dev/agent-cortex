/**
 * Execution Controller — coordinates pause/step/resume/replay-from.
 *
 * Singleton registered by the run script. Server endpoints call this
 * to control the running system. Holds references to the Brainstem,
 * project context, step barrier, and replay interceptor.
 */

import type { Brainstem } from "../brainstem/index.js";
import type { ProjectContext } from "../types/brainstem.js";
import { getStepBarrier, type ExecMode } from "./step-barrier.js";
import { getContentStore } from "./content-store.js";
import { getTraceCollector } from "./collector.js";
import { buildReplayCache, enableReplay, disableReplay, getReplayState } from "../llm/replay-interceptor.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("execution-controller");

export interface ExecStatus {
  mode: ExecMode;
  label: string;
  isPaused: boolean;
  replay: {
    active: boolean;
    served: number;
    total: number;
    remaining: number;
  };
}

export class ExecutionController {
  private brainstem: Brainstem;
  private projectContext: ProjectContext;
  private runPromise: Promise<unknown> | null = null;

  constructor(brainstem: Brainstem, projectContext: ProjectContext) {
    this.brainstem = brainstem;
    this.projectContext = projectContext;
  }

  /** Pause execution at the next checkpoint. */
  pause(): void {
    getStepBarrier().enable();
    emit("exec:paused", {});
    log.info("Execution paused");
  }

  /** Advance one step (release barrier once, stays enabled). */
  step(): void {
    getStepBarrier().release();
    emit("exec:stepped", {});
  }

  /** Resume live execution (disable barrier). */
  resume(): void {
    getStepBarrier().disable();
    emit("exec:resumed", {});
    log.info("Execution resumed (live)");
  }

  /**
   * Replay from a specific content entry ID.
   *
   * 1. Build replay cache from content store up to contentId
   * 2. Enable the replay interceptor
   * 3. Reset the trace collector (not the content store)
   * 4. Re-run the project — cached responses serve instantly
   *    until exhausted, then switches to live calls
   */
  async replayFrom(contentId: number): Promise<void> {
    log.info("Replay from content ID", { contentId });

    // 1. Build cache from existing content store
    const store = getContentStore();
    const cache = buildReplayCache(store, contentId);

    if (cache.total === 0) {
      log.warn("No cached responses found for replay", { contentId });
      return;
    }

    // 2. Enable replay interceptor
    enableReplay(cache, "replay");
    getStepBarrier().setMode("replaying");

    emit("exec:replay-started", { contentId, cachedResponses: cache.total });

    // 3. Reset trace collector (but NOT content store — it's the cache source)
    const collector = getTraceCollector();
    collector.reset();

    // 4. Re-run the project
    // The replay interceptor serves cached responses for all calls up to contentId.
    // When the cache is exhausted, it switches to live mode automatically.
    log.info("Re-running project with replay cache", {
      cachedResponses: cache.total,
      upToContentId: contentId,
    });

    this.runPromise = this.brainstem.runProject(this.projectContext)
      .then(() => {
        log.info("Replay run completed");
        emit("exec:replay-complete", {});
        getStepBarrier().setMode("live");
      })
      .catch((err) => {
        log.error("Replay run failed", { error: String(err) });
        emit("exec:replay-failed", { error: String(err) });
        getStepBarrier().setMode("live");
        disableReplay();
      });
  }

  /** Start the initial project run. Called by the run script. */
  async startRun(): Promise<void> {
    this.runPromise = this.brainstem.runProject(this.projectContext)
      .then(() => {
        log.info("Project run completed");
        emit("exec:complete", {});
      })
      .catch((err) => {
        log.error("Project run failed", { error: String(err) });
        emit("exec:failed", { error: String(err) });
      });
  }

  /** Get current execution status. */
  getStatus(): ExecStatus {
    const barrier = getStepBarrier();
    const replay = getReplayState();
    return {
      mode: barrier.mode,
      label: barrier.currentLabel,
      isPaused: barrier.isPaused,
      replay: {
        active: replay.mode !== "live",
        served: replay.served,
        total: replay.total,
        remaining: replay.remaining,
      },
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let controller: ExecutionController | null = null;

export function registerExecutionController(ctrl: ExecutionController): void {
  controller = ctrl;
}

export function getExecutionController(): ExecutionController | null {
  return controller;
}
