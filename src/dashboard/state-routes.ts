/**
 * State routes — HTTP handler for /api/* endpoints that expose
 * live Cortex runtime state to the dashboard.
 *
 * Queries the Cortex instance via the state registry singleton.
 * Returns 503 if Cortex hasn't registered yet (server started
 * before Cortex construction — shouldn't happen in practice).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getCortex, clearCortex, getWsTransport, startBoot, finishBoot, isBooting } from "./state-registry.js";
import { getLastNE } from "../kernel/norepinephrine.js";
import { bootFromWeb } from "./web-boot.js";
import { clearWorldviewSelection } from "../worldview/store.js";
import { clearTasteProfile } from "../taste/store.js";
import { clearSession } from "../session/state.js";

// ─── JSON helpers ───────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function unavailable(res: ServerResponse): void {
  json(res, { error: "Cortex not registered" }, 503);
}

/** Read JSON body from a POST request, then call handler. Returns true for route matching. */
function readBody(req: IncomingMessage, handler: (body: unknown) => void, res: ServerResponse): true {
  let data = "";
  req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
  req.on("end", () => {
    try {
      handler(JSON.parse(data));
    } catch {
      json(res, { error: "Invalid JSON body" }, 400);
    }
  });
  return true;
}

// ─── Route handler ──────────────────────────────────────────────

