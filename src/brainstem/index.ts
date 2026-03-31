/**
 * Brainstem — the vital rhythm engine.
 *
 * Ties together the three brainstem responsibilities:
 *   1. Rhythm — the recursive runner that drives all loops
 *   2. Homeostasis — vital signs monitoring with reflex responses
 *   3. Rest — load-triggered consolidation cycles
 *
 * Provides the main API for running tasks and projects through
 * the rhythm system.
 */

import type { Interrupt } from "../types/rhythm.js";
import type {
  ProjectContext,
  ProjectResult,
  SensoryCortexContext,
  SensoryCortexResult,
  VitalSigns,
  TaskGraphNode,
} from "../types/brainstem.js";
import type { CortexConfig } from "../types/orchestrator.js";
import type { SensoryCortex } from "../senses/cortex.js";
import { createTask } from "../types/task.js";
import { newId } from "../util/ids.js";
import { RhythmRunnerImpl } from "./runner.js";
import { CheckpointStore } from "../trace/checkpoint-store.js";
import type { CheckpointProvider } from "../types/checkpoint.js";
import { HomeostasisMonitor } from "./homeostasis.js";
import { NoOpSubcorticalHooks } from "./stubs.js";
import type { SubcorticalHooks } from "./stubs.js";
import { Cerebellum } from "../subcortical/cerebellum.js";
import { Hippocampus } from "../subcortical/hippocampus.js";
import { CompositeSubcorticalHooks } from "../subcortical/hooks.js";
import { TonicTracker } from "../subcortical/tonic.js";
import { createSensoryCortexDefinition } from "./rhythms/sensory-cortex.js";
import { createBuildCycleDefinition } from "./rhythms/build-cycle.js";
import { createProjectDefinition } from "./rhythms/project.js";
import { WorkingMemory } from "../kernel/working-memory.js";
import { Thalamus } from "../kernel/thalamus.js";
import { AttentionScheduler } from "../kernel/attention-scheduler.js";
import type { SchedulerConfig } from "../types/attention-scheduler.js";
import { MotorCortex } from "../kernel/motor-cortex.js";
import { BasalGanglia } from "../kernel/basal-ganglia.js";
import type { BasalGangliaConfig } from "../types/basal-ganglia.js";
import { BasalGangliaStore } from "../subcortical/basal-ganglia-store.js";
import type { Gate } from "../types/gate.js";
import type { StakeAdjuster } from "../kernel/evaluation-weighter.js";
import { createGate } from "../kernel/gate.js";
import { PlasticityStoreImpl } from "../subcortical/plasticity-store.js";
import type { PlasticityStoreConfig } from "../subcortical/plasticity-store.js";
import { Amygdala } from "../subcortical/amygdala.js";
import { ExteroceptionSystem } from "../subcortical/exteroception.js";
import { WorldModel } from "../kernel/world-model.js";
import { CognitiveFlexibility } from "../kernel/cognitive-flexibility.js";
import { PeripheralNervousSystem } from "../kernel/pns.js";
import { DriftMonitor } from "../kernel/drift-monitor.js";
import { Planner } from "../kernel/planner.js";
import { ProjectDiagnostics } from "../kernel/project-diagnostics.js";
import { ProspectiveMemory } from "../kernel/prospective-memory.js";
import { TasteFeedbackLoop } from "../kernel/taste-feedback.js";
import {
  processTasteResponse,
  processTaskSignal,
  applyMapping,
  applyTasteUpdate,
} from "../kernel/satisfaction-signal.js";
import type { SatisfactionResponse, SatisfactionSignal } from "../types/satisfaction-signal.js";
import { EscalationHandler } from "./escalation-handler.js";
import { AgentSdkDeliveryAdapter } from "./delivery-adapters.js";
import { ConversationCortex } from "../kernel/conversation-cortex.js";
import type { ConversationTransport } from "../types/conversation.js";
import { CostTracker } from "./cost-tracker.js";
import { registerCostCallback, setCostTaskId, setLlmConcurrency } from "../llm/client.js";
import type { CostBudget, ProjectCostSummary } from "../types/cost.js";
import { DEFAULT_COST_BUDGET } from "../types/cost.js";
import { bus } from "../events.js";
import type { Worldview } from "../types/worldview.js";
import { persistTasteProfile } from "../taste/store.js";

