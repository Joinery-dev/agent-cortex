export interface ProjectIntent {
  id: string;
  summary: string;
  audience: string;
  successCriteria: string[];
  constraints: string[];
  vision: string;
  keyDecisions: DecisionRecord[];
  driftLog: DriftEntry[];
  /**
   * Dollar budget for this project. Optional — unconstrained when absent.
   * The budget is the metabolic constraint that forces the system to
   * prioritize cognitive spending across tasks.
   */
  budget?: import("./cost.js").CostBudget;
  /** Runtime configuration — how to start the project for observation (dev server, API, etc.). */
  runtime?: import("./runtime.js").RuntimeConfig[];
  /** Human-declared urgency. Defaults to "normal" when absent. */
  urgency?: "low" | "normal" | "high" | "critical";
}

export interface TasteProfile {
  id: string;
  name: string;
  visual: string;
  decisionStyle: string;
  communication: string;
  patterns: string;
  raw: Record<string, string>;
}

export interface DecisionRecord {
  id: string;
  timestamp: Date;
  description: string;
  reasoning: string;
  confidence: number;
  requiresHumanReview: boolean;
  humanVerdict?: "approved" | "rejected" | "modified";
}

export interface DriftEntry {
  timestamp: Date;
  originalScope: string;
  currentScope: string;
  delta: string;
  acknowledged: boolean;
  /** Which drift monitor mode produced this entry. */
  source: "quick-check" | "deep-analysis";
  /** Drift level at the time this entry was logged (0–1). */
  driftLevel: number;
  /** Phase group that triggered this entry (deep analysis entries only). */
  phaseGroup?: string;
}
