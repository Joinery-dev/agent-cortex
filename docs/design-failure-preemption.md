# Predictive Failure Preemption via Thalamus Briefing Enrichment

## Context

Every failure produces information. A specification-gap failure tells you "the senses needed clearer acceptance criteria." An integration failure tells you "these two senses were going to conflict and resolution collapsed." An approach-bottleneck tells you "the approach can't reach the ceiling." A revision cycle that fixes the failure confirms that information — at a cost of 50-100K+ tokens.

The failure classifier (from revision cycle reduction) already categorizes failures into four types with different revision strategies. The Cerebellum already does episode-based similarity matching to predict scores. The Thalamus already modulates briefing content and framing based on NE and budget.

The missing piece: **if the Cerebellum can predict the failure mode before building, the Thalamus can inject the information that the failure would have produced — and the failure never happens.**

This is predictive coding applied to the build cycle. The briefing is the prediction. The evaluation is the error signal. Over time, the briefings get so precisely targeted that most failures are preempted before building starts.

---

## Change 1: Store failure classifications in episodes

**Extend `CerebellumEpisode`** in `src/types/cerebellum.ts`:
```
failureCategory?: FailureCategory
failureConfidence?: number
failureObjectingSenseIds?: string[]
```
All optional — pre-existing episodes and accepted-on-first-try episodes won't have them.

**Pass classification through `recordOutcome()`** in `src/subcortical/cerebellum.ts`. The classification is already computed in the build-cycle gate phase and available on `BuildCycleResult.failureClassification`. Thread it from `computeDopamineSignal()` through to episode storage.

**Thread from hooks**: `SubcorticalHooks.computeDopamineSignal()` gains an optional `failureClassification` parameter. `CompositeSubcorticalHooks` passes it to `cerebellum.recordOutcome()`.

---

## Change 2: Predict failure modes before building

**New method on Cerebellum: `predictFailureMode()`** in `src/subcortical/cerebellum.ts`.

Uses existing infrastructure (no new LLM calls):
- `findSimilarEpisodes()` with the task's fingerprint (already computed during `predict()`)
- Filter to episodes that have `failureCategory` data
- Compute weighted distribution over failure categories

**Output:**
```
FailureModePrediction = {
  predicted: FailureCategory | null    // most likely, or null if insufficient data
  distribution: Map<FailureCategory, number>  // probability per category (sums to 1)
  confidence: number                   // 0–1, based on episode count + agreement
  episodesConsidered: number
}
```

**Logic:**
- Insufficient episodes with failure data (< minEpisodes) → return null (cold start, no preemption)
- Compute similarity-weighted vote over failure categories from matching episodes
- `predicted` = category with highest weighted vote, if vote share > 0.4
- `confidence` = vote share of predicted category × min(1, episodesConsidered / 5)

**Cold start behavior**: The system starts with no failure mode data. As tasks complete and failures are classified, episodes accumulate failure categories. After ~5-10 tasks with classified failures, predictions become meaningful. This mirrors how the score prediction system bootstraps — no guessing on insufficient data.

**Wire through `SubcorticalHooks`**: `predictFailureMode(fingerprint)` on the hooks interface, returning `FailureModePrediction | null`. NoOp stub returns null.

---

## Change 3: Thalamus failure-preemptive briefing enrichment

This is the core change. The predicted failure mode becomes an input to the Thalamus's briefing assembly, driving **specific preemptive interventions** per failure category.

### 3a: Attach prediction to gestalt

**New field on `TaskGestalt`** in `src/types/task-gestalt.ts`:
```
failureModePrediction?: FailureModePrediction
```

**Attachment point**: In `sensory-cortex.ts` prepare phase, after `attachPrediction()` and `attachSpeedOfLight()`:
```
const failurePrediction = hooks.predictFailureMode(fingerprint);
if (failurePrediction) thalamus.attachFailureModePrediction(taskId, failurePrediction);
```

### 3b: Consultation-side preemption

When the Thalamus assembles consultation briefings (`forConsultationFromGestalt`), the predicted failure mode modulates what senses receive:

**Predicted specification-gap** → Add to `ConsultationEnrichment`:
```
failurePreemption?: {
  category: FailureCategory
  consultationGuidance: string
}
```
Guidance text: *"Tasks like this historically fail because senses and builder disagree on what 'done' means. Be explicit about your acceptance criteria: state concrete pass/fail conditions, not just directional preferences."*

This prompts senses to produce clearer `SensePerspective.perspective` text with specific criteria — the same information a specification-gap failure would have eventually surfaced through a failed cycle + reconsultation.

**Predicted integration** → Enhance existing `predictedTensions` in the consultation enrichment. The Thalamus already surfaces predicted tensions from the forward briefing. When the failure mode prediction says integration failure is likely, *promote* the predicted tension severity and add guidance: *"This tension historically collapses into capitulation. Each sense should state hard boundaries (non-negotiable minimums) so the motor can build within pre-resolved constraints."*

**Other categories** → No consultation-side change. Approach-bottleneck and local-logic are motor-side problems.

### 3c: Motor-side preemption

When the Thalamus assembles motor briefings (`forMotorFromGestalt`), the predicted failure mode drives specific enrichment:

