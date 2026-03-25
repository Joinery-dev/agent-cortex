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
  /** Self-assessed relevance to this task (0–1). How much would be lost if this sense had no input? */
  stake: number;
}

export interface SenseEvaluation {
  senseId: string;
  activationPath: string[];
  score: number;
  /** The sense's own judgment: is this work adequate from its perspective? Not derived from score. */
  acceptable: boolean;
  assessment: string;
  tensions: TensionFlag[];
  suggestions: string[];
}

export interface TensionFlag {
  withDimension: string;
  description: string;
}
