export type SenseLevel = "sense" | "pathway" | "receptor";

export interface Sense {
  id: string;
  name: string;
  level: SenseLevel;
  sensitivity: string;
  parentId?: string;
  children?: string[];
  activationHint: string;
}

export interface SensePerspective {
  senseId: string;
  senseName: string;
  perspective: string;
  evaluators: string[]; // receptor IDs that should evaluate the work
}

export interface SenseEvaluation {
  senseId: string;
  activationPath: string[];
  score: number;
  assessment: string;
  tensions: TensionFlag[];
  suggestions: string[];
}

export interface TensionFlag {
  withDimension: string;
  description: string;
}
