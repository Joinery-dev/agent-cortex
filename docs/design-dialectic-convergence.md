# Dialectic Convergence: Two Models, One Understanding

## The idea

The build cycle is a dialectic between two independently maintained models:

- **Builder model** — the motor cortex's understanding of what the problem requires and what the solution must satisfy. Articulated by the premotor as part of its planning output. Refined each cycle based on evaluator feedback.

- **Evaluator model** — the senses' accumulated understanding of what the solution must satisfy, measured against the speed-of-light ceiling. Synthesized from evaluation assessments, formal observations, and failure classifications by one cheap LLM call per rejection.

Acceptance isn't a score crossing a threshold. It's **convergence** — when these two models say the same thing, the problem is understood and the solution follows. The speed of light keeps both models honest — convergence must happen near the ceiling, not at comfortable mediocrity.

Three outcomes:
- **Converge near ceiling** → done. Genuine shared understanding, close to what's achievable.
- **Converge far from ceiling** → approach bottleneck. Both agree, but they're agreeing on something not good enough. Cognitive Flexibility fires.
- **Diverge** → keep iterating. Builder and senses disagree on what the problem requires. The gap IS the remaining work.

## Why this is better than score thresholds

The current gate checks `weightedAcceptability` and `weightedMean` against thresholds. These are numbers that can be gamed, require calibration, and don't capture whether the builder and senses actually agree on what they're building toward.

Convergence is structural, not numeric. It can't be gamed because neither model controls the other. It can't drift because both models are anchored to the SoL ceiling. And it's self-calibrating — no thresholds to tune, because convergence is a property of the relationship between two texts, not a number crossing a line.

The existing gate strategies remain as safety nets. Convergence augments them — it doesn't replace them.

---

## Change 1: Builder model (zero cost — part of existing premotor call)

**Extend `MotorPlan`** in `src/types/motor-cortex.ts`:
```
problemModel?: string
```

**Extend `RevisionPlan`** (inherits from MotorPlan, so it gets the field automatically).

**Update premotor prompts** in `src/llm/prompts.ts`:

For `premotorSystem()`: Add to the expected output schema:
```
"problemModel": "Your understanding of what this problem actually requires —
  what constraints the solution must satisfy, what the key tensions are,
  what the senses will care about. 2-3 sentences. This will be compared
  against the evaluators' understanding to measure alignment."
```

For `premotorRevisionUser()`: Include the previous builder model and the current evaluator model:
```
YOUR PREVIOUS UNDERSTANDING OF THE PROBLEM:
[builder's problemModel from previous cycle, or "(first attempt)" if cycle 1]

EVALUATORS' CURRENT UNDERSTANDING (synthesized from their assessments):
[evaluator model from previous cycle, or "(no evaluations yet)" if cycle 1]

Update your problem model based on what you've learned.
```

The premotor already reasons about what went wrong. Making it articulate "what I now believe this problem requires" is the same cognitive act, made explicit.

**Update Zod schema** (`MotorPlanSchema` in `src/kernel/motor-cortex.ts`): Add `problemModel: z.string().optional()`.

---

## Change 2: Evaluator model (one cheap LLM call per rejection)

**New function in `src/kernel/problem-model.ts`:**
```
synthesizeEvaluatorModel(input: {
  evaluations: SenseEvaluation[]
  rejectionDrivers: WeightedEvaluation[]
  failureClassification: FailureClassification | null
  formalObservations: EvaluatorObservation[]
  speedOfLight: SpeedOfLight | null
  previousEvaluatorModel: string | null
  builderModel: string | null
}): Promise<{ model: string; convergence: number }>
```

One LLM call. System prompt:
```
You maintain the evaluators' model of what a task's solution must satisfy.
You synthesize evaluation feedback, formal measurements, and failure
analysis into a concise problem model — what the solution MUST do.

You also assess convergence with the builder's model: how aligned
are the builder's understanding and the evaluators' understanding?
Score 0-1 (0 = completely different, 1 = saying the same thing).

The speed-of-light ceiling is the anchor: your model should describe
what's needed to reach the ceiling, not just what's needed to be acceptable.
```

User prompt: the evaluator's previous model + evaluation assessments + formal observations + failure classification + SoL ceiling data + builder's current model.

Output (structured):
```
{
  "model": "3 sentences synthesizing what the evaluators have established",
  "convergence": 0.0-1.0,
  "divergenceNote": "what specifically differs (if convergence < 0.8)"
}
```

**Cost**: ~500 input tokens, ~150 output tokens. At Sonnet pricing: ~$0.003 per call. A task with 3 rejections costs an extra penny.

**When it runs**: In the gate phase, after evaluation but before the conviction loop. This gives conviction access to the convergence signal.

---

## Change 3: Accumulator and threading

**Extend `BuildCycleAccumulator`:**
```
evaluatorModel: string | null      // synthesized evaluator understanding
builderModel: string | null        // from premotor's latest plan output
convergence: number | null         // 0-1, from evaluator synthesis
```

**Execute phase**: After premotor produces a plan, store `plan.problemModel` as `acc.builderModel`.

