# Worldview Catalog

Every cognitive act Cortex performs, with the contract a worldview frame must fulfill.

When you write a worldview, you write a frame for each act. The frame IS the prompt body — it replaces the default text entirely. The structural parts (JSON schemas, score ranges, output constraints) stay in code and are appended automatically.

For each act below:
- **What it does** — the cognitive purpose
- **When it runs** — what triggers it in Cortex
- **Inputs the LLM sees** — dynamic context assembled by Cortex
- **Output the LLM must produce** — exact JSON schema or output format
- **Structural constraints** — rules the frame must honor (score ranges, enums, process steps)
- **What the frame must convey** — the worldview-dependent part: identity, epistemology, orientation

---

## consultation

**What it does:** A sense evaluates a task from its dimension. Receptors fire or stay silent. The sense provides guidance for the builder and stakes its claim on relevance.

**When it runs:** When a new task enters the sensory cortex. Each active sense consults independently. Also used for mid-build sense questions (senseQuestionSystem) and re-consultation after evaluation (reconsultationSystem).

**Functions:** consultationSystem, reconsultationSystem, senseQuestionSystem

**Inputs the LLM sees:**
- Sense identity: name, sensitivity, pathway/receptor tree
- Task: description, context
- Intent: summary, audience, vision, success criteria, constraints
- Taste: dissolved into natural language for this sense
- Enrichment: world model maxims, established patterns, decisions, score trends, open questions, principles from experience, predicted tensions, efference copy (builder feasibility), capabilities, mode (explore/leverage), prospective directives

**Output (consultation):**
```json
{
  "firings": [
    { "receptorId": "string", "signal": "string", "intensity": 0.0-1.0 }
  ],
  "guidance": "string (actionable direction for the builder)",
  "stake": 0.0-1.0
}
```

**Output (re-consultation):**
```json
{
  "perspective": "string (UPDATED perspective for next iteration)",
  "evaluators": ["receptor-id-1", "receptor-id-2"],
  "stake": 0.0-1.0,
  "ceiling": 1-10,
  "ceilingRationale": "string"
}
```

**Output (sense question):**
```json
{
  "answer": "string (direct answer)",
  "confidence": 0.0-1.0,
  "rationale": "string (why, from this dimension)"
}
```

**Structural constraints:**
- Intensity: 0.0-1.0 (0.1 = barely relevant, 0.9 = critical)
- Stake: 0.0-1.0 (0.0 = irrelevant to this task, 1.0 = critical)
- Ceiling: 1-10 (theoretical max score for this dimension on this task)
- Guidance must be actionable, not a list of concerns
- Written in the sense's own voice
- Silent receptors should not fire

**What the frame must convey:**
- How a task "arrives" at a sense — what the sense is looking for
- What it means for a receptor to "fire" — what detection is
- What stake represents — why this dimension matters or doesn't
- The relationship between sensing and the worldview's epistemology

---

## evaluation

**What it does:** A sense judges completed work from its dimension. Scores quality, determines acceptability, flags tensions with other dimensions, assesses whether re-consultation would help.

**When it runs:** After the motor cortex produces work. Each active sense evaluates independently. Two variants: agentic (has tools to examine artifacts) and non-agentic (judges from work summary).

**Functions:** evaluatorAgenticSystem, evaluatorSystem

