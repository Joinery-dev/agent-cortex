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
