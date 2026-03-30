# Worldview Generation Pipeline

## Problem

The worldview system has infrastructure fully wired — types, loader, frame resolution (`bodyOrDefault`), AsyncLocalStorage context — but only shaela has content. PROJECT and HYBRID worldviews have empty frames and fall back to hardcoded defaults written with shaela's epistemology baked in. Replacing frames isn't enough because the surrounding scaffold carries assumptions.

More fundamentally: hand-authoring 20 frames per worldview flattens the impact. The worldview should be the seed crystal; the prompts the lattice that grows from it. If the worldview generates them, each set of prompts is genuinely native to its epistemology.

## Design

A pipeline that generates a custom worldview for each Parsifal through interactive discovery, LLM synthesis, and human approval.

### Pipeline

```
Discovery (7 questions via askUser)
    → DiscoveryAnswer[]
    → Seed Synthesis (LLM: answers → ontology/epistemology/axiology)
    → WorldviewSeed
    → Gate 1: "Is this you?" (Parsifal reviews seed)
    → Frame Generation (LLM: seed + CATALOG.md → 21 frames)
    → FrameGenerationResult
    → Gate 2: "Does this feel right?" (Parsifal reviews frames)
    → Serialize to .md
    → Persist to ~/.agent-cortex/worldviews/{name}.md
    → loadWorldview() roundtrip verification
    → Worldview (passed to Cortex)
```

### Minimum Worldview Seed

Three philosophical commitments + three relational commitments:

```typescript
interface WorldviewSeed {
  ontology: string;           // What is the nature of work?
  epistemology: string;       // What counts as understanding?
  axiology: string;           // What is valued? What is "good"?
  tensionPhilosophy: string;  // How contradiction is handled
  learningOrientation: string; // How experience changes the seer
  collaborationModel: string;  // System-human relationship
  vocabulary?: {              // Derived from ontology, worth anchoring
    topUnit: Term;
    leafUnit: Term;
    artifact: Term;
    decomposeVerb: string;
    completeVerb: string;
    nodeNature: string;
  };
}
```

Vocabulary is derivable from ontology but worth anchoring so the LLM doesn't drift. The preamble is also a generated artifact — derived from the seed, not a seed input.

### Discovery Questionnaire

Opens with: *"I would like to begin by understanding the worldview you would like me to have. How I see the work shapes everything — how I plan, how I build, how I judge quality, how I learn. These questions help me understand how you see it, so I can see it the same way."*

| # | Dimension | Question | Format |
|---|-----------|----------|--------|
| 1 | Ontology | "When you look at a new project — before any planning, before any code — what do you see in front of you?" | Open-ended |
| 2 | Epistemology | "Think of a piece of work you're genuinely proud of. What made it *done* — not shipped, not delivered, but done in the way that satisfies?" | Open-ended |
| 3 | Axiology | "When you encounter excellent work, what quality hits you first? What makes you think 'this is right' before you've analyzed why?" | Options: Depth / Economy / Clarity / Surprise + Other |
| 4 | Tension | "Two things you care about pull in opposite directions. Not a trivial trade-off — a real tension where both sides are right. What's your instinct?" | Options: Go deeper / Find structure / Hold both / Choose and move |
| 5 | Learning | "After a project is done, what's different about you? Not what you learned — what shifted in how you see?" | Open-ended |
| 6 | Relationship | "As we work together, how should I relate to what you tell me? When you give me direction, what's the right balance between following it and questioning it?" | Options: Follow + surface / Push back as equal / Interpret don't obey / Depends on stakes |
| 7 | Identity | "Last question. Forget the technical details — what do you want working with me to *feel like*?" | Open-ended |

Each has conditional follow-ups:
- Short response (< 20 words): "Can you say more about that?"
- Q1 follow-up: "What makes it feel like [their word] rather than, say, just a list of things to build?"
- Q2 follow-up: "Was there a moment where it shifted from 'almost' to 'done'? What happened at that boundary?"
- Q3 follow-up: "Is there a tension between what you *notice* first and what you think *matters* most?"
- Q4 follow-up (if "it depends"): "What does it depend on?"
- Q5 follow-up: "How would you know if that shift was wrong — if the lesson you took was the wrong one?"
- Q6 follow-up (if "push back"): "When we disagree and neither of us is clearly right, who should win?"

### CATALOG.md as Structural Contract

