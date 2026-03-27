/**
 * Project Diagnostics — project-level self-healing.
 *
 * When the replan cascade is exhausted (drift persists after replanning),
 * ProjectDiagnostics takes the full diagnostic corpus and diagnoses the
 * root cause. Five diagnoses, four self-healable:
 *
 *   path-problem        → task decomposition was wrong
 *   vision-problem      → manifested future was wrong/incomplete
 *   calibration-problem → evaluation system is miscalibrated
 *   taste-problem       → taste profile doesn't match reality
 *   environmental       → external constraints block progress (→ human)
 *
 * Only "environmental" escalates to the human. The others prescribe a
 * self-heal action that the project rhythm applies before restarting.
 *
 * This is the project-level analog of Cognitive Flexibility (Feature #5):
 *   CogFlex asks "why is this task stuck?"
 *   ProjectDiagnostics asks "why does this project keep drifting?"
 */

import type { OrchestratorResult } from "./orchestrator.js";
import type { TaskGraphNode } from "./brainstem.js";
import type { ProjectIntent, TasteProfile } from "./intent.js";
import type { DriftAssessment } from "./drift-monitor.js";
import type { ConvictionResult } from "./conviction.js";
import type { ScoreTrend, ConvictionEntry, ConvictionTrajectory } from "./working-memory.js";

// ─── Diagnosis ───────────────────────────────────────────────────

export type ProjectDiagnosis =
  | "path-problem"
  | "vision-problem"
  | "calibration-problem"
  | "taste-problem"
  | "environmental";

// ─── Context (input) ─────────────────────────────────────────────

/** What ProjectDiagnostics reads to make its assessment. */
export interface DiagnosticContext {
  /** All completed task results — scores, tensions, cycles. */
  taskResults: Map<string, OrchestratorResult>;
  /** Current drift assessment (quick check + deep analysis). */
  driftAssessment: DriftAssessment | null;
  /** Conviction history from task-dispatch rounds. */
  convictionHistory: ConvictionResult[];
  /** Per-sense score trends from Working Memory. */
  senseTrends: ScoreTrend[];
  /** World model maxims — system's current understanding. */
  worldModelMaxims: string[];
  /** The manifested future from Phase A. */
  manifestedFuture: string;
  /** The original task graph (before any replanning). */
  originalGraph: TaskGraphNode[];
  /** The most recent task graph (after last replan). */
  currentGraph: TaskGraphNode[];
  /** Project intent — the ground truth. */
  intent: ProjectIntent;
  /** Taste profile — stated preferences. */
  taste: TasteProfile;
  /** How many replans have been attempted. */
  replanCount: number;
}

// ─── Self-heal actions ───────────────────────────────────────────

/** Prescribed action the project rhythm applies before restarting. */
export type SelfHealAction =
  | { type: "replan-with-directive"; directive: string }
  | { type: "re-manifest" }
  | { type: "recalibrate-evaluation"; directive: string }
  | { type: "propose-taste-update"; proposedChanges: string };

// ─── Result (output) ─────────────────────────────────────────────

/** What ProjectDiagnostics produces. */
export interface DiagnosticResult {
  /** Root cause diagnosis. */
  diagnosis: ProjectDiagnosis;
  /** Human-readable explanation of the diagnosis. */
  reasoning: string;
  /** Prescribed self-heal action. Null when diagnosis is "environmental". */
  selfHealAction: SelfHealAction | null;
  /** Present when diagnosis is "environmental" — context for human escalation. */
  escalationContext?: string;
}

// ─── Triage (lightweight routing) ───────────────────────────────

/** What the triage function routes to. */
export type TriageRoute = "replan" | "re-manifest" | "full-diagnostic" | "escalate";

/** What triage reads — assembled by the project rhythm from WM + subcortical signals. */
export interface TriageContext {
  /** Conviction trajectory from WM. */
  convictionTrajectory: ConvictionTrajectory;
  /** Full conviction history from WM (for generation-level analysis). */
  convictionHistory: ConvictionEntry[];
  /** Per-sense score trends from WM. */
  senseTrends: ScoreTrend[];
  /** Current drift assessment. */
  driftAssessment: DriftAssessment | null;
  /** Cerebellum prediction accuracy (0–1). */
  cerebellumAccuracy: number;
  /** How many replans have been attempted so far. */
  replanCount: number;
  /** Max allowed before forced escalation. */
  maxReplans: number;

  /** When the escalation originated from the scheduler (not a drift-triggered replan). */
  escalationSource?: {
    type: "conviction-escalation" | "scheduler-escalation" | "pfc-flag";
    schedulerType?: "perseveration" | "cratering" | "deadlock" | "open-questions" | "drift";
    reason: string;
  };
}

/** What triage produces. */
export interface TriageResult {
  /** Where to route. */
  route: TriageRoute;
  /** Why this route was chosen — for logging and future BG learning. */
  reasoning: string;
  /** Which heuristic rule fired (stable identifier for BG pattern learning). */
  firedRule: string;
  /** Optional sense-specific note when route is "replan". */
  senseDirective?: string;
}
