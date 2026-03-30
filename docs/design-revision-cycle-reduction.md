# Reducing Revision Cycles: Failure Classification + Revision Prediction + Scoped Revisions

## Context

Each revision cycle costs premotor + motor + evaluation = 50-100K+ tokens. Research (arXiv:2602.02896) shows different failure types need different revision strategies — self-critique gets 0% improvement on integration failures. CATTS (arXiv:2602.12276) shows that iterating when consensus is high actually degrades outcomes. The system currently treats all rejections identically: full re-plan + full rebuild + full re-evaluation, even when only one sense objects.

Three changes that compose together:

---

## Change 1: Classify failure before revising

**New file: `src/kernel/failure-classifier.ts`** — pure functions, no LLM calls, follows the `evaluation-weighter.ts` pattern.

**New types in `src/types/motor-cortex.ts`:**
```
FailureCategory = "local-logic" | "integration" | "specification-gap" | "approach-bottleneck"
FailureClassification = { category, confidence, objectingSenseIds, signals, rationale }
```

**Classification heuristics** (all inputs already available in gate phase):
- **`approach-bottleneck`**: SoL gap > 0.5, or oscillation on 2+ receptors, or conviction verdict was "reshape". Conviction already handles reshape, but explicit classification enables downstream routing.
- **`integration`**: High-severity tensions present AND rejection drivers come from both sides of a tension. Or collapse detected (capitulation = failed integration).
- **`specification-gap`**: Multiple evaluations with `improvementPotential.level === "significant"` AND plan confidence was decent (>0.6). The motor thought it did fine but senses disagree about what "done" means → needs reconsultation, not re-building.
- **`local-logic`** (default): Few rejection drivers (1-2 senses), no tensions or only low-severity, no oscillations. Best case for targeted surgical revision.

**Where in build-cycle.ts**: After collapse detection (line ~1036), before the `return { action: "continue" }`. Store in `acc.lastFailureClassification`.

**Routing effect for `specification-gap`**: Return `{ action: "complete", accepted: false }` with `specificationGap: true` on `BuildCycleResult`. The inner build-cycle exits early. The outer sensory-cortex loop already handles non-accepted results by checking improvement potential and reconsulting — the specification-gap signal just avoids wasting an inner revision cycle on a problem that needs reconsultation.

---

## Change 2: Predict revision value before spending tokens

**New method on Cerebellum: `predictRevisionDelta()`** in `src/subcortical/cerebellum.ts`.

Uses existing data (no new LLM calls):
- Speed-of-light gap for this task (already cached)
- Current composite score
- Objecting sense scores from rejection drivers
- Failure classification from Change 1

**Logic:**
- If failure is `specification-gap` → delta = 0, shouldSkip = true (needs reconsultation)
- If failure is `approach-bottleneck` → delta = 0 (conviction already handles reshape, but this prevents a wasted revision cycle if conviction said "proceed" despite bottleneck)
- If SoL gap < 1.0 composite points AND all objecting senses are borderline (5-6) → predicted delta < threshold, shouldSkip = true
- Otherwise → shouldSkip = false, let revision proceed

**Conservative by default**: `shouldSkip` requires confidence > 0.6. Configuration via `CerebellumConfig`:
- `revisionDeltaThreshold`: 0.5 (minimum predicted composite improvement to justify revision)
- `revisionSkipConfidence`: 0.6 (minimum confidence to act on prediction)

**Where in build-cycle.ts**: After failure classification, before committing to revision. If `shouldSkip`, override gate to accept current work with reason "Revision skipped: predicted improvement below threshold."

**Wire through SubcorticalHooks** in `src/brainstem/stubs.ts` + `src/subcortical/hooks.ts`.

**Emit event**: `gate:revision-skipped` with classification, predicted delta, confidence — for observability.

---

## Change 3: Scope revisions to objecting senses

**Extend `RevisionContext`** in `src/types/motor-cortex.ts`:
- `objectingSenseIds?: string[]`
- `rejectionDrivers?: WeightedEvaluation[]` (import from evaluation-weighter)
- `failureClassification?: FailureClassification`

All optional for backward compatibility.

**Pass through in build-cycle.ts**: Store `gateOutput.rejectionDrivers` in accumulator (`acc.lastRejectionDrivers`). In prepare phase (lines 300-308), include in revision context.

**Update `premotorRevisionUser()` in `src/llm/prompts.ts`:**
- Separate evaluations into "SENSES THAT REJECTED (focus here)" and "SENSES THAT ACCEPTED (preserve)"
- Add failure classification hint (e.g., "FAILURE TYPE: Local logic error — targeted fix, not a rebuild")
- Add surgical scope instruction: "This is a SURGICAL revision. Focus on the N objecting senses' concerns. Do NOT modify aspects that accepting senses were satisfied with."
- All gated on `revision.objectingSenseIds` presence — falls back to flat list when absent

---

## Files to modify

| File | Change |
|---|---|
| `src/types/motor-cortex.ts` | Add `FailureCategory`, `FailureClassification`, extend `RevisionContext` |
| `src/kernel/failure-classifier.ts` | **NEW** — `classifyFailure()` pure function |
| `src/subcortical/cerebellum.ts` | Add `predictRevisionDelta()` method |
| `src/types/cerebellum.ts` | Add revision prediction config thresholds |
| `src/brainstem/stubs.ts` | Add `predictRevisionValue()` to `SubcorticalHooks` interface + stub |
| `src/subcortical/hooks.ts` | Wire `predictRevisionValue()` to cerebellum |
| `src/brainstem/rhythms/build-cycle.ts` | Gate phase: classification + prediction gating + accumulator fields + revision context threading |
| `src/types/brainstem.ts` | Add `specificationGap?: boolean` + `failureClassification?` to `BuildCycleResult` |
| `src/llm/prompts.ts` | Restructure `premotorRevisionUser()` with scoped sections |

## Implementation order

1. **Types + pure functions** (no behavioral change): `FailureClassification` types → `failure-classifier.ts` → cerebellum `predictRevisionDelta()` → hooks interface
2. **Build-cycle wiring** (behavioral): accumulator fields → gate phase integration → prepare phase context threading → `specification-gap` early exit
3. **Prompt restructuring**: `premotorRevisionUser()` scoped sections

## Verification

- `npx tsc --noEmit` after each phase
- For failure classification: emit `gate:failure-classified` event, inspect in logs for correct categorization
- For revision prediction: emit `gate:revision-skipped` event, confirm it fires for borderline rejections
- For scoped revisions: inspect the revision prompt content in the trace (content store), confirm objecting/accepted separation
- End-to-end: run a project, confirm fewer revision cycles without quality regression in accepted work
