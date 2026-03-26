/**
 * Amygdala — priority override.
 *
 * Three responsibilities:
 *   1. Detector registry — fast, synchronous threat detectors that scan
 *      motor cortex intentions before PNS execution.
 *   2. Alarm receiver — other components raise alarms when they detect
 *      asymmetric-risk situations in their own domain.
 *   3. Response protocol — how to stop the system safely.
 *
 * The amygdala doesn't learn. It gets updated. The hippocampus
 * crystallizes episodes into principles; those get installed as
 * new detectors via registerDetector().
 *
 * Follows the Cerebellum pattern: stateful class, private fields,
 * event emission, serializable snapshot.
 */

import type {
  ThreatDetector,
  DetectedThreat,
  Alarm,
  ThreatAssessment,
  ResponseAction,
  ResponseProtocolResult,
  ResponseDeps,
  AmygdalaConfig,
  AmygdalaState,
} from "../types/amygdala.js";
import type { Intention } from "../types/pns.js";
import { DEFAULT_AMYGDALA_CONFIG } from "../types/amygdala.js";
import {
  createBuiltInDetectors,
  computeResponseLevel,
  identifyBlockedIntentions,
} from "./detectors.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";
import { newId } from "../util/ids.js";

const log = createLogger("amygdala");

export class Amygdala {
  private detectors: Map<string, ThreatDetector> = new Map();
  private assessments: ThreatAssessment[] = [];
  private config: AmygdalaConfig;

  constructor(config?: Partial<AmygdalaConfig>) {
    this.config = { ...DEFAULT_AMYGDALA_CONFIG, ...config };

    // Register built-in detectors
    for (const detector of createBuiltInDetectors()) {
      this.detectors.set(detector.id, detector);
    }
    log.info("Amygdala initialized", {
      detectors: this.detectors.size,
      preActionGate: this.config.preActionGateEnabled,
      alarmReceiver: this.config.alarmReceiverEnabled,
    });
  }

  // ── Detector Registry ──────────────────────────────────────────

  /** Register a threat detector. Replaces if same ID exists. */
  registerDetector(detector: ThreatDetector): void {
    const replacing = this.detectors.has(detector.id);
    this.detectors.set(detector.id, detector);
    emit("amygdala:detector-registered", {
      id: detector.id,
      name: detector.name,
      origin: detector.origin,
      replacing,
    });
    log.debug("Detector registered", {
      id: detector.id,
      origin: detector.origin,
      replacing,
    });
  }

  /** Remove a detector by ID. Returns true if it existed. */
  removeDetector(id: string): boolean {
    const existed = this.detectors.delete(id);
    if (existed) {
      emit("amygdala:detector-removed", { id });
      log.debug("Detector removed", { id });
    }
    return existed;
  }

  /** Get all registered detectors. */
  getDetectors(): ThreatDetector[] {
    return [...this.detectors.values()];
  }

  /** Get detectors by origin (for observability). */
  getDetectorsByOrigin(origin: "built-in" | "hippocampus"): ThreatDetector[] {
    return [...this.detectors.values()].filter((d) => d.origin === origin);
  }

  // ── Pre-Action Gate ────────────────────────────────────────────

