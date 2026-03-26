/**
 * Runtime Manager — start, stop, and check readiness of project runtimes.
 *
 * The build cycle starts runtimes before evaluation so evaluators can
 * perceive the artifact running. Runtimes are shared across all evaluators
 * (each evaluator opens its own "window" via independent HTTP requests).
 *
 * Lifecycle: start → readiness check → evaluation runs → stop.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { RuntimeConfig, RuntimeInstance } from "../types/runtime.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("runtime-manager");

/** Active child processes, keyed by PID for cleanup. */
const activeProcesses = new Map<number, ChildProcess>();

// ── Lifecycle ─────────────────────────────────────────────────────

/** Start a runtime process and wait for readiness. */
export async function startRuntime(
  config: RuntimeConfig,
  projectCwd: string,
): Promise<RuntimeInstance> {
  const cwd = config.cwd ? join(projectCwd, config.cwd) : projectCwd;
  const url = `http://localhost:${config.port}`;

  log.info("Starting runtime", { name: config.name, command: config.startCommand, port: config.port });

  const [cmd, ...args] = config.startCommand.split(/\s+/);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...config.env },
    stdio: "pipe",
    detached: false,
  });

  const pid = child.pid;
  if (pid) {
    activeProcesses.set(pid, child);
  }

  // Log stdout/stderr for debugging but don't block
  child.stdout?.on("data", (data: Buffer) => {
    log.debug(`[${config.name}] ${data.toString().trim()}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    log.debug(`[${config.name}:err] ${data.toString().trim()}`);
  });

  child.on("exit", (code) => {
    if (pid) activeProcesses.delete(pid);
    log.info("Runtime exited", { name: config.name, code });
  });

  // Wait for readiness
  const timeoutSeconds = config.readinessTimeoutSeconds ?? 30;
  const readinessPath = config.readinessPath ?? "/";
  const ready = await waitForReady(url + readinessPath, timeoutSeconds);

  const instance: RuntimeInstance = {
    config,
    url,
    pid,
    startedAt: new Date(),
    ready,
  };

  emit("runtime:started", {
    name: config.name,
    url,
    pid,
    ready,
  });

  if (ready) {
    log.info("Runtime ready", { name: config.name, url });
  } else {
    log.warn("Runtime started but readiness check failed", { name: config.name, url });
  }

  return instance;
}

/** Stop a runtime process. */
export async function stopRuntime(instance: RuntimeInstance): Promise<void> {
  const { config, pid } = instance;

  if (config.stopCommand) {
    // Use explicit stop command
    const [cmd, ...args] = config.stopCommand.split(/\s+/);
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(cmd, args);
    } catch {
      log.warn("Stop command failed, falling back to SIGTERM", { name: config.name });
    }
  }

  if (pid) {
    const child = activeProcesses.get(pid);
    if (child && !child.killed) {
      child.kill("SIGTERM");

      // Wait up to 5s for graceful shutdown, then force kill
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    activeProcesses.delete(pid);
  }

  emit("runtime:stopped", { name: config.name, pid });
  log.info("Runtime stopped", { name: config.name });
}

/** Start all configured runtimes for a project. */
export async function startAllRuntimes(
  configs: RuntimeConfig[],
  projectCwd: string,
): Promise<RuntimeInstance[]> {
  const instances = await Promise.all(
    configs.map((config) => startRuntime(config, projectCwd)),
  );
  return instances;
}

/** Stop all running instances. */
export async function stopAllRuntimes(
  instances: RuntimeInstance[],
): Promise<void> {
  await Promise.all(instances.map((instance) => stopRuntime(instance)));
}

// ── Readiness Check ───────────────────────────────────────────────

/** Poll a URL until it responds with 2xx, or timeout. */
async function waitForReady(
  url: string,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const interval = 1000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return false;
}