export class Brainstem {
  private runner: RhythmRunnerImpl;
  private homeostasis: HomeostasisMonitor;
  private hooks: SubcorticalHooks;
  private config: CortexConfig;
  private library: SensoryCortex;
  private wm: WorkingMemory;
  private thalamus: Thalamus;
  private scheduler: AttentionScheduler;
  private motorCortex: MotorCortex;
  private basalGanglia: BasalGanglia;
  private gate: Gate;
  private stakeAdjuster: StakeAdjuster;
  private cerebellum: Cerebellum;
  private hippocampus: Hippocampus;
  private plasticityStore: PlasticityStoreImpl;
  private tonicTracker: TonicTracker;
  private worldModel: WorldModel;
  private cognitiveFlexibility: CognitiveFlexibility;
  private pns: PeripheralNervousSystem;
  private driftMonitor: DriftMonitor;
  private planner: Planner;
  private projectDiagnostics: ProjectDiagnostics;
  private prospectiveMemory: ProspectiveMemory;
  private tasteFeedbackLoop: TasteFeedbackLoop;
  private amygdala: Amygdala;
  private exteroception: ExteroceptionSystem;
  private escalationHandler: EscalationHandler;
  private conversationCortex: ConversationCortex;
  private costTracker: CostTracker | null = null;
  private askUser?: (question: string) => Promise<string>;

  constructor(
    config: CortexConfig,
    library: SensoryCortex,
    hooks?: SubcorticalHooks,
    wm?: WorkingMemory,
    schedulerConfig?: Partial<SchedulerConfig>,
    basalGangliaConfig?: Partial<BasalGangliaConfig>,
    gate?: Gate,
    stakeAdjuster?: StakeAdjuster,
    plasticityConfig?: Partial<PlasticityStoreConfig>,
    worldview?: Worldview,
  ) {
    this.config = config;
    this.library = library;
    this.runner = new RhythmRunnerImpl();
    this.homeostasis = new HomeostasisMonitor();

    // Apply global LLM concurrency limit if configured
    if (config.llmConcurrency) {
      setLlmConcurrency(config.llmConcurrency);
    }

    // Subcortical systems: prediction + episodic memory + plasticity.
    this.cerebellum = new Cerebellum();
    this.hippocampus = new Hippocampus({
      potentiationModel: config.models.consultation,
    });
    this.plasticityStore = new PlasticityStoreImpl(plasticityConfig);
    this.tonicTracker = new TonicTracker();
    this.amygdala = new Amygdala();
    this.exteroception = new ExteroceptionSystem(undefined, this.amygdala);

    // Register all built-in connections. Expand per-sense template
    // using the sense IDs from the library.
    const senseIds = library.getSenses().map((s) => s.id);
    this.plasticityStore.registerAll(
      new Map([["evaluator.sense-weight", senseIds]]),
    );

    // PFC: world model
    this.worldModel = new WorldModel({
      synthesisModel: config.models.consultation,
    });

    // PNS: I/O boundary
    this.pns = new PeripheralNervousSystem();

    // Core kernel — thalamus gets hippocampus + world model + PNS as sources
    this.wm = wm ?? new WorkingMemory("default");
    this.thalamus = new Thalamus({
      wm: this.wm,
      pns: this.pns,
      hippocampus: this.hippocampus,
      worldModel: this.worldModel,
    });
    this.scheduler = new AttentionScheduler(schedulerConfig);
    this.motorCortex = new MotorCortex(config, this.pns, worldview);
    this.basalGanglia = new BasalGanglia(
      basalGangliaConfig,
      new BasalGangliaStore(),
      this.plasticityStore,
    );
    this.gate = gate ?? createGate();
    this.cognitiveFlexibility = new CognitiveFlexibility(config);
    this.driftMonitor = new DriftMonitor({
      deepAnalysisModel: config.models.consultation,
    });
    this.planner = new Planner(config.models.motorCortex, undefined, worldview);
    this.projectDiagnostics = new ProjectDiagnostics(config);
    this.prospectiveMemory = new ProspectiveMemory();
    this.tasteFeedbackLoop = new TasteFeedbackLoop({
      proposalModel: config.models.consultation,
    });

    // StakeAdjuster: if caller provides one, use it. Otherwise build
    // one that reads evaluation-influence weights from the store.
    this.stakeAdjuster = stakeAdjuster ?? this.createStakeAdjuster();

    // Compose hooks — when no hooks are provided, wire all systems
    this.hooks = hooks ?? new CompositeSubcorticalHooks({
      cerebellum: this.cerebellum,
      hippocampus: this.hippocampus,
      homeostasis: this.homeostasis,
      plasticity: this.plasticityStore,
      basalGanglia: this.basalGanglia,
      amygdala: this.amygdala,
      exteroception: this.exteroception,
      tonic: this.tonicTracker,
      wm: this.wm,
      projectId: "default",
    });

    // Escalation handler — wires Thalamus briefings to runner pause/resume
    this.escalationHandler = new EscalationHandler(this.thalamus, this.wm, this.runner);

    // Conversation cortex — bidirectional channel between Cortex and Parsifal.
    // Consciousness agent identity comes from the worldview.
    this.conversationCortex = new ConversationCortex({
      wm: this.wm,
      runner: this.runner,
      escalationHandler: this.escalationHandler,
      thalamus: this.thalamus,
      worldview,
      worldModel: this.worldModel,
      costTracker: this.costTracker,
    });

    // Wire sense library to components that need sense verification
    this.hippocampus.setLibrary(library);
    this.tasteFeedbackLoop.setLibrary(library);
    this.escalationHandler.setLibraryAndModel(library, config.models.consultation);

    // ── Checkpoint provider ─────────────────────────────────────
    // Wire the runner to capture ambient state from services at checkpoint time.
    const checkpointProvider: CheckpointProvider = {
      captureAmbient: (taskId: string) => ({
        workingMemory: this.wm.snapshot(),
        plasticity: this.plasticityStore.snapshot("checkpoint"),
        gestalt: this.thalamus.getGestalt?.(taskId) ?? null,
      }),
      store: new CheckpointStore(),
    };
    this.runner.setCheckpointProvider(checkpointProvider);

    // ── Afferent signal routing ────────────────────────────────
    // PNS.receiveAfferent() creates Perceptions and emits pns:afferent.
    // Route them as rhythm interrupts based on source type:
    //   Parsifal feedback → soft interrupt on active sensory-cortex
    //   environment alerts → hard interrupt via amygdala pathway
    //   tool errors → soft interrupt for gate-phase consideration
    this.wireAfferentRouting();
  }

