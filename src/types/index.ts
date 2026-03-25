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

export type {
  Consultation,
  EvaluationPlanEntry,
  StakeDistribution,
  ConsultationConditions,
} from "./consultation.js";

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
  Gate,
  GateInput,
  GateOutput,
  GateStrategy,
  StrategySelector,
  SignalLandscape,
} from "./gate.js";

export type {
  ConsultationBriefing,
  MotorBriefing,
  EvaluationBriefing,
  SchedulingBriefing,
  BriefingMeta,
  ThalamusSources,
  HippocampusSource,
  PrincipleSummary,
} from "./thalamus.js";

export type {
  MotorPlan,
  MotorCortexResult,
  SelfAssessment,
  RevisionContext,
  RevisionPlan,
  PlanStep,
  TensionStrategy,
  PlanRisk,
  PlannedIntention,
  DriftArea,
} from "./motor-cortex.js";

export type {
  TaskFingerprint,
  CerebellumEpisode,
  ReceptorPrediction,
  CerebellumPrediction,
  ReceptorDopamine,
  DopamineSignal,
  SimilarityWeights,
  CerebellumConfig,
  AccuracyRecord,
  ScoredEpisode,
} from "./cerebellum.js";
export {
  DEFAULT_SIMILARITY_WEIGHTS,
  DEFAULT_CEREBELLUM_CONFIG,
} from "./cerebellum.js";

export type {
  BasalGangliaConfig,
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
} from "./basal-ganglia.js";
export { DEFAULT_BASAL_GANGLIA_CONFIG, SCOPE_HIERARCHY } from "./basal-ganglia.js";

export type {
  DeltaSource,
  ConnectionCategory,
  NormalizationBehavior,
  CategoryConfig,
  PlasticConnectionDeclaration,
  WeightDelta,
  PlasticWeight,
  ConnectionSnapshot,
  PlasticityStore,
  FixedConnection,
} from "./plasticity.js";
export {
  CATEGORY_CONFIG,
  FIXED_CONNECTIONS,
  PLASTIC_CONNECTIONS,
} from "./plasticity.js";

export type {
  Episode,
  EpisodeNarrative,
  ScoreProgressionEntry,
  ScoreProgressionScore,
  DecisionSnapshot,
  TensionSnapshot,
  SenseParticipationRecord,
  Principle,
  EvidenceRef,
  ExtractionContext,
  PotentiationTrigger,
  PatternDensityTrigger,
  SurpriseTrigger,
  ContradictionTrigger,
  EpisodeCluster,
  PrincipleContradiction,
  HippocampusConfig,
  HippocampusMeta,
  HippocampusState,
  PrincipleExtractionResult,
  PrincipleRefinementResult,
} from "./hippocampus.js";
export { DEFAULT_HIPPOCAMPUS_CONFIG } from "./hippocampus.js";

export type {
  TonicDopamine,
  TonicConfig,
  HippocampalProjection,
  StriatalProjection,
  PlasticityProjection,
  PrefrontalProjection,
  ReceptorWeightDelta,
  DopamineProjections,
  TonicSnapshot,
  TonicTrackerSnapshot,
} from "./dopamine.js";
export { DEFAULT_TONIC_CONFIG } from "./dopamine.js";
