# Agent Cortex: Full Architecture

28 features organized by brain region. Diagrams in `diagrams/`.

**Organizing principle:** Brain regions are what the system does. Neurotransmitters are how it modulates itself. They're not new components — they're the signaling layer between components.

---

## 🫀 Brainstem — vital rhythm

The fundamental operating cycle. Every project follows this heartbeat. The cortex modulates it — the brainstem keeps it beating.

### 27. Project Lifecycle

Six beats:

1. **Intake** — project enters. Brief + intent + taste profile received from human.
2. **Planning** — Planner decomposes into task graph. Inhibitor sets project-level suppressions. Norepinephrine tags each task's risk/novelty level.
3. **Task dispatch** — Attention Scheduler picks next task from graph. Prospective Memory checks triggers. Thalamus assembles enriched briefing from all sources.
4. **Task execution** — Sensory Cortex runs: consult → explore? → build → evaluate → resolve. Results flow back to Working Memory, Hippocampus, Cerebellum, Basal Ganglia.
5. **Between tasks** — Dopamine signal distributed. Crystallization may run. Drift Monitor checks trajectory. Integration check at phase gates.
6. **Completion** — final integration check across all artifacts, delivery, retrospective crystallization sweep.

At any point: escalation can interrupt the rhythm (drift alert, strategy failure, amygdala urgency).

Steps 3–5 repeat for every task. The rhythm is the same; the modulation changes based on what the system has learned.

---

## 🖐️ Peripheral Nervous System — I/O boundary

The brain's interface with the world. Defines what the system can perceive (afferent) and what it can do (efferent). Without this, the cortex has thoughts but no body.

### 28. I/O Capabilities

**Afferent (input):**
- Project briefs, intent documents, taste profiles (from human)
- Human feedback: approvals, corrections, answers to escalations
- Tool outputs: file contents, API responses, test results, build logs
- Environment state: what exists, what's deployed, what's broken

**Efferent (output):**
- Artifact generation: code, markup, copy, configuration
- File system: read, write, create, modify files
- Tool use: API calls, shell commands, deployments
- Human communication: escalations, proposals, status updates, questions

**Architectural principle:** The Motor Cortex doesn't call tools directly. It produces *intentions* — "write this file," "call this API." The PNS translates intentions into actual tool calls. This decouples the builder's cognition from specific tool implementations. A Motor Cortex that can think about "deploy this" doesn't need to know whether deployment means Vercel, AWS, or a local server.

The Thalamus routes I/O capabilities into briefings: the Motor Cortex's briefing includes what tools are available for this task. The Sensory Cortex's evaluation can reference what's observable (can we check if the deployment actually works?).

---

## 🧠 Prefrontal Cortex — executive function

The PFC has a reasoning discipline that governs all of its components. This isn't a separate module — it's the character of how every PFC decision is made, embedded in the gate phase at every rhythm level.

**The conviction loop.** At every gate (project, phase, task, build cycle), the PFC:
1. **Tests necessity:** Does this action need to happen? What breaks without it?
2. **Tests conviction:** Can we still manifest the outcome this leads to? If the reasoning doesn't hold, stop — don't iterate on a broken thesis.
3. **Tests speed of light:** How close to the ceiling are we? Optimize execution, or rearchitect from scratch?
4. **Shapes downstream:** What should consumers know about this decision? Update the forward briefing.

This loop runs continuously. New information (evaluation scores, dopamine signals, human feedback, episodes) is tested against the current manifestation at every gate. Large dopamine signals trigger a conviction test — does the manifested future still hold? If conviction persists, the system continues with the new information integrated. If conviction is challenged by genuine evidence, the PFC reshapes the manifestation and re-seeds all forward briefings. If conviction breaks, it escalates.