  /**
   * Subscribe to pns:afferent events and route them as rhythm interrupts.
   * Parsifal feedback arrives mid-task and should be considered at the next
   * gate. Environment alerts may require immediate attention.
   */
  private wireAfferentRouting(): void {
    bus.onCortex((event) => {
      if (event.type !== "pns:afferent") return;

      const sourceKind = event.data.sourceKind as string;
      const summary = event.data.summary as string;
      const activeRhythms = this.runner.getActiveRhythms();

      if (activeRhythms.length === 0) return;

      // Find the innermost active rhythm (most specific scope)
      const targetRhythmId = activeRhythms[activeRhythms.length - 1];

      if (sourceKind === "environment-alert" || sourceKind === "environment-change") {
        // Environment signals → hard interrupt. Cortex should stop
        // and reassess — something in the world changed.
        this.runner.interrupt(targetRhythmId, {
          mode: "hard",
          source: "pns-afferent",
          reason: `Environment signal: ${summary}`,
          context: { sourceKind, ...event.data },
        });
      } else if (sourceKind === "parsifal-feedback" || sourceKind === "parsifal-correction") {
        // Parsifal feedback → soft interrupt. Queued for the next gate
        // so Cortex can incorporate it in its next decision.
        this.runner.interrupt(targetRhythmId, {
          mode: "soft",
          source: "pns-afferent",
          reason: `Parsifal input: ${summary}`,
          context: { sourceKind, ...event.data },
        });
      } else {
        // Tool errors, other sources → soft interrupt
        this.runner.interrupt(targetRhythmId, {
          mode: "soft",
          source: "pns-afferent",
          reason: `Afferent signal (${sourceKind}): ${summary}`,
          context: { sourceKind, ...event.data },
        });
      }
    });
  }

