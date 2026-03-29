# Agent Cortex

*The next evolution of the agent pipeline. Not a harness — a synthetic organizational mind that understands intent, develops taste, governs itself through creative tension, and learns from every project it builds.*

## The landscape (March 2026)

Agent harnesses are 3 months old as a concept. The space has already converged on a few patterns: multi-agent role separation, git worktrees for isolation, state buses, eval-driven optimization. Our pipeline has most of these plus things nobody else has (QA/Resolve loop, interface contracts, design review).

But the current generation of harnesses — including ours — all share the same fundamental assumptions. The breakthroughs won't come from adding more features to the existing paradigm. They'll come from questioning the assumptions themselves.

## Research findings

### What the industry has converged on
- Harness engineering matters more than model selection (LangChain: 52.8% → 66.5% from harness changes alone, zero model changes)
- Multi-agent coordination plateaus at ~4 agents; beyond that, overhead eats gains
- Self-improving agents work (SICA: 17-53% improvement on SWE-Bench by editing own source code)
- Static instruction files get habituated — agents learn to predict and skip them (ngrok/bmo experiment)
- The "reasoning sandwich" outperforms max-reasoning-everywhere (63.6% vs 53.9%)
- Reverting aggressively on non-improvement is universal best practice
- Single-variable experiments are the only interpretable ones

### Unsolved problems
- **The 50 First Dates problem**: No memory across sessions that actually works over weeks
- **The perception-reality gap**: Devs 19% slower with AI while believing 20% faster (METR)
- **Eval ceiling**: Binary pass/fail gives optimizers no gradient to work with
- **Observability for non-deterministic systems**: Can't replay, debug, or audit what you can't reproduce
- **The knowing-doing gap**: Agents understand instructions but fail to sustain vigilance across turns

### What will be standard in 2-3 months
- Hierarchical agent architectures (Planner/Worker/Judge)
- Middleware-based harness hooks (pre-completion checklists, loop detection)
- Three-tier model routing by task complexity
- Git worktrees as default isolation
- A2A protocol for agent-to-agent communication
- Checkpoint-and-rollback over fix-forward

## Ideas nobody is doing yet

### 1. The harness as the product interface

Every harness assumes a developer at the keyboard. But our exec discovery loop already has a natural language conversation with a human. What if the human isn't a developer?

A painting contractor says "I need a website for my business." The exec loop asks the right questions. The pipeline builds it. The human reviews screenshots. Never touches code.

The harness isn't a dev tool. It's a product delivery system where the exec agent IS the product interface.

### 2. Business-aware agents

Every harness treats code as the universe. None of them know why the code exists. A business model layer — "this is a service business, they charge by the hour, they have crews of 3-5" — should inform every decision. PM knows what features matter. Builder knows what data shapes to use. QA knows what workflows to test.

### 3. Cross-project learning

What if insights from 50 projects fed back into the harness?

- "PM over-specifies footers on marketing sites"
- "QA catches the same responsive bug in 80% of Next.js projects"
- "First build attempt on API endpoints fails 60% of the time"

A learning loop outside the project loop. The harness evolves based on fleet-level data.

### 4. Agents that negotiate, not just pass/fail

The pipeline is linear: Build → QA → pass/fail → Resolve. What if QA could say "I'm 70% sure this is wrong — Builder, was this intentional?" and Builder could respond?

Conversation graph instead of state machine. Agents build shared understanding rather than issuing verdicts.

### 5. Dynamic context injection (the anti-AGENTS.md)

Static instruction files get habituated. Instead, inject context at the exact moment it's relevant. Not just "here's the task" but "here's what went wrong the last 3 times someone tried a task like this."

### 6. The disposable harness

Every piece of harness logic should be designed for deletion. The next model might not need it. The endpoint: tools + telemetry + guardrails. No workflow logic. The model plans everything.

### 7. Formal verification as QA

Instead of testing agent output with more AI, verify it with mathematical proofs. LLMs can write proofs in Lean and TLA+. Provable correctness for API contracts, data transformations, state machines.

## Self-improvement landscape (historical research)

Investigated Karpathy-style benchmark-driven auto-research (DSPy, SICA, OpenAI Self-Evolving Agents, MASS, STO). Conclusion: these approaches require rebuilding the system around replay and config-overlay experimentation. Doesn't fit Agent Cortex's architecture. The system learns through its passive learning stack instead — episodes, potentiation, plasticity weights, and dopamine-driven gradients.

