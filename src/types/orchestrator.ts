import type { SenseEvaluation } from "./sense.js";
import type { Tension, TensionResolution, ResolutionOutcome } from "./tension.js";
import type { DecisionRecord } from "./intent.js";

export interface OrchestratorResult {
  taskId: string;
  status: "complete" | "needs_revision" | "needs_human";
  work: string;
  evaluations: SenseEvaluation[];
  tensions: Tension[];
  resolutions: TensionResolution[];
  /** Measured outcomes of resolution attempts (pre/post score comparison). */
  resolutionOutcomes?: ResolutionOutcome[];
  /** Total inner build cycles across all outer cycles. */
  cycles: number;
  /** Number of sensory cortex outer cycles (consultation → build → evaluate). */
  outerCycles?: number;
  confidence: number;
  decisionLog: DecisionRecord[];
  /** Raw approach string from MotorPlan, threaded for downstream consumers. */
  approach?: string;
}

export interface CortexConfig {
  /** Max inner build-cycle iterations per outer cycle. */
  maxCycles: number;
  /** Max outer cycles for sensory cortex re-consultation loop. */
  maxOuterCycles: number;
  /** Minimum weighted improvement potential to justify another outer cycle (0–1). */
  improvementThreshold: number;
  /** Minimum composite score delta between outer cycles to avoid diminishing returns exit. */
  diminishingReturnsDelta: number;
  models: {
    consultation: string;
    motorCortex: string;
    evaluation: string;
    resolution: string;
    /** Defaults to motorCortex model if not specified. */
    premotor?: string;
    /** Defaults to motorCortex model if not specified. */
    proprioception?: string;
    /** Defaults to consultation model if not specified. */
    basalGanglia?: string;
    /** Defaults to consultation model if not specified. */
    collapseDetection?: string;
    /** Defaults to consultation model if not specified. */
    prospectiveMemory?: string;
    /** Defaults to consultation model if not specified. */
    explore?: string;
    /** Defaults to premotor model if not specified. */
    efferenceCopy?: string;
    /** Defaults to evaluation model if not specified. */
    integrationCheck?: string;
  };
  /** Max concurrent LLM API calls across the entire system. Prevents rate-limit thundering herds. Default: 8. */
  llmConcurrency?: number;
  /** Reliability thresholds and timeouts. Uses DEFAULT_RELIABILITY_CONFIG when absent. */
  reliability?: Partial<ReliabilityConfig>;
  /** Hierarchical planning configuration. */
  plannerConfig?: import("./planner.js").PlannerConfig;
}

// ─── Reliability configuration ───────────────────────────────────

/**
 * Thresholds and timeouts that govern the system's reliability behavior.
 * Every value has a documented rationale — no magic numbers.
 */
export interface ReliabilityConfig {
  /** Below this conviction level, escalate to human. 0.3 = system assesses <30% chance of success. */
  convictionEscalateThreshold: number;
  /** Below this conviction level, reshape approach. 0.5 = coin-flip odds aren't a strategy. */
  convictionReshapeThreshold: number;
  /** Within this fraction of ceiling = diminishing returns. 0.2 = ≥80% of theoretical max. */
  solNearCeilingRatio: number;
  /** Beyond this fraction from ceiling = approach can't reach target. 0.5 = <50% of theoretical max. */
  solFarFromCeilingRatio: number;
  /** Diagnostic load (0–1) above this triggers rest. tanh(~32 events/min / 30) ≈ 0.7. */
  diagnosticLoadCritical: number;
  /** Diagnostic load (0–1) above this triggers NE spike. tanh(~9 events/min / 30) ≈ 0.3. */
  diagnosticLoadElevated: number;
  /** Graph surgery blast radius above this triggers replan instead of direct surgery. */
  replanBlastRadiusThreshold: number;
  /** TTL for paused rhythms in milliseconds. Prevents infinite waits on human input. */
  pauseTimeoutMs: number;
  /** Maximum rest cycles before forcing exit. Prevents rest loops when consolidation doesn't help. */
  maxRestCycles: number;
}

export const DEFAULT_RELIABILITY_CONFIG: ReliabilityConfig = {
  convictionEscalateThreshold: 0.3,
  convictionReshapeThreshold: 0.5,
  solNearCeilingRatio: 0.2,
  solFarFromCeilingRatio: 0.5,
  diagnosticLoadCritical: 0.7,
  diagnosticLoadElevated: 0.3,
  replanBlastRadiusThreshold: 0.3,
  pauseTimeoutMs: 30 * 60 * 1000, // 30 minutes
  maxRestCycles: 3,
};

export const DEFAULT_CONFIG: CortexConfig = {
  maxCycles: 2,
  maxOuterCycles: 6,
  improvementThreshold: 0.3,
  diminishingReturnsDelta: 0.5,
  models: {
    consultation: "claude-sonnet-4-6-20250514",
    motorCortex: "claude-sonnet-4-6-20250514",
    evaluation: "claude-sonnet-4-6-20250514",
    resolution: "claude-sonnet-4-6-20250514",
  },
};
