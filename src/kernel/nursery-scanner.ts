/**
 * Nursery Surface Scanner — detects runtime surface area in phase artifacts.
 *
 * Detection over prediction. After a phase gate passes, this scanner
 * inspects what was actually built to determine whether the nursery
 * should exercise it. Heuristic file-content scan — no LLM call.
 *
 * Runtime surface area means: things that run. Servers, handlers,
 * pipelines, stateful objects, I/O wiring, event systems, CLIs.
 * Pure types, static config, and documentation don't run.
 */

import type { TaskGraphNode } from "../types/brainstem.js";
import type { OrchestratorResult } from "../types/orchestrator.js";
import type { NurserySurfaceScan, RuntimeSurfaceArea } from "../types/nursery.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("nursery-scanner");

// ─── Detection patterns ─────────────────────────────────────────
// Each pattern maps a regex to a surface area kind. The regex runs
// against the `work` field of completed task results (the artifact text).

interface DetectionPattern {
  kind: RuntimeSurfaceArea["kind"];
  /** Human-readable description of what this pattern detects. */
  label: string;
  /** Regex to test against artifact content. */
  pattern: RegExp;
}

const DETECTION_PATTERNS: DetectionPattern[] = [
  // ── Servers ──
  {
    kind: "server",
    label: "HTTP server (listen/serve call)",
    pattern: /\.(listen|serve)\s*\(/,
  },
  {
    kind: "server",
    label: "Express/Fastify/Hono app creation",
    pattern: /(?:express|fastify|Hono|createServer)\s*\(/,
  },
  {
    kind: "server",
    label: "HTTP server import",
    pattern: /from\s+['"](?:express|fastify|hono|@hono\/node-server|http|https)['"]/,
  },

  // ── Handlers / Routes ──
  {
    kind: "handler",
    label: "Route handler registration",
    pattern: /\.(get|post|put|patch|delete|all|use)\s*\(\s*['"`\/]/,
  },
  {
    kind: "handler",
    label: "WebSocket handler",
    pattern: /(?:WebSocket|ws|socket\.io|on\s*\(\s*['"]connection['"])/,
  },

  // ── Pipelines / Transforms ──
  {
    kind: "pipeline",
    label: "Stream pipeline",
    pattern: /(?:\.pipe\s*\(|pipeline\s*\(|Transform|Readable|Writable)/,
  },
  {
    kind: "pipeline",
    label: "Message queue consumer/producer",
    pattern: /(?:subscribe|publish|consume|produce|createConsumer|createProducer)\s*\(/,
  },

  // ── Stateful Objects ──
  {
    kind: "stateful-object",
    label: "Database connection/pool",
    pattern: /(?:createPool|createConnection|mongoose\.connect|prisma|drizzle|knex)\s*\(/,
  },
  {
    kind: "stateful-object",
    label: "Cache/store instance",
    pattern: /(?:createClient|Redis|Memcached|new Map\s*\(|new Set\s*\()\s*(?:\(|;)/,
  },

  // ── I/O Wiring ──
  {
    kind: "io-wiring",
    label: "File watcher",
    pattern: /(?:watch|watchFile|FSWatcher|chokidar)\s*\(/,
  },
  {
    kind: "io-wiring",
    label: "Network client",
    pattern: /(?:fetch\s*\(|axios|got\s*\(|request\s*\(|createConnection)\s*/,
  },

  // ── Event Systems ──
  {
    kind: "event-system",
    label: "Event emitter pattern",
    pattern: /(?:EventEmitter|\.on\s*\(\s*['"]|\.emit\s*\(\s*['"]|addEventListener)/,
  },

  // ── Scheduled Jobs ──
  {
    kind: "scheduled-job",
    label: "Cron/interval scheduling",
    pattern: /(?:cron|setInterval|schedule|CronJob)\s*\(/,
  },

  // ── CLI Tools ──
  {
    kind: "cli-tool",
    label: "CLI argument parsing",
    pattern: /(?:process\.argv|yargs|commander|parseArgs|minimist)/,
  },
  {
    kind: "cli-tool",
    label: "CLI entry point",
    pattern: /(?:#!\/usr\/bin\/env\s+node|bin.*:\s*['"])/,
  },
];

// ─── File path extraction ───────────────────────────────────────
// Best-effort extraction of file paths from work output. The motor
// typically writes file paths in its work output.

const FILE_PATH_PATTERN = /(?:src|lib|app|bin|server|api)\/[\w/.@-]+\.(?:ts|js|mjs|cjs|tsx|jsx)/g;

function extractFilePaths(work: string): string[] {
  const matches = work.match(FILE_PATH_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}

// ─── Scanner ────────────────────────────────────────────────────

/**
 * Scan completed phase artifacts for runtime surface area.
 *
 * Pure function — no side effects, no LLM calls, no file I/O.
 * Works entirely from the task results already in memory.
 */
export function scanPhaseArtifacts(
  phaseGroup: string,
  graph: TaskGraphNode[],
  taskResults: Map<string, OrchestratorResult>,
  completedTaskIds: Set<string>,
): NurserySurfaceScan {
  const phaseTaskIds = graph
    .filter((n) => n.phaseGroup === phaseGroup && completedTaskIds.has(n.task.id))
    .map((n) => n.task.id);

  const surfaceAreas: RuntimeSurfaceArea[] = [];
  const seen = new Set<string>(); // Deduplicate by kind+description

  for (const taskId of phaseTaskIds) {
    const result = taskResults.get(taskId);
    if (!result?.work) continue;

    const files = extractFilePaths(result.work);

    for (const dp of DETECTION_PATTERNS) {
      if (dp.pattern.test(result.work)) {
        const key = `${dp.kind}:${dp.label}`;
        if (seen.has(key)) continue;
        seen.add(key);

        surfaceAreas.push({
          kind: dp.kind,
          description: dp.label,
          files: files.length > 0 ? files : [`task:${taskId}`],
        });
      }
    }
  }

  const scan: NurserySurfaceScan = {
    hasRuntimeSurface: surfaceAreas.length > 0,
    surfaceAreas,
    phaseGroup,
    scanMethod: "heuristic-content-scan",
  };

  log.info("Surface scan complete", {
    phaseGroup,
    hasRuntimeSurface: scan.hasRuntimeSurface,
    surfaceAreaCount: surfaceAreas.length,
    kindsDetected: [...new Set(surfaceAreas.map((s) => s.kind))],
  });

  return scan;
}