---

---

## The Architecture We're Building Toward

### The core insight

The breakthrough is simple: **the harness should be a learning system that gets better at understanding intent, not just better at executing tasks.** Everything else follows from that.

Current harnesses — including ours — optimize execution. Better agents, better prompts, better coordination. But the actual failure modes are upstream (we don't understand what the human wants deeply enough) and downstream (we don't learn from our own failures structurally). Fixing execution when the input is wrong just produces wrong things faster.

### The four layers

The pipeline today has three layers. We're adding a fourth that sits above all of them.

```
INTENT LAYER (new)
  Project Intent — what we're building and why
  Taste Profile  — how decisions get made when intent doesn't specify
  Intent Drift   — how far we've moved from the original scope

STATE LAYER (.goals.json)
  What's been done, what's in progress, what's next

PROTOCOL LAYER (commands/*.md)
  How agents behave, what steps they follow

CONTEXT LAYER (briefings)
  What each agent needs right now for this specific task
```

Intent sits above all three. It informs how state is interpreted ("this task technically works but doesn't match the intent"). It informs how protocols behave ("for this project, QA should focus on mobile because the clients are on phones"). It informs what goes in briefings ("the builder needs to know this is for an older demographic who prefer larger text").

### Project Intent

A project isn't just code. It's a painting contractor's website. It's a personal assistant. It's a SaaS platform. The intent layer captures *why* the project exists and *what good looks like* — not just what features to build.

Project intent is created during the exec discovery phase and is a **living document** that the exec updates as the project evolves. It includes:
- Who the project serves and what problem it solves
- What success looks like from the human's perspective
- Key constraints and priorities
- The vision, diagrams, and illustrations as the optimized target outcome

The exec doesn't just execute intent — it **improves intent**. It's a partner with domain expertise that can propose better versions of what the human asked for. "You asked for a contact form, but based on everything I know about your business, you actually need a booking system with availability slots, and here's why."

The human has veto power. The exec has proposal power. The exec doesn't need permission for every decision. It needs **accountability** for every decision.

### Taste Profiles

Taste is how decisions get made when the intent doesn't specify. "Should the CTA be red or blue?" Intent doesn't answer that. Taste does.

A taste profile captures the accumulated pattern of a human's preferences:

```
Visual: warm earth tones, serif headings, generous whitespace, rounded corners
Decisions: prefers simple over clever, ships good over perfects great
Communication: terse updates, show screenshots not descriptions
Patterns: always wants a contact form, iterates on headlines most
```

Taste profiles are:
- **Portable across projects** — the human's preferences travel with them
- **Community-shareable** — "download the 'minimalist SaaS' taste profile" as a starting point
- **Refined over time** — every human reaction teaches the system about their preferences
- **Never delivered as a static file** — dissolved into briefings contextually (see below)

### The habituation problem and contextual dissolution

Static instruction files (AGENTS.md, taste profiles, protocol docs) get habituated — agents learn to predict and skip them. The ngrok/bmo experiment proved this.

The solution: taste and intent are **source materials for the distiller**, never documents the agent reads directly. The agent never sees "Taste Profile: Kevin." Instead:

For a builder working on the header:
> "This site serves painting contractors. The feel is warm and professional — think rust, forest green, cream. The header should make it easy to get a quote. The client prefers generous whitespace and rounded corners."

For a builder working on the API:
> "Keep it simple. The client prefers straightforward over clever. Standard REST patterns, no over-engineering."

Every briefing is unique because it's the intersection of *this task* and *the relevant slice of intent and taste*. The distiller performs **contextual judgment** about what this agent needs to know right now to make good decisions — not a summary, but a curated perspective.

This is the real breakthrough in briefing: not "here's your task" but **"here's what you need to know to make good judgment calls while doing your task."**

### Creative freedom through governed tension

The industry is moving toward more constraint — tighter prompts, more guardrails, stricter schemas. We're going the opposite direction: **give agents intent and taste, not blueprints.**

Instead of "create a 64px header with logo left, 5 nav links center, CTA right," you say "this is a warm, professional site for a painting contractor. The header should feel welcoming and make it easy to get a quote. Here's the visual language. Here's what the client cares about. Build it."

The builder makes *design decisions informed by intent* instead of mechanically executing a spec. The output might be better than what the PM would have specified, because the builder can see the code and the intent simultaneously.

