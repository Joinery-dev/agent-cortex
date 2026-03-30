# Agent Cortex — Comprehensive Audit Checklist

> **Purpose:** Every independently auditable aspect of Cortex. Work through one section at a time, verify against actual code.
>
> **Last updated:** 2026-03-29. Includes shaela ontology, graph builder pipeline, exteroception, nursery, and all NE expansion changes.

---

## A. Brainstem — Vital Rhythm (10 features)

- [ ] **A1. Project Lifecycle** — Six beats: intake → planning → dispatch → execution → between-tasks → completion. Verify project.ts orchestrates all six.
- [ ] **A2. Task Dispatch Rhythm** — prepare/execute/integrate/gate cycle. Verify accumulator state, signal assembly, all 7 scheduler action handlers.
- [ ] **A3. Sensory Cortex Rhythm** — consult → explore → build → evaluate → resolve. Verify sensory-cortex.ts phases.
- [ ] **A4. Build Cycle Rhythm** — premotor → primary → proprioception → gate. Verify revision loop, sandbox management, NE recomputation at gate.
- [ ] **A5. Rest Rhythm** — 7 consolidation steps. Verify rest.ts executes all. Verify arousal fatigue (cumulativeNE) resets on rest completion.
- [ ] **A6. Nursery Rhythm** (formerly gestation) — post-phase stress testing. Verify nursery.ts + nursery-scanner.ts + nursery-consul.ts pipeline.
- [ ] **A7. Homeostasis** — 8 vital signs (WM load, prediction accuracy, context capacity, budget utilization, learning signal health, weight volatility, weight displacement, tonic dopamine). Verify each vital → reflex mapping.
- [ ] **A8. Cost Tracker** — Every LLM call recorded, per-task + per-project totals. Verify milestones at 80%/100%. Verify escalation behavior (never throttle quality).
- [ ] **A9. Escalation Handler** — Pause rhythms, assemble briefing via Thalamus, gather sense assessments (up to 4 non-flat senses), deliver via adapter. Verify resolution resumes rhythm.
- [ ] **A10. Delivery Adapters** — Pluggable escalation transport. Verify adapter interface and fire-and-forget delivery.

## B. PFC — Executive Function (22 features)

- [ ] **B1. Planner Phase A** — Interactive manifestation: senses query (inquiry) → Motor Cortex synthesizes → question-asker approves. Verify manifestation task creation + extraction.
- [ ] **B2. Planner Phase B.1** — Shael decomposition: backward reasoning from manifested future to shaels (phases), not tasks. Verify ShaelDecompositionSchema.
- [ ] **B3. Planner Phase B.2** — Three-step dependency wiring: (1) Semantic Mapping (LLM - capability tokens) → (2) Algorithmic Derivation (code - provides/consumes matching) → (3) Affinity Analysis + Correction (LLM). Verify Graph Builder pipeline.
- [ ] **B4. Planner Phase B.3** — PFC Review: structural warnings, dependency patching. Verify it runs when NE ≥ 0.7.
- [ ] **B5. Planner Replan** — Mid-project replanning with completed task context. Verify NE passed at replan time.
- [ ] **B6. Planner Hierarchical Stubs** — assessHierarchyDepth() and planPhase() exist. Verify PlannedPhase, HierarchyAssessment, PhasePlanResult types exported.
- [ ] **B7. Generative Completion** — After shalem: "What questions couldn't have been asked before?" Verify proposals surface to question-asker.
- [ ] **B8. Working Memory** — Tasks, scores, patterns, decisions, questions, territory observations, inhibited senses, load computation. Verify all slots.
- [ ] **B9. Attention Scheduler** — 11-step priority cascade, 7 action types (dispatch-task, dispatch-gestate, observe, escalate, rest, replan, complete). Verify NE-responsive observe threshold (0.9 - 0.5 * NE).
- [ ] **B10. Conviction Loop** — necessity → conviction → SOL → shape. Verify 3 verdicts (continue/reshape/escalate). Verify NE-modulated thresholds.
- [ ] **B11. Drift Monitor** — Quick check (every task) + deep analysis (phase gates). Verify taste divergence detection.
- [ ] **B12. Norepinephrine** — 5 weighted inputs: maturity 0.27, risk 0.23, novelty 0.23, conviction 0.17, urgency 0.10. Verify weights sum to 1.0. Verify max-blend formula (40/60). Verify all risk factors: phaseGateProximity, dependencyFanOut, decliningTrends, wmPressure, weightVolatility, budgetPressure, observationPressure, recentFailure, taskComplexity.
- [ ] **B13. Cognitive Flexibility** — Perseveration detection → shouldReset/shouldEscalate. Verify approach history and sandbox discard.
- [ ] **B14. World Model** — Weltanschauung synthesis. Verify rebuild at rhythm boundaries. Verify maxim extraction feeds Thalamus.
- [ ] **B15. World Model Store** — Cross-project maxim persistence to disk (~/.agent-cortex/world-model/). Verify atomic writes and date serialization.
- [ ] **B16. Prospective Memory** — Trigger conditions that fire when specific tasks become ready. Verify fast-path check in dispatch.
- [ ] **B17. Prospective Preparation** — Forward briefings: predicted tensions + bottlenecks. Verify Thalamus seeding.
- [ ] **B18. Integration Check** — Evaluation-only sensory cortex for cross-task coherence at phase gates.
- [ ] **B19. Deep Synthesis** — LLM observation + principle recombination → proposals. Verify blast radius threshold (30%) determines replan vs surgery.
- [ ] **B20. Graph Surgery** — 4 operations: insert, amend, rework, reorder. Verify blast radius computation + validation.
- [ ] **B21. Quick Triage** — No-LLM scan, amend-only, NE threshold. Verify flags for deep synthesis at pressure > 0.7.
- [ ] **B22. Project Discovery** — Automated project profiling: kind, language, frameworks, dev/test/build/lint commands. Verify all three entry points (greenfield, mid-project, existing).

