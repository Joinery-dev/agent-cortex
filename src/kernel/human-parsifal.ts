/**
 * HumanParsifal — wraps the existing ConversationCortex + transport
 * infrastructure behind the ParsifaInterface contract.
 *
 * This is the current behavior, factored into the interface:
 *   ask()         → ConversationCortex.askUser()
 *   notify()      → broadcast via transports
 *   onDirection() → wires to ConversationCortex.receive()
 *
 * All capabilities enabled — a human can do everything.
 */

import type { ParsifaInterface, ParsifaCapabilities, AskContext, NotifyCategory } from "../types/parsifa.js";
import type { ConversationCortex } from "./conversation-cortex.js";
import type { ConversationTransport } from "../types/conversation.js";
import type { TasteProposal } from "../types/taste-feedback.js";
import type { SatisfactionResponse } from "../types/satisfaction-signal.js";

export class HumanParsifal implements ParsifaInterface {
  private conversationCortex: ConversationCortex;

  readonly capabilities: ParsifaCapabilities = {
    canInquire: true,
    canApprove: true,
    canFeedbackTaste: true,
    canEscalate: true,
    canNotify: true,
  };

  constructor(
    conversationCortex: ConversationCortex,
    transports?: ConversationTransport[],
  ) {
    this.conversationCortex = conversationCortex;

    if (transports) {
      for (const t of transports) {
        this.conversationCortex.addTransport(t);
      }
    }

    this.conversationCortex.activate();
  }

  async ask(question: string, _context?: AskContext): Promise<string> {
    return this.conversationCortex.askUser(question);
  }

  notify(message: string, _category: NotifyCategory): void {
    // Broadcast as a proactive message through the conversation cortex.
    // The transport layer handles display.
    this.conversationCortex.broadcastProactive(message);
  }

  onDirection(handler: (text: string) => void): void {
    // The ConversationCortex already routes inbound messages through
    // receive(). We register an additional handler for direction that
    // flows outside the normal receive path (e.g., programmatic input).
    this.conversationCortex.onExternalDirection(handler);
  }

  async proposeTaste(proposal: TasteProposal): Promise<SatisfactionResponse | null> {
    // Format the proposal as a question and ask the human.
    // Parse structured response from their answer.
    const question = `I've noticed a taste divergence on ${proposal.dimensions.join(", ")}:\n\n${proposal.interpretation}\n\nHow would you like to respond? (update / keep / nuanced / defer)`;
    const answer = await this.conversationCortex.askUser(question);

    const normalized = answer.trim().toLowerCase();
    if (normalized.startsWith("update")) {
      return { proposalId: proposal.id, type: "update", detail: answer, receivedAt: new Date() };
    }
    if (normalized.startsWith("keep")) {
      return { proposalId: proposal.id, type: "keep", detail: answer, receivedAt: new Date() };
    }
    if (normalized.startsWith("nuanced") || normalized.startsWith("nuance")) {
      return { proposalId: proposal.id, type: "nuanced", detail: answer, newPreference: answer, receivedAt: new Date() };
    }
    // Default: defer
    return { proposalId: proposal.id, type: "deferred", detail: answer, receivedAt: new Date() };
  }
}
