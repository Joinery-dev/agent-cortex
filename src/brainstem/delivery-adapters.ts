/**
 * Escalation Delivery Adapters — transport layer for Parsifal escalations.
 *
 * The EscalationHandler produces rich briefings. These adapters decide
 * HOW to get them to the Parsifal and return the response.
 *
 * EventBusDeliveryAdapter: passive — the event bus already emits
 *   "escalation:created", external code (dashboard, CLI) picks it up
 *   and calls EscalationHandler.resolve() when the Parsifal answers.
 *
 * AgentSdkDeliveryAdapter: active — calls an askUser callback (typically
 *   wired to the Agent SDK's AskUserQuestion tool) and auto-resolves.
 */

import type {
  Escalation,
  EscalationResolution,
  EscalationDeliveryAdapter,
} from "../types/brainstem.js";
import type { EscalationBriefing } from "../types/thalamus.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("delivery-adapter");

// ── Formatter ────────────────────────────────────────────────────
// Pure function: EscalationBriefing → human-readable string.

export function formatEscalationForParsifal(
  escalation: Escalation,
  briefing: EscalationBriefing,
): string {
  const sections: string[] = [];

  // Header with severity
  const severityLabel = escalation.severity.toUpperCase();
  sections.push(`[${severityLabel}] ${escalation.summary}`);

  // Detail
  sections.push(escalation.detail);

  // Question (if any)
  if (escalation.question) {
    sections.push(`Question: ${escalation.question}`);
  }

  // Proposed actions (if any)
  if (escalation.proposedActions && escalation.proposedActions.length > 0) {
    sections.push(
      "Proposed actions:\n" +
      escalation.proposedActions.map((a, i) => `  ${i + 1}. ${a}`).join("\n"),
    );
  }

  // Project context
  const snap = briefing.projectSnapshot;
  const progress = `${snap.completedTasks}/${snap.totalTasks} tasks complete`;
  sections.push(`Context: ${snap.intentSummary} (${progress})`);

  // Open questions
  if (snap.openQuestions.length > 0) {
    sections.push(
      "Open questions:\n" +
      snap.openQuestions.map((q) => `  - ${q.question}`).join("\n"),
    );
  }

  // Rhythm context
  const rc = briefing.rhythmContext;
  sections.push(
    `System state: ${rc.rhythmType} rhythm, phase ${rc.phase}, cycle ${rc.cycle}` +
    (rc.parentRhythmType ? ` (parent: ${rc.parentRhythmType})` : ""),
  );

  return sections.join("\n\n");
}

// ── Event Bus Adapter (passive / default) ────────────────────────

/**
 * No-op adapter. The escalation event was already emitted by the
 * EscalationHandler. Resolution arrives via an external resolve() call
 * (dashboard, CLI, webhook listener, etc.).
 */
export class EventBusDeliveryAdapter implements EscalationDeliveryAdapter {
  async deliver(
    _escalation: Escalation,
    _briefing: EscalationBriefing,
  ): Promise<EscalationResolution | null> {
    // Passive: external code listens to "escalation:created" event
    // and calls EscalationHandler.resolve() when the Parsifal answers.
    return null;
  }
}

// ── Agent SDK Adapter (active / headless) ────────────────────────

/**
 * Active adapter that delivers escalations through a callback — typically
 * wired to the Agent SDK's AskUserQuestion tool. Formats the briefing
 * into a readable message, calls askUser, and returns the resolution.
 */
export class AgentSdkDeliveryAdapter implements EscalationDeliveryAdapter {
  private askUser: (question: string) => Promise<string>;

  constructor(askUser: (question: string) => Promise<string>) {
    this.askUser = askUser;
  }

  async deliver(
    escalation: Escalation,
    briefing: EscalationBriefing,
  ): Promise<EscalationResolution> {
    const message = formatEscalationForParsifal(escalation, briefing);

    log.info("Delivering escalation to Parsifal via SDK", {
      escalationId: escalation.id,
      severity: escalation.severity,
    });

    const answer = await this.askUser(message);

    return {
      answer,
      resolvedAt: new Date(),
    };
  }
}
