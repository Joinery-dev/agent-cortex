export interface Tension {
  id: string;
  taskId: string;
  senseA: {
    id: string;
    path: string[];
    score: number;
    assessment: string;
  };
  senseB: {
    id: string;
    path: string[];
    score: number;
    assessment: string;
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
