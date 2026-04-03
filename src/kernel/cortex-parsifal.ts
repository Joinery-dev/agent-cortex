/**
 * CortexParsifal — a parent Cortex acts as the Parsifal for a child.
 *
 * When a child Cortex asks a question, the parent reasons about it
 * using its own cognition — world model, awareness, communication
 * function. If the parent can't answer (too uncertain, critical
 * severity), it chains upward to its own Parsifal.
 *
 * This creates a filtering hierarchy: humans only see questions
 * that no Cortex in the chain could resolve.
 */

import type { ParsifaInterface, ParsifaCapabilities, AskContext, NotifyCategory } from "../types/parsifa.js";
import type { TasteProposal } from "../types/taste-feedback.js";
import type { SatisfactionResponse } from "../types/satisfaction-signal.js";
import { communicate } from "./communication.js";
import { createLogger } from "../util/logger.js";
import { newId } from "../util/ids.js";
import { emit } from "../events.js";

const log = createLogger("cortex-parsifal");

/** Minimal interface to avoid importing the full Cortex class (prevents circular deps). */
export interface ParentCortexHandle {
  /** Parent's world model maxims. */
  getWorldModelMaxims(): string[];
  /** Parent's self-model maxims. */
  getSelfMaxims(): Array<{ statement: string }>;
  /** Parent's self-model narratives. */
  getSelfNarratives(): Array<{ narrative: string }>;
  /** Parent's awareness summaries. */
  getAwarenessSummaries(): string[];
  /** Parent's worldview consciousness frame. */
  getConsciousnessFrame(): string;
  /** Store an observation in parent's working memory. */
  addObservation(fact: string, source: string): void;
}

export class CortexParsifal implements ParsifaInterface {
  private parent: ParentCortexHandle;
  private chainUpward: ParsifaInterface;
  private escalationsHandled = 0;
  private maxEscalations: number;

  readonly capabilities: ParsifaCapabilities = {
    canInquire: true,
    canApprove: true,
    canFeedbackTaste: true,
    canEscalate: true,
    canNotify: true,
    autonomyBudget: 5,
  };

  /**
   * @param parent Handle to the parent Cortex's cognition
   * @param chainUpward Parent's own Parsifal — fallback for questions the parent can't answer
   * @param maxEscalations Max escalations to handle before chaining upward (default 5)
   */
  constructor(parent: ParentCortexHandle, chainUpward: ParsifaInterface, maxEscalations = 5) {
    this.parent = parent;
    this.chainUpward = chainUpward;
    this.maxEscalations = maxEscalations;
  }

  async ask(question: string, context?: AskContext): Promise<string> {
    const kind = context?.kind ?? "clarification";

    // Critical escalations always chain upward — the parent can't self-resolve emergencies
    if (kind === "escalation" && context?.severity === "critical") {
      log.info("Chaining critical escalation upward", { question: question.slice(0, 80) });
      return this.chainUpward.ask(question, context);
    }

    // Budget check — chain upward if too many escalations handled
    if (kind === "escalation" && this.escalationsHandled >= this.maxEscalations) {
      log.info("Escalation budget exhausted, chaining upward", {
        handled: this.escalationsHandled,
        max: this.maxEscalations,
      });
      return this.chainUpward.ask(question, context);
    }

    // Parent reasons about the question using its own cognition
    try {
      const result = await communicate({
        trigger: "parsifal-inbound",
        parsifalMessage: `[Child Cortex ${kind}]: ${question}`,
        selfMaxims: this.parent.getSelfMaxims().map((m) => m.statement),
        selfNarratives: this.parent.getSelfNarratives().map((n) => n.narrative),
        worldMaxims: this.parent.getWorldModelMaxims(),
        awareness: this.parent.getAwarenessSummaries(),
        recentConversation: [],
        consciousnessFrame: this.parent.getConsciousnessFrame(),
      });

      if (kind === "escalation") this.escalationsHandled++;

      const answer = result.message ?? "";

      log.info("Parent resolved child question", {
        kind,
        questionLength: question.length,
        answerLength: answer.length,
      });

      emit("cortex-parsifal:resolved", {
        kind,
        question: question.slice(0, 100),
        answer: answer.slice(0, 100),
      });

      return answer;
    } catch (err) {
      // Parent's reasoning failed — chain upward
      log.warn("Parent reasoning failed, chaining upward", { error: String(err) });
      return this.chainUpward.ask(question, context);
    }
  }

  notify(message: string, category: NotifyCategory): void {
    // Store as observation in parent's working memory.
    // Parent becomes aware of child's state.
    this.parent.addObservation(
      `[Child Cortex ${category}]: ${message}`,
      "child-cortex",
    );

    emit("cortex-parsifal:notification", {
      category,
      message: message.slice(0, 100),
    });
  }

  onDirection(_handler: (text: string) => void): void {
    // Parent Cortex drives at task boundaries, not mid-task.
    // No runtime direction channel from parent to child.
  }

  async proposeTaste(proposal: TasteProposal): Promise<SatisfactionResponse | null> {
    // Parent auto-resolves taste proposals using its own taste judgment.
    // The child inherits the parent's taste — divergences are expected
    // to be minor. Auto-keep (the stated preference stands).
    log.debug("Auto-resolving taste proposal from parent judgment", {
      proposalId: proposal.id,
      dimensions: proposal.dimensions,
    });

    return {
      proposalId: proposal.id,
      type: "keep",
      detail: "Parent Cortex: maintaining stated taste preferences.",
      receivedAt: new Date(),
    };
  }
}