**New field on `MotorEnrichment`** in `src/types/thalamus.ts`:
```
failurePreemption?: {
  predictedCategory: FailureCategory
  confidence: number
  guidance: string          // category-specific preemptive instruction
  historicalPatterns: string[]  // what went wrong on similar tasks
}
```

**Per-category guidance assembly** (pure function, in thalamus.ts):

- **`specification-gap`**: Extract acceptance criteria from consultation perspectives. Each sense's `SensePerspective` already contains evaluation intent — the Thalamus extracts the concrete expectations and presents them as explicit acceptance criteria. Guidance: *"Historical pattern: builder and senses disagree on 'done.' Here are the concrete acceptance criteria extracted from each sense's consultation."*

- **`integration`**: Extract the predicted tension pair and each side's hard boundaries from consultation. Guidance: *"Historical pattern: [SenseA] and [SenseB] tension collapses into capitulation. Pre-negotiated boundaries: [SenseA minimum], [SenseB minimum]. Build within these constraints."*

- **`approach-bottleneck`**: Promote existing `bottleneckSenses` + `speedOfLight` data (already in MotorEnrichment). Add historical approach-class performance from episodes. Guidance: *"Historical pattern: [approach class] hits ceiling of [X] on [sense]. Alternative approaches achieved [Y]. Consider a different strategy."*

- **`local-logic`**: Extract common failure patterns from similar episodes' evaluation assessments. Guidance: *"Historical pattern: similar tasks fail on [specific issues]. Pay particular attention to [areas]."*

**Key constraint**: The briefing doesn't get bigger. The failure-preemptive section replaces lower-priority enrichment content within the existing token budget (breathing reflex). When failure preemption is active, the Thalamus deprioritizes enrichment that isn't relevant to the predicted failure — e.g., drop historical score trends when the predicted failure is specification-gap (score trends don't help clarify what "done" means).

---

## Change 4: Learning loop closure

**Failure mode prediction accuracy tracking** in `src/subcortical/cerebellum.ts`:

After the actual failure classification runs (in the build-cycle gate phase), compare to the prediction:
- Predicted specification-gap, actual specification-gap → correct prediction
- Predicted specification-gap, actual local-logic → prediction error
- Predicted specification-gap, no failure (accepted first try) → **preemption success** (the intervention may have prevented the failure)

**New accuracy metric**: `failureModeAccuracy` — rolling window, same pattern as score prediction accuracy. Feeds into vital signs for observability.

**Preemption success signal**: When a failure was predicted but didn't occur, that's ambiguous — either the prediction was wrong, or the preemption worked. Track the rate of "predicted failure, no actual failure" over time. If this rate is high AND the overall acceptance-on-first-try rate improves as the system matures, the preemption is working. This is an aggregate signal, not per-task — individual cases are ambiguous.

**Event emission**: `gate:failure-mode-predicted` (before build), `gate:failure-preempted` (predicted failure didn't occur), `gate:failure-prediction-error` (predicted wrong category).

---

## Files to modify

| File | Change |
|---|---|
| `src/types/cerebellum.ts` | Add failure fields to `CerebellumEpisode`, add `FailureModePrediction` type |
| `src/subcortical/cerebellum.ts` | Store failure classification in episodes, add `predictFailureMode()`, track failure mode accuracy |
| `src/brainstem/stubs.ts` | Add `predictFailureMode()` to `SubcorticalHooks` + stub |
| `src/subcortical/hooks.ts` | Wire `predictFailureMode()` to cerebellum |
| `src/types/task-gestalt.ts` | Add `failureModePrediction` field |
| `src/kernel/thalamus.ts` | `attachFailureModePrediction()`, consultation + motor preemptive enrichment |
| `src/types/thalamus.ts` | Add `failurePreemption` to `ConsultationEnrichment` and `MotorEnrichment` |
| `src/brainstem/rhythms/sensory-cortex.ts` | Attach failure mode prediction to gestalt after consultation |
| `src/brainstem/rhythms/build-cycle.ts` | Thread failure classification to `computeDopamineSignal()` |
| `src/llm/prompts.ts` | Render failure preemption sections in consultation + motor prompts |

## Implementation order

1. **Episode storage** (no behavioral change): Extend `CerebellumEpisode` → thread classification through hooks → store in `recordOutcome()`
2. **Prediction** (no behavioral change): `predictFailureMode()` on Cerebellum → hooks interface → gestalt attachment
3. **Thalamus preemption** (behavioral): Consultation-side enrichment → motor-side enrichment → prompt rendering
4. **Learning loop**: Accuracy tracking → preemption success signal → events

## Verification

- `npx tsc --noEmit` after each phase
- Episode storage: inspect stored episodes for failure fields after a failed build cycle
- Prediction: emit `gate:failure-mode-predicted` event, inspect distribution and confidence
- Thalamus preemption: inspect consultation + motor briefing content in trace (content store) for preemptive sections
- Learning loop: emit `gate:failure-preempted` and `gate:failure-prediction-error` events, track accuracy
- End-to-end: run a project with repeated similar tasks, confirm that failure preemption activates after sufficient episodes and reduces first-cycle rejection rate
