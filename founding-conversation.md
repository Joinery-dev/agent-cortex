# Agent Cortex — Founding Conversation

*This captures the conversation that led to the Agent Cortex vision, starting from the frontier research phase.*

---

## Kevin: What comes next?

Ok so the agent-pipeline and supporting infrastructure is called an agent harness. Do deep research on other harnesses, especially the most popular ones, to see what we are doing right, what we could add, and how we can tailor our harness for lots of use cases. It seems like a lot of other harnesses have been built for specific kinds of projects.

## Claude: [Conducted deep research on 17+ major harnesses]

*Full research results in agent-cortex.md under "Research findings"*

Key findings:
- Our pipeline has things nobody else has (QA/Resolve loop, interface contracts, design review, autoresearch)
- Biggest gaps: repo map/AST-aware context, persistent cross-session memory, cost tracking, dynamic model routing
- Most harnesses are general-purpose single-agent tools or web-app generators

## Kevin: What about public github harnesses released by normal people?

## Claude: [Researched indie/community harnesses]

Found: Superpowers (107k stars), Everything Claude Code (101k stars), BMAD Method (42k stars), GSD/Get Shit Done (40k stars), Claude Squad (6.5k stars), Overstory (1.1k stars), agtx (667 stars), Citadel (166 stars), and others.

Key insight from GSD: verify/done split for acceptance criteria. Key insight from Superpowers: TDD enforcement. Key insight from BMAD: role-separated validation. Key insight from Citadel: cost-optimal tier routing.

## Kevin: Dig into the formalized acceptance criteria

## Claude: [Deep dive on acceptance criteria patterns across harnesses]

Four approaches:
1. GSD: `<verify>` (executable commands) + `<done>` (observable success states)
2. Superpowers: tests ARE criteria (deletes non-TDD code)
3. BMAD: role-separated checklists
4. Citadel: implicit anti-pattern scanning

Recommended adopting GSD's verify/done split for our pipeline.

---

## The Frontier Conversation Begins

## Kevin: Don't just research the future of what is already here - no one had even considered auto research/agent harnesses three months ago - we need to get creative about what people aren't even considering right now.

## Claude: [Launched two research agents in parallel — one on future direction, one on self-improving systems]

While waiting, started thinking about what nobody's talking about:

1. **Agents that understand the business, not just the code** — every harness treats the codebase as the universe. None of them know that the feature they're building is for a painting contractor who needs to send invoices.

2. **Cross-project learning** — autoresearch improves prompts for one project. What if insights from 50 projects fed back into the harness?

3. **Agents that negotiate with each other** — instead of QA saying pass/fail, what if QA and Builder could have a conversation?

4. **The harness as a product, not a tool** — what if non-technical people could use it?

## Research Results

### Future of Agent Harnesses (key findings):

**Unsolved problems:**
- The "50 First Dates" problem — no memory across sessions
- Perception-reality gap — devs 19% slower with AI while believing 20% faster (METR)
- Multi-agent coordination plateaus at ~4 agents
- Static instruction files get habituated (ngrok/bmo experiment)

**Wild ideas from the research:**
- Training-inference convergence — harness becomes the data collection mechanism that improves the underlying model
- The "bitter lesson" harness — designed for deletion, each model upgrade makes it thinner
- Anti-AGENTS.md — static files get ignored, dynamic context injection works better
- Sub-agent feedback loops analyzing failures in real-time

### Self-Improving Systems (key findings):

- SICA (Bristol): agent edits its own source code, 17-53% improvement
- DSPy: Bayesian prompt optimization, prompt-only
- Our autoresearch is ahead of most — nightly benchmark-driven optimization with auto-revert
- Key learning: binary evals give no gradient, need continuous metrics

## Claude: Synthesis — what nobody is considering

1. **The harness as the product interface** — the exec agent IS the product interface for non-developers
2. **Business-aware agents** — a business model layer that informs every decision
3. **Cross-project learning (meta-autoresearch)** — fleet-level pattern detection
4. **Agents that negotiate, not just pass/fail** — conversation graph instead of state machine
5. **Dynamic context injection** — dissolve context into briefings at the moment of relevance
6. **The disposable harness** — designed for deletion, gets thinner with each model upgrade
7. **Formal verification as QA** — mathematical proofs instead of testing with more AI