The risk is inconsistency. The solution is **Goodhart tension** — optimizing multiple competing forces so no single metric can be gamed:

1. **Builder** has creative freedom within intent + taste
2. **Design review** smooths inconsistencies BUT also recognizes when a deviation is *better* and propagates it across the project
3. **QA** checks functional correctness independently
4. **Exec** monitors intent alignment across everything

Four forces in tension. No single agent can game the system because they're evaluated on orthogonal axes. The builder can't just "pass QA" because design review might flag it. Design review can't just enforce uniformity because it's also looking for improvements to adopt. QA can't be too rigid because the exec might say "that's technically wrong per the spec but better for the intent."

This is a **governance model** — checks and balances, not a chain of command.

### Intent Drift Detection

The human's intent drifts. They start wanting a simple website and gradually scope-creep into wanting a full CRM. They don't announce this — it happens through a series of small requests that each seem reasonable.

The exec tracks the delta between the original project intent and the accumulated changes. Not to block drift — sometimes drift is good — but to make it visible:

> "You started with a 5-page marketing site. Based on your requests, this is now a 12-page site with user accounts, a dashboard, and payment processing. Want to re-scope, or is this the real project now?"

Good human project managers do this instinctively. No agent does it. Ours will.

### Attention-Proportional Reporting

The exec makes hundreds of autonomous decisions per project. The human can't review them all. The solution: **confidence-scored decision logging with attention-proportional surfacing.**

Every autonomous decision gets a confidence score:
- **Below threshold** → ask the human before acting
- **Above threshold** → act and log
- **At report time** → surface the lowest-confidence decisions first

The human sees: "Here are the 3 decisions I'm least confident about." Everything else is in the record if they want to look. A GUI (like the sidebar panels app) provides the monitoring surface — checkpoints, implementation progress, decision history.

The threshold is adaptive. "You're asking me too much" lowers it. "You should have asked me about that" raises it. Over time, the exec learns the human's tolerance for autonomy.

### The Human's Role

Humans used to row boats. Then they built machines and turned wheels. Now they monitor AI systems that autonomously drive, intervening only on errors.

The human's job in this system:
- Express intent ("I need a website for my painting business")
- React to proposals ("yes but make the header bolder")
- Review confidence-flagged decisions
- Adjust the autonomy threshold
- Course-correct on intent drift

Everything else is automated. The harness is the product interface. The exec is the product partner. The pipeline is invisible.

### Where this leads

The harness gets thinner over time, not thicker. Every feature we add should be measured against: "does this bring us closer to the human just saying what they want and getting it?"

Each model upgrade should make the harness thinner. The end state is just: intent layer + tools + telemetry + governance. The model handles everything else.

But we build toward that end state by building the intent layer *now* — because that's the piece that survives regardless of how good the models get. Models will get better at execution. They won't automatically get better at understanding what a painting contractor in Ohio needs. That's our job.

---

## Implementation Roadmap

### Phase 1: Intent foundations (now)
- Implement verify/done acceptance criteria (plan written)
- Formalize project intent as a structured document created during exec discovery
- Add intent drift tracking to exec checkpoints
- Build taste profile schema

### Phase 2: Smart distillation (next)
- Refactor distill-briefing.js to draw from intent + taste, not just state
- Contextual dissolution — agent never sees raw intent docs, only relevant slices
- Add confidence scoring to exec autonomous decisions
- Intent-aware QA (check against intent, not just specs)

### Phase 3: Generalized governance (after that)
- Constitutional calibration loop (see below)
- Builder creative freedom with intent+taste briefings instead of blueprints
- Attention-proportional reporting in the sidebar GUI

### Phase 4: Learning system (ongoing)
- Cross-project learning (fleet-level pattern detection)
- Failure taxonomy (structured data on *why* things fail, not just *that* they fail)
- Taste profile refinement from human reactions
- Adaptive autonomy thresholds
- Dimension library built from cross-project learnings

---

## Generalized Governance: Constitutional Calibration

### The idea

Instead of hardcoding roles (PM, Builder, QA, Resolver) with fixed evaluation criteria, the governance structure is **generated from the project**. The harness doesn't know what kind of project it is. It generates the right checks and balances for whatever comes in.

The pattern:
1. Define outcome A
2. Generate N orthogonal dimensions that describe quality for A
3. Calibrate each dimension's rubric against A specifically
4. Execute work in a force field of all N dimensions
5. Resolve tensions through creative synthesis, not compromise
6. The orchestrator's job is conflict resolution and intent alignment

