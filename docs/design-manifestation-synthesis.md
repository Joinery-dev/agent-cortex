# Manifestation via Synthesis — Design Document

*Replacing the build-loop manifestation with a linguistic synthesis loop. The manifested future becomes a constraint surface in natural language, not a built artifact.*

**Supersedes:** Phase A (1b) in `design-planning.md`. Phases 1a (Inquiry) and 1c (Approval) are unchanged. Phase B (Path Reasoning) is unchanged — it reasons backward from the same `ManifestedFuture` type.

---

## The Problem

The current manifestation (Phase 1b) runs as a full sensory cortex task: Motor Cortex creates a sandbox branch, premotor plans, primary motor builds an artifact, senses evaluate, gate decides, possibly multiple cycles. This was the architecture's original intent — "planning is a task, not a special phase."

In practice, this is wrong for manifestation. The Motor Cortex is a builder. It produces code, files, artifacts. But a manifestation isn't an artifact to build — it's a shared understanding to reach. When you ask a builder to "describe the finished product," it builds a rough draft instead of describing a destination. It creates sandbox branches to write prose. It makes agentic tool-using calls to produce a text description.

The manifestation is a **constraint surface**. The senses aren't describing how to build something. They're describing what the finished thing looks like from their perspective — what properties it has, what tensions it resolves, what it feels like to use. That's inherently linguistic. You can't capture "this API feels inevitable rather than configured" in a schema.

This connects to specification artistry. The Thalamus modulates between prescriptive and invitational specification depth. A language manifestation is naturally invitational — it describes the destination without dictating the route. That's exactly what lets the builder exceed the specification rather than just satisfy it.

---

## The Design

### Two Faces of Manifestation

The manifested future has two faces:

1. **The vision** — natural language, held by senses and presented to the Parsifal. This is the soul of what's being built. It stays in natural language because that's where nuance lives.

2. **The acceptance surface** — what evaluators actually check against during execution. This isn't a separate artifact — it's what the senses derive from the vision when they evaluate. Each sense knows what to look for because it contributed to the vision. The vision isn't a checklist; the senses are the checklist.

Verification isn't against the text — it's against the senses who wrote it. The vision is the shared understanding. The senses are the living validators.

Where this could break: if a sense manifests something vague enough that it can't later tell whether the build satisfied it. But that's a sense quality problem, not a medium problem. A sense that can't recognize its own vision fulfilled is a bad sense. The convergence loop (below) is where this gets caught early.

### The Synthesis Loop

```
1. Senses manifest
   Each sense describes the finished product from its perspective.
   What properties must it have? What does success look like for
   this dimension? What tensions does it see with other dimensions?

2. Synthesizer combines into vision
   A single LLM call takes all sense perspectives + inquiry context
   and produces a unified natural language vision. Not averaging —
   synthesis. Tensions are named and resolved, not smoothed over.

3. Senses evaluate the synthesis
   Each sense reads the unified vision and responds:
   - Does this capture what I contributed?
   - Are the tension resolutions acceptable from my perspective?
   - What's missing, wrong, or vague?
   - Am I satisfied? (explicit signal)

4. If unresolved tensions remain → synthesizer re-manifests
   Incorporates sense feedback, sharpens vague areas, re-resolves
   tensions where senses pushed back. Back to step 3.

5. When all senses are satisfied → present to Parsifal
   Show unified vision with per-sense contributions and resolved
   tensions. Ask for approval or redirection.

6. If Parsifal redirects → synthesizer re-manifests with feedback
   Parsifal feedback goes back through sense evaluation (step 3),
   because Parsifal input could introduce new tensions the senses
   need to resolve. The system doesn't blindly apply the note.

7. If Parsifal accepts → manifested future is set
```

### Convergence Criteria

The inner loop (steps 3-4) converges when **every sense signals satisfaction**. A sense is satisfied when:
- Its core perspective is represented in the vision
- Tension resolutions involving its dimension are acceptable (not necessarily ideal — acceptable)
- Nothing in the vision is vague enough that the sense couldn't later recognize fulfillment

This last criterion is critical. The convergence loop is a **sense calibration mechanism**. A sense that can't sharpen its perspective under feedback from other senses gets exposed during manifestation, not during build evaluation when it's expensive. If Design says "the visual language should feel bold" and can't, under synthesis pressure, clarify what "bold" means for this specific project — that's a signal.

Maximum convergence rounds: configurable, default 4 (matching inquiry convergence). If senses haven't converged by the limit, the vision goes to the Parsifal with unresolved tensions flagged explicitly.