### The core insight:

**The harness should be a learning system that gets better at understanding intent, not just better at executing tasks.** Everything else follows from that.

---

## Kevin: This is exactly what I have been thinking.

We have tried to implement self healing and inline auto research which are scratching at this itch.

## Claude: The missing loop

Autoresearch optimizes *how agents do work*. Self-healing recovers *when work breaks*. Neither optimizes *understanding what the human actually wanted*.

The missing loop: **did the output match the intent?** Not "did the tests pass" — but "is this what you meant?"

Proposed: structured capture of human reactions as data about where intent was misunderstood. Over time, the harness learns patterns about intent gaps.

## Kevin: What if instead of "business as context" we generalize it as "project intent"?

A project could be anything - a personal assistant, a project, a business, or an entire LLM like Claude. It is about creating intent baselines and then dynamically updating them and delivering the correct intent through distillation to agents when they need it.

And beyond that, building an exec agent that can automate most of this for humans - imbued with taste and character unique to the project, that can dynamically update the intent, elevating to humans and producing reports about decisions it made.

Bounce back ideas at me as if we are equals and you have things to add / push back on.

## Claude: Pushing back and building on

**Intent and Taste are two separate things:**

1. **Intent** — what the project is trying to achieve. Relatively stable. A painting contractor's website has the same fundamental intent for months.
2. **Taste** — how decisions get made when intent doesn't specify. "Should the CTA be red or blue?" Evolves through human reactions.

**Push back on exec autonomy:** The exec should autonomously decide "how" (taste decisions) but elevate "what" (intent decisions) to the human. The line: does this decision change *what* we're building, or *how* we're building it?

**The distillation problem is the real breakthrough:** For any given task, generate the minimal context that would cause the agent to make the same decision the human would make. Not "here's your task" — "here's what you need to know to make good judgment calls while doing your task."

**Added: Intent drift detection.** Track the delta between original intent and accumulated changes. Make drift visible: "You started with a 5-page marketing site. This is now a 12-page site with user accounts. Want to re-scope?"

**Question: Can taste be learned from one project?** Cross-project taste learning requires identity persistence — knowing that projects share a human.

## Kevin: The exec should be allowed to shape "what" it produces

This is where things are going. The better the agents get, the more this will happen. We should start working on improving that process now.

"Here's what you need to know to make good judgment calls" — this is it. This is the real breakthrough because the individual agents are so smart. We need to give them breathing room and space to get creative and fulfill intent in ways we can't even imagine, rather than trying to pre-plan and constrain.

Intent drift — love this, we should incorporate it.

Taste profiles can be downloaded to executive/orchestrator agents like skills.

## Claude: Creative freedom through governed tension

Agreed on exec shaping "what." The exec isn't a project manager taking orders. It's a **partner with domain expertise** that can propose better versions of what the human asked for.

On giving agents breathing room — this goes against every harness in existence. The industry moves toward more constraint. We're going the opposite direction. The mechanism: **give the builder intent and taste, not a blueprint.**

Instead of "create a 64px header with logo left, 5 nav links center, CTA right," you say "this is a warm, professional site for a painting contractor. The header should feel welcoming and make it easy to get a quote. Build it."

The risk of inconsistency is solved by **Goodhart tension** — optimizing multiple competing forces:
1. Builder has creative freedom
2. Design review smooths inconsistencies BUT propagates good accidents
3. QA checks functional correctness
4. Exec monitors intent alignment

Four forces in tension. No single agent can game the system. This is a **governance model** — checks and balances, not a chain of command.

### Taste profiles and habituation

The ngrok/bmo finding: agents habituate to static files. Solution: the taste profile is a **source the distiller draws from**, never a document the agent reads. The agent never sees "Taste Profile: Kevin." Instead, for a builder working on the header: "This site serves painting contractors. The feel is warm and professional — think rust, forest green, cream."

Every briefing is unique — the intersection of this task and the relevant slice of intent and taste. The distiller performs **contextual judgment** about what this agent needs right now.

### Attention-proportional reporting