  /**
   * Scan intentions for threats. Returns assessment with threats
   * found and blocked intention IDs, or null if clean.
   *
   * Called AFTER motor cortex produces intentions, BEFORE PNS executes.
   * Must be fast: synchronous pattern matching in each detector.
   *
   * @param urgencyThreshold - From plasticity weight amygdala.threshold.urgency.
   *   Modulates response aggressiveness, not detection sensitivity.
   */
  scanIntentions(
    intentions: Intention[],
    urgencyThreshold: number,
  ): ThreatAssessment | null {
    if (!this.config.preActionGateEnabled) {
      return null;
    }
    if (intentions.length === 0) {
      return null;
    }

    // Run every detector against the intentions
    const allThreats: DetectedThreat[] = [];
    for (const detector of this.detectors.values()) {
      const threats = detector.scan(intentions);
      allThreats.push(...threats);
    }

    if (allThreats.length === 0) {
      return null;
    }

    // Compute response level modulated by plasticity
    const { responseLevel, effectiveSeverity } = computeResponseLevel(
      allThreats,
      urgencyThreshold,
    );
    const blockedIntentionIds = identifyBlockedIntentions(allThreats);

    const assessment: ThreatAssessment = {
      id: newId(),
      trigger: "pre-action-gate",
      threats: allThreats,
      effectiveSeverity,
      responseLevel,
      blockedIntentionIds,
      assessedAt: new Date(),
    };

    this.recordAssessment(assessment);

    emit("amygdala:threat-detected", {
      assessmentId: assessment.id,
      threatCount: allThreats.length,
      blockedCount: blockedIntentionIds.length,
      effectiveSeverity,
      responseLevel,
    });

    log.warn("Threats detected in intentions", {
      threatCount: allThreats.length,
      blockedIntentionIds,
      effectiveSeverity,
      responseLevel,
    });

    return assessment;
  }

  // ── Alarm Receiver ─────────────────────────────────────────────

  /**
   * Receive an alarm from another component.
   * The amygdala trusts the source's domain expertise and
   * executes the response protocol.
   */
  receiveAlarm(alarm: Alarm): ThreatAssessment {
    if (!this.config.alarmReceiverEnabled) {
      log.warn("Alarm received but receiver disabled", {
        source: alarm.source,
      });
    }

    const assessment: ThreatAssessment = {
      id: newId(),
      trigger: "alarm",
      threats: [],
      alarm,
      effectiveSeverity: alarm.severity,
      responseLevel: alarm.severity === "emergency" ? 1.0 : 0.75,
      blockedIntentionIds: [],
      assessedAt: new Date(),
    };

    this.recordAssessment(assessment);

    emit("amygdala:alarm-received", {
      assessmentId: assessment.id,
      source: alarm.source,
      severity: alarm.severity,
      description: alarm.description,
    });

    log.warn("Alarm received", {
      source: alarm.source,
      severity: alarm.severity,
      description: alarm.description,
    });

    return assessment;
  }

  // ── Human Escalation ───────────────────────────────────────────

  /**
   * Human directly escalated. Always fires at maximum severity.
   *
   * This is both an alarm AND the most important training signal.
   * Every human escalation is a false negative — the amygdala
   * should have caught it but didn't. The hippocampus learns from
   * the episode; the result is a new detector installed later.
   */
  receiveHumanEscalation(
    description: string,
    context: Record<string, unknown>,
  ): ThreatAssessment {
    const assessment: ThreatAssessment = {
      id: newId(),
      trigger: "human-escalation",
      threats: [
        {
          detectorId: "human",
          intentionId: "n/a",
          description,
          signalStrength: 1.0,
          category: "human-escalation",
        },
      ],
      effectiveSeverity: "emergency",
      responseLevel: 1.0,
      blockedIntentionIds: [],
      assessedAt: new Date(),
    };

    this.recordAssessment(assessment);

    emit("amygdala:human-escalation", {
      assessmentId: assessment.id,
      description,
      context,
    });

    log.warn("Human escalation received", { description });

    return assessment;
  }

  // ── Response Protocol ──────────────────────────────────────────

