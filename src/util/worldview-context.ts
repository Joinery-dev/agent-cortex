/**
 * Worldview Context — per-execution-context worldview propagation.
 *
 * Uses AsyncLocalStorage so that concurrent Cortex instances (e.g.
 * running shaela, project, and hybrid worldviews in parallel via
 * Promise.all) each get their own worldview without cross-contamination.
 *
 * The Cortex wraps its run/runProject calls in runWithWorldview().
 * Every prompt function anywhere in the call stack can then call
 * getActiveWorldview() to get the current execution's worldview.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Worldview } from "../types/worldview.js";

const storage = new AsyncLocalStorage<Worldview>();

/**
 * Execute a function with a worldview bound to its async context.
 * All code in the call tree — no matter how deeply nested — can
 * call getActiveWorldview() and get this worldview.
 */
export function runWithWorldview<T>(worldview: Worldview, fn: () => T): T {
  return storage.run(worldview, fn);
}

/**
 * Get the worldview for the current async execution context.
 * Returns undefined if no worldview has been set (i.e. the code
 * is not running inside a runWithWorldview() call).
 */
export function getActiveWorldview(): Worldview | undefined {
  return storage.getStore();
}