### The calibration loop

1. **Human provides intent.** "Here is A. We want to create A."

2. **Orchestrator spawns N evaluator agents.** Each is told: "Look at this project. Pick ONE dimension that matters for its success. Define what 'good' looks like on that dimension. Your job during the project will be to optimize for this and ONLY this."

3. **Each evaluator proposes its dimension independently.** They can draw from a dimension library (accessibility, performance, trust, usability, tone, security, etc.) or invent new ones — but must justify why the dimension matters for *this specific project*.

4. **Orchestrator reviews all N:** checks for gaps ("nobody picked security and this is a payments app"), overlaps ("two of you are both optimizing for visual quality"), and coverage ("do these N dimensions together fully describe what makes A good?").

5. **Evaluators refine.** 2-3 rounds until the orchestrator is satisfied the dimensions cover the space well, are genuinely orthogonal, and are calibrated to this project.

6. **Each evaluator produces a rubric** — a concrete, measurable definition of what good looks like on their dimension for this specific project. These rubrics become the governance constitution.

### Why dimensions should be emergent, not fixed

The best dimensions are ones nobody would put in a library. An evaluator looking at a painting contractor's site might invent "trust-at-first-glance" — the idea that within 3 seconds of landing, the visitor should feel this is a legitimate business they'd be comfortable giving their home address to. That's not usability. Not visual design. It's its own thing, and arguably the most important dimension for that specific project.

A dimension library provides seeds and prompts ("have you considered accessibility? trust signals? content tone?") but evaluators can combine, split, or invent dimensions. The library grows over time as evaluators across many projects discover dimensions that prove useful.

### Evaluators as advocates, not just judges

During calibration, each evaluator builds a case for why their dimension matters. "This site needs to feel like a friendly neighbor, not a corporation." "Painting contractors are in the field on 3G — if this takes 4 seconds to load they'll never use it."

These arguments become part of the context distilled to builders. Not as rules, but as *perspectives*. The builder gets: "the warmth advocate cares about X, the performance advocate cares about Y, here's the tension you need to navigate."

The builder isn't executing a task. It's navigating a **force field** of competing priorities specific to this project. It can make creative tradeoffs because it understands *why* each dimension matters.

### Tension resolution during execution

Work gets evaluated by all N evaluators. Each scores through its lens. They don't just pass/fail — they produce **tensions**:

> "The warmth evaluator scores this 9/10 — the hero image feels inviting. The performance evaluator scores this 4/10 — the image is 2MB and will take 6 seconds on mobile. **Tension detected.** Orchestrator: find a solution that satisfies both. Compress the image to maintain warmth while hitting performance targets."

The orchestrator doesn't pick a winner. It identifies conflicts and pushes for solutions that satisfy multiple dimensions simultaneously. The best outcomes happen when a builder finds a solution that scores high on *all* dimensions — that's the creative magic.

Evaluators can also **build alternatives**. "The warmth evaluator thinks the header should look like this instead" — producing a competing implementation. The orchestrator picks the one that best satisfies the full force field.

### Generalization

This works for any project type because the governance is derived, not configured:

| Project | Possible emergent dimensions |
|---|---|
| Painting contractor website | Trust-at-first-glance, warmth, mobile speed, lead conversion, local SEO |
| SaaS API backend | Correctness, security, developer ergonomics, latency, documentation clarity |
| Personal assistant | Helpfulness, personality consistency, response quality, context retention, safety |
| Research paper | Rigor, clarity, narrative flow, citation completeness, audience calibration |
| Business plan | Market accuracy, financial realism, narrative persuasiveness, risk coverage, actionability |

Same harness. Completely different governance. Generated from the project, not from a template.

### The builder in this model

The builder isn't a separate species from the evaluators. It's the same kind of agent given a different job — "create" instead of "evaluate." Evaluators could produce competing implementations. Builders could evaluate their own work against the rubrics before submitting.

The distinction between builder and evaluator is a job assignment, not an agent type. This means the system scales without needing new agent definitions for each project type.

### Per-task dimensional attention (not per-project)

Fixed evaluators for an entire project is too coarse. A homepage and a booking API endpoint shouldn't have the same governance. Instead, the dimension library works like **attention** — all dimensions exist, each one does a fast relevance check against the current task, and only the ones that light up get brought in for deep evaluation.

