/**
 * State registry — singleton that holds a reference to the Cortex instance
 * so the dashboard server can query live state without prop-drilling.
 *
 * Same register/get pattern as getTraceCollector() and getExecutionController().
 */

import type { Cortex } from "../index.js";
import type { WebSocketTransport } from "../conversation/websocket-transport.js";

let instance: Cortex | null = null;
let wsTransportInstance: WebSocketTransport | null = null;
let bootInProgress = false;

/** Register the Cortex instance. Called once at startup. */
export function registerCortex(cortex: Cortex): void {
  instance = cortex;
}

/** Get the registered Cortex instance, or null if not yet registered. */
export function getCortex(): Cortex | null {
  return instance;
}

/** Store the dashboard's WebSocket transport so a late-booting Cortex can wire it. */
export function registerWsTransport(transport: WebSocketTransport): void {
  wsTransportInstance = transport;
}

/** Get the stored WebSocket transport. */
export function getWsTransport(): WebSocketTransport | null {
  return wsTransportInstance;
}

/** Clear the Cortex instance so a new one can be booted. */
export function clearCortex(): void {
  instance = null;
}

/** Mark boot as in-progress. Returns false if already booting. */
export function startBoot(): boolean {
  if (bootInProgress) return false;
  bootInProgress = true;
  return true;
}

/** Mark boot as finished (success or failure). */
export function finishBoot(): void {
  bootInProgress = false;
}

/** Check if a boot is currently in progress. */
export function isBooting(): boolean {
  return bootInProgress;
}