## C. Thalamus (7 sub-aspects)

- [ ] **C1. Source reading** — Verify all sources: WM, Hippocampus, Cerebellum, PNS, Project/Intent, World Model, Forward Briefing.
- [ ] **C2. Gestalt assembly** — assembleGestalt() per task, cached in Map. Verify gestalt mutability (attachPrediction, attachSpeedOfLight, attachExplorePath).
- [ ] **C3. 8 briefing types** — consultation, motor, evaluation, scheduling, escalation, inhibition, integrationCheck, senseQuestion.
- [ ] **C4. NE modulation** — BriefingDepth (full/standard/compressed/minimal). Verify tone directiveness.
- [ ] **C5. Pre-indexed lookups** — Principles keyed by sense ID for O(1) evaluation briefing.
- [ ] **C6. Observation buffer** — harvestObservations() on Thalamus: reads WM observations, applies source credibility filtering (≥70% dismissal rate) + NE re-filtering at harvest time + BriefingMeta. Wired at observe-action + phase-gate deep synthesis.
- [ ] **C7. Gestalt-from-cache briefings** — forConsultationFromGestalt, forMotorFromGestalt, etc. Verify they read cached gestalt.

## D. Sensory + Motor (10 features)

- [ ] **D1. Consul** — Parallel consultation, stake + ceiling, evaluation plan derivation.
- [ ] **D2. Re-consultation** — Selective second round. Verify generation tracking.
- [ ] **D3. Explore** — 3-5 divergent sketches, surprise × quality. Verify exploit mode skipping.
- [ ] **D4. Evaluator** — Agentic (NE ≥ 0.3) vs text-only. Verify observation levels. Verify degradation detection.
- [ ] **D5. Evaluation Weighter** — score × adjustedStake. Verify composite + weighted acceptability.
- [ ] **D6. Resolver** — Tension detection (≥4 gap, stake-modulated severity) + LLM resolution + revised instructions.
- [ ] **D7. Motor Cortex** — Efference → premotor → primary → proprioception. Verify mid-build consultation callback. Verify agentic vs text-only.
- [ ] **D8. Sense Questioner** — Lightweight mid-build question answering. Verify single structured LLM call.
- [ ] **D9. PNS** — Consumer-aware (builder vs evaluator). 3 NE tiers. Verify capability registry + innate tools.
- [ ] **D10. Resolution Quality** — 50% gap shrinkage + 50% score maintenance. Verify collapse detection + quality=0 for capitulation.

## E. 14 Senses

- [ ] **E1–E14.** Design, Content Craft, DX, Correctness, Security, Reliability, Compliance & Privacy, Intent Alignment, SEO & Discovery, i18n, Performance, Maintainability, Observability, Scalability. Verify each has consultation + evaluation personas with appropriate receptors.

## F. Subcortical — Learning & Memory (14 features)

