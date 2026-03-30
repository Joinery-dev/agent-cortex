/**
 * Replay Interceptor — serves cached LLM responses for fast replay.
 *
 * When "Resume From Here" is clicked, Cortex re-runs from the beginning
 * using cached responses (no real API calls) up to the selected point,
 * then switches to live calls. This lets the Parsifal make code changes and
 * see how they affect behavior without re-running expensive LLM calls.
 *
 * Cache key: hash of (purpose, systemPrompt, userMessage).
 * Same key can have multiple responses (FIFO queue) for calls that
 * repeat with identical prompts across cycles.
 */

import { createHash } from "node:crypto";
import type { ContentStore } from "../trace/content-store.js";
import type { ContentEntry } from "../trace/types.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("replay-interceptor");

// ─── Types ──────────────────────────────────────────────────────

export interface CachedResponse {
  /** The response text. */
  text: string;
  /** Token usage from the original call. */
  tokens: { input: number; output: number };
  /** Model used. */
  model: string;
  /** Cost of the original call (replay costs $0). */
  originalCost: number;
  /** Content entry ID this came from. */
  contentId: number;
  /** Whether this was an agentic call. */
  agentic: boolean;
  /** Tool trace text (agentic calls only). */
  toolTraceText?: string;
}

export type ReplayMode = "live" | "replay" | "replay-strict";

interface ReplayCache {
  /** Queued responses per cache key. FIFO — shift() to consume. */
  responses: Map<string, CachedResponse[]>;
  /** How many responses have been served from cache. */
  served: number;
  /** Total responses in the cache. */
  total: number;
  /** Content ID we're replaying up to. */
  upToContentId: number | null;
}

// ─── Hash ───────────────────────────────────────────────────────

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function cacheKey(purpose: string, systemPrompt: string, userMessage: string): string {
  return `${purpose}:${hashText(systemPrompt)}:${hashText(userMessage)}`;
}

// ─── Cache builder ──────────────────────────────────────────────

/**
 * Build a replay cache from content store entries.
 * @param store The content store to read from.
 * @param upToContentId Only include entries with id <= this value. Null = all.
 */
export function buildReplayCache(
  store: ContentStore,
  upToContentId: number | null = null,
): ReplayCache {
  const responses = new Map<string, CachedResponse[]>();
  let total = 0;

  const llmEntries = store.getByKind("llm-call");

  for (const entry of llmEntries) {
    // Skip entries beyond the replay point
    if (upToContentId !== null && entry.id > upToContentId) continue;

    // Extract prompt components
    const systemBlock = entry.inputs.find((b) => b.label === "System prompt");
    const userBlock = entry.inputs.find((b) => b.label === "User message");
    const responseBlock = entry.outputs.find((b) => b.label === "LLM response");
    const toolTraceBlock = entry.outputs.find((b) => b.label === "Tool trace");

    if (!systemBlock || !userBlock || !responseBlock) continue;
    if (!entry.purpose) continue;

    const key = cacheKey(entry.purpose, systemBlock.text, userBlock.text);

    const cached: CachedResponse = {
      text: responseBlock.text,
      tokens: entry.tokens ?? { input: 0, output: 0 },
      model: entry.model ?? "sonnet",
      originalCost: entry.costDollars ?? 0,
      contentId: entry.id,
      agentic: !!toolTraceBlock,
      toolTraceText: toolTraceBlock?.text,
    };

    let queue = responses.get(key);
    if (!queue) {
      queue = [];
      responses.set(key, queue);
    }
    queue.push(cached);
    total++;
  }

  log.info("Replay cache built", {
    entries: total,
    uniqueKeys: responses.size,
    upToContentId,
  });

  return { responses, served: 0, total, upToContentId };
}

// ─── Interceptor state ──────────────────────────────────────────

let mode: ReplayMode = "live";
let cache: ReplayCache | null = null;

/** Check the interceptor for a cached response. Returns null to fall through to real LLM. */
export function checkReplayInterceptor(
  purpose: string,
  systemPrompt: string,
  userMessage: string,
): CachedResponse | null {
  if (mode === "live" || !cache) return null;

  const key = cacheKey(purpose, systemPrompt, userMessage);
  const queue = cache.responses.get(key);

  if (!queue || queue.length === 0) {
    if (mode === "replay-strict") {
      throw new Error(`Replay-strict: no cached response for ${purpose} (key: ${key})`);
    }
    // replay mode: cache miss → fall through to real LLM
    log.info("Cache miss — falling through to live LLM", { purpose, key: key.slice(0, 40) });
    return null;
  }

  // Consume the next response in the queue (FIFO)
  const cached = queue.shift()!;
  cache.served++;

  log.debug("Serving cached response", {
    purpose,
    contentId: cached.contentId,
    served: cache.served,
    remaining: cache.total - cache.served,
  });

  // If we've served everything up to the replay point, switch to live
  if (cache.upToContentId !== null && cache.served >= cache.total) {
    log.info("Replay complete — switching to live mode", {
      served: cache.served,
      total: cache.total,
    });
    mode = "live";
  }

  return cached;
}

// ─── Mode control ───────────────────────────────────────────────

/** Set the replay mode and cache. */
export function enableReplay(replayCache: ReplayCache, replayMode: ReplayMode = "replay"): void {
  cache = replayCache;
  mode = replayMode;
  log.info("Replay interceptor enabled", {
    mode,
    cacheEntries: replayCache.total,
    upTo: replayCache.upToContentId,
  });
}

/** Switch back to live mode. */
export function disableReplay(): void {
  mode = "live";
  cache = null;
}

/** Get current replay state. */
export function getReplayState(): {
  mode: ReplayMode;
  served: number;
  total: number;
  remaining: number;
} {
  return {
    mode,
    served: cache?.served ?? 0,
    total: cache?.total ?? 0,
    remaining: cache ? cache.total - cache.served : 0,
  };
}