### What the Synthesizer Produces

The synthesizer output is a `ManifestedFuture`:

- **`vision`**: Natural language description of the finished artifact. Concrete enough that someone could evaluate a real artifact against it. Not a feature list. Not a spec. The actual finished thing, from every dimension.
- **`senseContributions`**: Per-sense perspective summaries (keyed by sense name). What each sense contributed and what it will look for during evaluation.
- **`confidence`**: System confidence in the vision (0-1), derived from sense satisfaction levels and tension resolution quality.
- **`cycles`**: How many synthesis rounds it took to converge.

The type doesn't change. Downstream consumers (`setManifestedFuture`, path reasoning, speed-of-light, evaluation during execution) see the same interface.

---

## What Changes

### Removed
- Manifestation task creation (`planner.createManifestationTask`) — no task needed, no sensory cortex loop
- Sandbox branch creation for manifestation — no git branch, no Motor Cortex
- `runner.run(sensoryCortexDef, manifestCtx, parentId)` for manifestation — replaced by synthesis loop
- `planner.extractManifestedFuture()` — synthesizer produces the `ManifestedFuture` directly
- Agentic (tool-using) LLM calls for vision generation — replaced by structured calls

### Added
- **Sense manifestation call**: each sense produces its perspective on the finished product (parallel, one structured call per sense — same pattern as inquiry)
- **Synthesizer call**: single structured call combining perspectives into unified vision
- **Sense evaluation call**: each sense evaluates the synthesized vision and signals satisfaction (parallel)
- **Convergence loop**: repeat synthesis + evaluation until all senses satisfied or max rounds

### Unchanged
- Phase 1a (Inquiry) — senses still ask clarifying questions, Parsifal answers
- Phase 1c (Approval) — Parsifal still approves or redirects
- `ManifestedFuture` type — same shape, same consumers
- Everything downstream: path reasoning, speed-of-light ceiling, evaluation during execution
- Thalamus integration: `setManifestedFuture(future.vision)` still called on approval

---

## LLM Call Budget

Current manifestation: 1 agentic multi-turn call (Motor Cortex) + N consultation calls + N evaluation calls per cycle. Heavy, unpredictable token usage.

New manifestation per convergence round:
- **N sense manifestation calls** (parallel) — one structured call per active sense
- **1 synthesizer call** — structured, combining N perspectives
- **N sense evaluation calls** (parallel) — one structured call per active sense

With 11 senses and 2 convergence rounds: ~45 structured calls vs 1 agentic call + ~22 structured calls. More calls, but each is cheap and predictable. No tool use, no sandbox, no git branches. Total tokens likely lower because structured calls are tightly scoped.

First round only: if senses converge immediately (no tensions, clear intent), it's 11 + 1 + 11 = 23 calls. Worst case (4 rounds): 11 + 4*(1 + 11) = 59 calls.

---

## Connection to Speed of Light

The Cerebellum's speed-of-light ceiling still works. Per-sense ceilings come from consultation during execution (not from manifestation). The manifestation anchors what the ceilings *mean* concretely — "8/10 for Design means this specific visual language is achieved" — but the ceiling numbers themselves are computed from sense estimates and episode history, not from the manifested text.

The manifested future makes ceilings concrete rather than statistical. Evaluation during execution asks "how close is this to the outcome that must exist?" — the manifested future is the "outcome that must exist." The evaluator reads both the manifestation and the built artifact, then scores. No prose-to-code diffing needed.

---

## Connection to Conviction Loop

The manifested future produced by this loop is the same object the conviction loop tests against. When a large dopamine signal fires during execution, the PFC tests: does this vision still hold given the new information? If conviction breaks, the manifestation can be reshaped — which means re-running the synthesis loop (not the full build machinery).

This is actually cheaper to re-run than the current approach. Reshaping a linguistic vision is a few structured calls. Reshaping a built artifact means rebuilding.

---

## Risk: Vague Senses

If a sense produces a vague manifestation perspective ("the design should feel modern"), the convergence loop is the first line of defense. Other senses' concrete perspectives create synthesis pressure — the synthesizer will produce something specific, and when the vague sense evaluates it, it either sharpens ("modern means: generous whitespace, system font stack, muted palette with one accent color") or waves it through.

If it waves through vague: it will fail during build evaluation, scoring low without clear rationale. That failure is visible and learnable (hippocampus records it). Over time, the system learns which senses produce vague manifestations and can flag this.

The convergence loop is a sense calibration mechanism. It doesn't guarantee every sense is sharp, but it makes vagueness visible early rather than expensive later.