- [ ] **F1. Cerebellum** — Forward model, per-sense SOL ceilings, approach-specific ceilings, accuracy rolling window. Verify recordOutcome.
- [ ] **F2. Forward Model** — Episode similarity, weighted prediction, approach ceiling. Verify similar episode lookup.
- [ ] **F3. Dopamine** — actual − predicted, per-receptor weighted by stake + confidence. Verify aggregate computation.
- [ ] **F4. Projections** — 4 destinations: hippocampal, striatal, plasticity, prefrontal. Verify all computed and routed.
- [ ] **F5. Hippocampus** — Episodes → principles, per-sense crystallization, hippocampal simulation, disk persistence, cross-project. Verify full lifecycle.
- [ ] **F6. Potentiation** — 3 triggers: pattern density (≥3), surprise, contradiction. Verify clustering + LLM extraction.
- [ ] **F7. Basal Ganglia** — Routines, direct/hyperdirect, explore/exploit, inhibition. Verify confidence decay. Note: BG→Hippocampus merge PLANNED but NOT done.
- [ ] **F8. Plasticity** — Per-sense weights, dopamine-driven updates, resolution quality deltas, taste feedback deltas. Verify persistence.
- [ ] **F9. Amygdala** — 4 built-in detectors + hippocampus-installed. Verify urgent vs emergency. Verify NE override to 0.95.
- [ ] **F10. Approach Classifier** — Archetype tagging → Cerebellum approach-specific SOL.
- [ ] **F11. Detectors** — DESTRUCTIVE_PATTERNS + SECURITY_PATTERNS regex. Verify scope-violation + data-loss detectors.
- [ ] **F12. Exteroception** — Generic monitor registry + mini cerebellum cadence learning + two-path routing (urgent → Amygdala, normal → batch at between-tasks). Verify sentry loop and credibility tracking.
- [ ] **F13. Hooks** — SubcorticalHooks interface, 30+ methods. Verify full implementation vs NoOp stubs.
- [ ] **F14. Episode Builder** — Task story construction from OrchestratorResult.

## G. Infrastructure (10 features)

- [ ] **G1. Event Bus** — CortexEvent, severity routing, rhythm context stack. Verify all components emit.
- [ ] **G2. LLM Client** — Retry, cost recording per call. Verify cost callback.
- [ ] **G3. Structured LLM** — Zod validation. Verify fallback on parse failure.
- [ ] **G4. Prompt Library** — 40+ prompt pairs. Verify each call site uses correct prompt.
- [ ] **G5. Visual Capture** — Playwright screenshots + performance metrics. Verify graceful degradation.
- [ ] **G6. Trace Collector + Server** — In-memory buffer + SSE streaming. Verify buffer rotation.
- [ ] **G7. Project Diagnostics** — Phase summary, completion tracking, retrospective.
- [ ] **G8. System Overrides** — Research-driven threshold tuning. Verify override chain.
- [ ] **G9. Sandbox** — Git branch isolation. Verify create/merge/discard lifecycle.
- [ ] **G10. Runtime Manager** — Dev server lifecycle for agentic evaluation. Verify start/stop/health.

## H. Removed Features (verify absence)

- [ ] **H1. Auto-Research / Researcher** — REMOVED. Verify researcher.ts does not exist. Verify scheduler no longer has dispatch-research action. Passive learning stack remains.
- [ ] **H2. Research Rhythm** — REMOVED. Verify research.ts does not exist in brainstem/rhythms/.
- [ ] **H3. Reference Discovery Rhythm** — NOT FOUND. Verify reference-discovery.ts does not exist.

---

## I. Integration Audits (connections between features)

- [ ] **I1. Thalamus ← all sources** — Verify data flows from WM, Hippocampus, Cerebellum, PNS, Project/Intent, World Model, Forward Briefing.
- [ ] **I2. NE → all 14+ downstream effects** — Verify NE is read by: Thalamus depth, BG suppression, evaluation mode, motor mode, proprioception toggle, PNS tools, gate strategy, model selector, observation threshold, routine bucketing, explore/exploit, briefing compression, escalation thresholds, planner granularity. Plus arousal fatigue accumulation.
- [ ] **I3. Between-Tasks fast path** — Verify all steps execute: dopamine → episode → routines → resolution learning → prospective prep → clear gestalt → observation drain → world model rebuild → drift check → quick triage.
- [ ] **I4. Phase Gate slow path** — Verify: integration check → deep synthesis → graph surgery → budget reconciliation → taste evaluation → deliberation audit.
- [ ] **I5. Dopamine → 4 projections** — Verify hippocampal, striatal, plasticity, prefrontal all computed and routed.
- [ ] **I6. Escalation triggers** — Verify all sources wired: conviction, cog flex, scheduler cascade, amygdala.
- [ ] **I7. Revision loop** — gate reject → resolutions → premotor → rebuild → re-eval → gate.
- [ ] **I8. Consultation → Motor** — Verify consultation results folded into motor briefing via Thalamus.
- [ ] **I9. Efference → Consultation** — Verify ceilings included in consultation briefing.
- [ ] **I10. Graph Surgery → Task Graph** — Verify proposals mutate live graph in dispatch accumulator.
- [ ] **I11. Planning pipeline B.1→B.2→B.3** — Verify shael decomposition feeds graph builder feeds PFC review in sequence.
- [ ] **I12. Exteroception → Between-Tasks** — Verify sentry signals route to between-tasks batch processing (non-urgent) or Amygdala (urgent).
- [ ] **I13. Nursery → Graph Surgery** — Verify nursery findings create graph surgery proposals for issues found.

