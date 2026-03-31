/**
 * WebSocket transport — bidirectional conversation for the webapp.
 *
 * Connects to the dashboard server's /conversation WebSocket endpoint.
 * Carries both conversation messages (right pane) and narration items
 * (left pane) over the same connection.
 *
 * Protocol: JSON messages with a `channel` field:
 *   { channel: "message", payload: ConversationMessage }
 *   { channel: "narration", payload: NarrationItem }
 *   { channel: "status", payload: SystemStatus }
 *   { channel: "input", payload: { text: string } }  // from client
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type {
  ConversationTransport,
  ConversationMessage,
  NarrationItem,
  SystemStatus,
  PlanSnapshot,
  ArtifactItem,
} from "../types/conversation.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("websocket-transport");

// ─── Wire types ────────────────────────────────────────────────

interface WireMessage {
  channel: "message" | "narration" | "status" | "plan" | "artifact" | "input";
  payload: unknown;
}

// ─── Transport ─────────────────────────────────────────────────

export class WebSocketTransport implements ConversationTransport {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private handler: ((text: string) => void) | null = null;
  private closed = false;

  /** Recent messages for late-connecting clients. */
  private replayBuffer: WireMessage[] = [];
  private readonly maxReplay = 200;

  constructor(server: HttpServer, path = "/conversation") {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests for the conversation path
    server.on("upgrade", (req, socket, head) => {
      if (req.url === path) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      }
      // Don't consume upgrades for other paths
    });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      log.info("WebSocket client connected", { clients: this.clients.size });

      // Replay recent messages so late-joining clients catch up
      for (const msg of this.replayBuffer) {
        ws.send(JSON.stringify(msg));
      }

      ws.on("message", (data) => {
        try {
          const wire = JSON.parse(data.toString()) as WireMessage;
          if (wire.channel === "input" && this.handler) {
            const payload = wire.payload as { text: string };
            if (payload.text?.trim()) {
              this.handler(payload.text.trim());
            }
          }
        } catch (err) {
          log.warn("Invalid WebSocket message", { error: String(err) });
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        log.info("WebSocket client disconnected", { clients: this.clients.size });
      });

      ws.on("error", (err) => {
        log.warn("WebSocket error", { error: String(err) });
        this.clients.delete(ws);
      });
    });
  }

  sendMessage(msg: ConversationMessage): void {
    if (this.closed) return;
    const wire: WireMessage = { channel: "message", payload: msg };
    this.buffer(wire);
    this.broadcast(wire);
  }

  sendNarration(item: NarrationItem): void {
    if (this.closed) return;
    const wire: WireMessage = { channel: "narration", payload: item };
    this.buffer(wire);
    this.broadcast(wire);
  }

  sendStatus(status: SystemStatus): void {
    if (this.closed) return;
    const wire: WireMessage = { channel: "status", payload: status };
    // Status doesn't need replay buffering — just send latest
    this.broadcast(wire);
  }

  sendPlan(plan: PlanSnapshot): void {
    if (this.closed) return;
    const wire: WireMessage = { channel: "plan", payload: plan };
    if (plan.kind === "full") {
      // Full snapshots replace any buffered plan messages
      this.replayBuffer = this.replayBuffer.filter((w) => w.channel !== "plan");
    }
    this.buffer(wire);
    this.broadcast(wire);
  }

  sendArtifact(artifact: ArtifactItem): void {
    if (this.closed) return;
    const wire: WireMessage = { channel: "artifact", payload: artifact };
    this.buffer(wire);
    this.broadcast(wire);
  }

  onReceive(handler: (text: string) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    this.wss.close();
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  // ─── Internal ──────────────────────────────────────────────

  private broadcast(wire: WireMessage): void {
    const data = JSON.stringify(wire);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  private buffer(wire: WireMessage): void {
    this.replayBuffer.push(wire);
    if (this.replayBuffer.length > this.maxReplay) {
      this.replayBuffer.shift();
    }
  }
}