  /**
   * Initialize cost tracking for a project with a budget.
   * Called by runProject() when the intent has a budget.
   * Separated from constructor because the budget comes from
   * the ProjectIntent, which arrives at project start — not
   * at Brainstem construction time.
   */
  initCostTracking(budget: CostBudget): CostTracker {
    this.costTracker = new CostTracker(budget);
    registerCostCallback((record) => {
      this.costTracker!.recordCall(record);
      // Update the budgetUtilization vital sign
      this.homeostasis.update("budgetUtilization", this.costTracker!.getUtilization());
    });
    return this.costTracker;
  }

  /**
   * Build a StakeAdjuster that reads per-sense evaluation-influence
   * weights from the plasticity store.
   *
   * The raw stake (sense's self-assessed relevance) is multiplied by
   * the learned weight (how much Cortex has learned to trust that
   * sense's self-assessment). Returns raw stake if no weight is registered.
   */
  private createStakeAdjuster(): StakeAdjuster {
    const store = this.plasticityStore;
    return (senseId: string, rawStake: number): number => {
      const weight = store.get(`evaluator.sense-weight.${senseId}`);
      if (!weight) return rawStake;

      // Weight is normalized (sums to 1.0 across senses). Multiply into
      // the raw stake to modulate influence. Scale by number of senses
      // so the weight doesn't shrink stakes toward zero.
      const senseCount = store.getByCategory("evaluation-influence").length;
      return rawStake * weight.value * senseCount;
    };
  }

  /**
   * Run a single task through the sensory-cortex rhythm.
   * Returns OrchestratorResult via SensoryCortexResult.
   */
  async runTask(context: SensoryCortexContext): Promise<SensoryCortexResult> {
    await this.hippocampus.load();
    await this.worldModel.load();
    await this.basalGanglia.load();
    await this.plasticityStore.loadFromDisk();
    this.thalamus.updateProject(context.intent, context.taste);

    const definition = createSensoryCortexDefinition(
      this.config,
      this.library,
      this.hooks,
      this.wm,
      this.thalamus,
      this.motorCortex,
      this.basalGanglia,
      this.gate,
      this.cognitiveFlexibility,
      this.stakeAdjuster,
    );

    return this.runner.run(definition, context);
  }

  /**
   * Reset per-project state for a new project cycle.
   * Clears working memory and gestalts while preserving cross-project
   * learning (hippocampus, basal ganglia, plasticity, world model, cerebellum).
   */
  prepareForNewProject(projectId: string): void {
    this.wm.reset(projectId);
    this.thalamus.clearAllGestalts();
    this.conversationCortex.reset();
  }

  /**
   * Run a full project — multiple tasks with dependencies.
   * Spawns the project rhythm → task-dispatch → sensory-cortex → build-cycle.
   */
  async runProject(context: ProjectContext): Promise<ProjectResult> {
    await this.hippocampus.load();
    await this.worldModel.load();
    await this.basalGanglia.load();
    await this.plasticityStore.loadFromDisk();
    if (this.hooks instanceof CompositeSubcorticalHooks) {
      this.hooks.setProjectId(context.intent.id);
    }
    this.thalamus.updateProject(context.intent, context.taste);

    const definition = createProjectDefinition(
      this.config,
      this.library,
      this.hooks,
      this.homeostasis,
      this.wm,
      this.thalamus,
      this.scheduler,
      this.motorCortex,
      this.basalGanglia,
      this.gate,
      this.cognitiveFlexibility,
      this.stakeAdjuster,
      this.worldModel,
      this.pns,
      this.driftMonitor,
      this.tasteFeedbackLoop,
      this.planner,
      this.projectDiagnostics,
      this.prospectiveMemory,
      this.costTracker ?? undefined,
      this.cerebellum,
      this.askUser,
    );

    return this.runner.run(definition, context);
  }