**Three directions of awareness.** The PFC doesn't just manage internal components. It manages the entire supply chain:
- **Inward:** Are our components performing? Are senses producing useful evaluations? Is the Motor Cortex converging? Are patterns crystallizing? Pruning complexity — conventions that aren't holding, decisions that are no longer relevant.
- **Forward:** What's coming next? What will the next task need? Prospective preparation — seeding the future into every briefing so the system runs ahead of itself.
- **Outward:** What does the environment need to provide? Is the intent clear enough? Are the right tools available? Does the human need to make a decision? Is the taste profile accurate given what we've learned? This is what turns the system from an executor into a partner — shaping upstream inputs, not just consuming them.

**The world model.** The PFC maintains an integrated representation of reality — not where we're going (that's the manifested future), but where we are and what surrounds us. The manifested future is an abstraction without the world model. With it, the manifested future is a concrete destination because the system knows the terrain.

The world model integrates all sources into a single coherent picture:
- Working Memory (patterns, score trends, conventions, inhibitions, open questions)
- Hippocampus (relevant episodes, crystallized principles)
- Cerebellum (prediction accuracy, current forward models)
- Task graph (progress, phase gate proximity, dependencies, what's completed)
- PNS (available capabilities, recent perceptions)
- Project context (intent, taste, constraints)
- System health (vital signs, WM load, learning signal health)

No single component holds this picture. Each holds its slice. The world model is the integration — rebuilt at every rhythm boundary (between-tasks, phase gates, project start). Not stored as a new data structure — computed from all sources and cached as the foundation for everything that follows.

When a task arrives, the Thalamus produces a **task gestalt**: the world model + this specific task's features. The gestalt is the "cortical representation" that subcortical systems (BG, Cerebellum, Inhibitor) read from — pre-processed, structured, available before the expensive sensory cortex fires. Consumer-specific briefings are then derived from the gestalt, not assembled independently.

Three layers: **world model** (PFC maintains, rebuilt at boundaries) → **task gestalt** (Thalamus assembles per-task from world model + task features) → **consumer briefings** (Thalamus extracts per-component from gestalt).

The conviction loop runs against the world model, not against raw signals. When new information arrives (dopamine signal, human feedback, environment change), the world model updates first. Then the PFC tests: does the manifested future still make sense given the updated terrain?

### 1. Planner
Two phases, not one. Planning is itself a task that runs through the sensory cortex loop.

**Phase A: Manifestation.** Before decomposing anything, the system imagines the completed outcome concretely. This runs as a sensory-cortex rhythm: the senses consult on what must be true about the finished artifact from their perspective (Design manifests the visual language, Performance manifests the load profile, Security manifests the threat surface). The Motor Cortex synthesizes these into a **manifested future** — concrete enough that the system can reason backward from it. The senses then evaluate whether the manifested future satisfies the intent. Tensions about the *vision* get resolved before a single task is planned.

**Phase B: Path reasoning.** Given the manifested future, reason backward to the minimum path. Every proposed step passes Jensen's three gates: Does it need to exist? Does it need to be this? Does it need to take this long? The task graph emerges from backward reasoning, not forward decomposition. Integration checks at phase gates verify cross-task coherence against the manifested future.

This nests recursively. A project-level plan spawns phase-level plans, each of which is itself a sensory-cortex task. The plan carries tension resolution forward — the senses have already argued about the vision, so execution starts with shared understanding, not discovery.

The manifested future also anchors the speed-of-light ceiling. Evaluation during execution doesn't ask "how good is this?" — it asks "how close is this to the outcome that must exist?" The ceiling is concrete, not statistical.

### 2. Working Memory
Active scratchpad — not long-term storage. Holds patterns established, score trends across tasks, key decisions made, conventions adopted. What's in mind right now.

### 3. Prospective Memory
Future intentions attached to trigger conditions. "When booking page starts → ask about Calendly." "When next image-heavy task → enforce perf budget." Fires when the matching context arrives.

### 4. Inhibitor
Top-down suppression of irrelevant senses. Project-level ("scalability irrelevant for a 5-page site") and per-task ("text-heavy page → suppress SEO subcategories"). Prevents phantom tensions from noise.

### 5. Cognitive Flexibility
Detects perseveration — same approach, no improvement across cycles. Distinguishes bad execution from bad strategy. Forces a full strategy reset, not just revision.

### 6. Drift Monitor
Compares cumulative trajectory against original intent. Catches slow divergence that no single task reveals. Also compares stated preferences (taste profile) against demonstrated preferences (what actually scores well). Proposes taste updates when they diverge.

### 7. Attention Scheduler
Drives the whole system. Picks next task based on dependencies + drift signals + confidence. Checks prospective triggers before dispatch. Decides what needs human input. Determines explore or exploit. Absorbs the role of the old orchestrator — there is no central controller, just the PFC deciding what happens next.

**Prospective preparation.** The Scheduler doesn't just decide what's next — it prepares the system for what's next. During the between-tasks phase, the Scheduler consumes Cerebellum predictions (score forecasts, ceiling estimates), Hippocampus episodes (what happened last time with similar tasks), the task graph (what's coming, what phase gate is approaching), and the strategic intent. It synthesizes all of this into a **forward briefing** that the Thalamus dissolves into every consumer's context for the upcoming task.

