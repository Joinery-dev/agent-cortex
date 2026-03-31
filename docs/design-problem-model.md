# Problem Model: Accumulated Structural Understanding Across Build Cycles

## Context

Cortex's build cycle iterates: build → evaluate → revise. Each rejection gives the premotor the latest evaluation scores and revision instructions. But the premotor doesn't receive what was *learned* about the problem from prior failures. Each cycle sees the current state, not the accumulated structural understanding.

Google DeepMind's Aletheia (arXiv:2602.10177) solved open Erdős problems not by iterating faster, but by accumulating structural understanding through failures. Each failed proof attempt reveals constraints about the problem that no single successful attempt could have surfaced. Over N attempts, the system builds an increasingly detailed model of what the solution *must* satisfy.

The Variance Inequality (arXiv:2512.02731) formalizes why this matters: self-improvement works when verification is strong. The problem model makes verification cumulative — each cycle's verification adds to the map instead of replacing it.

## The gap

Currently the premotor sees on revision:
- The rejected plan (what was tried)
- Latest evaluation scores (how it was received)
- Failure classification (what type of failure)
- Resolution instructions (what the resolver suggests)
- Objecting vs accepting senses (where to focus)

What it does NOT see:
- "Attempt 1 established that semantic HTML alone is insufficient for visual hierarchy"
- "Attempt 2 established that custom typography exceeds the performance budget"
- "Therefore: hierarchy must come from layout structure or color, within the existing font stack"
- "Hard constraint: load time must be < 2.0s (formally verified, measured 3.2s in attempt 2)"

The premotor operates reactively — fixing the latest scores. It should operate strategically — satisfying accumulated constraints.

---

## Change 1: Problem constraint type

**New types in `src/types/motor-cortex.ts`:**

```
ProblemConstraint = {
  id: string
  cycle: number                          // which cycle established this
  category: "structural" | "boundary" | "tradeoff" | "hard"
  constraint: string                     // what the failure revealed
  source: string                         // which sense(s) informed this
  verification: "formal" | "subjective"  // hard check vs assessment
  supersedes?: string                    // id of constraint this refines/replaces
}
```

Four constraint categories:
- **structural**: What the problem actually requires (not what was assumed). "Visual hierarchy requires explicit visual differentiation, not just semantic structure."
- **boundary**: Limits on the solution space. "Custom fonts push load time above budget."
- **tradeoff**: Tensions that must be synthesized, not traded. "Hierarchy and performance are in tension — layout-based hierarchy resolves it, typography-based hierarchy doesn't."
- **hard**: Formally verified facts with numeric thresholds. "Load time: 3.2s measured, 2.0s target. FAIL."

---

## Change 2: Constraint extraction after gate rejection

**New pure function in `src/kernel/problem-model.ts`:**

```
extractConstraints(
  cycle: number,
  evaluations: SenseEvaluation[],
  rejectionDrivers: WeightedEvaluation[],
  failureClassification: FailureClassification,
  previousConstraints: ProblemConstraint[],
): ProblemConstraint[]
```

No LLM call — structured extraction from existing data:

1. **From rejection drivers (subjective):** Each rejecting sense's assessment becomes a structural or boundary constraint. The assessment text already explains *why* the sense rejected — this IS the structural insight, just not framed as a constraint yet. Extract the sense name + the assessment as a constraint.

2. **From evaluation observations (formal):** Agentic evaluators produce `EvaluatorObservation[]` with `kind: "measurement" | "check" | "finding"`. Measurements and checks with `pass: false` become hard constraints with the observed value vs threshold.

3. **From tension resolutions (tradeoff):** When two senses tension and the resolution identifies a synthesis, that synthesis becomes a tradeoff constraint: "SenseA and SenseB tension on X — resolve via Y."

