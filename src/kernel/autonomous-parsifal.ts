/**
 * AutonomousParsifal — no external entity. Bounded self-resolution.
 *
 * For headless/autonomous operation where no human or parent Cortex
 * is available. Inquiry is skipped, approval is auto-granted,
 * escalations self-resolve up to a budget, taste feedback defers.
 *
 * When the autonomy budget is exhausted, ask() throws — the caller
 * must handle this as "cannot continue without external help."
 */

import type { ParsifaInterface, ParsifaCapabilities, AskContext, NotifyCategory } from "../types/parsifa.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("autonomous-parsifal");

export class AutonomousParsifal implements ParsifaInterface {
  private escalationsResolved = 0;
  private budget: number;

  readonly capabilities: ParsifaCapabilities;

  /**
   * @param autonomyBudget Max escalations to self-resolve before failing.
   *   Default 3. Set to Infinity for fully autonomous (never fails on escalation).
   */
  constructor(autonomyBudget = 3) {
    this.budget = autonomyBudget;
    this.capabilities = {
      canInquire: false,
      canApprove: true,
      canFeedbackTaste: false,
      canEscalate: autonomyBudget > 0,
      canNotify: false,
      autonomyBudget,
    };
  }

  async ask(question: string, context?: AskContext): Promise<string> {
    const kind = context?.kind ?? "clarification";

    switch (kind) {
      case "inquiry":
        // Skip inquiry — use intent as-is
        log.debug("Autonomous: skipping inquiry", { question: question.slice(0, 80) });
        return "";

      case "approval":
        // Auto-approve — trust the system's own vision synthesis
        log.debug("Autonomous: auto-approving", { question: question.slice(0, 80) });
        return "approved";

      case "escalation": {
        if (this.escalationsResolved >= this.budget) {
          log.warn("Autonomous: autonomy budget exhausted", {
            budget: this.budget,
            resolved: this.escalationsResolved,
            question: question.slice(0, 80),
          });
          throw new Error(
            `Autonomous Parsifal budget exhausted (${this.budget} escalations). ` +
            `Cannot resolve: ${question.slice(0, 200)}`,
          );
        }
        this.escalationsResolved++;
        const severity = context?.severity ?? "medium";
        log.info("Autonomous: self-resolving escalation", {
          severity,
          resolved: this.escalationsResolved,
          budget: this.budget,
        });
        // Return a generic "proceed with best judgment" resolution
        return "Proceed with your best judgment. If the approach isn't working, try a simpler alternative.";
      }

      case "clarification":
      default:
        // Can't clarify — return empty to signal no input
        log.debug("Autonomous: no clarification available", { question: question.slice(0, 80) });
        return "";
    }
  }

  notify(message: string, category: NotifyCategory): void {
    // Log but don't display — no one to show it to
    log.debug("Autonomous: notification", { category, message: message.slice(0, 100) });
  }

  onDirection(_handler: (text: string) => void): void {
    // No-op — no external entity to send direction
  }

  /** Reset the escalation counter (e.g., between projects). */
  resetBudget(): void {
    this.escalationsResolved = 0;
  }
}
