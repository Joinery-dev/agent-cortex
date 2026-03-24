import type { SenseEvaluation } from "./sense.js";
import type { Tension, TensionResolution } from "./tension.js";
import type { DecisionRecord } from "./intent.js";

export interface OrchestratorResult {
  taskId: string;
  status: "complete" | "needs_revision" | "needs_human";
  work: string;
  evaluations: SenseEvaluation[];
  tensions: Tension[];
  resolutions: TensionResolution[];
  cycles: number;
  confidence: number;
  decisionLog: DecisionRecord[];
}

export interface CortexConfig {
  maxCycles: number;
  acceptableMinScore: number;
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
    inhibitor?: string;
    /** Defaults to consultation model if not specified. */
    collapseDetection?: string;
  };
}

export const DEFAULT_CONFIG: CortexConfig = {
  maxCycles: 3,
  acceptableMinScore: 6,
  models: {
    consultation: "claude-sonnet-4-6-20250514",
    motorCortex: "claude-sonnet-4-6-20250514",
    evaluation: "claude-sonnet-4-6-20250514",
    resolution: "claude-sonnet-4-6-20250514",
  },
};
