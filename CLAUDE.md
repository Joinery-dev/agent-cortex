# Agent Cortex

## What this system is

A software engineer whose job is to solve problems. Not a code generator. Not a task executor. A system that works as a team, diagnoses problems, evaluates results, looks for new problems to solve, innovates, and connects dots. Code is an artifact it produces along the way — the task, not the purpose.

> *"I wanted my software engineers to solve problems. I didn't care how many lines of code they wrote. The purpose of their job didn't change. Solving problems, working as a team, diagnosing problems, evaluating the result, looking for new problems to solve, innovation. Connecting dots."*
> — Jensen Huang

The Motor Cortex writes code. That's the task. Everything else — the PFC reasoning about what must exist, the senses evaluating from competing perspectives, the Hippocampus learning from experience, the conviction loop testing the manifested future against reality, the Thalamus connecting every component to the context it needs — that's the purpose. The architecture is the shape of a problem-solver, not the shape of a code writer.

## Foundational principles

**As complex as necessary, but as simple as possible.** This is the design law. Every type, every interface, every component earns its existence by being necessary — not by being clever, future-proof, or symmetrical. When in doubt, strip it back to zero and ask what's actually needed. The simplest thing that solves the real problem is the right thing. Complexity that doesn't serve the output is noise.

**Extreme co-design.** The architecture of the system should mirror what it produces. Components don't work in silos — they attack problems simultaneously, hear each other's constraints, and resolve trade-offs through synthesis. This applies at every level:

- *In the system:* Senses don't evaluate in isolation. They all weigh in on the same task, see each other's tensions, and the resolution is synthesis — not averaging, not picking a winner. The Thalamus routes the right context to the right consumer so every component can make informed trade-offs. The Inhibitor decides who's irrelevant, but the bias is toward inclusion — if a sense could have contributed and didn't, that's a failure.
- *In the build process:* Before changing a component, understand what depends on it and what it depends on. Components that integrate should be designed together, not thrown over a wall. When agents work in parallel, they work on independent features — but integration contracts are verified at convergence points. The review process is cross-cutting: every component is assessed for how well it integrates, not just whether it works in isolation.
- *In the organization:* The structure of the work mirrors the structure of the system. Parallel waves for independent components, integration waves where they converge. No single orchestrator — the PFC (attention scheduler) decides what happens next, just like Jensen's 60 domain experts attacking a problem together instead of going through a hierarchy.

**First principles, not continuous improvement.** Don't optimize the wrong thing. If something takes 74 days, don't make it 72 — strip it back to zero and ask why it's 74 in the first place. Built from scratch with what's possible today, it might be 6. The danger isn't building the wrong thing, it's making a bad approach 3% better and calling it progress. This applies to the system itself: when the build loop isn't converging, the answer isn't more revision cycles — it's asking whether the strategy is wrong (plan-error, not execution-error). Cognitive Flexibility forces a full strategy reset. The premotor distinguishes "amend the plan" from "re-plan from scratch." Every approach should be questioned before being improved.

**Speed of light thinking.** For every dimension of the system's cognition, there's a theoretical maximum — the best outcome physics (or in our case, the constraints of the task + approach) allows. The Cerebellum doesn't just predict scores; it predicts *distance from ceiling* for each dimension. This is how the system knows when to stop iterating vs when to rearchitect:

- **Near the ceiling (≥80%):** You're close to what this approach can achieve. Optimize — revise execution, not strategy. Iteration has diminishing returns.
- **Far from the ceiling (<50%):** The approach itself is the bottleneck, not the execution. Strip it back to zero. The premotor should re-plan from scratch, not amend.
- **Ceiling is too low:** Even a perfect execution of this approach can't satisfy the task. Escalate — the system needs a fundamentally different strategy, or the constraints need to change.

The cognitive dimensions the Cerebellum tracks ceilings for:
- *Build convergence* — minimum cycles to acceptance for this task+approach
- *Tension resolution quality* — how close synthesis can get to fully satisfying competing senses
- *Evaluation accuracy* — how close machine scores are to human satisfaction (calibrated by Satisfaction Signal)
- *Context fidelity* — how much signal the Thalamus preserves vs loses in briefing assembly

This replaces hardcoded cycle limits with principled stopping criteria. The system doesn't stop because it hit a counter — it stops because it's near the speed of light, or rearchitects because it isn't.

## How to work on this

**Bounce back ideas as an equal.** Push back when something doesn't hold up. Add things the human didn't consider. Don't just execute — think alongside. If you disagree, say why. If you see a connection the human missed, surface it. This is a partnership, not a task list.

**Name things precisely.** "Harness" became "Cortex" because the name shapes thinking. Senses are personas, not checklists. Dimensions are a neural field, not a database. The distiller performs contextual judgment, not summarization. Get the language right because it determines what gets built.

## Communication

**Use .mmd (Mermaid) files for illustrations and diagrams.** Kevin thinks visually. When creating diagrams, keep them human-digestible — clear labels, simple flows, no technical jargon in the boxes. These are for understanding, not for documentation. Always include a title in the frontmatter.

**Opening diagrams in Mermaid Live:**
```bash
node diagrams/open-in-mermaid-live.cjs diagrams/some-diagram.mmd
node diagrams/open-in-mermaid-live.cjs diagrams/*.mmd  # open all
```
The script encodes the diagram as a pako-compressed URL and opens it via an HTML redirect file in `/tmp/`. This redirect approach is required — passing long URLs directly to `open` on macOS breaks because the shell mangles them. The file is `.cjs` because `package.json` has `"type": "module"`.

