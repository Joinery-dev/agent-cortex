/**
 * State registry — singleton that holds a reference to the Cortex instance
 * so the dashboard server can query live state without prop-drilling.
 *
 * Same register/get pattern as getTraceCollector() and getExecutionController().
 */

import type { Cortex } from "../index.js";

let instance: Cortex | null = null;

/** Register the Cortex instance. Called once at startup. */
export function registerCortex(cortex: Cortex): void {
  instance = cortex;
}

/** Get the registered Cortex instance, or null if not yet registered. */
export function getCortex(): Cortex | null {
  return instance;
}
