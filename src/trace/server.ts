/**
 * Trace server — HTTP request handler for the trace UI and API.
 * Mounts under /trace on the existing dashboard server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTraceCollector } from "./collector.js";
import { getContentStore } from "./content-store.js";
import { TraceStepper } from "./stepper.js";
import { narrate, narrateAll } from "./narrator.js";
import { getExecutionController } from "./execution-controller.js";
import { getStepBarrier } from "./step-barrier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Stepper singleton ──────────────────────────────────────────

let stepperSingleton: TraceStepper | null = null;

function getStepper(): TraceStepper {
  if (!stepperSingleton) {
    stepperSingleton = new TraceStepper();
  }
  return stepperSingleton;
}

// ─── SSE connections ────────────────────────────────────────────

const traceClients: Set<ServerResponse> = new Set();
const stepperClients: Set<ServerResponse> = new Set();

function setupSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("\n");
}

function sendSSE(res: ServerResponse, data: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection closed
  }
}

// Start broadcasting trace entries
let traceBroadcastSetup = false;

function ensureTraceBroadcast(): void {
  if (traceBroadcastSetup) return;
  traceBroadcastSetup = true;

  const collector = getTraceCollector();
  collector.onEntry((entry) => {
    for (const client of traceClients) {
      sendSSE(client, {
        seq: entry.seq,
        type: entry.event.type,
        region: entry.region,
        component: entry.component,
        severity: entry.event.severity,
        taskId: entry.taskId,
        microTs: entry.microTs,
        deltaMs: entry.deltaMs,
        timestamp: entry.event.timestamp,
      });
    }
  });
}

let stepperBroadcastSetup = false;

function ensureStepperBroadcast(): void {
  if (stepperBroadcastSetup) return;
  stepperBroadcastSetup = true;

  const stepper = getStepper();
  stepper.onStateChange((state) => {
    for (const client of stepperClients) {
      sendSSE(client, state);
    }
  });
}

// ─── Request body parser ────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ─── JSON response helper ───────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse, message = "Not found"): void {
  json(res, { error: message }, 404);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ─── Route handler ──────────────────────────────────────────────

export function handleTraceRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS" && url.startsWith("/trace")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (!url.startsWith("/trace")) return false;

  // ── HTML page ─────────────────────────────────────────────────
  if (url === "/trace" || url === "/trace/") {
    try {
      const html = readFileSync(join(__dirname, "..", "..", "src", "dashboard", "trace.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <h1>Agent Cortex Trace</h1>
        <p>trace.html not found. API is available at /trace/api/*</p>
        <script>
          const es = new EventSource('/trace/stream');
          es.onmessage = e => {
            const entry = JSON.parse(e.data);
            const div = document.createElement('div');
            div.textContent = JSON.stringify(entry);
            document.body.appendChild(div);
          };
        </script>
      </body></html>`);
    }
    return true;
  }

  // ── SSE streams ───────────────────────────────────────────────
  if (url === "/trace/stream") {
    ensureTraceBroadcast();
    setupSSE(res);
    traceClients.add(res);
    req.on("close", () => traceClients.delete(res));
    return true;
  }

  if (url === "/trace/stepper-stream") {
    ensureStepperBroadcast();
    setupSSE(res);
    stepperClients.add(res);
    req.on("close", () => stepperClients.delete(res));
    return true;
  }

  // ── API routes ────────────────────────────────────────────────
  const collector = getTraceCollector();
  const contentStore = getContentStore();
  const stepper = getStepper();

  // GET /trace/api/summary
  if (url === "/trace/api/summary" && method === "GET") {
    json(res, {
      trace: collector.getSummary(),
      content: contentStore.getSummary(),
      stepper: stepper.getState(),
    });
    return true;
  }

  // GET /trace/api/events?limit=N&fromSeq=N&region=X&component=X&taskId=X&type=X&severity=X
  if (url.startsWith("/trace/api/events") && method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const filter: Record<string, unknown> = {};
    if (params.has("limit")) filter.limit = parseInt(params.get("limit")!, 10);
    if (params.has("fromSeq")) filter.fromSeq = parseInt(params.get("fromSeq")!, 10);
    if (params.has("toSeq")) filter.toSeq = parseInt(params.get("toSeq")!, 10);
    if (params.has("region")) filter.region = params.get("region");
    if (params.has("component")) filter.component = params.get("component");
    if (params.has("taskId")) filter.taskId = params.get("taskId");
    if (params.has("type")) filter.eventType = params.get("type");
    if (params.has("severity")) filter.severity = params.get("severity");

    const slice = collector.query(filter as any);
    json(res, {
      entries: slice.entries.map((e) => ({
        seq: e.seq,
        type: e.event.type,
        severity: e.event.severity,
        region: e.region,
        component: e.component,
        taskId: e.taskId,
        rhythmId: e.rhythmContext?.rhythmId ?? null,
        phase: e.rhythmContext?.phase ?? null,
        cycle: e.rhythmContext?.cycle ?? null,
        microTs: e.microTs,
        deltaMs: e.deltaMs,
        timestamp: e.event.timestamp,
        data: e.event.data,
      })),
      edges: slice.edges,
      total: slice.total,
    });
    return true;
  }

  // GET /trace/api/entry/:seq
  const entryMatch = url.match(/^\/trace\/api\/entry\/(\d+)$/);
  if (entryMatch && method === "GET") {
    const seq = parseInt(entryMatch[1], 10);
    const entry = collector.getEntry(seq);
    if (!entry) return notFound(res, `Entry ${seq} not found`), true;
    json(res, {
      seq: entry.seq,
      event: entry.event,
      region: entry.region,
      component: entry.component,
      taskId: entry.taskId,
      rhythmContext: entry.rhythmContext,
      parentRhythmId: entry.parentRhythmId,
      microTs: entry.microTs,
      deltaMs: entry.deltaMs,
      content: contentStore.getByEventSeq(seq),
    });
    return true;
  }

  // GET /trace/api/waterfall
  if (url === "/trace/api/waterfall" && method === "GET") {
    json(res, collector.getWaterfall());
    return true;
  }

  // GET /trace/api/flow
  if (url === "/trace/api/flow" && method === "GET") {
    json(res, collector.getFlowGraph());
    return true;
  }

  // GET /trace/api/types
  if (url === "/trace/api/types" && method === "GET") {
    json(res, collector.getTypes());
    return true;
  }

  // GET /trace/api/components
  if (url === "/trace/api/components" && method === "GET") {
    json(res, collector.getComponents());
    return true;
  }

  // GET /trace/api/tasks
  if (url === "/trace/api/tasks" && method === "GET") {
    json(res, collector.getTasks());
    return true;
  }

  // GET /trace/api/edges
  if (url === "/trace/api/edges" && method === "GET") {
    json(res, collector.getEdges());
    return true;
  }

  // ── Content API ───────────────────────────────────────────────

  // GET /trace/api/content/summary
  if (url === "/trace/api/content/summary" && method === "GET") {
    json(res, contentStore.getSummary());
    return true;
  }

  // GET /trace/api/content/all
  if (url === "/trace/api/content/all" && method === "GET") {
    json(res, contentStore.getAll());
    return true;
  }

  // GET /trace/api/content/id/:id
  const contentIdMatch = url.match(/^\/trace\/api\/content\/id\/(\d+)$/);
  if (contentIdMatch && method === "GET") {
    const id = parseInt(contentIdMatch[1], 10);
    const entry = contentStore.get(id);
    if (!entry) return notFound(res, `Content ${id} not found`), true;
    json(res, entry);
    return true;
  }

  // GET /trace/api/content/event/:seq
  const contentEventMatch = url.match(/^\/trace\/api\/content\/event\/(\d+)$/);
  if (contentEventMatch && method === "GET") {
    const seq = parseInt(contentEventMatch[1], 10);
    json(res, contentStore.getByEventSeq(seq));
    return true;
  }

  // GET /trace/api/content/task/:taskId
  const contentTaskMatch = url.match(/^\/trace\/api\/content\/task\/(.+)$/);
  if (contentTaskMatch && method === "GET") {
    const taskId = decodeURIComponent(contentTaskMatch[1]);
    json(res, contentStore.getForTask(taskId));
    return true;
  }

  // GET /trace/api/content/kind/:kind
  const contentKindMatch = url.match(/^\/trace\/api\/content\/kind\/(.+)$/);
  if (contentKindMatch && method === "GET") {
    const kind = decodeURIComponent(contentKindMatch[1]);
    json(res, contentStore.getByKind(kind as any));
    return true;
  }

  // ── Narrative API ─────────────────────────────────────────────

  // GET /trace/api/narrative/all
  if (url === "/trace/api/narrative/all" && method === "GET") {
    const allContent = contentStore.getAll();
    json(res, narrateAll(allContent));
    return true;
  }

  // GET /trace/api/narrative/id/:id
  const narrativeIdMatch = url.match(/^\/trace\/api\/narrative\/id\/(\d+)$/);
  if (narrativeIdMatch && method === "GET") {
    const id = parseInt(narrativeIdMatch[1], 10);
    const entry = contentStore.get(id);
    if (!entry) return notFound(res, `Content ${id} not found`), true;
    json(res, narrate(entry));
    return true;
  }

  // GET /trace/api/narrative/task/:taskId
  const narrativeTaskMatch = url.match(/^\/trace\/api\/narrative\/task\/(.+)$/);
  if (narrativeTaskMatch && method === "GET") {
    const taskId = decodeURIComponent(narrativeTaskMatch[1]);
    const entries = contentStore.getForTask(taskId);
    json(res, narrateAll(entries));
    return true;
  }

  // ── Stepper API ───────────────────────────────────────────────

  // GET /trace/api/stepper/state
  if (url === "/trace/api/stepper/state" && method === "GET") {
    json(res, stepper.getState());
    return true;
  }

  // GET /trace/api/stepper/window?before=N&after=N
  if (url.startsWith("/trace/api/stepper/window") && method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const before = params.has("before") ? parseInt(params.get("before")!, 10) : 5;
    const after = params.has("after") ? parseInt(params.get("after")!, 10) : 5;
    json(res, stepper.getWindow(before, after));
    return true;
  }

  // POST /trace/api/stepper/enable-replay
  if (url === "/trace/api/stepper/enable-replay" && method === "POST") {
    parseBody(req).then((body) => {
      const granularity = (body.granularity as string) ?? "event";
      stepper.enableReplay(granularity as any);
      json(res, stepper.getState());
    });
    return true;
  }

  // POST /trace/api/stepper/enable-live
  if (url === "/trace/api/stepper/enable-live" && method === "POST") {
    parseBody(req).then((body) => {
      const granularity = (body.granularity as string) ?? "event";
      stepper.enableLive(granularity as any);
      json(res, stepper.getState());
    });
    return true;
  }

  // POST /trace/api/stepper/disable
  if (url === "/trace/api/stepper/disable" && method === "POST") {
    stepper.disable();
    json(res, stepper.getState());
    return true;
  }

  // POST /trace/api/stepper/forward
  if (url === "/trace/api/stepper/forward" && method === "POST") {
    const entry = stepper.stepForward();
    json(res, { state: stepper.getState(), entry: entry ?? null });
    return true;
  }

  // POST /trace/api/stepper/back
  if (url === "/trace/api/stepper/back" && method === "POST") {
    const entry = stepper.stepBack();
    json(res, { state: stepper.getState(), entry: entry ?? null });
    return true;
  }

  // POST /trace/api/stepper/jump/:seq
  const jumpMatch = url.match(/^\/trace\/api\/stepper\/jump\/(\d+)$/);
  if (jumpMatch && method === "POST") {
    const seq = parseInt(jumpMatch[1], 10);
    const entry = stepper.jumpTo(seq);
    json(res, { state: stepper.getState(), entry: entry ?? null });
    return true;
  }

  // POST /trace/api/stepper/granularity
  if (url === "/trace/api/stepper/granularity" && method === "POST") {
    parseBody(req).then((body) => {
      const granularity = (body.granularity as string) ?? "event";
      stepper.setGranularity(granularity as any);
      json(res, stepper.getState());
    });
    return true;
  }

  // POST /trace/api/stepper/auto-advance
  if (url === "/trace/api/stepper/auto-advance" && method === "POST") {
    parseBody(req).then((body) => {
      const ms = body.ms as number | undefined;
      if (ms && ms > 0) {
        stepper.startAutoAdvance(ms);
      } else {
        stepper.stopAutoAdvance();
      }
      json(res, stepper.getState());
    });
    return true;
  }

  // ── Execution control endpoints ─────────────────────────────

  if (url === "/trace/api/exec/status") {
    const ctrl = getExecutionController();
    if (!ctrl) {
      json(res, { mode: "live", label: "", isPaused: false, replay: { active: false, served: 0, total: 0, remaining: 0 } });
    } else {
      json(res, ctrl.getStatus());
    }
    return true;
  }

  if (url === "/trace/api/exec/pause" && method === "POST") {
    const ctrl = getExecutionController();
    if (ctrl) ctrl.pause();
    else getStepBarrier().enable();
    json(res, { ok: true, ...(ctrl?.getStatus() ?? { mode: "paused" }) });
    return true;
  }

  if (url === "/trace/api/exec/step" && method === "POST") {
    const ctrl = getExecutionController();
    if (ctrl) ctrl.step();
    else getStepBarrier().release();
    json(res, { ok: true, ...(ctrl?.getStatus() ?? {}) });
    return true;
  }

  if (url === "/trace/api/exec/resume" && method === "POST") {
    const ctrl = getExecutionController();
    if (ctrl) ctrl.resume();
    else getStepBarrier().disable();
    json(res, { ok: true, ...(ctrl?.getStatus() ?? { mode: "live" }) });
    return true;
  }

  if (url === "/trace/api/exec/replay-from" && method === "POST") {
    const ctrl = getExecutionController();
    if (!ctrl) {
      json(res, { error: "No execution controller registered" }, 400);
      return true;
    }
    readBody(req).then((body) => {
      const data = JSON.parse(body || "{}");
      const contentId = data.contentId;
      if (typeof contentId !== "number") {
        json(res, { error: "contentId required" }, 400);
        return;
      }
      ctrl.replayFrom(contentId).catch(() => {});
      json(res, { ok: true, replayingFrom: contentId, ...(ctrl.getStatus()) });
    }).catch(() => {
      json(res, { error: "Invalid request body" }, 400);
    });
    return true;
  }

  // ── Checkpoint endpoints ─────────────────────────────────────

  if (url === "/trace/api/checkpoints" && method === "GET") {
    import("./checkpoint-store.js").then(({ CheckpointStore }) => {
      const cpStore = new CheckpointStore();
      cpStore.list().then((index) => json(res, index));
    });
    return true;
  }

  if (url === "/trace/api/checkpoints/latest" && method === "GET") {
    import("./checkpoint-store.js").then(({ CheckpointStore }) => {
      const cpStore = new CheckpointStore();
      cpStore.latest("pre-integrate").then((checkpoint) => {
        if (!checkpoint) json(res, { error: "No checkpoints available" }, 404);
        else json(res, checkpoint);
      });
    });
    return true;
  }

  if (url?.startsWith("/trace/api/checkpoints/") && url.endsWith("/resume") && method === "POST") {
    const id = url.split("/")[4]; // /trace/api/checkpoints/{id}/resume
    const ctrl = getExecutionController();
    if (!ctrl) {
      json(res, { error: "No execution controller registered" }, 400);
      return true;
    }
    import("./checkpoint-store.js").then(({ CheckpointStore }) => {
      const cpStore = new CheckpointStore();
      cpStore.load(id).then((checkpoint) => {
        if (!checkpoint) {
          json(res, { error: `Checkpoint ${id} not found` }, 404);
          return;
        }
        ctrl.resumeFromCheckpoint(checkpoint).catch(() => {});
        json(res, { ok: true, checkpointId: id, label: checkpoint.label });
      });
    });
    return true;
  }

  if (url === "/trace/exec-stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial state
    const ctrl = getExecutionController();
    const state = ctrl?.getStatus() ?? { mode: "live", label: "", isPaused: false };
    res.write(`data: ${JSON.stringify(state)}\n\n`);

    // Subscribe to barrier changes
    const unsub = getStepBarrier().onChange((mode, label) => {
      const status = ctrl?.getStatus() ?? { mode, label, isPaused: getStepBarrier().isPaused };
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    });

    req.on("close", () => unsub());
    return true;
  }

  // ── Fallback ──────────────────────────────────────────────────
  notFound(res, `Unknown trace route: ${url}`);
  return true;
}
