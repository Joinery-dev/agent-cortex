import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bus } from "../events.js";
import type { CortexEvent } from "../events.js";
import { createLogger } from "../util/logger.js";
import { handleStateRequest } from "./state-routes.js";
import { registerCortex, registerWsTransport } from "./state-registry.js";
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

      // ── /diagrams — list all .mmd files with metadata ──────────
      if (req.url === "/diagrams") {
        const diagramsDir = path.join(__dirname, "..", "..", "diagrams");
        const altDir = path.join(__dirname, "..", "diagrams");
        const dir = fs.existsSync(diagramsDir) ? diagramsDir : fs.existsSync(altDir) ? altDir : null;
        if (!dir) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end("[]");
          return;
        }
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".mmd"));
        const diagrams = files.map((file: string) => {
          const content = fs.readFileSync(path.join(dir, file), "utf-8");
          const titleMatch = content.match(/title:\s*["']?([^"'\n]+)/);
          const scopeMatch = content.match(/scope:\s*(\w+)/);
          const phaseMatch = content.match(/phase:\s*(\d+)/);
          const featureMatch = content.match(/feature:\s*(\d+)/);
          return {
            file,
            title: titleMatch?.[1]?.trim() ?? file.replace(".mmd", ""),
            scope: scopeMatch?.[1] ?? "global",
            phase: phaseMatch ? parseInt(phaseMatch[1]) : null,
            feature: featureMatch ? parseInt(featureMatch[1]) : null,
          };
        });
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(diagrams));
        return;
      }

      // ── /diagrams/<file>.mmd — serve raw diagram content ────────
      if (req.url?.startsWith("/diagrams/") && req.url.endsWith(".mmd")) {
        const file = req.url.slice("/diagrams/".length);
        const diagramsDir = path.join(__dirname, "..", "..", "diagrams");
        const altDir = path.join(__dirname, "..", "diagrams");
        const dir = fs.existsSync(diagramsDir) ? diagramsDir : fs.existsSync(altDir) ? altDir : null;
        const filePath = dir ? path.join(dir, file) : null;
        if (!filePath || !fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end("Diagram not found");
          return;
        }
        const content = fs.readFileSync(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(content);
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
    registerWsTransport(wsTransport);

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