4. **From failure classification (structural):** The classification category itself implies a meta-constraint:
   - `integration`: "The tension between [senseA] and [senseB] must be genuinely synthesized, not traded."
   - `approach-bottleneck`: "The current approach class cannot reach the ceiling — a different strategy is required."
   - `local-logic`: [no meta-constraint — the specific assessment is sufficient]
   - `specification-gap`: [shouldn't reach here — spec-gap exits early to reconsultation]

5. **Deduplication:** If a new constraint is semantically similar to an existing one (same sense, same category, similar text), supersede the old one rather than adding a duplicate. Simple heuristic: same sense + same category → replace.

---

## Change 3: Accumulator + prepare phase threading

**Extend `BuildCycleAccumulator`:**
```
problemConstraints: ProblemConstraint[]
```

Initialize to `[]`. After each gate rejection (in the gate phase, after failure classification), call `extractConstraints()` and append to the accumulator.

**Extend `RevisionContext`:**
```
problemConstraints?: ProblemConstraint[]
```

In the prepare phase, include `acc.problemConstraints` in the revision context.

---

## Change 4: Render in revision prompt

**Modify `premotorRevisionUser()` in `src/llm/prompts.ts`:**

When `revision.problemConstraints` is present and non-empty, add a new section between the previous plan and the evaluation results:

```
ACCUMULATED PROBLEM UNDERSTANDING (constraints established by prior attempts):

HARD CONSTRAINTS (formally verified — these are facts):
- [cycle N] Load time: 3.2s measured vs 2.0s target. [Performance, formal]

STRUCTURAL INSIGHTS (what prior attempts revealed about the problem):
- [cycle 1] Visual hierarchy requires explicit visual differentiation, not just semantic structure. [Design, subjective]
- [cycle 2] Custom typography exceeds performance budget — hierarchy must use layout/color. [Performance, subjective]

TRADEOFFS (tensions that must be synthesized):
- [cycle 2] Design × Performance: hierarchy and load time tension — layout-based hierarchy resolves it. [subjective]

Your revised plan must satisfy ALL hard constraints and address ALL structural insights.
Do not re-attempt approaches that violated established constraints.
```

Grouped by category (hard first — non-negotiable), then structural, then tradeoff. Each prefixed with the cycle that established it so the premotor can see the learning trajectory.

---

## Change 5: Crystallization on task completion

When the build cycle completes (accepted), if `problemConstraints` is non-empty, thread the constraints onto `BuildCycleResult`:

```
problemConstraints?: ProblemConstraint[]
```

This flows through `SensoryCortexResult` → `OrchestratorResult` → `recordEpisode()`. The Hippocampus receives the accumulated constraints as part of the episode. During potentiation, constraints from multiple episodes can be clustered into cross-task principles:

- Episode A constraint: "custom typography exceeds performance budget on image-heavy pages"
- Episode B constraint: "web fonts add 200ms+ to first contentful paint"
- Crystallized principle: "typography choices are a primary driver of performance on content-heavy pages — prefer system fonts or variable fonts over custom font families"

This is the cross-task learning that Aletheia achieves in mathematics — the structural understanding that transfers.

---

## Files to modify

| File | Change |
|---|---|
| `src/types/motor-cortex.ts` | `ProblemConstraint` type |
| `src/kernel/problem-model.ts` | **NEW** — `extractConstraints()` pure function |
| `src/brainstem/rhythms/build-cycle.ts` | Accumulator field, gate phase extraction, prepare phase threading |
| `src/llm/prompts.ts` | Render accumulated constraints in `premotorRevisionUser()` |
| `src/types/brainstem.ts` | Add `problemConstraints?` to `BuildCycleResult` |

## Implementation order

1. **Types** (no behavioral change): `ProblemConstraint` type, extend `RevisionContext`, extend `BuildCycleResult`
2. **Extraction** (no behavioral change): `problem-model.ts` pure function
3. **Build-cycle wiring** (behavioral): accumulator field, gate phase extraction, prepare phase threading, completion threading
4. **Prompt rendering** (behavioral): constraint sections in `premotorRevisionUser()`

## Verification

- `npx tsc --noEmit` after each phase
- Run a task that requires 2+ build cycles. Inspect the revision prompt in the content store — constraints should accumulate across cycles.
- Hard constraints from agentic evaluation observations should appear with `[formal]` tag.
- Cycle 2+ revision prompts should show constraints from all prior cycles.
- Verify deduplication: same sense + same category on consecutive cycles should supersede, not duplicate.