  /**
   * Execute the full response protocol for a threat assessment.
   *
   * Sequence matters — minimize damage before doing anything else:
   *   1. Block intentions (prevent the dangerous action)
   *   2. Interrupt runner (stop future work)
   *   3. Override NE (make the system pay full attention)
   *   4. Inhibit compromised senses (if applicable)
   *   5. Add open question (escalate to human for deliberate response)
   */
  executeResponse(
    assessment: ThreatAssessment,
    deps: ResponseDeps,
  ): ResponseProtocolResult {
    const start = Date.now();
    const actions: ResponseAction[] = [];

    // 1. Block intentions (for pre-action gate assessments)
    if (assessment.blockedIntentionIds.length > 0) {
      actions.push({
        kind: "block-intentions",
        intentionIds: assessment.blockedIntentionIds,
      });
    }

    // 2. Interrupt active rhythms (hard interrupt for emergency)
    if (assessment.effectiveSeverity === "emergency") {
      const rhythmId = assessment.alarm?.rhythmId ?? deps.activeRhythmIds[0];
      if (rhythmId) {
        deps.runner.interrupt(rhythmId, {
          mode: "hard",
          source: "amygdala",
          reason: this.formatReason(assessment),
          context: { assessmentId: assessment.id },
        });
        actions.push({
          kind: "interrupt-rhythm",
          rhythmId,
          mode: "hard",
        });
      }
    }

    // 3. Override NE (signal is read by NE computation at next gate)
    actions.push({ kind: "override-ne" });

    // 4. Add open question for human (the PFC plans the response)
    const questionText = this.formatQuestion(assessment);
    deps.wm.addQuestion(questionText, `Amygdala assessment ${assessment.id}`);
    actions.push({
      kind: "add-open-question",
      question: questionText,
      context: `Amygdala assessment ${assessment.id}`,
    });

    const duration = Date.now() - start;
    const result: ResponseProtocolResult = {
      assessment,
      actions,
      duration,
    };

    emit("amygdala:response-executed", {
      assessmentId: assessment.id,
      actionCount: actions.length,
      effectiveSeverity: assessment.effectiveSeverity,
      duration,
    });

    log.warn("Response protocol executed", {
      assessmentId: assessment.id,
      actions: actions.map((a) => a.kind),
      duration,
    });

    return result;
  }

  // ── State ──────────────────────────────────────────────────────

  getState(): AmygdalaState {
    const detectors = [...this.detectors.values()];
    return {
      detectorCount: detectors.length,
      builtInDetectors: detectors.filter((d) => d.origin === "built-in").length,
      learnedDetectors: detectors.filter((d) => d.origin === "hippocampus")
        .length,
      assessments: [...this.assessments],
      lastAssessment: this.assessments.length > 0
        ? this.assessments[this.assessments.length - 1]
        : null,
    };
  }

  // ── Internal ───────────────────────────────────────────────────

  private recordAssessment(assessment: ThreatAssessment): void {
    this.assessments.push(assessment);
    // Prune if over max
    if (this.assessments.length > this.config.maxAssessmentHistory) {
      this.assessments = this.assessments.slice(-this.config.maxAssessmentHistory);
    }
  }

  private formatReason(assessment: ThreatAssessment): string {
    if (assessment.trigger === "human-escalation") {
      return `Human escalation: ${assessment.threats[0]?.description ?? "urgent"}`;
    }
    if (assessment.trigger === "alarm" && assessment.alarm) {
      return `Alarm from ${assessment.alarm.source}: ${assessment.alarm.description}`;
    }
    const categories = [
      ...new Set(assessment.threats.map((t) => t.category)),
    ];
    return `Threat detected: ${categories.join(", ")} (${assessment.threats.length} threats)`;
  }

  private formatQuestion(assessment: ThreatAssessment): string {
    if (assessment.trigger === "human-escalation") {
      return `Human escalated: ${assessment.threats[0]?.description ?? "urgent issue"}. How should we proceed?`;
    }
    if (assessment.trigger === "alarm" && assessment.alarm) {
      return `${assessment.alarm.source} raised alarm: ${assessment.alarm.description}. How should we proceed?`;
    }
    const descriptions = assessment.threats
      .slice(0, 3)
      .map((t) => t.description);
    return `Threats detected: ${descriptions.join("; ")}. How should we proceed?`;
  }
}