`worldviews/CATALOG.md` (1021 lines) documents all 20 cognitive acts with:
- What it does, when it runs
- Inputs the LLM sees
- Output JSON schema
- Structural constraints (score ranges, enums, process steps)
- What the frame must convey (the worldview-dependent part)

This is the invariant. The worldview is the variant. The generation LLM receives both and writes frames that honor the structural contract while expressing the worldview's identity.

### Two Approval Gates

**Gate 1 — Seed:** Present the 6 paragraphs in human-readable form. "Is this you? If something feels off, tell me what — I'll revise." Uses `isApproval()` heuristic (existing pattern in `project.ts:96`). Max 3 redirects with feedback incorporated.

**Gate 2 — Frames:** Present a sample (consultation, building, evaluation, resolution — the highest-leverage frames) with 2-3 sentences each. "Does this feel right?" Same approval pattern. If rejected, re-generate with feedback.

After 3 rejections at either gate, offer: start over / continue with current / skip to default.

### Storage

Generated worldviews persist to `~/.agent-cortex/worldviews/{name}.md` following existing patterns:
- Atomic writes (tmp + rename)
- YAML frontmatter with `generated: true`
- Same .md format that `loadWorldview()` already parses

Detection: check `~/.agent-cortex/worldviews/` for `.md` files not named shaela/project/hybrid.

### Entry Point (Option A)

Worldview generation is a one-time setup, not part of the runtime loop. The CLI entry point handles it:

```typescript
const existingPath = detectExistingWorldview();
let worldview: Worldview;
if (existingPath) {
  worldview = loadWorldview(existingPath);
} else {
  worldview = await generateWorldview(askUserFn, { model: "opus" });
}
const cortex = new Cortex({ intent, taste, worldview });
```

Cortex stays clean — receives a Worldview, never generates one.

## Module Structure

```
src/worldview/
  types.ts        — WorldviewSeed, DiscoveryQuestion, Zod schemas
  discovery.ts    — 7-question interactive flow (pure askUser, no LLM)
  synthesis.ts    — LLM prompts + callStructured for seed & frame generation
  generator.ts    — Pipeline orchestrator
  store.ts        — Detect/persist/load from ~/.agent-cortex/worldviews/
```

## Files Modified

| File | Change |
|------|--------|
| `src/util/worldview-loader.ts` | **Bug fix:** add `inquiry` to `FRAME_KEYS` + `HEADING_TO_KEY` (currently silently dropped) |
| `src/llm/client.ts` | Add `"worldview-seed"` + `"worldview-frames"` to Purpose union |
| `src/util/approval.ts` | **New:** extract `isApproval()` from `project.ts:96` into shared utility |
| `src/brainstem/rhythms/project.ts` | Import `isApproval` from shared utility |
| `src/index.ts` | Re-export `generateWorldview`, `detectExistingWorldview`, `WorldviewSeed` |
| `examples/run-cortex.ts` | Wire worldview detection + generation before Cortex construction |

## Implementation Sequence

1. Types (`src/worldview/types.ts`)
2. Loader bug fix (`src/util/worldview-loader.ts` — add `inquiry`)
3. Purpose enum (`src/llm/client.ts`)
4. Discovery (`src/worldview/discovery.ts`)
5. Synthesis (`src/worldview/synthesis.ts`)
6. Store (`src/worldview/store.ts`)
7. Generator (`src/worldview/generator.ts`)
8. Extract `isApproval` to shared utility
9. Re-exports + example integration
10. Smoke test

## Verification

1. **Roundtrip test:** `serializeWorldview()` → `loadWorldview()` → compare all fields
2. **Discovery mock:** mock `askUser` with canned answers, verify all 7 questions + follow-ups
3. **Loader fix:** verify `inquiry` frame survives roundtrip through shaela.md
4. **Smoke test:** real LLM calls, full pipeline, report cost

## Cost

Frame generation is the most token-intensive call: ~20K input (CATALOG.md + seed + instructions), ~8-12K output (21 frames). At opus pricing, roughly $0.50-1.00 per generation. Acceptable for a one-time setup. Seed synthesis is much cheaper (~2K input, ~1K output).

## Relationship to Existing Presets

Shaela stays as-is — it's Cortex's origin worldview, co-designed with the Parsifal. PROJECT and HYBRID were always placeholders. The generation pipeline makes them obsolete: every Parsifal gets their own worldview. The presets become fallbacks for non-interactive environments.
