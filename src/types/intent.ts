export interface ProjectIntent {
  id: string;
  summary: string;
  audience: string;
  successCriteria: string[];
  constraints: string[];
  vision: string;
  keyDecisions: DecisionRecord[];
  driftLog: DriftEntry[];
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
}
