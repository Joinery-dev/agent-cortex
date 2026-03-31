# Reflective Evolution of Failure Preemption Guidance

## Context

The failure preemption system (just implemented) predicts failure modes and injects category-specific guidance text into briefings. The guidance texts are static — hardcoded strings in the Thalamus. The learning loop tracks whether preemption worked (`gate:failure-preempted`) or didn't (`gate:failure-prediction-error`), but the guidance itself never improves.

GEPA (arXiv:2507.19457) demonstrates that an LLM reading execution traces + evaluator feedback can propose targeted revisions to text artifacts, outperforming RL with 35x fewer rollouts. The key insight: natural language traces are "the text-optimization analogue of a gradient."

Cortex already has everything GEPA needs:
- **Traces**: Content store records briefings, evaluations, motor plans, failure classifications
- **Actionable Side Information**: Sense evaluations explain *why* the work fell short
- **Outcome measurement**: `failureModeAccuracy` on the Cerebellum tracks preemption success/failure per category
- **Natural trigger**: Rest cycles already consolidate and recalibrate

This design applies reflective mutation to the four failure preemption guidance texts — the one operational artifact where the intervention is isolated, the outcome is directly measurable, and the attribution is clean.

---

## What evolves

Four guidance text artifacts, one per failure category. Currently hardcoded in `thalamus.ts`:

1. **Consultation guidance** for `specification-gap` — prompts senses to specify concrete acceptance criteria
2. **Consultation guidance** for `integration` — prompts senses to state hard boundaries
3. **Motor guidance** per category (4 texts) — injected into builder briefing with historical patterns

Total: 6 text artifacts (2 consultation-side + 4 motor-side).

These move from hardcoded strings to a **guidance store** — a persistent, per-project collection of guidance variants that the Thalamus reads at briefing assembly time.

---

## Change 1: Guidance store

**New file: `src/kernel/guidance-store.ts`** — simple persistent store for guidance variants.

```
GuidanceVariant = {
  id: string
  category: FailureCategory
  consumer: "consultation" | "motor"
  text: string
  version: number              // monotonically increasing
  parentId: string | null      // which variant this mutated from
  stats: {
    timesUsed: number
    timesPreempted: number     // predicted failure didn't occur
    timesFailed: number        // predicted failure still occurred
    preemptionRate: number     // timesPreempted / timesUsed
  }
  createdAt: Date
  active: boolean              // currently selected for use
}
```

**`GuidanceStore` class:**
- `getActive(category, consumer)` → returns the active variant for a category+consumer pair
- `record(category, consumer, taskId, preempted: boolean)` → increments stats on the active variant
- `propose(variant: GuidanceVariant)` → adds a new candidate (not yet active)
- `promote(variantId)` → marks a candidate as active, deactivates the previous
- `getVariants(category, consumer)` → all variants for inspection
- `getUnderperformers(threshold)` → variants with preemptionRate below threshold after N uses

**Initialization**: Seed with the current hardcoded texts as version 0 variants.

**Persistence**: JSON file in the project directory (follows the content store pattern). Loaded at project start, saved after mutations.

---

## Change 2: Wire guidance store into Thalamus

**Modify `src/kernel/thalamus.ts`:**

`assembleConsultationPreemption()` and `assembleMotorPreemption()` currently return hardcoded strings. Change them to read from the guidance store:

```ts
// Before:
case "specification-gap":
  return { category: "specification-gap", confidence, consultationGuidance: "Tasks like this..." };

// After:
case "specification-gap":
  const variant = this.guidanceStore.getActive("specification-gap", "consultation");
  return { category: "specification-gap", confidence, consultationGuidance: variant.text };
```

**Thread `GuidanceStore` into Thalamus constructor.** Optional — falls back to hardcoded defaults when absent (backward compatible).

**Record outcomes**: In the build-cycle gate phase (or between-tasks), after failure classification runs, call `guidanceStore.record(category, consumer, taskId, preempted)` to update stats on whichever variant was active during that task.

---

## Change 3: Reflective mutation during rest

**New consolidation priority: `"evolve-preemption"`** added to the `ConsolidationPriority` union in `src/types/brainstem.ts`.

**Trigger**: During rest priority selection in task-dispatch prepare, add:
```ts
const underperformers = guidanceStore.getUnderperformers(0.5); // <50% preemption rate
if (underperformers.length > 0) priorities.push("evolve-preemption");
```

Only triggers when a guidance variant has been used enough times (≥5) and its preemption rate is below threshold. No evolution on cold start or when guidance is working well.

**New hook: `evolvePreemptionGuidance()`** on `SubcorticalHooks`.

**Implementation** (new file: `src/kernel/guidance-evolver.ts`):

### The reflection pipeline

For each underperforming variant:

**Step 1: Collect traces.** From the content store, gather traces for recent tasks where this variant's category was predicted:

- **Failure traces** (guidance injected but failure still occurred): the briefing content, the evaluation results, the failure classification, the evaluator's assessments explaining what went wrong
- **Success traces** (guidance injected and failure was preempted): same data, showing what worked

