/**
 * State routes — HTTP handler for /api/* endpoints that expose
 * live Cortex runtime state to the dashboard.
 *
 * Queries the Cortex instance via the state registry singleton.
 * Returns 503 if Cortex hasn't registered yet (server started
 * before Cortex construction — shouldn't happen in practice).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getCortex } from "./state-registry.js";
import { getLastNE } from "../kernel/norepinephrine.js";

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

// ─── Route handler ──────────────────────────────────────────────

export function handleStateRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS" && url.startsWith("/api")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (!url.startsWith("/api/")) return false;

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