Every autonomous decision gets a confidence score. Below threshold → ask before acting. Above threshold → act and log. Surface the lowest-confidence decisions to the human. The threshold is adaptive — "you're asking me too much" lowers it, "you should have asked me about that" raises it.

## Kevin: The human's role is monitoring

Humans used to row boats. Then they turned wheels. Now they monitor autonomous systems and intervene on errors. The human stays in control through a GUI like the sidebar panels app.

"Governance model — checks and balances, not a chain of command" — this is it. This is what I was trying to build with the Genesis interview agent but didn't have enough scaffolding for. The project vision/diagram/illustrations are the optimized final outcome.

Attention-proportional reporting — excellent. There should still be a full report somewhere with all changes.

## Kevin: How do we make this maximally general purpose?

What if instead of selecting a few measuring tools for the entire project, every single one in the dimension library "glanced" at the outcome? Like what happens in human brains. Then the dimensions that are activated light up and provide inputs because this is their thing. Each dimension's "interest" gets scored and the orchestrator brings in the top 5-10 for in-depth analysis. The next task might pick up 5-10 completely different dimensions.

## Claude: Per-task dimensional attention

This solves the coordination ceiling. We're not coordinating 50 agents. We're activating 5-8 per task from a library of 50. Coordination is always small. Coverage is enormous.

The library grows organically — every project that invents a new dimension adds it. Over hundreds of projects, the library becomes a comprehensive model of everything that can matter about software.

Proposed trigger profiles (keywords, file patterns) for fast relevance checking.

## Kevin: Trigger profiles are too rigid. Nested measures.

The design measure is an umbrella. It could have hundreds of measures within it. Like personalities — major personality types with lots of traits that inform the final instantiation. We get coverage by playing "20 questions" within major governance personalities. Each Major Governor has its own neural field within it.

## Claude: Fractal governance

```
DESIGN (major governor — a persona)
  ├── Visual Identity (color harmony, typography, spacing, brand)
  ├── User Experience (trust-at-first-glance, cognitive load, navigation)
  ├── Accessibility (contrast, screen reader, keyboard)
  └── Emotional Response (warmth, professionalism, urgency)

CORRECTNESS (major governor)
  ├── Functional (validation, error handling, edge cases)
  ├── Data Integrity (type safety, state consistency)
  └── ...
```

Cascading activation: 5-7 major governors → 3-5 sub-fields → 2-4 measures. Three levels of branching. Never scanning thousands.

**Key insight: governors are personas, not checklists.** The Design governor gets a personality: "You care deeply about visual coherence. You believe design should feel inevitable." The nested measures are emergent from that persona encountering work, not a lookup table.

The dimension library isn't a database of measures. It's a **library of personas at multiple scales.**

## Kevin: You're right. It's a "harness" if you think human beings live in a mind harness.

## Claude: What you're building is closer to an organizational mind.

A design studio doesn't have a checklist for every project. It has designers with internalized taste, a creative director with a vision, a culture that shapes decisions. The "people" are personas, the "culture" is the dimension library, the "creative director" is the exec with project intent, the "institutional memory" is cross-project learning.

The word "harness" implies the agent is a horse that needs controlling. What you're describing is raising a colleague.

## Kevin: What should we call it? Also checklists and processes are still important.

## Claude: The tensions we need

- **Judgment vs. process** — personas make creative decisions, checklists catch what judgment misses
- **Autonomy vs. accountability** — agents act freely but every decision is logged
- **Creativity vs. consistency** — builders can invent, design review ensures cohesion
- **Speed vs. thoroughness** — most measures stay dormant, activated ones go deep
- **Emergence vs. structure** — library grows organically within structured calibration loops

Naming options: Agency, Studio, Org, Mind, Cortex, or just Joinery.

## Kevin: Cortex is excellent. Let's call it Agent Cortex.

## Claude: It works on every level.

- Layered architecture maps to cortical layers
- Nested neural fields with contextual activation
- Multiple regions evaluating the same input through different lenses
- Learns from experience
- It's not a harness. It's a mind that builds things.

## Kevin: Let's create a new folder and get started.

---

*End of founding conversation. The vision doc (`agent-cortex.md`) contains the full architecture. The `CLAUDE.md` contains the collaboration principles and project context.*