  /**
   * Resume from a checkpoint — dispatches by checkpoint kind.
   *
   * - pre-integrate: run integrate + gate for a single build cycle (original behavior)
   * - post-inquiry / post-manifestation / post-plan / post-shael: resume the full
   *   project rhythm, skipping phases that are already complete.
   */
  async runFromCheckpoint(checkpoint: import("../types/checkpoint.js").Checkpoint): Promise<
    | { integrated: unknown; gateDecision: import("../types/rhythm.js").GateDecision<import("../types/brainstem.js").BuildCycleResult> }
    | import("../types/brainstem.js").ProjectResult
  > {
    // Load persistent stores
    await this.hippocampus.load();
    await this.worldModel.load();
    await this.basalGanglia.load();
    await this.plasticityStore.loadFromDisk();

    // Restore transient state from checkpoint
    if (checkpoint.workingMemory) {
      this.wm.restore(checkpoint.workingMemory as import("../types/working-memory.js").WorkingMemoryState);
    }
    if (checkpoint.plasticity) {
      this.plasticityStore.restore(checkpoint.plasticity as import("../types/plasticity.js").ConnectionSnapshot);
    }
    if (checkpoint.gestalt && checkpoint.taskId) {
      this.thalamus.restoreGestalt(
        checkpoint.taskId,
        checkpoint.gestalt as import("../types/task-gestalt.js").TaskGestalt,
      );
    }

    // Restore project context from checkpoint's initialContext
    const ctx = checkpoint.initialContext as Record<string, unknown>;
    if (ctx.intent && ctx.taste) {
      this.thalamus.updateProject(
        ctx.intent as import("../types/intent.js").ProjectIntent,
        ctx.taste as import("../types/intent.js").TasteProfile,
      );
    }

    // ── Dispatch by checkpoint kind ──
    if (checkpoint.kind === "pre-integrate") {
      // Original behavior: run integrate + gate for one build cycle
      const definition = createBuildCycleDefinition(
        this.config,
        this.library,
        this.hooks,
        this.wm,
        this.thalamus,
        this.motorCortex,
        this.basalGanglia,
        this.gate,
        this.cognitiveFlexibility,
        this.stakeAdjuster,
        this.pns,
        this.amygdala,
      );

      return this.runner.runFromCheckpoint(checkpoint, definition);
    }

    // Project-level resume — run the full project rhythm with resume markers
    return this.resumeProject(checkpoint);
  }

  /**
   * Resume the project rhythm from a project-level checkpoint.
   * Seeds the accumulator with resume markers so the project rhythm's
   * execute phase skips to the right point.
   */
  private async resumeProject(
    checkpoint: import("../types/checkpoint.js").Checkpoint,
  ): Promise<import("../types/brainstem.js").ProjectResult> {
    const ctx = checkpoint.initialContext as Record<string, unknown>;
    const intent = ctx.intent as import("../types/intent.js").ProjectIntent;
    const taste = ctx.taste as import("../types/intent.js").TasteProfile;

    if (this.hooks instanceof CompositeSubcorticalHooks) {
      this.hooks.setProjectId(intent.id);
    }
    this.thalamus.updateProject(intent, taste);

    const context: import("../types/brainstem.js").ProjectContext = {
      intent,
      taste,
      tasks: [], // empty = planner path, resume markers handle the skip
    };

    const definition = createProjectDefinition(
      this.config,
      this.library,
      this.hooks,
      this.homeostasis,
      this.wm,
      this.thalamus,
      this.scheduler,
      this.motorCortex,
      this.basalGanglia,
      this.gate,
      this.cognitiveFlexibility,
      this.stakeAdjuster,
      this.worldModel,
      this.pns,
      this.driftMonitor,
      this.tasteFeedbackLoop,
      this.planner,
      this.projectDiagnostics,
      this.prospectiveMemory,
      this.costTracker ?? undefined,
      this.cerebellum,
      this.askUser,
    );

    // Seed accumulator with resume markers — the project rhythm detects these
    // and skips to the appropriate phase
    const initialAccumulator: Record<string, unknown> = {
      __resumeKind: checkpoint.kind,
      __resumeData: checkpoint.accumulator,
    };

    return this.runner.run(definition, context, undefined, initialAccumulator);
  }

  /** Get the working memory instance. */
  getWorkingMemory(): WorkingMemory {
    return this.wm;
  }

  /** Get the thalamus for advanced use. */
  getThalamus(): Thalamus {
    return this.thalamus;
  }

  /** Get the attention scheduler. */
  getScheduler(): AttentionScheduler {
    return this.scheduler;
  }

  /** Get the motor cortex instance. */
  getMotorCortex(): MotorCortex {
    return this.motorCortex;
  }

