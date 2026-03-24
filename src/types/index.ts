export type { Task, TaskEvent } from "./task.js";
export { createTask, addEvent } from "./task.js";

export type {
  ProjectIntent,
  TasteProfile,
  DecisionRecord,
  DriftEntry,
} from "./intent.js";

export type {
  Sense,
  SenseLevel,
  SensePerspective,
  SenseEvaluation,
  TensionFlag,
} from "./sense.js";

export type { Council } from "./council.js";

export type { Tension, TensionResolution } from "./tension.js";

export type { OrchestratorResult, CortexConfig } from "./orchestrator.js";
export { DEFAULT_CONFIG } from "./orchestrator.js";

export type {
  RhythmPhase,
  GateContinue,
  GateComplete,
  GateEscalate,
  GatePause,
  GateDecision,
  SoftInterrupt,
  HardInterrupt,
  Interrupt,
  RhythmState,
  RhythmDefinition,
  RhythmRunner,
} from "./rhythm.js";

export type {
  ProjectState,
  ProjectContext,
  TaskGraphNode,
  TaskDispatchContext,
  SensoryCortexContext,
  BuildCycleContext,
  ProjectResult,
  TaskDispatchResult,
  SensoryCortexResult,
  BuildCycleResult,
  BetweenTasksFastPath,
  BetweenTasksSlowPath,
  BetweenTasksResult,
  EscalationSource,
  Escalation,
  VitalSigns,
  VitalSignThresholds,
  ConsolidationLoad,
  ConsolidationPriority,
  RestCycleContext,
  RestCycleResult,
  ContextSlot,
  ContextTransition,
} from "./brainstem.js";
export {
  escalationToInterruptMode,
  DEFAULT_VITAL_THRESHOLDS,
} from "./brainstem.js";

export type {
  Intention,
  IntentionCategory,
  IntentionStatus,
  Operation,
  ArtifactRef,
  Effect,
  Perception,
  PerceptionSource,
  SideEffect,
  Capability,
  CapabilityCategory,
  AfferentCategory,
  EfferentCategory,
  CheckpointPolicy,
} from "./pns.js";
export { createIntention, DEFAULT_CHECKPOINT_POLICY } from "./pns.js";

export type {
  ScoreEntry,
  ScoreSnapshot,
  TrendDirection,
  ScoreTrend,
  WMTaskStatus,
  TaskSummary,
  WMTask,
  EstablishedPattern,
  OpenQuestion,
  InhibitedSense,
  WorkingMemoryState,
} from "./working-memory.js";

export type {
  InhibitorConfig,
  InhibitionScope,
  SuppressionDecision,
  SuppressionEntry,
  ReactivationEntry,
  CollapseContext,
  CollapseSignal,
  CollapseDetail,
  InhibitionBriefing,
  InhibitionEnrichment,
  SenseSummary,
} from "./inhibitor.js";
export { DEFAULT_INHIBITOR_CONFIG, SCOPE_HIERARCHY } from "./inhibitor.js";