**Gate phase**: After integrate (evaluation done), before conviction loop:
1. Call `synthesizeEvaluatorModel()` with current evaluations + previous models
2. Store `acc.evaluatorModel` and `acc.convergence`
3. Pass convergence to conviction loop as additional evidence

**Prepare phase** (revision): Include both models in `RevisionContext`:
```
builderModel?: string
evaluatorModel?: string
```

---

## Change 4: Gate integration

**Conviction loop**: Add convergence as evidence in `testConviction()`. High convergence (>0.8) near ceiling → strengthen conviction. Low convergence (<0.4) → weaken conviction. The conviction loop already synthesizes multiple signals into a verdict — convergence is one more.

**Signal landscape**: Add to `SignalLandscape`:
```
convergence?: number    // 0-1, from evaluator model synthesis
```

**Gate strategies**: The existing strategies check scores, acceptability, tensions. Convergence adds a fourth dimension:
- High convergence (>0.8) + near SoL → **bias toward acceptance**. The builder and senses agree, and they agree near the ceiling. Even if one sense still objects on a minor point, the structural understanding is shared.
- Low convergence (<0.4) + high scores → **Goodhart alert**. Scores look good but models disagree on what "good" means. The builder may be satisfying metrics without genuine understanding. Bias toward rejection.

This doesn't require rewriting the gate strategies. The conviction loop already modulates the effective NE, which selects the gate strategy. High convergence + near SoL → higher conviction → lower NE → expedient strategy (which accepts more readily). Low convergence → lower conviction → higher NE → deliberative strategy (which requires consensus).

Convergence flows through existing mechanisms. No new gate logic needed.

---

## Change 5: SoL anchoring (the Parsifal's correction)

The evaluator model synthesis prompt includes SoL ceiling data for a reason. Without it, the evaluator model describes "what's acceptable." With it, the evaluator model describes "what's achievable." The ceiling prevents comfortable convergence:

- Evaluator model without SoL: "The solution needs visual hierarchy and reasonable load time."
- Evaluator model with SoL: "The solution needs visual hierarchy (Design ceiling: 8.5) through layout structure achieving ≥7/10, with LCP < 2.0s (Performance ceiling: 9.0, currently at 3.2s)."

The SoL makes the evaluator model specific and ambitious. When the builder's model converges to this, it's converging to something good, not just something agreed-upon.

If models converge but far from ceiling (`convergence > 0.8 AND composite < 0.5 * ceiling`), conviction's testSpeedOfLight already handles this — it produces a "reshape" verdict, which triggers Cognitive Flexibility. The convergence doesn't override the SoL check; it works alongside it.

---

## Change 6: Supersede constraint list rendering

The structured `ProblemConstraint` extraction (problem-model.ts) remains — it's useful for:
- Tracing and observability
- Feeding the evaluator model synthesis call (structured input)
- Hippocampus crystallization (cross-task transfer)

But the **prompt rendering changes**. Instead of rendering constraints as a list in `premotorRevisionUser()`, the revision prompt shows:
- The evaluator model (one paragraph, ~50 tokens)
- The builder's previous model (one paragraph, ~50 tokens)
- The convergence score and divergence note

This is constant size regardless of cycle count. The constraint list served as a stepping stone to this design.

---

## Files to modify

| File | Change |
|---|---|
| `src/types/motor-cortex.ts` | Add `problemModel?: string` to `MotorPlan`, extend `RevisionContext` with `builderModel` + `evaluatorModel` |
| `src/kernel/motor-cortex.ts` | Add `problemModel` to `MotorPlanSchema` |
| `src/kernel/problem-model.ts` | Add `synthesizeEvaluatorModel()` (one LLM call) |
| `src/llm/prompts.ts` | Update premotor prompts (system + revision user), replace constraint list with model pair |
| `src/brainstem/rhythms/build-cycle.ts` | Accumulator fields, gate phase synthesis call, prepare phase threading |
| `src/types/gate.ts` | Add `convergence?: number` to `SignalLandscape` |
| `src/types/brainstem.ts` | Add `evaluatorModel` + `builderModel` + `convergence` to `BuildCycleResult` |
| `src/llm/client.ts` | Add `"evaluator-synthesis"` purpose |

## Implementation order

1. **Types**: `problemModel` on MotorPlan, accumulator fields, SignalLandscape, BuildCycleResult
2. **Builder model**: Premotor prompt update + Zod schema
3. **Evaluator model**: `synthesizeEvaluatorModel()` function + prompt
4. **Build-cycle wiring**: Gate phase synthesis, conviction evidence, prepare phase threading
5. **Prompt restructuring**: Replace constraint list with model pair in revision prompt

## Verification

- `npx tsc --noEmit` after each phase
- After a 2+ cycle task: inspect content store for evaluator synthesis calls, check that convergence score increases across cycles
- Verify builder model appears in premotor output (check Zod schema accepts it)
- Verify convergence feeds into conviction (check conviction evidence array)
- Verify revision prompt shows two models instead of constraint list
- End-to-end: run a task that requires multiple cycles, confirm convergence rises toward 1.0 as cycles progress, confirm task accepts when convergence is high + near SoL
