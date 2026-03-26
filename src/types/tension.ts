export interface Tension {
  id: string;
  taskId: string;
  senseA: {
    id: string;
    path: string[];
    score: number;
    assessment: string;
    stake?: number;
  };
  senseB: {
    id: string;
    path: string[];
    score: number;
    assessment: string;
    stake?: number;
  };
  description: string;
  severity: "low" | "medium" | "high";
  resolution?: TensionResolution;
}

export interface TensionResolution {
  strategy: string;
  satisfiesBoth: boolean;
  revisedInstructions: string;
}

/**
 * Measured outcome of a resolution attempt.
 *
 * Computed by comparing pre-resolution scores (cycle N) to
 * post-resolution scores (cycle N+1) for the two senses involved.
 * Quality captures both gap shrinkage (did they converge?) and
 * score maintenance (did neither drop?). Collapsed resolutions
 * (capitulation, not synthesis) produce quality = 0.
 */
export interface ResolutionOutcome {
  tensionId: string;
  senseAId: string;
  senseBId: string;
  preScores: { senseA: number; senseB: number };
  postScores: { senseA: number; senseB: number };
  /** |preScoreA - preScoreB| */
  preGap: number;
  /** |postScoreA - postScoreB| */
  postGap: number;
  /** preGap - postGap. Positive = gap shrunk (improvement). */
  gapShrinkage: number;
  /** Neither sense's score dropped by more than 1 point. */
  scoresMaintained: boolean;
  /** Combined quality metric: 0–1. */
  quality: number;
  /** Collapse detection flagged this resolution as capitulation. */
  collapsed: boolean;
}
