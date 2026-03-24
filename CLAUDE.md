# Agent Cortex

## How to work on this

**Think from first principles, not from existing solutions.** The breakthroughs here are simple — they're logical puzzles that start from first principles and meet the problems of the day at their core. Don't look at what other harnesses do and add features. Ask what's actually broken and find the simplest thing that fixes it.

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
- If you create a new `.mmd` diagram during a phase, add it to that phase's `"diagrams"` array

**A subtask isn't done until `build-status.json` says it is.** When you complete implementation work:
- Update the subtask's `status` to `"complete"`
- Set the `detail` field to reference the actual files created (e.g. `"src/kernel/foo.ts — FooClass: method1, method2, event emission"`)
- If your work created something not covered by an existing subtask, add a new subtask for it
- If your work changes the scope of a feature (new responsibilities, new design decisions), update the feature's `notes`

**Status values:** `"not-started"`, `"in-progress"`, `"complete"`, `"blocked"`

**Architecture reference:** `ARCHITECTURE.md` describes all 28 features. Read the relevant section before building a feature.

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
- **Subcortical systems** — hippocampus (episodic memory + crystallization of episodes into principles), basal ganglia (learned routines + explore/exploit gate), amygdala (urgency override), cerebellum (prediction engine).
- **Plasticity** — connections reshape with experience. Fixed connections (structural) vs. plastic connections (learned weights). This is how the system's identity forms.
- **Dopamine** — reward prediction error (cerebellum predicted vs. actual). The learning gradient. Without it, the system records but doesn't learn.
- **Norepinephrine** — arousal/thoroughness dial. High = more senses, lower thresholds. Low = fewer senses, fast-tracked.
- **Taste profiles** — portable persona docs capturing human preferences. Never delivered raw — dissolved into briefings by the thalamus.
- **Goodhart tension** — competing senses create tension resolved by synthesis, not averaging. No single metric can be gamed.
- **The exec as partner** — not just executing intent but improving it. Drift monitor proposes taste updates. Proposal power with human veto.