export function handleStateRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS" && url.startsWith("/api")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (!url.startsWith("/api/")) return false;

  // ── Run endpoints — boot Cortex with full sequence ───────────
  if ((url === "/api/run" || url === "/api/run-project") && method === "POST") {
    return readBody(req, async (body) => {
      const { description } = body as { description?: string };
      const desc = (typeof description === "string" && description.trim()) ? description.trim() : "New project";
      if (url === "/api/run" && desc === "New project") {
        json(res, { error: "Missing 'description' string in body" }, 400);
        return;
      }

      // Reject if already booting or running
      if (isBooting()) {
        json(res, { error: "Boot already in progress" }, 409);
        return;
      }
      const cortex = getCortex();
      if (cortex) {
        const runner = cortex.getBrainstem().getRunner();
        if (runner.getActiveRhythms().length > 0) {
          json(res, { error: "Cortex is already running" }, 409);
          return;
        }
      }

      const ws = getWsTransport();
      if (!ws) {
        json(res, { error: "No WebSocket transport available" }, 503);
        return;
      }

      if (!startBoot()) {
        json(res, { error: "Boot already in progress" }, 409);
        return;
      }

      // Fire-and-forget — the boot sequence runs worldview selection,
      // taste setup, Claus boot, then asks for the project prompt
      // and runs the project. All interaction via WebSocket.
      bootFromWeb(ws)
        .catch((err) => {
          console.error("Boot failed:", err);
          try {
            ws.sendMessage({
              id: "error-" + Date.now(),
              role: "cortex" as const,
              kind: "message" as const,
              text: `Boot failed: ${String(err)}`,
              timestamp: new Date(),
            });
          } catch { /* best effort */ }
        })
        .finally(() => finishBoot());

      json(res, { status: "booting" });
    }, res);
  }

  // ── POST /api/stop — hard-interrupt all rhythms, clear Cortex ──
  if (url === "/api/stop" && method === "POST") {
    const cortex = getCortex();
    if (!cortex) {
      json(res, { error: "Nothing running" }, 404);
      return true;
    }
    const runner = cortex.getBrainstem().getRunner();
    const active = runner.getActiveRhythms();
    for (const rhythmId of active) {
      runner.interrupt(rhythmId, {
        mode: "hard",
        source: "webapp",
        reason: "Stopped by user",
        context: {},
      });
    }
    clearCortex();
    json(res, { status: "stopped", interrupted: active.length });
    return true;
  }

  // ── POST /api/clean-slate — wipe persisted state, reset to start ──
  if (url === "/api/clean-slate" && method === "POST") {
    // Stop any running Cortex first
    const running = getCortex();
    if (running) {
      const runner = running.getBrainstem().getRunner();
      for (const rhythmId of runner.getActiveRhythms()) {
        runner.interrupt(rhythmId, {
          mode: "hard",
          source: "webapp",
          reason: "Clean slate",
          context: {},
        });
      }
      clearCortex();
    }

    // Wipe persisted worldview, taste, and session
    clearWorldviewSelection();
    clearTasteProfile();
    clearSession();

    // Clear boot lock and WebSocket replay buffer
    finishBoot();
    const ws = getWsTransport();
    if (ws) ws.clearReplayBuffer();

    json(res, { status: "clean" });
    return true;
  }

  const cortex = getCortex();
  if (!cortex) {
    unavailable(res);
    return true;
  }

  const brainstem = cortex.getBrainstem();
  const wm = cortex.getWorkingMemory();

  // ── GET /api/vitals ─────────────────────────────────────────
  if (url === "/api/vitals" && method === "GET") {
    json(res, cortex.getVitals());
    return true;
  }

  // ── GET /api/ne ─────────────────────────────────────────────
  if (url === "/api/ne" && method === "GET") {
    const last = getLastNE();
    if (!last) {
      json(res, { ne: null, components: null, computedAt: null });
    } else {
      json(res, last);
    }
    return true;
  }

  // ── GET /api/budget ─────────────────────────────────────────
  if (url === "/api/budget" && method === "GET") {
    const summary = cortex.getCostSummary();
    json(res, summary ?? { error: "No budget configured" });
    return true;
  }

  // ── GET /api/budget/:taskId ─────────────────────────────────
  const budgetTaskMatch = url.match(/^\/api\/budget\/(.+)$/);
  if (budgetTaskMatch && method === "GET") {
    const taskId = decodeURIComponent(budgetTaskMatch[1]);
    const tracker = brainstem.getCostTracker();
    if (!tracker) {
      json(res, { error: "No budget configured" });
    } else {
      json(res, tracker.getTaskBudget(taskId));
    }
    return true;
  }

  // ── GET /api/working-memory ─────────────────────────────────
  if (url === "/api/working-memory" && method === "GET") {
    const snapshot = wm.snapshot();
    json(res, {
      ...snapshot,
      load: wm.getLoad(),
      senseTrends: wm.getSenseTrends(),
      receptorTrends: wm.getReceptorTrends(),
      convictionTrajectory: wm.getConvictionTrajectory(),
      observationPressure: wm.getObservationPressure(),
    });
    return true;
  }

  // ── GET /api/tasks ──────────────────────────────────────────
  if (url === "/api/tasks" && method === "GET") {
    json(res, {
      tasks: wm.getTasks(),
      currentTaskId: wm.getCurrentTaskId(),
    });
    return true;
  }

  // ── GET /api/senses ─────────────────────────────────────────
  if (url === "/api/senses" && method === "GET") {
    const library = cortex.getLibrary();
    const thalamus = brainstem.getThalamus();
    const active = thalamus.getActiveSenses(library);
    const inhibited = wm.getInhibitedSenses();
    json(res, {
      active: active.map((s) => ({
        id: s.id,
        name: s.name,
        level: s.level,
        sensitivity: s.sensitivity,
        parentId: s.parentId ?? null,
      })),
      inhibited,
    });
    return true;
  }

  // ── GET /api/rhythms ────────────────────────────────────────
  if (url === "/api/rhythms" && method === "GET") {
    const runner = brainstem.getRunner();
    json(res, { active: runner.getActiveRhythms() });
    return true;
  }

  // ── GET /api/world-model ────────────────────────────────────
  if (url === "/api/world-model" && method === "GET") {
    const worldModel = brainstem.getWorldModel();
    json(res, worldModel.getState());
    return true;
  }

  // ── GET /api/plasticity ─────────────────────────────────────
  if (url === "/api/plasticity" && method === "GET") {
    const store = brainstem.getPlasticityStore();
    json(res, store.snapshot());
    return true;
  }

  // ── GET /api/gestalt/:taskId ────────────────────────────────
  const gestaltMatch = url.match(/^\/api\/gestalt\/(.+)$/);
  if (gestaltMatch && method === "GET") {
    const taskId = decodeURIComponent(gestaltMatch[1]);
    const thalamus = brainstem.getThalamus();
    const gestalt = thalamus.getGestalt(taskId);
    if (!gestalt) {
      json(res, { error: `No gestalt for task ${taskId}` }, 404);
    } else {
      json(res, gestalt);
    }
    return true;
  }

  // ── GET /api/conviction ─────────────────────────────────────
  if (url === "/api/conviction" && method === "GET") {
    json(res, wm.getConvictionTrajectory());
    return true;
  }

  // ── GET /api/observations ───────────────────────────────────
  if (url === "/api/observations" && method === "GET") {
    json(res, {
      observations: wm.getObservations(),
      pressure: wm.getObservationPressure(),
      newCount: wm.getNewObservations().length,
    });
    return true;
  }

  // ── GET /api/drift ──────────────────────────────────────────
  if (url === "/api/drift" && method === "GET") {
    const driftMonitor = brainstem.getDriftMonitor();
    json(res, driftMonitor.getState());
    return true;
  }

  // ── GET /api/state — aggregate snapshot ─────────────────────
  if (url === "/api/state" && method === "GET") {
    const library = cortex.getLibrary();
    const thalamus = brainstem.getThalamus();
    const runner = brainstem.getRunner();

    json(res, {
      vitals: cortex.getVitals(),
      ne: getLastNE(),
      budget: cortex.getCostSummary(),
      workingMemory: {
        load: wm.getLoad(),
        currentTaskId: wm.getCurrentTaskId(),
        taskCount: wm.getTasks().length,
        senseTrends: wm.getSenseTrends(),
        convictionTrajectory: wm.getConvictionTrajectory(),
        observationPressure: wm.getObservationPressure(),
      },
      senses: {
        activeCount: thalamus.getActiveSenses(library).length,
        inhibitedCount: wm.getInhibitedSenses().length,
      },
      rhythms: { active: runner.getActiveRhythms() },
      worldModel: brainstem.getWorldModel().getState(),
      drift: brainstem.getDriftMonitor().getState(),
      tokenUsage: cortex.getTokenUsage(),
    });
    return true;
  }

  // ── Fallback ────────────────────────────────────────────────
  json(res, { error: `Unknown state route: ${url}` }, 404);
  return true;
}