```
Task submitted
      │
      ▼
Dimension Library (all 50+)
  Each dimension does a fast relevance check.
  "Does this task touch my domain?"
      │
      ▼
Orchestrator selects top 5-8 by relevance score
      │
      ▼
Deep evaluation + advocacy from activated dimensions
      │
      ▼
Tension resolution + builder feedback
      │
      ▼
Next task → completely different dimensions may activate
```

"Build the hero section" activates trust-at-first-glance, warmth, mobile performance, visual hierarchy, lead conversion. "Build the booking API" activates correctness, input validation, security, error messaging, data integrity. Same harness, same library, completely different governance per task.

**This solves the coordination ceiling.** Research says multi-agent coordination breaks down beyond 4 agents. But we're not coordinating 50 agents. We're activating 5-8 *per task* from a library of 50. Coordination is always small. Coverage is enormous.

### Nested governance: fractal dimensions

The dimension library isn't flat. It's fractal — major governors contain sub-fields, which contain specific measures, which can contain finer measures still. Like personalities: there are major personality types, but each one has many traits that inform its final expression.

```
DESIGN (major governor — a persona)
  │
  ├── Visual Identity
  │     ├── color harmony
  │     ├── typography consistency
  │     ├── spacing rhythm
  │     └── brand alignment
  │
  ├── User Experience
  │     ├── trust-at-first-glance
  │     ├── cognitive load
  │     ├── navigation intuition
  │     └── mobile-first feel
  │
  ├── Accessibility
  │     ├── contrast ratios
  │     ├── screen reader flow
  │     └── keyboard navigation
  │
  └── Emotional Response
        ├── warmth
        ├── professionalism
        └── urgency

CORRECTNESS (major governor)
  ├── Functional (input validation, error handling, edge cases)
  ├── Data Integrity (type safety, state consistency)
  └── ...

PERFORMANCE, INTENT ALIGNMENT, SECURITY, etc.
```

### Activation through cascading "20 questions"

For a painting contractor's homepage hero section:

1. **Which major governors activate?** Design, Intent Alignment, Performance. (Not Security — static hero section.)
2. **Within Design, which sub-fields?** Visual Identity, User Experience, Emotional Response. (Not Accessibility deeply.)
3. **Within Emotional Response, which measures?** Warmth and professionalism. (Not urgency.)
4. **Within User Experience, which measures?** Trust-at-first-glance, cognitive load. (Not keyboard navigation.)

From thousands of possible measures, this task gets evaluated by 8-12 that actually matter — the *right* 8-12, selected through cascading relevance, not flat keyword matching.

The cascade is cheap: 5-7 major governors, 3-5 sub-fields per activated governor, 2-4 measures per sub-field. Three to four levels of branching with a small factor at each level. Never scanning thousands.

### Governors are personas, not checklists

A major governor isn't a prompt with a list of things to check. It's a **persona with internalized values**. The Design governor gets a personality:

> "You care deeply about visual coherence. You believe design should feel inevitable — like nothing could be changed without making it worse. You have high standards but you also recognize when something unexpected works better than what was planned."

The nested measures aren't a lookup table. They're emergent from that persona encountering specific work. The Design persona *naturally* focuses on color harmony when evaluating a hero section and on typography when evaluating an about page. Just like a human designer would.

The dimension library isn't a database of measures. It's a **library of personas at multiple scales**. Major governors are broad personas. Sub-fields are personality facets. Specific measures are instincts. Each level has its own neural field that activates contextually.

### Library growth

The library grows organically. Every project that invents a new dimension — a new persona, a new facet, a new instinct — adds it. Over hundreds of projects, the library becomes a comprehensive model of *everything that can matter about software*.

No human could write this list. It emerges from the system using itself. Dimensions that consistently catch real issues get promoted. Dimensions that never provide actionable feedback get deprecated. The library self-prunes and self-organizes.

### Open questions

- **When to recalibrate?** If intent drifts significantly, the activated dimensions for similar tasks might need to shift. The orchestrator should detect when the governance is no longer fitting and adjust trigger profiles.
- **How to evaluate the evaluators?** Cross-project learning: if "trust-at-first-glance" consistently catches issues that other dimensions miss, it gets promoted. If a dimension never provides actionable feedback, it gets deprioritized.
- **Dimension interaction effects.** Some dimensions amplify each other (warmth + trust). Some genuinely conflict (performance + visual richness). The orchestrator needs to learn which tensions are productive and which are just noise.
