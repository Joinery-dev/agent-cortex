/**
 * Web Boot — full boot sequence triggered from the webapp.
 *
 * Mirrors the boot() flow in examples/run-cortex.ts but uses
 * the WebSocket transport for user interaction instead of terminal
 * readline. The sequence:
 *
 *   1. Worldview selection (interactive, via WebSocket chat)
 *   2. Taste setup (interactive, via WebSocket chat)
 *   3. Boot Claus (consciousness agent, greets the Parsifal)
 *   4. Create Cortex with everything wired
 *   5. Ask for project prompt via conversation cortex
 *   6. Run the project
 */

import type { WebSocketTransport } from "../conversation/websocket-transport.js";
import type { ConversationMessage } from "../types/conversation.js";
import type { ProjectIntent } from "../types/intent.js";
import { setupWorldview } from "../worldview/generator.js";
import { setupTaste } from "../taste/setup.js";
import { Claus } from "../conversation/claus.js";
import { Cortex } from "../index.js";
import { registerCortex } from "./state-registry.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("web-boot");

type AskUserFn = (question: string) => Promise<string>;

/**
 * Create an askUser function that routes questions and responses
 * through the WebSocket transport. Queue-based: each question
 * waits for exactly one response, in order.
 *
 * This handler is active only during boot (before conversation
 * cortex takes over the transport's onReceive).
 */
function createWsAskUser(ws: WebSocketTransport): AskUserFn {
  const pending: Array<(text: string) => void> = [];

  ws.onReceive((text: string) => {
    // Echo back as parsifal message so it appears in the conversation feed
    ws.sendMessage({
      id: "parsifal-" + Date.now(),
      role: "parsifal",
      kind: "message",
      text,
      timestamp: new Date(),
    } as ConversationMessage);

    const resolver = pending.shift();
    if (resolver) resolver(text);
  });

  return (question: string): Promise<string> => {
    ws.sendMessage({
      id: "setup-" + Date.now(),
      role: "cortex",
      kind: "question",
      text: question,
      timestamp: new Date(),
    } as ConversationMessage);

    return new Promise<string>((resolve) => {
      pending.push(resolve);
    });
  };
}

/**
 * Boot Cortex from the webapp — full interactive sequence.
 *
 * Called from /api/run-project. Runs asynchronously; the HTTP
 * response returns immediately. All interaction happens over WebSocket.
 */
export async function bootFromWeb(ws: WebSocketTransport): Promise<void> {
  const askUser = createWsAskUser(ws);

  // ── 1. Worldview selection ───────────────────────────────────
  log.info("Starting worldview selection");
  const worldview = await setupWorldview(askUser, { model: "opus" });
  log.info("Worldview selected", { name: worldview.name });

  // ── 2. Taste setup ───────────────────────────────────────────
  log.info("Starting taste setup");
  const taste = await setupTaste(askUser);
  log.info("Taste configured", { name: taste.name });

  // ── 3. Boot Claus + Cortex ────────────────────────────────────
  // Create Claus and Cortex together. The conversation cortex wires
  // the WebSocket transport and activates Claus hooks.
  // No separate greeting — Claus introduces itself through the
  // askUser reformulation (single message, no duplicates).
  log.info("Booting Claus + Cortex");
  const claus = new Claus({
    transports: [ws],
    worldview,
  });

  const intent: ProjectIntent = {
    id: `web-${Date.now()}`,
    summary: "",
    audience: "",
    vision: "",
    successCriteria: [],
    constraints: [],
    keyDecisions: [],
    driftLog: [],
  };

  const cortex = new Cortex({
    intent,
    taste,
    worldview,
    claus,
    logLevel: "warn",
    conversationTransports: [ws],
  });
  registerCortex(cortex);
  log.info("Cortex booted and registered");

  // ── 4. Ask for project prompt ────────────────────────────────
  // Claus reformulates this into its worldview voice — serves as
  // both greeting and prompt in a single message.
  const convoCortex = cortex.getBrainstem().getConversationCortex();
  const prompt = await convoCortex.askUser(
    "Introduce yourself briefly, then ask what they'd like to build.",
  );

  // Update intent with the actual prompt
  intent.summary = prompt;
  intent.vision = prompt;
  intent.successCriteria = [`Deliver: ${prompt}`];

  // ── 6. Run the project ───────────────────────────────────────
  log.info("Starting project", { prompt: prompt.slice(0, 100) });
  await cortex.runProject({ tasks: [] });
  log.info("Project complete");
}
