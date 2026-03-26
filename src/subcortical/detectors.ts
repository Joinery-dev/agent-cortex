/**
 * Built-in Threat Detectors — pure functions, no side effects.
 *
 * Each detector scans Intention[] for a specific category of danger.
 * They examine operations, effects, and descriptions via fast pattern
 * matching. No LLM calls — these must be synchronous and fast because
 * they sit in the hot path between motor cortex output and PNS execution.
 *
 * Follows the forward-model.ts pattern: pure computation separated
 * from state management. The Amygdala class delegates to these.
 */

import type { Intention, Operation } from "../types/pns.js";
import type { ThreatDetector, DetectedThreat } from "../types/amygdala.js";

// ─── Patterns ──────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bforce[\s-]?push\b/i,
  /\b--force\b/,
  /\bdrop\s+(?:table|database|schema|index)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b.*\bwhere\b.*(?:1\s*=\s*1|true)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/i,
];

const SECURITY_PATTERNS = [
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /(?:password|secret|api[_-]?key|token|credential)s?\s*[:=]\s*["'][^"']{4,}/i,
  /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/,  // AWS access key
  /disable[d_-]?\s*(?:auth|authentication|security|csrf|cors)/i,
  /\bcors\s*[:=].*\*|Access-Control-Allow-Origin.*\*/i,
  /innerHTML\s*=|\.html\s*\(/i,
];

// ─── Detector Factories ────────────────────────────────────────

/**
 * Create all built-in threat detectors.
 * Called once at Amygdala construction.
 */
export function createBuiltInDetectors(): ThreatDetector[] {
  return [
    destructiveOperationDetector(),
    securityAntipatternDetector(),
    dataLossRiskDetector(),
    scopeViolationDetector(),
  ];
}

/**
 * Destructive operations: rm -rf, force push, DROP TABLE,
 * git reset --hard, git clean -f, git branch -D.
 */
export function destructiveOperationDetector(): ThreatDetector {
  return {
    id: "built-in:destructive-operation",
    name: "Destructive Operation Detector",
    origin: "built-in",
    description:
      "Scans for destructive operations: rm -rf, force push, DROP TABLE, " +
      "git reset --hard, and other irreversible commands.",
    scan(intentions: Intention[]): DetectedThreat[] {
      const threats: DetectedThreat[] = [];
      for (const intention of intentions) {
        // Check operations for "remove" effects on high-risk targets
        for (const op of intention.operations) {
          if (
            op.effect.type === "remove" &&
            (op.target.kind === "environment" || op.target.kind === "deployment")
          ) {
            threats.push({
              detectorId: "built-in:destructive-operation",
              intentionId: intention.id,
              description: `Remove effect on ${op.target.kind} target`,
              signalStrength: 0.9,
              category: "destructive-operation",
            });
          }
        }
        // Check description for destructive command patterns
        if (matchesAny(intention.description, DESTRUCTIVE_PATTERNS)) {
          threats.push({
            detectorId: "built-in:destructive-operation",
            intentionId: intention.id,
            description: `Destructive pattern in description: "${truncate(intention.description, 80)}"`,
            signalStrength: 0.85,
            category: "destructive-operation",
          });
        }
        // Check operation content/descriptions for destructive patterns
        for (const op of intention.operations) {
          const text = operationText(op);
          if (text && matchesAny(text, DESTRUCTIVE_PATTERNS)) {
            threats.push({
              detectorId: "built-in:destructive-operation",
              intentionId: intention.id,
              description: `Destructive pattern in operation on ${op.target.kind}`,
              signalStrength: 0.85,
              category: "destructive-operation",
            });
          }
        }
      }
      return threats;
    },
  };
}

/**
 * Security antipatterns: hardcoded credentials, eval(), disabled auth,
 * permissive CORS, innerHTML assignment.
 */
export function securityAntipatternDetector(): ThreatDetector {
  return {
    id: "built-in:security-antipattern",
    name: "Security Antipattern Detector",
    origin: "built-in",
    description:
      "Scans for security antipatterns: hardcoded credentials, eval(), " +
      "disabled authentication, permissive CORS, innerHTML.",
    scan(intentions: Intention[]): DetectedThreat[] {
      const threats: DetectedThreat[] = [];
      for (const intention of intentions) {
        // Check description
        if (matchesAny(intention.description, SECURITY_PATTERNS)) {
          threats.push({
            detectorId: "built-in:security-antipattern",
            intentionId: intention.id,
            description: `Security antipattern in description: "${truncate(intention.description, 80)}"`,
            signalStrength: 0.8,
            category: "security-antipattern",
          });
        }
        // Check create/modify effect content
        for (const op of intention.operations) {
          const text = operationText(op);
          if (text && matchesAny(text, SECURITY_PATTERNS)) {
            threats.push({
              detectorId: "built-in:security-antipattern",
              intentionId: intention.id,
              description: `Security antipattern in ${op.effect.type} effect on ${op.target.kind}`,
              signalStrength: 0.8,
              category: "security-antipattern",
            });
          }
        }
      }
      return threats;
    },
  };
}

/**
 * Data loss risk: "remove" effects on file targets without a
 * preceding "verify" effect in the same intention set.
 */
export function dataLossRiskDetector(): ThreatDetector {
  return {
    id: "built-in:data-loss-risk",
    name: "Data Loss Risk Detector",
    origin: "built-in",
    description:
      "Scans for remove effects on file targets without a preceding " +
      "verify effect in the same intention batch.",
    scan(intentions: Intention[]): DetectedThreat[] {
      const threats: DetectedThreat[] = [];

      // Collect all verify targets across the intention batch
      const verifiedPaths = new Set<string>();
      for (const intention of intentions) {
        for (const op of intention.operations) {
          if (op.effect.type === "verify" && op.target.kind === "file") {
            verifiedPaths.add(op.target.path);
          }
        }
      }

      // Flag remove-on-file that wasn't preceded by verify
      for (const intention of intentions) {
        for (const op of intention.operations) {
          if (op.effect.type === "remove" && op.target.kind === "file") {
            if (!verifiedPaths.has(op.target.path)) {
              threats.push({
                detectorId: "built-in:data-loss-risk",
                intentionId: intention.id,
                description: `File removal without verify: ${op.target.path}`,
                signalStrength: 0.7,
                category: "data-loss-risk",
              });
            }
          }
        }
      }
      return threats;
    },
  };
}

/**
 * Scope violation: operations targeting artifacts outside the task's
 * declared scope. Placeholder — returns empty until scope tracking exists.
 */
export function scopeViolationDetector(): ThreatDetector {
  return {
    id: "built-in:scope-violation",
    name: "Scope Violation Detector",
    origin: "built-in",
    description:
      "Placeholder: will scan for operations outside declared task scope " +
      "when scope tracking is available.",
    scan(_intentions: Intention[]): DetectedThreat[] {
      // No scope tracking yet — always clean
      return [];
    },
  };
}

// ─── Response Level Computation ────────────────────────────────

/**
 * Compute the response level from threats and the plasticity weight.
 *
 * responseLevel = max(signalStrength) * urgencyWeight
 * effectiveSeverity = responseLevel >= 0.7 → "emergency", else "urgent"
 *
 * The plasticity weight modulates the RESPONSE, not detection.
 * Detectors still fire; the system just doesn't panic as hard when mature.
 */
export function computeResponseLevel(
  threats: DetectedThreat[],
  urgencyWeight: number,
): { responseLevel: number; effectiveSeverity: "urgent" | "emergency" } {
  if (threats.length === 0) {
    return { responseLevel: 0, effectiveSeverity: "urgent" };
  }
  const maxSignal = Math.max(...threats.map((t) => t.signalStrength));
  const responseLevel = maxSignal * urgencyWeight;
  const effectiveSeverity = responseLevel >= 0.7 ? "emergency" : "urgent";
  return { responseLevel, effectiveSeverity };
}

/**
 * Deduplicated intention IDs from all threats.
 * An intention is blocked if ANY detector flagged it.
 */
export function identifyBlockedIntentions(threats: DetectedThreat[]): string[] {
  return [...new Set(threats.map((t) => t.intentionId))];
}

// ─── Helpers ───────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Extract scannable text from an operation's effect. */
function operationText(op: Operation): string | null {
  switch (op.effect.type) {
    case "create":
      return op.effect.content;
    case "modify":
      return (op.effect.description ?? "") + (op.effect.delta ?? "");
    case "send":
      return op.effect.message;
    case "verify":
      return op.effect.condition;
    case "query":
      return op.effect.question;
    case "remove":
      return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
