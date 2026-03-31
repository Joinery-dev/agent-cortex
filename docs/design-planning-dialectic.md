# Planning Dialectic: Convergence in Phase A Manifestation

## Context

Phase A manifestation already has a convergence loop: `manifestSenses()` → `synthesizeVision()` → `evaluateVision()` → loop until all senses satisfied. But the stopping criterion is binary (`every sense satisfied`), there's no growing structural understanding across rounds, and the vision synthesizer doesn't articulate what it believes the project requires separately from the vision itself.

The dialectic convergence model we built for the build cycle applies directly. Two independently maintained models — the synthesizer's understanding of what the project requires, and the senses' collectively established requirements — converging toward shared understanding.

## What changes

Phase A manifestation gains:
- **Synthesizer model** — the vision synthesizer outputs a `problemModel` alongside the vision, articulating what it believes the project requires
- **Evaluator model** — after sense evaluation, one cheap LLM call synthesizes sense feedback into a collective understanding of project requirements
- **Convergence score** — measures alignment between synthesizer and evaluator models
- **Convergence-aware exit** — the loop can exit when convergence is high even if one sense has minor objections, and should NOT exit when all senses say "satisfied" but convergence is low (premature agreement)

## Change 1: Synthesizer model (zero cost — part of existing call)

**Extend `VisionSynthesis`** in `src/types/planner.ts`:
```
problemModel?: string
```

The `synthesizeVision()` prompt already asks the LLM to produce a unified vision + tension resolutions. Adding "your understanding of what this project requires" is the same cognitive act, made explicit. Update the Zod schema and prompt.

## Change 2: Evaluator model (one cheap LLM call per round)

**Reuse `synthesizeEvaluatorModel()`** from `src/kernel/problem-model.ts` — or create a planning-specific variant. The input structure is similar: sense evaluations + previous model + synthesizer's model.

The planning variant is simpler than the build-cycle version because:
- No formal observations (nothing built yet)
- No failure classification (senses produce satisfied/unsatisfied + feedback, not failure categories)
- No SoL data (no historical ceiling for project-level planning)
- The ceiling anchor is the **intent itself** — how close is the manifested future to what the Parsifal actually wants?

**New function**: `synthesizePlanningEvaluatorModel()` in `src/kernel/problem-model.ts`:
```
Input: sense evaluation results + intent + previous evaluator model + synthesizer model
Output: { model: string, convergence: number, divergenceNote: string }
```

One LLM call per manifestation round. Same ~$0.003 cost.

## Change 3: Convergence-aware loop exit

**Modify `runManifestation()`** in `src/brainstem/rhythms/project.ts`:

Currently (simplified):
```
while (!allSatisfied && round < 4) {
  synthesize → evaluate → check satisfaction
}
```

With dialectic:
```
while (round < 4) {
  synthesize (outputs problemModel) → evaluate → synthesize evaluator model

  if convergence >= 0.8:
    exit (models agree on what the project requires)
  if allSatisfied && convergence < 0.5:
    warn (premature agreement — senses aren't pushing hard enough)
    continue anyway (don't override, just flag)
  if allSatisfied:
    exit (traditional criterion still works)
}
```

The convergence check catches two failure modes:
1. **Early convergence** — models agree before senses have fully explored the problem space. Allow exit.
2. **False satisfaction** — all senses say "satisfied" but the synthesizer's model and senses' model actually disagree. Flag it (don't block, but emit a warning for observability).

## Change 4: Thread models through re-synthesis

When the loop re-synthesizes (round 2+), the synthesizer receives:
- Previous vision (as before)
- Unsatisfied sense feedback (as before)
- **Its own previous problem model**
- **The evaluators' current model**
- **Convergence score**

Same pattern as the build-cycle revision prompt. The synthesizer sees where the models diverge and can close the gap.

## Change 5: Store on ManifestedFuture

**Extend `ManifestedFuture`** in `src/types/planner.ts`:
```
problemModel?: string     // synthesizer's final understanding
evaluatorModel?: string   // senses' final understanding
convergence?: number      // final convergence score
```

These flow into Phase B — the backward reasoning step receives not just the vision but the structural understanding of what the project requires. The decomposer knows what constraints the tasks must satisfy.

They also flow into the Thalamus (which stores the manifested future) and become available to the conviction loop, drift monitor, and forward briefings for the entire project.

## Files to modify

| File | Change |
|---|---|
| `src/types/planner.ts` | `problemModel` on `VisionSynthesis`, convergence fields on `ManifestedFuture` |
| `src/kernel/problem-model.ts` | `synthesizePlanningEvaluatorModel()` function |
| `src/brainstem/rhythms/project.ts` | Convergence-aware loop in `runManifestation()`, thread models through re-synthesis |
| `src/llm/prompts.ts` | Update vision synthesis prompt (add problemModel output), re-synthesis prompt (add model pair) |

## Implementation order

1. Types: VisionSynthesis + ManifestedFuture extensions
2. Evaluator model: planning-specific synthesis function
3. Project rhythm: convergence-aware loop + model threading
4. Prompts: synthesis + re-synthesis prompt updates

## What this enables downstream

The manifested future now carries structural understanding, not just a vision string. Phase B's backward reasoning gets "here's what the project requires and both sides agree" instead of just "here's a vision." The conviction loop can test convergence at the project level. The drift monitor can measure drift against a structurally grounded target.

And when the system learns to predict project-level failure modes (future work), the same dialectic that prevents task-level failures can prevent project-level planning failures — the wrong manifested future caught before a single task is executed.
