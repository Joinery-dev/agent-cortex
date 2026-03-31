import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bus } from "../events.js";
import type { CortexEvent } from "../events.js";
import { createLogger } from "../util/logger.js";
import { handleTraceRequest } from "../trace/server.js";
import { handleStateRequest } from "./state-routes.js";
import { registerCortex } from "./state-registry.js";
import { getTraceCollector } from "../trace/collector.js";
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

export function startDashboard(port: number = 3000, cortex?: Cortex): Promise<string> {
  // Ensure trace collector is running
  getTraceCollector();

  // Register Cortex instance for state routes
  if (cortex) registerCortex(cortex);

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Trace routes — /trace/*
      if (handleTraceRequest(req, res)) return;

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

      // Serve .mmd diagram files
      if (req.url?.startsWith("/diagrams/") && req.url.endsWith(".mmd")) {
        const mmdPath = path.join(__dirname, "..", "..", req.url);
        if (!fs.existsSync(mmdPath)) {
          res.writeHead(404);
          res.end("Diagram not found");
          return;
        }
        fs.readFile(mmdPath, "utf-8", (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end("Failed to read diagram");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(content);
        });
        return;
      }

      // List available diagrams with frontmatter metadata
      if (req.url === "/diagrams") {
        const diagramDir = path.join(__dirname, "..", "..", "diagrams");
        const files = fs.readdirSync(diagramDir).filter((f: string) => f.endsWith(".mmd"));
        const diagrams = files.map((f: string) => {
          const content = fs.readFileSync(path.join(diagramDir, f), "utf-8");
          const titleMatch = content.match(/title:\s*["']?(.+?)["']?\s*$/m);
          const scopeMatch = content.match(/scope:\s*(\S+)\s*$/m);
          const phaseMatch = content.match(/phase:\s*(\d+)\s*$/m);
          const featureMatch = content.match(/feature:\s*(\d+)\s*$/m);
          return {
            file: f,
            title: titleMatch ? titleMatch[1] : f.replace(".mmd", ""),
            scope: scopeMatch ? scopeMatch[1] : "global",
            phase: phaseMatch ? parseInt(phaseMatch[1], 10) : null,
            feature: featureMatch ? parseInt(featureMatch[1], 10) : null,
          };
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(diagrams));
        return;
      }

      // Check which src files exist (for live subtask status)
      if (req.url === "/src-files") {
        const projectRoot = path.join(__dirname, "..", "..");
        const dirs = ["src/types", "src/kernel", "src/brainstem", "src/brainstem/rhythms", "src/senses", "src/llm"];
        const files: string[] = [];
        for (const dir of dirs) {
          const full = path.join(projectRoot, dir);
          if (fs.existsSync(full)) {
            for (const f of fs.readdirSync(full)) {
              if (f.endsWith(".ts")) files.push(`${dir}/${f}`);
            }
          }
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(files));
        return;
      }

      // Determine which file to serve
      let filename = "index.html";
      let contentType = "text/html";

      if (req.url === "/build") {
        filename = "build.html";
      } else if (req.url === "/planning") {
        filename = "planning.html";
      } else if (req.url === "/build-status") {
        // Serve build-status.json from project root
        const jsonCandidates = [
          path.join(__dirname, "..", "..", "build-status.json"),
          path.join(__dirname, "build-status.json"),
        ];
        const jsonPath = jsonCandidates.find((p) => fs.existsSync(p));
        if (!jsonPath) {
          res.writeHead(404);
          res.end("build-status.json not found");
          return;
        }
        fs.readFile(jsonPath, "utf-8", (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end("Failed to read build-status.json");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(content);
        });
        return;
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

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      log.info(`Dashboard running at ${url}`);
      resolve(url);
    });
  });
}