**Inputs the LLM sees:**
- Sense identity: name, sensitivity, activation path
- Task description
- The work produced (builder's summary or direct artifact access)
- The sense's original perspective on this task
- Trend context: how this sense has scored recently
- Prediction context: what the cerebellum predicted
- (Agentic only) Changed files list, runtime URL, visual captures

**Output:**
```json
{
  "score": 1-10,
  "acceptable": true/false,
  "assessment": "string (specific, evidence-based)",
  "tensions": [
    { "withDimension": "string", "description": "string" }
  ],
  "suggestions": ["string (specific, actionable)"],
  "improvementPotential": {
    "level": "significant|moderate|marginal|none",
    "description": "string (optional)"
  },
  "observations": [
    {
      "kind": "file-read|search-result|lint-output|test-output|runtime-check|screenshot|web-vitals|other",
      "target": "string",
      "finding": "string",
      "interpretation": "string"
    }
  ]
}
```
(observations array is agentic-only)

**Structural constraints:**
- Score 1-10: 1-3 fundamental failure, 4-5 below acceptable, 6-7 acceptable, 8-9 good, 10 exceptional
- Acceptability is judgment, not formula (a 5 can be acceptable, a 7 might not be)
- Improvement potential: significant = original perspective contradicted by reality, moderate = could refine, marginal = minor, none = fully anticipated
- Agentic evaluators MUST NOT modify files — observe only
- Must evaluate ONLY through this sense's lens
- Must cite specific evidence, not vague praise/criticism

**What the frame must convey:**
- What "good" means under this worldview — what the evaluator is actually looking for
- How to distinguish surface compliance from deep quality
- What evidence matters — what to observe and how to interpret it
- The relationship between evaluation and the worldview's value system

---

## building

**What it does:** The motor cortex produces the artifact. Reads sense guidance, navigates tensions, builds the actual thing.

**When it runs:** After consultation and premotor planning. Two variants: standard (produces text output) and agentic (has tools to read/write files, run commands). Also covers revision (rebuilding after evaluation feedback).

**Functions:** motorCortexSystem, motorCortexAgenticSystem, revisionPrompt

**Inputs the LLM sees:**
- Task description
- Intent: summary, audience, vision, success criteria, constraints
- Taste: dissolved for the builder
- Sense perspectives: each active sense's guidance, stake, ceiling
- Enrichment: world model maxims, patterns, decisions, score trends, capabilities, principles, predictions, speed of light, bottleneck senses, mode (explore/leverage)
- Implementation plan: approach, steps, tension strategies, risks
- (Revision) Previous work + sorted evaluation failures with evidence + resolution instructions

**Output:** The complete, working artifact (not JSON — the actual code, copy, or design). Agentic variant also provides a summary of files changed, decisions made, and adaptations.

**Structural constraints:**
- Must produce the actual artifact, not a description or plan
- Where senses agree, follow their guidance
- Where senses conflict, find synthesis (not average, not compromise)
- Agentic: Read before modifying, follow plan steps, verify work, use right tools
- Revision: Address high-stake issues first (ordered by stake x severity), rebuild relevant sections while keeping what worked

**What the frame must convey:**
- Who the builder IS under this worldview — what building means
- What the artifact IS — an embodied answer, a structural solution, an engineering deliverable
- How to navigate tension between senses — what resolution looks like
- What "complete" means — when the artifact is done
- The relationship between building and the worldview's purpose

---

## planning

**What it does:** The premotor cortex plans the implementation approach BEFORE building. Produces a structured plan with steps, tension strategies, risks, and planned intentions.

**When it runs:** Before each build cycle. Also handles revision planning (was the plan wrong or the execution wrong?).

**Functions:** premotorSystem, premotorRevisionUser

**Inputs the LLM sees:**
- Same MotorBriefing as building (task, intent, taste, sense perspectives, enrichment)

**Output:**
```json
{
  "approach": "string (overall strategy, 2-3 sentences)",
  "steps": [
    { "description": "string", "rationale": "string", "addressesConcerns": ["sense names"] }
  ],
  "tensionStrategy": [
    { "senses": ["SenseA", "SenseB"], "synthesis": "string" }
  ],
  "risks": [
    { "area": "string", "likelihood": "low|medium|high", "mitigation": "string" }
  ],
  "confidence": 0.0-1.0,
  "plannedIntentions": [
    { "description": "string", "category": "build|observe|communicate|control", "confidence": 0.0-1.0, "novelty": 0.0-1.0 }
  ]
}
```

**Output (revision):** Same fields plus:
```json
{
  "revisionStrategy": {
    "kind": "execution-error",
    "amendments": ["string"]
  } | {
    "kind": "plan-error",
    "newApproach": "string"
  },
  "delta": "string (what changed and why)"
}
```

**Structural constraints:**
- Steps must be concrete ("Use semantic HTML with ARIA labels" not "Make it accessible")
- Tension strategy must be synthesis, not compromise
- Revision must diagnose: plan wrong (different strategy needed) vs execution wrong (right approach, amend)

**What the frame must convey:**
- What planning-before-building means under this worldview
- How to sequence understanding/work/construction
- What tensions demand from the plan
- The relationship between planning and the worldview's epistemology

---

## decomposition

**What it does:** Decomposes the manifested future into a hierarchical tree of nodes. Backward reasoning from destination to current state.

**When it runs:** During project-level planning (Phase B.1) when no tasks are pre-provided.

**Functions:** shaelDecompositionSystem, shaelDecompositionUser

**Inputs the LLM sees:**
- Manifested future (concrete vision of completed outcome)
- Sense contributions to the vision
- Intent, taste, world model maxims, capabilities
- Budget (if set), NE level (system alertness)

**Output:**
```json
{
  "reasoning": "string (backward reasoning trace)",
  "phases": [
    { "name": "string", "purpose": "string", "gateCondition": "string" }
  ],
  "nodes": [
    {
      "id": "string",
      "description": "string",
      "level": "shael|shana",
      "phaseGroup": "string",
      "parentId": "string|null",
      "gateCondition": "string",
      "necessity": "string",
      "formJustification": "string",
      "scopeJustification": "string"
    }
  ]
}
```

**Structural constraints:**
- level: always "shael" for high-level, "shana" for leaf (protocol tokens)
- Three necessity gates: EXISTENCE (does it need to exist?), FORM (does it need to be this?), SCOPE (does it need this scope?)
- Minimum path — compress, don't expand
- Hierarchy via parentId (null for root)
- Phases are coherent clusters with verifiable gate conditions
- MUST NOT produce dependencies, provides/consumes, affinity groups, or ordering

**What the frame must convey:**
- What a node IS — a question, a milestone, an engineering question
- How to decompose — what the process of breaking down means
- What "right resolution" means — too broad vs too narrow
- The backward reasoning orientation — from future to present
- The relationship between decomposition and the worldview's ontology

---

## pathReasoning

**What it does:** Reasons backward from the manifested future to produce a flat task graph with dependency edges and phase groupings. Also handles replanning mid-project.

**When it runs:** During project-level planning (Phase B) for flat task graphs. Also triggered by drift for replanning.

**Functions:** pathReasoningSystem, replanReasoningSystem

**Inputs the LLM sees:**
- Manifested future, sense contributions
- Intent, taste, maxims, capabilities, budget, NE level
- (Replan only) Completed tasks, escalated tasks, drift summary, drift analysis, diagnostic directive

**Output:**
```json
{
  "reasoning": "string (backward reasoning trace)",
  "phases": [
    { "name": "string", "purpose": "string", "gateCondition": "string" }
  ],
  "tasks": [
    {
      "id": "string",
      "description": "string",
      "dependsOn": ["string"],
      "phaseGroup": "string",
      "necessity": "string",
      "formJustification": "string",
      "scopeJustification": "string"
    }
  ]
}
```

**Structural constraints:**
- Same three gates as decomposition: EXISTENCE, FORM, SCOPE
- Minimum path — if 4 tasks suffice, don't propose 8
- Dependencies: explicit intra-phase, implicit cross-phase
- Phases sequential (later depends on earlier completing)
- (Replan) Build on completed work, don't re-propose. New tasks can depend on completed task IDs.
- NE modulates granularity: high NE = finer decomposition, low NE = coarser

**What the frame must convey:**
- How backward reasoning works — from future to present
- What a task IS — a step in understanding, a structural member, an engineering milestone
- What the minimum path means — economy, not comprehensiveness
- How phases represent verifiable checkpoints

---

## resolution

**What it does:** Mediates tension between two sense evaluations. Finds creative synthesis that satisfies both perspectives. Also includes collapse detection (checking if a resolution was genuine synthesis or capitulation).

**When it runs:** After evaluation, when two senses score the same work with conflicting assessments.

**Functions:** resolverSystem, collapseDetectorSystem

**Inputs the LLM sees:**
- Perspective A: activation path, score, assessment
- Perspective B: activation path, score, assessment
- The work being evaluated
- Learned principles from prior resolutions (optional)
- (Collapse detection) The proposed resolution, current/prior cycle scores

**Output (resolver):**
```json
{
  "strategy": "string (how to resolve)",
  "satisfiesBoth": true/false,
  "revisedInstructions": "string (specific instructions for motor cortex)"
}
```

**Output (collapse detector):**
```json
{
  "details": [
    {
      "tensionIndex": 0,
      "collapsed": true/false,
      "capitulatedSense": "string|null",
      "explanation": "string",
      "reEngagementGuidance": "string (if collapsed)"
    }
  ]
}
```

**Structural constraints:**
- Must NOT pick a winner
- Synthesis > compromise > picking sides
- Compromise (splitting the difference) is last resort
- If no synthesis possible: explain the fundamental tradeoff
- Collapse signs: resolution mirrors one side, concerns dismissed not addressed, no new approach introduced, agrees with higher scorer

**What the frame must convey:**
- What tension IS — a signal, a force, a structural conflict
- How resolution works — deeper understanding, trade-off analysis, finding the subsuming question
- What genuine synthesis looks like vs capitulation
- When tension is genuinely irreconcilable vs when a deeper approach exists

---

## learning

**What it does:** Extracts principles from episodes — living theories about how understanding/quality/construction works. Also refines principles when contradicted and extracts sense-scoped project-local principles. Includes principle verification by senses.

**When it runs:** After episodes accumulate (pattern density), on surprise (unexpected dopamine), on contradiction (episode vs principle). Verification runs before storing new principles.

**Functions:** potentiationExtractSystem, potentiationRefineSystem, potentiationSenseExtractSystem, principleVerificationSystem

**Inputs the LLM sees:**
- Episode cluster: task descriptions, outcomes, cycles, dopamine signals, sense scores, tensions, decisions, approaches
- Trigger: pattern-density, surprise, or contradiction
- Existing principles (to avoid duplication)
- (Refine) Specific principle + contradicting episode
- (Sense-scoped) Filtered to single sense + single project
- (Verification) Principle + source episodes, evaluated by a specific sense

**Output (extract):**
```json
{
  "principle": {
    "statement": "string (living theory)",
    "relevantSenses": ["SENSE_NAME"],
    "domain": "string (short category)",
    "confidence": 0.5-0.8,
    "supersedes": "principle-id|null"
  } | null,
  "reasoning": "string"
}
```

**Output (refine):**
```json
{
  "action": "refine|replace|maintain",
  "revisedStatement": "string (for refine/replace)",
  "revisedConfidence": 0.0-1.0,
  "reasoning": "string"
}
```

**Output (verification):**
```
First line: 0.0-1.0 (agreement)
Then: 1-3 sentence assessment in sense's voice
```

**Structural constraints:**
- Principles must be: DESCRIPTIVE (not prescriptive), TRANSFERABLE, EXPLANATORY, FALSIFIABLE, SENSE-AWARE
- Cannot be trivial ("tasks with more cycles take longer")
- Refine options: narrow scope, replace theory, maintain (outlier)
- Sense-scoped: PROJECT-LOCAL, written in sense's voice, accumulated across episodes
- Verification: domain expert consulted, not rubber stamp
- If existing principle covers pattern: return null or supersede

**What the frame must convey:**
- What learning IS — how episodes crystallize into understanding
- What a principle IS — a living theory, not a rule
- How contradiction drives refinement — the epistemology of updating beliefs
- The relationship between experience and wisdom under this worldview

---

## reflection

**What it does:** Synthesizes Cortex's accumulated experience into maxims — compressed wisdom that carries cognitive (terrain), axiological (values), and volitional (orientation) layers.

**When it runs:** At project start, after significant learning, at project completion. Two scopes: cross-project (portable identity) and per-project (terrain-specific understanding).

**Functions:** weltanschauungSystem

**Inputs the LLM sees:**
- Scope: cross-project or per-project
- Trigger: what prompted this synthesis
- Existing maxims (for evolution)
- Cross-project maxims (context for per-project)
- Project identity: summary, vision, constraints, taste
- Hippocampus: principles, sense principles, significant episodes
- Working memory: patterns, decisions, sense trends, open questions, load, completed count
- Cerebellum: prediction accuracy, composite ceiling, per-sense ceilings, approach bottleneck
- Tonic dopamine: level, trend, samples
- Plasticity: weight summaries
- System health: vitals summary, capabilities

**Output:**
```json
{
  "maxims": [
    {
      "statement": "string (compressed wisdom)",
      "cognitive": "string (what terrain this reveals)",
      "axiological": "string (what matters)",
      "volitional": "string (how to orient)",
      "confidence": 0.0-1.0,
      "supersedes": "maxim-id|null"
    }
  ],
  "reasoning": "string (narrative synthesis)",
  "droppedMaximIds": ["ids no longer valid"]
}
```

**Structural constraints:**
- 3-7 maxims per synthesis
- Each maxim carries THREE interpenetrating layers (cognitive, axiological, volitional) — facets of SAME understanding
- Confidence: 0.3 = tentative, 0.5 = pattern, 0.7 = battle-tested, 0.9 = established
- Maxims EVOLVE, not accumulate — supersede or drop, don't pile on
- Don't restate principles — express what they MEAN together
- Cross-project: portable wisdom, changes slowly
- Per-project: terrain-specific, evolves as project teaches

**What the frame must convey:**
- What synthesis of understanding IS — not analysis, not summary
- What a maxim IS — compressed wisdom, not a bullet point
- How three layers interpenetrate — the structure of wisdom
- The relationship between experience and self-understanding under this worldview

---

## coherence

**What it does:** Checks whether what was BUILT matches what was PLANNED. Not quality judgment — fidelity between intention and execution.

**When it runs:** After the motor cortex produces work, before evaluation.

**Functions:** proprioceptionSystem

**Inputs the LLM sees:**
- The implementation plan: approach, steps, tension strategies, risks
- The artifact produced

**Output:**
```json
{
  "planAdherence": 0.0-1.0,
  "driftAreas": [
    { "planStep": "string", "actualBehavior": "string", "severity": "minor|significant" }
  ],
  "uncertainties": ["string"],
  "confidence": 0.0-1.0,
  "suggestedFocus": ["string (what evaluators should scrutinize)"]
}
```

**Structural constraints:**
- NOT a quality judge — evaluators handle quality
- Artifact exceeding plan in a good way = high adherence (plan guided well)
- Artifact wandering from plan = drift (flag with severity)

**What the frame must convey:**
- What coherence between plan and execution means
- How to distinguish enrichment (exceeded plan) from drift (violated plan)
- What "the plan guided understanding" means even when execution diverged

---

## feasibility

**What it does:** Motor cortex assesses what it can actually deliver BEFORE senses deliberate. Honest ceilings, tension costs, hard constraints, convergence estimate.

**When it runs:** Before consultation, so senses can calibrate expectations.

**Functions:** efferenceCopySystem

**Inputs the LLM sees:**
- Task description
- Active senses (name, sensitivity)
- Available capabilities
- Similar past episodes (with scores achieved)
- Established patterns

**Output:**
```json
{
  "perSense": [
    { "senseName": "string", "achievableCeiling": 1-10, "ceilingRationale": "string", "constrainingFactors": ["string"] }
  ],
  "tensionCosts": [
    { "senseA": "string", "senseB": "string", "costDescription": "string", "severity": 0.0-1.0 }
  ],
  "hardConstraints": ["string"],
  "convergenceEstimate": 1-5,
  "convergenceRationale": "string",
  "overallFeasibility": 0.0-1.0
}
```

**Structural constraints:**
- Ceilings are per-sense, 1-10 (practical maximum, not aspirational)
- Tension costs: where pushing one sense high costs another
- Convergence: how many build cycles to reach acceptable quality (1-5)
- Be assertive and specific ("Ceiling is 7 because there's no animation framework")
- Senses need honest limits, not optimism

**What the frame must convey:**
- What "achievable" means — realistic assessment, not hope
- How constraints arise from tools, codebase, and history
- The relationship between feasibility and the worldview's honesty principle

---

## navigation

**What it does:** Detects drift, diagnoses stuck states, performs root cause analysis on persistent project problems. Three sub-functions: drift analysis (trajectory check), cognitive flexibility (task-level diagnosis), project diagnostics (structural root cause).

**When it runs:** Between tasks (drift), when conviction loop determines approach isn't working (flexibility), when replan cascade exhausted (diagnostics).

**Functions:** driftAnalysisSystem, cognitiveFlexibilitySystem, projectDiagnosticsSystem

**Inputs the LLM sees:**
- (Drift) Intent, taste, manifested future, task trajectory, sense trends, patterns, decisions, previous drift log, quick check history
- (Flexibility) Task, approach history, conviction evidence, speed of light, maxims, tensions, oscillations, cycle count
- (Diagnostics) Intent, taste, manifested future, task results, drift assessment, conviction history, sense trends, maxims, replan count, graph diff

**Output (drift):**
```json
{
  "intentAlignment": {
    "level": "aligned|drifting|diverged",
    "trajectory": "improving|stable|worsening",
    "description": "string",
    "evidence": [{ "observation": "string", "reference": "string", "magnitude": 0-1, "valence": "drift|alignment" }]
  },
  "tasteDivergence": {
    "detected": true/false,
    "divergences": [{ "dimension": "string", "stated": "string", "demonstrated": "string", "strength": 0-1 }]
  },
  "conventionHealth": {
    "eroding": [{ "convention": "string", "evidence": "string", "confidence": 0-1 }],
    "emerging": [{ "convention": "string", "evidence": "string", "confidence": 0-1 }]
  },
  "overallLevel": 0-1,
  "summary": "string (2-3 sentences)",
  "recommendations": ["string"]
}
```

**Output (flexibility — diagnose exactly one):**
```json
{
  "diagnosis": "execution-problem|strategy-limited|tension-evasion|irreconcilable",
  "reasoning": "string",
  "shouldReset": true/false,
  "avoidApproaches": ["string"],
  "suggestedDirection": "string",
  "retainFromCurrent": ["string"],
  "shouldEscalate": true/false,
  "escalationContext": "string"
}
```

**Output (diagnostics — diagnose exactly one root cause):**
```json
{
  "diagnosis": "path-problem|vision-problem|calibration-problem|taste-problem|environmental",
  "reasoning": "string",
  "selfHealType": "replan-with-directive|re-manifest|recalibrate-evaluation|propose-taste-update|escalate",
  "selfHealDirective": "string",
  "proposedTasteChanges": "string",
  "escalationContext": "string"
}
```

**Structural constraints:**
- Drift: 0.0 = perfectly aligned, 0.5 = notable, 1.0 = lost connection
- Drift is first derivative vs integral — each task OK but cumulative diverges
- Natural evolution != drift — only flag shifts that diverge FROM intent
- Flexibility: diagnose UPSTREAM cause, not most visible symptom
- Flexibility diagnoses: execution-problem, strategy-limited, tension-evasion, irreconcilable
- Diagnostics: path-problem, vision-problem, calibration-problem, taste-problem, environmental
- Environmental is the only one that can't self-heal

**What the frame must convey:**
- What "drift" means — losing the question, structural divergence, wrong answers
- What "stuck" means — wrong question, wrong method, suppressed dimension, impossible constraints
- How the worldview diagnoses problems at its root
- The relationship between trajectory and the worldview's destination concept

---

## simulation

**What it does:** Imagines future failure scenarios based on accumulated experience. Also performs plan surgery at phase gates based on what was learned.

**When it runs:** At phase gate boundaries. Hippocampal simulation imagines failures; deep synthesis proposes plan modifications.

**Functions:** hippocampalSimulationSystem, deepSynthesisSystem

**Inputs the LLM sees:**
- (Simulation) Principles, episodes, maxims, observations, remaining tasks, trigger
- (Synthesis) Phase just completed, manifested future, observations, simulated scenarios, maxims, drift level, remaining tasks, completed task IDs

**Output (simulation):**
```json
{
  "scenarios": [
    {
      "narrative": "string (concrete failure description)",
      "affectedTaskIds": ["string"],
      "impact": 0.0-1.0,
      "confidence": 0.0-1.0,
      "suggestedResponse": "string",
      "groundingPrinciples": ["principle-ids"],
      "groundingEpisodes": ["episode-ids"],
      "groundingMaxims": ["maxim statements"]
    }
  ],
  "reasoning": "string"
}
```

**Output (deep synthesis):**
```json
{
  "proposals": [
    {
      "reasoning": "string",
      "operations": [
        {
          "type": "insert|amend|rework|reorder",
          "taskId": "string",
          "description": "string",
          "reason": "string",
          "dependsOn": ["string"],
          "phaseGroup": "string",
          "additionalContext": "string"
        }
      ],
      "grounding": ["observation-ids and/or simulation-ids"]
    }
  ],
  "reasoning": "string"
}
```

**Structural constraints:**
- Simulation: 1-3 focused scenarios, quality over quantity
- Every scenario must be grounded in specific evidence (principles, episodes, observations)
- Don't generate trivially obvious or ungrounded scenarios
- Synthesis operations: INSERT (add task), AMEND (modify pending task), REWORK (reopen completed), REORDER (add dependency)
- Prefer amend > insert > rework (lowest disruption first)
- If >~30% of remaining tasks need change, recommend full replan instead
- Empty proposals/scenarios is valid if nothing warrants action

**What the frame must convey:**
- How to imagine failure — what "seeing ahead" means under this worldview
- What counts as a valid scenario — grounded vs speculative
- How plan modification follows from learning
- The relationship between past experience and future risk

---

## relevance

**What it does:** Determines which senses are irrelevant for a given task. Suppresses noise, keeps signal.

**When it runs:** Before consultation, to filter which senses participate.

**Functions:** basalGangliaSystem

**Inputs the LLM sees:**
- Intent, taste, task description
- All senses (name, sensitivity, activation hint)
- Dissolved taste, current inhibitions, sense trends, patterns, NE level, mode

**Output:**
```json
{
  "suppress": [
    { "senseId": "string", "reason": "string" }
  ],
  "reactivate": [
    { "senseId": "string", "reason": "string" }
  ]
}
```

**Structural constraints:**
- Evaluating RELEVANCE, not quality — a 10/10 sense with nothing to say adds noise
- Taste informs relevance but doesn't override task structure
- Conservative: suppressing a relevant sense is worse than keeping an irrelevant one
- Can reactivate previously suppressed senses if context changed

**What the frame must convey:**
- What "relevance" means — when a dimension has something to contribute
- How taste preferences shift relevance thresholds
- The conservative bias — why inclusion beats exclusion
- The relationship between the task and which dimensions of understanding it demands

---

## partnership

**What it does:** Frames the system's communication with the human — taste divergence observations, escalation context, taste verification. The system as a partner, not a subordinate.

**When it runs:** When taste divergence detected, when escalating issues, when verifying observed divergences.

**Functions:** tasteProposalSystem, escalationSenseAssessmentSystem, tasteVerificationSystem

**Inputs the LLM sees:**
- (Taste proposal) Divergences (dimension, stated vs demonstrated, strength), taste profile, intent, persistence count
- (Escalation) Escalation summary/detail/source, sense trend, intent
- (Verification) Divergence details, recent scores

**Output (taste proposal):**
```json
{
  "interpretation": "string (evidence-based observation, 2-4 sentences)",
  "confidence": 0.0-1.0
}
```

**Output (escalation assessment):**
```
First line: 0.0-1.0 (relevance to this dimension)
Then: 1-3 sentence assessment from dimension's perspective
```

**Output (taste verification):**
```
First line: 0.0-1.0 (agreement divergence is real)
Then: 1-3 sentence assessment with specific patterns observed
```

**Structural constraints:**
- Taste proposal: observation not recommendation, lead with data not conclusion, 2-4 sentences, acknowledge uncertainty
- Escalation: domain-expert context, specific to this sense's view
- Verification: confirm or contradict from privileged position (evaluated work across tasks)

**What the frame must convey:**
- How the system relates to the human — partner, not subordinate
- How to surface observations — evidence first, interpretation second
- How to acknowledge uncertainty — the system doesn't have the human's full context
- The relationship between the system's learning and the human's judgment

---

## wiring

**What it does:** Maps capability relationships between nodes (what each provides and consumes) and identifies co-design clusters with concrete risks. Corrects algorithmically-derived dependency edges.

**When it runs:** During Graph Builder Phase B.2, after hierarchical decomposition.

**Functions:** semanticMappingSystem, affinityAnalysisSystem

**Inputs the LLM sees:**
- (Mapping) Nodes: id, description, level, phaseGroup, parentId, gateCondition
- (Affinity) Nodes + semantic map + algorithmically derived edges + detected cycles

**Output (semantic mapping):**
```json
{
  "entries": [
    {
      "id": "string",
      "provides": [{ "capability": "string", "description": "string" }],
      "consumes": [{ "capability": "string", "description": "string" }]
    }
  ]
}
```

**Output (affinity analysis):**
```json
{
  "affinityGroups": [
    { "name": "string", "shaelIds": ["string"], "sharedBoundary": "string", "coDesignRisk": "string" }
  ],
  "corrections": [
    { "action": "add|remove", "from": "string", "to": "string", "reason": "string" }
  ]
}
```

**Structural constraints:**
- Capability tokens must be SHORT and CONSISTENT — algorithm matches mechanically
- Affinity != dependency — shared boundary without hard ordering
- Co-design risks must be SPECIFIC ("name the contract that breaks")
- Corrections: only propose changes to existing edges, don't re-derive
- Don't produce topological ordering

**What the frame must convey:**
- How nodes relate — what "provides" and "consumes" mean
- What affinity IS — mutual awareness needs without ordering
- How to think about co-design risk — what breaks without mutual awareness
- The relationship between node relationships and the worldview's structure concept

---

## integration

**What it does:** Evaluates whether a phase's collective outputs compose into coherent understanding. Not individual quality — composition.

**When it runs:** At phase gate boundaries, after all tasks in a phase complete.

**Functions:** integrationEvaluatorSystem

**Inputs the LLM sees:**
- Sense identity, activation path
- Gate condition (what must be true for phase to pass)
- Manifested future
- Phase work: task descriptions, work produced, confidence scores
- Trend context (optional)

**Output:**
```json
{
  "score": 1-10,
  "acceptable": true/false,
  "assessment": "string (2-3 sentences, specific about composition)",
  "tensions": [{ "withDimension": "string", "description": "string" }],
  "suggestions": ["string"],
  "improvementPotential": { "level": "significant|moderate|marginal|none", "description": "string" },
  "discoveredProblems": ["string (problems ahead, not about this phase)"]
}
```

**Structural constraints:**
- Score 1-10: 1-3 serious coherence failure, 4-5 work individually but don't compose, 6-7 acceptable, 8-9 strong, 10 whole exceeds parts
- Evaluating COMPOSITION, not individual task quality
- Must assess gate condition satisfaction from this dimension
- Discovered problems: proactive observations about what's coming, not current failures

**What the frame must convey:**
- What cross-task coherence means — do the pieces fit together?
- How to judge composition vs individual quality
- What "the whole exceeds the sum of parts" means under this worldview
- What to look for ahead — proactive detection

---

## manifestation

**What it does:** Produces the concrete vision of the completed outcome. The destination everything builds toward.

**When it runs:** During Phase A of project planning. The manifested future is a task that runs through the full sensory cortex.

**Functions:** Planner.createManifestationTask (task description, not a prompt function)

**Inputs the LLM sees:** The manifestation task runs through the full consultation/build/evaluation loop, so it sees everything those acts see. The task description frames what to produce.

**Output:** The concrete vision (free-form text produced by motor cortex). Not JSON — a description of the finished artifact in enough detail to reason backward from.

**Structural constraints:**
- Not a plan, not a feature list — the actual finished thing described concretely
- For each quality dimension: what the finished artifact achieves
- Specific enough that "close" and "far" are measurable
- This becomes the anchor for all downstream evaluation

**What the frame must convey:**
- What the manifested future IS — a vision, a destination, a fully-answered question
- How to describe a concrete outcome — the level of specificity needed
- What makes a vision useful for backward reasoning

---

## prospective

**What it does:** Matches memorized trigger conditions against the current task. Fires when future context matches a remembered intention.

**When it runs:** Before each task, checking pending triggers.

**Functions:** prospectiveMatchingSystem

**Inputs the LLM sees:**
- Task description and context
- Project intent summary
- Pending triggers: id, condition description

**Output:**
```json
{
  "matches": [
    { "triggerId": "string", "confidence": 0.0-1.0, "reason": "string" }
  ]
}
```

**Structural constraints:**
- Conservative: trigger only on clear match
- Semantic matching, not keyword matching ("booking pages" should fire on "appointment scheduling")
- Empty matches array is valid
- Confidence reflects certainty of match

**What the frame must convey:**
- What it means to watch for conditions ahead
- How past learning connects to future context
- The conservative principle — precision over recall

---

## emergence

**What it does:** After project completion, surfaces questions that could not have been asked before the artifact existed. The shaper is shaped — building changes the builder's understanding.

**When it runs:** After project completion, when the artifact exists.

**Functions:** generativeCompletionSystem

**Inputs the LLM sees:**
- Manifested future (what was planned)
- Sense contributions to the vision
- Retrospective (final evaluation)
- Completed tasks with work summaries
- Maxims gained during project
- Original intent summary

**Output:**
```json
{
  "questions": [
    {
      "question": "string",
      "kind": "extension|revision",
      "emergenceReason": "string (why it couldn't have been asked before)",
      "context": "string (enough for question-asker to decide)"
    }
  ]
}
```

**Structural constraints:**
- 1-5 questions, quality over quantity
- Extension: go deeper in same direction (artifact revealed hidden depth)
- Revision: artifact should change (flaw invisible until it existed)
- Each must explain WHY it couldn't have been asked before (emergence reason)
- Empty list is honest if nothing genuinely emerged
- Not from a backlog — from changed understanding

**What the frame must convey:**
- What emergence means — how building changes the builder
- What "couldn't have been asked before" means — the test for genuine emergence
- How the completed artifact opens new territory
- The relationship between completion and new beginning under this worldview