The senses don't read the roadmap. They don't need to. By the time Design receives its consultation briefing for task 8, the PFC has already seeded it: "this is the third of four image-heavy pages, tension between visual richness and load time is predicted, the established pattern is dark/bold, the phase gate after this task checks cross-page visual consistency." The system runs slightly ahead of itself — every component operates with a forward model of what's coming, shaped by the one component that sees the full picture.

This is how the system avoids starting from scratch on each task. Not through memory alone (that's the Hippocampus), but through anticipation — the PFC pre-positioning the entire system before the work begins.

---

## 🔀 Thalamus — context routing

### 8. Thalamus
Central relay. Routes the right context to the right consumer. Draws from working memory, intent, taste, inhibition signals, prospective triggers, episodes, crystallized principles, predictions, arousal level. Contextual extraction, not concatenation — each consumer gets exactly what it needs.

**The artistry of specification.** The Thalamus doesn't just decide *what* context to include — it decides *how much freedom to leave.* Modulated by NE and the PFC's conviction level:

- **High NE / exploit / high conviction:** Prescriptive briefings. Rich context, established patterns emphasized, constraints explicit, approach guidance tight. "The visual language is dark/bold. The component pattern is card-based. The phase gate checks consistency." The builder knows exactly what's expected and executes against it.
- **Low NE / explore / low conviction:** Invitational briefings. Intent clear, constraints non-negotiable, but the approach deliberately under-specified. "Here's what the senses care about. Here are the hard constraints. The rest is yours — surprise us." The builder has room to exceed the specification.

This isn't about more context vs less context. A prescriptive briefing and an invitational briefing can contain the same information, framed differently. One constrains. The other invites. The PFC decides which framing serves the outcome — and sometimes the best outcome comes from under-specifying on purpose, to enable the builder to produce something better than what was imagined.

> *"I under specify it on purpose to enable 43,000 people to make it even better than what I imagined."* — Jensen Huang

---

## 👁️ Sensory Cortex — per-task loop

### 9. Consultation
Activated senses weigh in from their perspective. Each sense maintains its own running project summary across tasks — Design knows "dark/bold established," Performance knows "image-heavy pages are a risk." Recommendations always integrate with the build so far.

### 10. Explore Phase
Generates 3-5 divergent *paths* from the current state to the manifested future. The destination is fixed (the Planner's Phase A output); the creativity is in how to get there. Sketches, not paintings — cheap, one LLM call per path. Selection criterion: surprise × quality — the path that most defies the Cerebellum's prediction while meeting a quality floor is the most creative. Skipped when Basal Ganglia has a strong routine match (exploit known patterns instead).

### 11. Motor Cortex
The builder. Premotor plans the implementation approach. Primary motor produces the artifact. Proprioception provides real-time feedback mid-build for self-correction. Connected to Cerebellum for prediction/correction (cerebellum is primarily a motor coordination organ in the brain).

**Efference copy.** Before building, the Motor Cortex sends a prediction of what it *can* produce — its limits, capabilities, and difficulty estimates — so the senses can calibrate their expectations against reality. This runs during sensory-cortex prepare, before consultation. One lightweight LLM call that receives:
- PNS capabilities (what tools/APIs/frameworks are available)
- Cerebellum's similar episodes (what happened with comparable tasks)
- Speed-of-light ceiling (historical best-case per dimension)
- Current codebase context (what exists, what patterns are established)

And produces per-sense ceiling estimates, tension cost assessments, hard constraints, and convergence estimates. The Thalamus includes the efference copy in every sense's consultation briefing, so the senses deliberate with awareness of what's actually buildable — not just what's desirable.

This is the counterpart to proprioception: proprioception is feedback *after* building (did the artifact follow the plan?). The efference copy is feedforward *before* building (what can the builder actually achieve?). In the brain, efference copies let other regions prepare for and adjust expectations around a planned movement. Here, they let senses adjust their ambitions around what's achievable.

Without the efference copy, the senses might consult and conclude "we need a highly interactive, beautifully animated, fully accessible, blazing fast component." With it, the senses hear "combining Design + Performance above 7/7 requires animation trade-offs that double build complexity" and adjust their ambitions accordingly. The consultation produces a more realistic plan because it was informed by the builder's ground truth — the same way Jensen's hardware engineers brief the room on what the silicon can do before the architects design the system.

**Mid-build sense consultation (AskSenseQuestion).** During building, the Motor Cortex may hit ambiguity that the specification didn't resolve. Rather than guessing (risky) or building it wrong and waiting for evaluation (wasteful), the builder can pause and ask a targeted question to a specific sense — treating it as a domain expert on the team.

The builder formulates a `BuildQuestion` with the specific question, build context, and optionally the target dimension. The Thalamus routes it:
1. If `targetDimension` matches a sense with sufficient stake → route to that sense
2. If no dimension match → route to the highest-stake sense
3. If no sense has sufficient stake → escalate to the user (same mechanism, different audience — unified escalation path)

The sense receives a lightweight `SenseQuestionBriefing` (not a full consultation) containing the question, its original perspective, and task context. It answers from its dimension's perspective — a targeted response, not a mini-evaluation.

Norepinephrine modulates the threshold for asking. High NE (unfamiliar territory, immature system) = lower bar, more questions allowed. Low NE (well-trodden ground, high prediction accuracy) = the builder should be making most calls autonomously. This mirrors how a junior engineer asks more questions and a senior one asks fewer — not because seniors don't have ambiguities, but because they've built calibration.

The question must be specific and answerable: "should this error surface as a Result type or propagate as an exception?" — not "what should this function do?" The sense gives a targeted answer, not an open-ended opinion.

This completes the Motor Cortex's feedback triangle:
- **Efference copy** — feedforward *before* building (what can I achieve?)
- **Mid-build consultation** — targeted questions *during* building (what did you mean?)
- **Proprioception** — self-assessment *after* building (did I follow the plan?)

### 12. Evaluation
Score on activated receptors from competing perspectives. Per-sense weights (from plasticity) shape how much influence each evaluation has. Competing perspectives create creative tension — Goodhart's law protection through orthogonal evaluation axes.

**Anti-capitulation principle:** Senses are constitutively committed to their dimension. A Craftsmanship sense does not say "well maybe quality doesn't matter here" when confronted with a Velocity argument. It scores, it explains, it holds its ground. The evaluator receives all sense positions *simultaneously* in a single context — never serially, because serial presentation biases toward the last voice. If a sense dramatically shifts its assessment between iterations and nothing changed in the artifact — only in what other senses said — that's drift, not learning. The Drift Monitor (Feature #6) should flag this.

### 13. Resolution
Detect tensions between senses. Synthesize creative solutions — not averaging, not compromising, but finding approaches that satisfy competing concerns simultaneously.

**Collapsed tension vs. resolved tension:** Resolution requires genuine engagement with the contradiction, not one side capitulating. Resolved tension: "Craftsmanship wants X, Velocity wants Y, here's Z that satisfies both." Collapsed tension: "Craftsmanship wanted X but Velocity has a point, so Y." The Inhibitor (Feature #4) must distinguish these — premature convergence where senses stop disagreeing without a synthesis is a failure mode, not consensus.

---

## Subcortical Systems

### 14. Hippocampus
Episodic memory. Full task stories, not just facts: "tried card grid on services page, scored 4 twice, switched to accordion, scored 7.5." Cross-project pattern library. Feeds Thalamus, never consumers directly.

### 15. Hippocampus Crystallization
A method on the Hippocampus that runs between tasks. Clusters similar episodes and feeds them to the LLM: "what's the principle?" Output is not "what happened" but "what this means" — e.g., "fragmented layouts underperform for scope-heavy content because users need to see the full scope before committing."

Triggered by:
- Enough similar episodes accumulate (pattern density)
- A surprising outcome demands explanation (large dopamine signal)
- An existing principle gets contradicted (old crystallization was wrong)

Crystallized principles become first-class material for the Thalamus. Over time, specific episodes can fade — the principle carries the weight.

### 16. Basal Ganglia
Learned routines. Task type → sense activation patterns. Direct pathway: release these senses. Indirect pathway: suppress competing senses. Hyperdirect pathway: novel task → global pause, full consultation.

Also gates the explore/leverage decision:
- Strong routine match → skip explore, converge directly (we've done this before)
- Novel + creative task → explore first (no routine, high design surface area)
- Constrained task (spec implementation, compliance fix) → skip explore

Trained by eval scores via dopamine signal.

### 17. Amygdala
Priority override. Bypasses normal scheduling. Security vulnerability found → reconfigure Thalamus immediately. Breaking change detected → interrupt current task. Human escalation → override attention queue. Talks directly to Inhibitor (override suppression list) and Thalamus (urgent reconfiguration), not through the PFC.

### 18. Cerebellum
Prediction engine and speed-of-light calculator. Two roles:

**Role 1: Score prediction.** Forward models: given this task + these senses + this approach, predict evaluation scores before building. Compares predictions to actual outcomes. The delta IS the dopamine signal — the most information-rich signal in the entire system.

**Role 2: Ceiling estimation.** For each cognitive dimension, predict the theoretical maximum achievable by the current approach — the speed of light. Not "what score will this get?" but "what's the *best possible* score this approach can get?" The gap between current performance and the ceiling is diagnostic:
- Near the ceiling → optimize execution (revise, don't rearchitect)
- Far from ceiling → the approach is the bottleneck (rearchitect from scratch)
- Ceiling too low → escalate (constraints need to change, or fundamentally different strategy needed)

Cognitive dimensions tracked: build convergence (predicted cycles to acceptance), tension resolution quality (can this approach satisfy competing senses?), evaluation accuracy (distance from human satisfaction), context fidelity (signal preservation through Thalamus).

This is what replaces hardcoded cycle limits. The gate doesn't stop because a counter expired — it stops because the Cerebellum says the system is near its speed of light, or rearchitects because it says the ceiling is too low.

Primarily connected to Motor Cortex (it's a motor coordination organ — predicts where your hand will be, corrects mid-movement). The ceiling estimates flow to the gate (stopping criteria) and to Cognitive Flexibility (is the approach worth continuing?).

---

## 🧬 Plasticity — connections reshape with experience

### 19. Connection Weights
Every plastic connection has a learned weight. Per-sense evaluation influence — how much Design's score matters relative to Performance's. Strengthens what works, weakens what doesn't. This is how the system's identity forms over time. A system that has built 50 marketing sites will have different weights than one that has built 50 API backends.

### 20. Fixed vs. Plastic Connections
Two kinds of wiring:
- **Fixed (→)**: structural. Results always flow back to Working Memory. Thalamus always routes. These are the architecture.
- **Plastic (🧬)**: influence weights. How much the Hippocampus shapes a briefing. How aggressive the Inhibitor is. How much weight the Amygdala's urgency signal carries. These reshape with experience.

---

## Neurotransmitter Signals — the wiring between nodes

### 21. Dopamine
Reward prediction error: `cerebellum.predicted - sensory.actual = signal`. Not "reward" — reward PREDICTION ERROR. Fires when reality surprises the system, not when things go as expected.

- Cerebellum predicted 7, actual 7 → no signal, no learning needed
- Cerebellum predicted 7, actual 3 → large negative → hippocampus records significant episode, basal ganglia weakens the routine that led here
- Cerebellum predicted 4, actual 8 → large positive → hippocampus records what went right, basal ganglia strengthens this pattern

Flows to: Hippocampus, Basal Ganglia, Cerebellum (self-calibration), Plasticity weights.

Without this signal, the learning systems are recording but not learning.

### 22. Norepinephrine
Arousal/thoroughness dial. Continuous, not binary (that's the Amygdala). Modulates how much attention the entire system gives to everything it does:

- **High** → more senses activated, lower acceptance thresholds, more revision cycles allowed, more checkpoints mid-build
- **Low** → fewer senses, higher thresholds, fast-tracked

Computed from multiple signals:
- **Task novelty** — how different this task is from anything the system has seen (Cerebellum episode similarity)
- **Task risk** — stakes, constraint tightness, phase gate proximity
- **Prediction accuracy** — the Cerebellum's overall calibration. This is the developmental signal: a poorly-calibrated system (few episodes, low accuracy) has high baseline NE because everything is uncertain. As the system matures and predictions improve, baseline NE drops. The training wheels come off automatically as the system learns.
- **Conviction level** — low conviction from the PFC reasoning loop raises NE. The system pays more attention when its own reasoning isn't convincing itself.

Spiked by Amygdala for urgent situations. This is both the difference between careful evaluation of an auth system and quick approval of a copy change, AND the difference between a system on its first project and a system that has built fifty.

NE also modulates the Thalamus's specification artistry. High NE → prescriptive briefings (constrain the builder). Low NE → invitational briefings (leave room for the builder to exceed the specification). The PFC's conviction level determines which framing serves the outcome — high conviction prescribes, low conviction invites exploration.

---

## Human Partnership

### 23. Escalation Pathways
Four routes to human:
- **Drift Monitor** → drift alerts, taste divergence detected
- **Attention Scheduler** → proposals, prospective questions
- **Cognitive Flexibility** → strategy failure, needs new direction
- **Amygdala** → urgent issues, immediate interrupt

### 24. Taste Feedback Loop
Drift Monitor detects when demonstrated preferences (what actually scores well across tasks) diverge from stated preferences (taste profile). Proposes updates: "You said warm tones but cool tones consistently score higher on your own intent measures. Want to update?"

### 25. Satisfaction Signal
Human approval, correction, or override flows to plasticity weights. This is Goodhart's law protection — the system can't just optimize its own internal scores. External human signal anchors the learning to actual satisfaction, not metric gaming.

### 26. Per-Sense Project Summaries
Each sense maintains its own running narrative of the project from its perspective. Not centralized in Working Memory — distributed within each sense. Design knows the visual language. Performance knows which page types are risky. When a sense weighs in on task 8, it doesn't start from scratch — it has continuity from its own perspective across all previous tasks.
