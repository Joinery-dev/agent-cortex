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

### 1. Planner
Decomposes project into task graph with dependencies. Identifies parallel tracks. Runs integration checks at phase gates to verify cross-task coherence.

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

---

## 🔀 Thalamus — context routing

### 8. Thalamus
Central relay. Routes the right context to the right consumer. Draws from working memory, intent, taste, inhibition signals, prospective triggers, episodes, crystallized principles, predictions, arousal level. Contextual extraction, not concatenation — each consumer gets exactly what it needs.

---

## 👁️ Sensory Cortex — per-task loop

### 9. Consultation
Activated senses weigh in from their perspective. Each sense maintains its own running project summary across tasks — Design knows "dark/bold established," Performance knows "image-heavy pages are a risk." Recommendations always integrate with the build so far.

### 10. Explore Phase
Generates 3-5 divergent approaches before committing. Sketches, not paintings — cheap, one LLM call. Selection criterion: surprise × quality. The approach that most defies the Cerebellum's prediction while meeting a quality floor is the most creative. Skipped when Basal Ganglia has a strong routine match (exploit known patterns instead).

### 11. Motor Cortex
The builder. Premotor plans the implementation approach. Primary motor produces the artifact. Proprioception provides real-time feedback mid-build for self-correction. Connected to Cerebellum for prediction/correction (cerebellum is primarily a motor coordination organ in the brain).

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

Also gates the explore/exploit decision:
- Strong routine match → skip explore, converge directly (we've done this before)
- Novel + creative task → explore first (no routine, high design surface area)
- Constrained task (spec implementation, compliance fix) → skip explore

Trained by eval scores via dopamine signal.

### 17. Amygdala
Priority override. Bypasses normal scheduling. Security vulnerability found → reconfigure Thalamus immediately. Breaking change detected → interrupt current task. Human escalation → override attention queue. Talks directly to Inhibitor (override suppression list) and Thalamus (urgent reconfiguration), not through the PFC.

### 18. Cerebellum
Prediction engine. Forward models: given this task + these senses, predict evaluation scores before building. Compares predictions to actual outcomes. The delta IS the dopamine signal — the most information-rich signal in the entire system. Primarily connected to Motor Cortex (it's a motor coordination organ — predicts where your hand will be, corrects mid-movement).

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

- **High** → more senses activated, lower acceptance thresholds, more revision cycles allowed
- **Low** → fewer senses, higher thresholds, fast-tracked

Set by Planner based on task characteristics (risk, novelty, complexity). Spiked by Amygdala for urgent situations. This is the difference between careful evaluation of an auth system and quick approval of a copy change.

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