  /** Get the basal ganglia instance. */
  getBasalGanglia(): BasalGanglia {
    return this.basalGanglia;
  }

  /** Get the gate instance. */
  getGate(): Gate {
    return this.gate;
  }

  /** Get the cerebellum (prediction engine). */
  getCerebellum(): Cerebellum {
    return this.cerebellum;
  }

  /** Get the hippocampus (episodic memory + potentiation). */
  getHippocampus(): Hippocampus {
    return this.hippocampus;
  }

  /** Get the plasticity store (connection weights). */
  getPlasticityStore(): PlasticityStoreImpl {
    return this.plasticityStore;
  }

  /** Get the tonic dopamine tracker. */
  getTonicTracker(): TonicTracker {
    return this.tonicTracker;
  }

  /** Get the world model (Weltanschauung). */
  getWorldModel(): WorldModel {
    return this.worldModel;
  }

  /** Get cognitive flexibility (perseveration detection + strategy reset). */
  getCognitiveFlexibility(): CognitiveFlexibility {
    return this.cognitiveFlexibility;
  }

  /** Get the PNS (I/O boundary). */
  getPns(): PeripheralNervousSystem {
    return this.pns;
  }

  /** Get the drift monitor (trajectory vs. intent). */
  getDriftMonitor(): DriftMonitor {
    return this.driftMonitor;
  }

  /** Get project diagnostics (project-level self-healing). */
  getProjectDiagnostics(): ProjectDiagnostics {
    return this.projectDiagnostics;
  }

  /** Get prospective memory (future intentions with trigger conditions). */
  getProspectiveMemory(): ProspectiveMemory {
    return this.prospectiveMemory;
  }

  /** Get the amygdala (priority override + threat detection). */
  getAmygdala(): Amygdala {
    return this.amygdala;
  }

  /** Get the exteroception system (external world monitoring). */
  getExteroception(): ExteroceptionSystem {
    return this.exteroception;
  }

  /** Get the escalation handler (pause/resume + Parsifal-facing briefings). */
  getEscalationHandler(): EscalationHandler {
    return this.escalationHandler;
  }

  /** Set a delivery adapter for active escalation transport to the Parsifal. */
  setEscalationDelivery(adapter: import("../types/brainstem.js").EscalationDeliveryAdapter): void {
    this.escalationHandler.setDeliveryAdapter(adapter);
  }

  /**
   * Set the Parsifal interaction callback for inquiry and approval.
   * Also wires the callback as an AgentSdkDeliveryAdapter for escalations.
   */
  setAskUser(askUser: (question: string) => Promise<string>): void {
    this.askUser = askUser;
    this.escalationHandler.setDeliveryAdapter(new AgentSdkDeliveryAdapter(askUser));
  }

  /**
   * Wire a conversation transport and activate the conversation cortex.
   *
   * This replaces setAskUser for the conversational experience:
   * inquiry, approval, and escalation all flow through the conversation.
   * Multiple transports can be active simultaneously (terminal + web).
   */
  setConversationTransport(transport: ConversationTransport): void {
    this.conversationCortex.addTransport(transport);

    // Wire askUser through the conversation cortex so inquiry,
    // approval, and escalation questions appear as conversation messages.
    if (!this.askUser) {
      this.askUser = (question: string) => this.conversationCortex.askUser(question);
      // No AgentSdkDeliveryAdapter needed — escalations route through
      // the conversation cortex via event bus subscription.
    }

    // Activate if not already listening
    this.conversationCortex.activate();
  }

  /** Get the conversation cortex (bidirectional Parsifal channel). */
  getConversationCortex(): ConversationCortex {
    return this.conversationCortex;
  }

  /** Get the taste feedback loop (taste divergence proposals). */
  getTasteFeedbackLoop(): TasteFeedbackLoop {
    return this.tasteFeedbackLoop;
  }

