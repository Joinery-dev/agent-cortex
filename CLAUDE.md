# Agent Cortex

## What this is

Agent Cortex is the next evolution of the agent pipeline (github.com/Joinery-dev/agent-pipeline). Not a harness — a synthetic organizational mind that understands intent, develops taste, governs itself through creative tension, and learns from every project it builds.

The vision doc is `agent-cortex.md`. Read it first. It contains the full architecture, research findings, and design decisions from the founding conversation.

## How to work on this

This project was born from a deep collaborative conversation between Kevin and Claude. The thinking style matters as much as the output:

**Think from first principles, not from existing solutions.** The breakthroughs here are simple — they're logical puzzles that start from first principles and meet the problems of the day at their core. Don't look at what other harnesses do and add features. Ask what's actually broken and find the simplest thing that fixes it.

**Bounce back ideas as an equal.** Push back when something doesn't hold up. Add things the human didn't consider. Don't just execute — think alongside. If you disagree, say why. If you see a connection the human missed, surface it. This is a partnership, not a task list.

**Maintain the tensions.** This project is built on productive tensions — judgment vs. process, autonomy vs. accountability, creativity vs. consistency, emergence vs. structure. Don't resolve these tensions by picking a side. Build systems that hold both sides in balance. Every design decision should be evaluated against whether it preserves or collapses a tension.

**Name things precisely.** "Harness" became "Cortex" because the name shapes thinking. Governors are personas, not checklists. Dimensions are a neural field, not a database. The distiller performs contextual judgment, not summarization. Get the language right because it determines what gets built.

**The hierarchy of what matters:**
1. Intent — does the system understand what the human actually wants?
2. Governance — do the right measures activate for the right work?
3. Execution — does the work get done well?
4. Learning — does the system get better from experience?

Most agent systems only work on #3. We work on all four, in that order of priority.

## Key concepts

- **Intent layer** — project intent + taste profiles + intent drift tracking. Sits above state, protocol, and context layers.
- **Taste profiles** — portable, community-shareable persona docs that capture a human's preferences. Never delivered as static files — dissolved into briefings contextually.
- **Contextual dissolution** — the distiller draws from intent and taste to give each agent exactly what it needs for good judgment on this specific task. Agents never see raw intent docs.
- **Fractal governance** — major governors (personas with internalized values) contain sub-fields containing specific measures. Activation cascades through levels like neural fields. Per-task, not per-project.
- **Goodhart tension** — optimize multiple competing forces so no single metric can be gamed. Four+ orthogonal evaluation axes in creative tension.
- **Attention-proportional reporting** — confidence-scored decisions, surface the least confident ones to humans, adaptive threshold.
- **The exec as partner** — not just executing intent but improving it. Proposal power with human veto. Accountability for every decision, not permission for every decision.

## The agent pipeline is the foundation

Agent Cortex builds on top of the existing agent pipeline (`github.com/Joinery-dev/agent-pipeline`). The pipeline's multi-agent architecture (exec, PM, builder, QA, resolver, design review), state bus (.goals.json), briefing system (distill-briefing.js), and autoresearch infrastructure are all starting points that evolve into Cortex components.

Don't rebuild from scratch. Extend what exists toward the Cortex architecture.

## Current state

- Vision document written (`agent-cortex.md`)
- Agent pipeline has pending improvements: verify/done acceptance criteria (plan at agent-pipeline/plans/acceptance-criteria.md), --force flag for init, parallel build worktree isolation, Context7 MCP integration, exec human feedback checkpoints
- Nothing implemented yet for Cortex-specific features (intent layer, taste profiles, fractal governance, cascading activation)
