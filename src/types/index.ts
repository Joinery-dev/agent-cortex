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
  ImprovementPotential,
  TensionFlag,
  EvaluatorObservation,
  ObservationLevel,
} from "./sense.js";

export type {
  Consultation,
  EvaluationPlanEntry,
  StakeDistribution,
  ConsultationConditions,
} from "./consultation.js";

export type { Tension, TensionResolution, ResolutionOutcome } from "./tension.js";

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
  EscalationResolution,
  EscalationDeliveryAdapter,
  VitalSigns,
  VitalSignThresholds,
  ConsolidationLoad,
  ConsolidationPriority,
  RestCycleContext,
  RestCycleResult,
  BriefingSlot,
  BriefingReceipt,
  CompactionConfig,
  CompactionResponse,
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
  ToolBinding,
  ActivatedToolSet,
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
  ConvictionEntry,
  ConvictionTrajectory,
  OscillationSignal,
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
  EscalationBriefing,
  EscalationRhythmContext,
  EscalationProjectSnapshot,
  BriefingMeta,
  ThalamusSources,
  HippocampusSource,
  WorldModelSource,
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
  SenseCeiling,
  SpeedOfLight,
  ApproachCeiling,
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
  InhibitionBriefing,
  InhibitionEnrichment,
  SenseSummary,
  Routine,
  RoutineFingerprint,
  RoutineMatch,
} from "./basal-ganglia.js";
export { DEFAULT_BASAL_GANGLIA_CONFIG, SCOPE_HIERARCHY } from "./basal-ganglia.js";

export type {
  CollapseSignal,
  CollapseDetail,
} from "./collapse.js";

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

export type {
  Maxim,
  Weltanschauung,
  WorldModelSourcesSummary,
  WorldModelSources,
  WorkingMemorySource,
  CerebellumSource,
  TonicSource,
  PlasticitySource,
  RebuildTrigger,
  WorldModelConfig,
  WorldModelState,
} from "./world-model.js";
export { DEFAULT_WORLD_MODEL_CONFIG } from "./world-model.js";

export type {
  ExplorePath,
  ExploreResult,
  ExploreSelected,
  ExploreSkipped,
} from "./explore.js";
export { EXPLORE_QUALITY_FLOOR } from "./explore.js";

export type {
  EfferenceCopy,
  EfferenceSenseFeasibility,
  TensionCost,
  EfferenceCopyContext,
  SerializedEpisode,
} from "./efference-copy.js";

export type {
  TaskGestalt,
  GestaltWeltanschauung,
  GestaltAccumulated,
  GestaltEpisodic,
  GestaltCapabilities,
  GestaltGraphPosition,
  GestaltAssemblyContext,
} from "./task-gestalt.js";

export type {
  FlexibilityDiagnosis,
  FlexibilityContext,
  ApproachHistoryEntry,
  FlexibilityAssessment,
  ResetDirective,
} from "./cognitive-flexibility.js";

export type {
  ConvictionContext,
  ConvictionResult,
  ConvictionEvidence,
  ConvictionShaping,
} from "./conviction.js";

export type {
  NEWeights,
  NEInputs,
  RiskFactors,
  NEResult,
  NEComponents,
} from "./norepinephrine.js";

export type {
  DriftMonitorConfig,
  DriftMonitorSources,
  DriftMonitorWMSource,
  QuickCheckSignals,
  QuickCheckResult,
  DriftEvidence,
  IntentAlignmentLevel,
  AlignmentTrajectory,
  IntentAlignment,
  TasteDivergenceItem,
  TasteDivergence,
  ConventionSignal,
  ConventionHealth,
  DeepAnalysis,
  DriftAssessment,
  DriftMonitorState,
} from "./drift-monitor.js";
export { DEFAULT_DRIFT_MONITOR_CONFIG } from "./drift-monitor.js";

export type {
  ForwardBriefing,
  PredictedTension,
  PredictedBottleneck,
  ForwardBriefingSources,
  HippocampusEpisodeSummary,
} from "./forward-briefing.js";

export type {
  ProspectiveTrigger,
  TriggerCondition,
  TriggerAction,
  FiredTrigger,
  ProspectiveMemoryConfig,
  ProspectiveMemoryState,
} from "./prospective-memory.js";
export { DEFAULT_PROSPECTIVE_MEMORY_CONFIG } from "./prospective-memory.js";

export type {
  PlannerConfig,
  ManifestedFuture,
  ProposedTask,
  ProposedPhase,
  PathReasoningRaw,
  RejectedTask,
  PlannerResult,
  ReplanContext,
  ReplanResult,
} from "./planner.js";
export { DEFAULT_PLANNER_CONFIG } from "./planner.js";

export type {
  ProjectDiagnosis,
  DiagnosticContext,
  DiagnosticResult,
  SelfHealAction,
  TriageRoute,
  TriageContext,
  TriageResult,
} from "./project-diagnostics.js";

export type {
  ThreatDetector,
  DetectedThreat,
  ThreatCategory,
  Alarm,
  ThreatAssessment,
  ResponseAction,
  ResponseProtocolResult,
  ResponseDeps,
  AmygdalaConfig,
  AmygdalaState,
} from "./amygdala.js";
export { DEFAULT_AMYGDALA_CONFIG } from "./amygdala.js";

export type {
  TasteFeedbackConfig,
  TasteFeedbackSources,
  TasteFeedbackDriftSource,
  DivergenceRecord,
  ProposalStatus,
  TasteProposal,
  TasteFeedbackState,
} from "./taste-feedback.js";
export { DEFAULT_TASTE_FEEDBACK_CONFIG } from "./taste-feedback.js";

export type {
  CostBudget,
  ModelPricing,
  CostRecord,
  TaskCostSummary,
  ProjectCostSummary,
  ProjectCostEstimate,
  BriefingDepth,
} from "./cost.js";
export {
  MODEL_PRICING,
  DEFAULT_COST_BUDGET,
  COLD_START_DEPTH,
  computeCallCost,
  estimateCallCost,
} from "./cost.js";

export type {
  GraphSurgeryOp,
  GraphSurgeryInsert,
  GraphSurgeryAmend,
  GraphSurgeryRework,
  GraphSurgeryReorder,
  ReworkDirective,
  SurgeryProposal,
  SurgeryResult,
  ValidationResult,
} from "./graph-surgery.js";

export type {
  TerritoryObservation,
  ObservationStatus,
  ObservationSource,
} from "./territory-observation.js";
export {
  relevanceThreshold,
  observationPressure,
} from "./territory-observation.js";

export type {
  SimulatedScenario,
  SimulationGrounding,
  SimulationTrigger,
  SimulationAccuracyRecord,
  SimulationConfig,
  SimulationLLMResult,
} from "./hippocampal-simulation.js";
export { DEFAULT_SIMULATION_CONFIG } from "./hippocampal-simulation.js";

export type {
  TasteResponseType,
  SatisfactionResponse,
  SatisfactionKind,
  SatisfactionSignal,
  TaskSatisfactionSignal,
  PlasticityMapping,
  PlasticityUpdate,
  TasteUpdate,
  SatisfactionSignalConfig,
} from "./satisfaction-signal.js";
export { DEFAULT_SATISFACTION_CONFIG } from "./satisfaction-signal.js";