## J. Contract Audits

- [ ] **J1. Prompt ↔ Context** — For 5 high-leverage prompts: does assembled prompt include all referenced context?
- [ ] **J2. Event taxonomy** — List all emitted events. Verify each consumed somewhere. Flag orphans.
- [ ] **J3. Type ↔ Runtime** — Spot-check 10 key interfaces against runtime values.
- [ ] **J4. Configuration defaults** — All thresholds, weights, limits have rationale and sensible value.
- [ ] **J5. Override chain** — Verify: research override → NE-modulated → config default. For each overridable threshold.
- [ ] **J6. Shaela vocabulary consistency** — Verify shael/shana/shalem used consistently in code, prompts, types, and docs.

## K. Lifecycle Audits (end-to-end)

- [ ] **K1. Happy path task** — dispatch → thalamus → consul → explore → motor → eval → gate accept → sandbox merge → between-tasks → learning.
- [ ] **K2. Revision cycle** — gate reject → resolutions → premotor revise → rebuild → re-eval → gate accept.
- [ ] **K3. Strategy reset** — conviction reshape → cog flex → shouldReset → discard sandbox → fresh approach.
- [ ] **K4. Learning loop** — eval → dopamine → projections → hippocampus records → potentiation → principle → next task's thalamus briefing.
- [ ] **K5. Escalation** — trigger → handler → Parsifal briefing → sense assessments → Parsifal response → resume.
- [ ] **K6. Rest cycle** — homeostasis trigger (including arousal fatigue) → rest rhythm → consolidation → resume → cumulativeNE reset.
- [ ] **K7. Taste feedback** — drift detect → propose (gated) → sense verify → Parsifal responds → satisfaction signal → plasticity.
- [ ] **K8. Sandbox lifecycle** — create → build → merge/discard/leave.
- [ ] **K9. Proactive discovery** — observation → WM → quick triage → amend proposal / flag deep synthesis → graph surgery.
- [ ] **K10. Nursery** — phase complete → scheduler dispatches → surface area scan → stress scenarios → execute → findings → graph surgery.
- [ ] **K11. Planning pipeline** — intake → Phase A manifestation → Phase B.1 shael decomposition → B.2 graph builder (semantic map → derive deps → affinity analysis) → B.3 PFC review → task graph.
- [ ] **K12. Exteroception** — external signal → sentry triage → urgent path (Amygdala) or normal path (between-tasks batch) → observation stored.

## L. Quality Audits

- [ ] **L1. Prompt quality** — 5 high-leverage prompts: planner, motor, evaluator, resolver, consultation. Manually review clarity and output quality.
- [ ] **L2. Sense completeness** — Each of 14 senses has appropriate receptors for its domain.
- [ ] **L3. Error handling** — LLM fail, tool fail, sense fail, NaN dopamine, missing NE inputs.
- [ ] **L4. Robustness** — Empty graph, zero budget, no senses, cold-start Cerebellum, first project.
- [ ] **L5. Persistence** — Hippocampus + plasticity + world model store persist to disk, survive across sessions, cross-project principles travel.
- [ ] **L6. Diagram accuracy** — All 3 system diagrams match code. No stale labels, missing components, wrong connections.

---

## Summary

| Section | Count | Covers |
|---------|-------|--------|
| A. Brainstem | 10 | Rhythms, homeostasis, cost, escalation |
| B. PFC | 22 | Planning pipeline, scheduling, executive function |
| C. Thalamus | 7 | Sources, gestalt, briefings, modulation |
| D. Sensory + Motor | 10 | Consultation, evaluation, building |
| E. 14 Senses | 14 | Domain coverage per sense |
| F. Subcortical | 14 | Learning, memory, prediction, exteroception |
| G. Infrastructure | 10 | Events, LLM, prompts, sandbox, runtime |
| H. Removed | 3 | Verify absence of cut features |
| I. Integration | 13 | Cross-component connections |
| J. Contracts | 6 | Interface ↔ reality |
| K. Lifecycles | 12 | End-to-end sequences |
| L. Quality | 6 | Prompts, robustness, persistence |
| **Total** | **127** | |
