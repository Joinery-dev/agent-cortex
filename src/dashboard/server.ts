import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bus } from "../events.js";
import type { CortexEvent } from "../events.js";
import { createLogger } from "../util/logger.js";
import { handleStateRequest } from "./state-routes.js";
import { registerCortex } from "./state-registry.js";
import { WebSocketTransport } from "../conversation/websocket-transport.js";
import type { Cortex } from "../index.js";

const log = createLogger("dashboard");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const clients: Set<http.ServerResponse> = new Set();

// Buffer recent events so late-connecting clients get caught up
const eventBuffer: CortexEvent[] = [];
const MAX_BUFFER = 200;

function sendEvent(event: CortexEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();

  const data = JSON.stringify(event);
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Subscribe to all cortex events
bus.onCortex(sendEvent);

/** Result from starting the dashboard — includes server handle for WebSocket wiring. */
export interface DashboardHandle {
  url: string;
  server: http.Server;
  /** WebSocket transport wired to /conversation. Add to ConversationCortex. */
  wsTransport: WebSocketTransport;
}

export function startDashboard(port?: number, cortex?: Cortex): Promise<string>;
export function startDashboard(port: number, cortex: Cortex | undefined, opts: { returnHandle: true }): Promise<DashboardHandle>;
export function startDashboard(port = 3000, cortex?: Cortex, opts?: { returnHandle: boolean }): Promise<string | DashboardHandle> {
  // Register Cortex instance for state routes
  if (cortex) registerCortex(cortex);

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // State routes — /api/*
      if (handleStateRequest(req, res)) return;

      if (req.url === "/events") {
        // SSE endpoint
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        // Replay buffered events so the client catches up
        for (const event of eventBuffer) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // Determine which file to serve
      let filename = "conversation.html";
      const contentType = "text/html";

      if (req.url === "/conversation") {
        filename = "conversation.html";
      } else if (req.url === "/planning") {
        filename = "planning.html";
      }

      // Serve HTML files — try multiple paths for tsx vs compiled
      const candidates = [
        path.join(__dirname, filename),
        path.join(__dirname, "..", "..", "src", "dashboard", filename),
      ];
      const htmlPath = candidates.find((p) => fs.existsSync(p));
      if (!htmlPath) {
        res.writeHead(404);
        res.end("Page not found");
        return;
      }
      fs.readFile(htmlPath, "utf-8", (err, content) => {
        if (err) {
          res.writeHead(500);
          res.end("Failed to load page");
          return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      });
    });

    // Wire WebSocket transport for conversation
    const wsTransport = new WebSocketTransport(server);

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      log.info(`Dashboard running at ${url}`);
      if (opts?.returnHandle) {
        resolve({ url, server, wsTransport } as DashboardHandle & string);
      } else {
        resolve(url as string & DashboardHandle);
      }
    });
  });
}