Cap at 3 failure traces + 2 success traces (5 total, like GEPA's default minibatch of 3).

**Step 2: Assemble reflection prompt.** One LLM call:

```
You are improving an instruction that Cortex (an AI system) gives to its components
to prevent a specific type of failure.

CURRENT INSTRUCTION:
<current variant text>

FAILURE CATEGORY: <category name and description>

CASES WHERE THE INSTRUCTION PREVENTED THE FAILURE (what worked):
<for each success trace:>
  - Task: <task description>
  - Briefing included: <the guidance text as injected>
  - Evaluation outcome: <what the senses said>

CASES WHERE THE FAILURE STILL OCCURRED DESPITE THE INSTRUCTION (what didn't work):
<for each failure trace:>
  - Task: <task description>
  - Briefing included: <the guidance text as injected>
  - Evaluation outcome: <what the senses said — why it still failed>
  - Failure details: <the failure classification signals and rationale>

PREEMPTION RATE: <N>/<M> (<percentage>%)

Analyze WHY the instruction failed in the failure cases. What did the senses or builder
still get wrong despite the guidance? What pattern distinguishes the success cases from
the failure cases?

Write a revised instruction that addresses the specific failure patterns you identified.
The instruction should be concise (under 500 characters) and actionable.

Return the revised instruction text only, no explanation.
```

**Step 3: Score the candidate.** Don't test it live immediately. Instead, store it as a `proposed` variant with `active: false`. The next time a task with that failure category prediction occurs, use the proposed variant and track its outcome.

Actually — simpler: **A/B testing.** After a mutation is proposed, alternate between the current and proposed variant on subsequent tasks. After N tasks with each (minimum 3), compare preemption rates. If the proposed variant is strictly better, promote it. If not, discard it.

The A/B approach avoids the GEPA complexity of Pareto fronts. We don't need per-instance specialists — there are only 6 guidance texts, and each one targets a single failure category. A simple "is the new version better than the old one?" comparison suffices.

**Step 4: Return result.** The hook returns:
```
{ variantsProposed: number, categories: string[] }
```

### Constraints on mutation

- **Size limit**: Guidance text must be ≤ 500 characters (prevents prompt bloat)
- **Semantic retention**: The reflection prompt explicitly asks for the same failure category — can't drift to a different purpose
- **Minimum sample**: Don't evolve a variant until it's been used ≥ 5 times (need enough data for the reflection LLM to reason about)
- **Cool-down**: Don't evolve the same category more than once per rest cycle
- **Max mutations**: Cap at 3 mutations per rest cycle (token budget for rest)
- **Model**: Use the consultation model (cheaper than motor), since this is a reflection task not a generation task

---

## Change 4: Outcome tracking and A/B resolution

**Extend `GuidanceStore`:**

```
PendingAB = {
  controlId: string         // current active variant
  challengerId: string      // proposed variant
  controlResults: boolean[] // preempted outcomes for control
  challengerResults: boolean[]
  startedAt: Date
}
```

When a pending A/B exists for a category:
- Odd tasks get the control variant, even tasks get the challenger
- After both have ≥ 3 results, compare preemption rates
- Strictly better → promote challenger, discard control
- Not better → discard challenger, keep control
- If neither reaches 3 results within 20 tasks, discard (insufficient signal)

**Wire into Thalamus**: `getActive()` checks for pending A/B and alternates. The Thalamus doesn't need to know about the A/B mechanism — the guidance store handles selection internally.

---

## Files to modify

| File | Change |
|---|---|
| `src/kernel/guidance-store.ts` | **NEW** — GuidanceStore class, GuidanceVariant type, A/B tracking |
| `src/kernel/guidance-evolver.ts` | **NEW** — reflection pipeline, trace collection, prompt assembly |
| `src/kernel/thalamus.ts` | Read guidance from store instead of hardcoded strings |
| `src/types/brainstem.ts` | Add `"evolve-preemption"` to ConsolidationPriority |
| `src/brainstem/stubs.ts` | Add `evolvePreemptionGuidance()` to SubcorticalHooks |
| `src/subcortical/hooks.ts` | Wire evolution hook |
| `src/brainstem/rhythms/rest.ts` | Execute evolution during rest |
| `src/brainstem/rhythms/task-dispatch.ts` | Add evolution trigger to rest priority selection |
| `src/llm/prompts.ts` | Reflection prompt for guidance evolution |

## Implementation order

1. **Guidance store** (no behavioral change): Type, store class, seed with current hardcoded texts, persistence
2. **Thalamus wiring** (behavioral): Read from store, record outcomes
3. **Reflection pipeline** (behavioral): Trace collection, reflection prompt, mutation proposal
4. **Rest integration** (behavioral): Consolidation priority, trigger logic, hook wiring
5. **A/B resolution** (behavioral): Alternation logic, promotion/discard

## Verification

- `npx tsc --noEmit` after each phase
- Guidance store: seed correctly, stats update on record(), getActive() returns expected variant
- Thalamus: briefings contain guidance from store (not hardcoded) — verify via content store
- Reflection: after rest with underperforming guidance, check that a mutation was proposed
- A/B: after sufficient tasks, check that promotion/discard occurred
- End-to-end: run project, artificially inject poor guidance, confirm rest cycle evolves it, confirm preemption rate improves after evolution