  /**
   * Receive a Parsifal response to a taste divergence proposal.
   *
   * This closes the learning loop:
   *   1. TasteFeedbackLoop surfaced a proposal (via dispatch:taste-proposal event)
   *   2. Parsifal responded with update/keep/nuanced/deferred
   *   3. This method routes the response through satisfaction-signal
   *      to produce plasticity weight updates and taste profile mutations
   *   4. Changes propagate via Thalamus to all future consumers
   *
   * Returns true if the response was processed, false if the proposal
   * wasn't found (expired or already responded).
   */
  receiveTasteResponse(response: SatisfactionResponse): boolean {
    // 1. Route to taste feedback loop — attaches response to proposal
    const proposal = this.tasteFeedbackLoop.receiveResponse(response);
    if (!proposal) return false;

    // 2. Process through satisfaction signal — compute plasticity mapping
    const mapping = processTasteResponse(response, proposal);

    // 3. Apply plasticity weight updates
    applyMapping(mapping, this.plasticityStore);

    // 4. Apply taste profile mutation if present
    if (mapping.tasteUpdate) {
      const currentTaste = this.thalamus.getTaste();
      if (currentTaste) {
        const updatedTaste = applyTasteUpdate(currentTaste, mapping.tasteUpdate);
        this.thalamus.updateTaste(updatedTaste);
        persistTasteProfile(updatedTaste);
      }
    }

    return true;
  }

  /**
   * Receive a task-level approval or correction signal.
   *
   * Lighter-weight than taste responses — adjusts per-sense evaluation
   * influence weights based on whether the Parsifal approved or corrected
   * a task's output.
   */
  receiveTaskSignal(signal: SatisfactionSignal, activeSenseNames: string[]): void {
    const mapping = processTaskSignal(signal, activeSenseNames);
    applyMapping(mapping, this.plasticityStore);
  }

  /** Get the cost tracker (null when no budget is set). */
  getCostTracker(): CostTracker | null {
    return this.costTracker;
  }

  /** Get the project cost summary. Returns null when no budget is set. */
  getCostSummary(): ProjectCostSummary | null {
    return this.costTracker?.getProjectSummary() ?? null;
  }

  /** Interrupt a running rhythm. */
  interrupt(rhythmId: string, interrupt: Interrupt): void {
    this.runner.interrupt(rhythmId, interrupt);
  }

  /** Get current vital signs. */
  getVitals(): VitalSigns {
    return this.homeostasis.getVitals();
  }

  /** Get the homeostasis monitor (for components that need to report vitals). */
  getHomeostasis(): HomeostasisMonitor {
    return this.homeostasis;
  }

  /** Get the rhythm runner (for advanced use). */
  getRunner(): RhythmRunnerImpl {
    return this.runner;
  }
}

// Re-export key types for consumers
export { RhythmRunnerImpl } from "./runner.js";
export { HomeostasisMonitor } from "./homeostasis.js";
export { NoOpSubcorticalHooks } from "./stubs.js";
export type { SubcorticalHooks } from "./stubs.js";
export type { ReflexAction } from "./homeostasis.js";
export { EscalationError, RhythmAbortedError } from "./errors.js";
export { EscalationHandler } from "./escalation-handler.js";
export { EventBusDeliveryAdapter, AgentSdkDeliveryAdapter, formatEscalationForParsifal } from "./delivery-adapters.js";
export { Thalamus } from "../kernel/thalamus.js";
export { AttentionScheduler } from "../kernel/attention-scheduler.js";
export { MotorCortex } from "../kernel/motor-cortex.js";
export { BasalGanglia } from "../kernel/basal-ganglia.js";
export { Cerebellum } from "../subcortical/cerebellum.js";
export { Hippocampus } from "../subcortical/hippocampus.js";
export { PlasticityStoreImpl } from "../subcortical/plasticity-store.js";
export { CompositeSubcorticalHooks, CerebellumSubcorticalHooks } from "../subcortical/hooks.js";
export { TonicTracker } from "../subcortical/tonic.js";
export { Amygdala } from "../subcortical/amygdala.js";
export { ExteroceptionSystem } from "../subcortical/exteroception.js";
export { CognitiveFlexibility } from "../kernel/cognitive-flexibility.js";
export { PeripheralNervousSystem } from "../kernel/pns.js";
export { DriftMonitor } from "../kernel/drift-monitor.js";
export { TasteFeedbackLoop } from "../kernel/taste-feedback.js";
export { processTasteResponse, processTaskSignal, applyMapping, applyTasteUpdate } from "../kernel/satisfaction-signal.js";
export { ProjectDiagnostics } from "../kernel/project-diagnostics.js";