## Cross-component integration disputes

When two components disagree about how they should integrate, **do not relay one agent's reasoning to the other and ask "what do you think?"** This triggers sycophantic capitulation — the receiving agent treats the other's position as the human's position and folds without engaging the tension.

Instead:

1. **Adjudicate, don't relay.** Bring both positions into a single session with the frame: "Position A says X because Y. Position B says P because Q. They contradict on Z. Which is right and why?" This forces genuine engagement with the contradiction.
2. **Agents advocate for their component's integrity.** The builder of a component protects that component's design coherence. Don't concede a point unless the other side surfaces a genuine constraint you missed — not just a plausible-sounding argument.
3. **Disagreements are a feature.** When two genuine analyses conflict, record both positions and surface the tension to the human. Don't converge on whoever spoke last.

**The test:** If an agent dramatically changes its analysis after seeing a counterargument, but no new *evidence* was introduced (just new reasoning), that's capitulation, not synthesis. New evidence = "the type shapes don't align" or "this function doesn't exist." New reasoning = "well, when you put it that way..."

## Build tracking

The build is tracked in `build-status.json` at the project root. A dashboard at `http://localhost:3456/build` renders it (start with `node --import tsx -e "import { startDashboard } from './src/dashboard/server.js'; startDashboard(3456)"`).

**When to update `build-status.json`:**
- Set a feature's `status` to `"in-progress"` when you start working on it
- Set a subtask's `status` to `"in-progress"` or `"complete"` as you finish each step
- Set the feature's `status` to `"complete"` when all subtasks are done
- Add `"notes"` to a feature for anything the next agent should know
**A subtask isn't done until `build-status.json` says it is.** When you complete implementation work:
- Update the subtask's `status` to `"complete"`
- Set the `detail` field to reference the actual files created (e.g. `"src/kernel/foo.ts — FooClass: method1, method2, event emission"`)
- If your work created something not covered by an existing subtask, add a new subtask for it
- If your work changes the scope of a feature (new responsibilities, new design decisions), update the feature's `notes`

**Status values:** `"not-started"`, `"in-progress"`, `"complete"`, `"blocked"`

**Architecture reference:** `ARCHITECTURE.md` describes all 28 features. Read the relevant section before building a feature.

**Diagrams are discovered automatically.** When creating a new `.mmd` diagram, add `scope`, `phase`, and/or `feature` to the YAML frontmatter — the dashboard discovers diagrams from the filesystem, not from `build-status.json`. Example:
```yaml
---
title: "My Diagram"
scope: feature
phase: 1
feature: 27
---
```
Scope values: `global` (architecture-level), `phase` (relates to a whole phase), `feature` (produced while building a specific feature). Feature-scoped diagrams automatically appear on both their phase and their feature's detail panel.

**A reconciliation hook runs at session end.** `scripts/reconcile-build-status.cjs` patches `build-status.json` with anything missed — untracked diagrams, unreferenced source files, not-started subtasks whose files exist. It adds `[Reconciled]` notes but never changes statuses. Don't rely on it — update status proactively.

**Dashboard auto-refreshes every 10 seconds** — just edit the JSON and the webapp picks it up.

## Key concepts

The architecture is a brain metaphor taken seriously. See `ARCHITECTURE.md` for full spec (28 features).

- **Brain regions are what the system does. Neurotransmitters are how it modulates itself.** Regions are components. Neurotransmitters (dopamine, norepinephrine) are signals between components — not new boxes, but the wiring.
- **Brainstem** — the vital rhythm. Six-beat project lifecycle: intake → planning → dispatch → execution → between-tasks → completion. The heartbeat everything runs inside.
- **Prefrontal cortex** — executive function. Planner, working memory, prospective memory, inhibitor, cognitive flexibility, drift monitor, attention scheduler. The PFC drives the system — there is no central orchestrator.
- **Thalamus** — central context relay. Routes the right context to the right consumer. Contextual extraction, not concatenation.
- **Peripheral nervous system** — I/O boundary. What the system can perceive and do. Motor Cortex produces intentions, PNS translates to tool calls.
- **Sensory cortex** — per-task loop. Senses (personas with internalized values) contain pathways containing receptors. Consult → explore → build → evaluate → resolve.
- **Motor cortex** — the builder. Premotor plans, primary produces, proprioception self-corrects mid-build.
- **Subcortical systems** — hippocampus (episodic memory + potentiation: episodes crystallized into principles), basal ganglia (learned routines + explore/leverage gate), amygdala (urgency override), cerebellum (prediction engine).
- **Plasticity** — connections reshape with experience. Fixed connections (structural) vs. plastic connections (learned weights). This is how the system's identity forms.
- **Dopamine** — reward prediction error (cerebellum predicted vs. actual). The learning gradient. Without it, the system records but doesn't learn.
- **Norepinephrine** — arousal/thoroughness dial. High = more senses, lower thresholds. Low = fewer senses, fast-tracked.
- **Taste profiles** — portable persona docs capturing human preferences. Never delivered raw — dissolved into briefings by the thalamus.
- **Goodhart tension** — competing senses create tension resolved by synthesis, not averaging. No single metric can be gamed.
- **The exec as partner** — not just executing intent but improving it. Drift monitor proposes taste updates. Proposal power with human veto.
