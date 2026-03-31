# Plastic Convergence Thresholds

## Context

The dialectic convergence system introduced seven hardcoded thresholds. These should be plastic — learned by the system based on whether each threshold value led to good outcomes.

The plasticity infrastructure already exists: `PLASTIC_CONNECTIONS` declarations in `types/plasticity.ts`, `PlasticityStoreImpl` with `get()`/`update()`, the dopamine → plasticity projection pipeline in `subcortical/hooks.ts`. Several thresholds (gate NE thresholds, BG aggressiveness) are already declared as plastic connections but not yet wired.

## The thresholds and their learning signals

### 1. `convergence.acceptance` (default: 0.8)
**What it controls:** When the system accepts work (build cycle + outer loop + planning).
**What it should learn:** The minimum convergence that predicts satisfactory outcomes.
**Learning signal:** Dopamine (predicted vs actual outcome quality) on tasks where convergence data existed.
- Positive dopamine → threshold was cautious enough or overcautious → nudge down
- Negative dopamine → threshold wasn't cautious enough → nudge up

### 2. `convergence.score-blend` (default: 0.3)
**What it controls:** How much convergence modulates the score signal in conviction (the 70/30 blend).
**What it should learn:** How predictive convergence is of outcome quality.
**Learning signal:** Correlation between convergence level and dopamine direction.
- Tasks with high convergence AND positive dopamine → convergence is predictive → nudge up (trust it more)
- Tasks with high convergence AND negative dopamine → convergence is misleading → nudge down

### 3. `convergence.sol-proximity` (default: 0.7)
**What it controls:** How close to ceiling is "close enough" when convergence is high (outer loop exit condition 7).
**What it should learn:** Whether 70% of ceiling is sufficient when models agree.
**Learning signal:** Same as acceptance — did tasks accepted at this proximity succeed?
- Moves in tandem with acceptance threshold but on the SoL dimension

### 4. `convergence.preemption-confidence` (default: 0.4)
**What it controls:** Minimum failure prediction confidence before injecting preemptive guidance.
**Learning signal:** Preemption success rate (already tracked on `GuidanceStore` + Cerebellum's `failureModeAccuracy`).
- High preemption success → can preempt at lower confidence → nudge down
- Many false preemptions (guidance injected, wrong failure category) → nudge up

### 5. `convergence.planning-acceptance` (default: 0.8)
**What it controls:** When the planning manifestation loop exits on dialectic convergence.
**Learning signal:** Project-level satisfaction. Did the manifested future lead to a good plan? Measured by drift during execution — if the project drifts significantly, the manifested future wasn't good enough, and the planning threshold was too low.
- Low drift → threshold was fine → nudge down (can accept planning convergence sooner)
- High drift → threshold was too low → nudge up

### 6. `convergence.supports-threshold` (default: 0.6)
### 7. `convergence.undermines-threshold` (default: 0.3)
**What they control:** Conviction evidence labeling.
**Derived:** These don't need independent learning signals. Derive from acceptance threshold:
- `supports = acceptance * 0.75`
- `undermines = acceptance * 0.375`

When acceptance threshold moves, these move proportionally.

## Change 1: Declare plastic connections

**`src/types/plasticity.ts`** — Add to `PLASTIC_CONNECTIONS` array (in the threshold section):

```ts
{
  id: "convergence.acceptance",
  region: "Dialectic",
  description: "Convergence level between builder and evaluator models that means 'done'. Lower = accepts sooner. Higher = demands stronger agreement.",
  defaultValue: 0.8,
  range: [0.5, 0.95],
  category: "threshold",
},
{
  id: "convergence.score-blend",
  region: "Dialectic",
  description: "How much convergence modulates the score signal in conviction. 0 = convergence ignored. 1 = convergence dominates.",
  defaultValue: 0.3,
  range: [0.05, 0.6],
  category: "threshold",
},
{
  id: "convergence.sol-proximity",
  region: "Dialectic",
  description: "How close to SoL ceiling is 'close enough' when convergence is high. For outer loop exit.",
  defaultValue: 0.7,
  range: [0.5, 0.9],
  category: "threshold",
},
{
  id: "convergence.preemption-confidence",
  region: "Dialectic",
  description: "Minimum failure mode prediction confidence for preemptive guidance injection.",
  defaultValue: 0.4,
  range: [0.2, 0.8],
  category: "threshold",
},
{
  id: "convergence.planning-acceptance",
  region: "Dialectic",
  description: "Planning manifestation convergence threshold. Same as acceptance but at project level.",
  defaultValue: 0.8,
  range: [0.5, 0.95],
  category: "threshold",
},
```

Note: ranges are deliberately bounded. Acceptance can't go below 0.5 (always require some agreement) or above 0.95 (unreachable convergence freezes the system). Score blend can't go below 0.05 (always give convergence some voice) or above 0.6 (scores still matter more than convergence alone).

## Change 2: Read from plasticity at each usage site

**New helper function** in a new file `src/kernel/convergence-config.ts`:

```ts
export function readConvergence(
  plasticity: PlasticityStore | undefined,
  neLevel?: number,
): ConvergenceThresholds {
  const ne = neLevel ?? 0.5;
  // NE modulation: high NE → more cautious (raise thresholds), low NE → less cautious
  const neModulation = 1 + 0.15 * (ne - 0.5); // ±7.5% at extremes

  const acceptance = (plasticity?.get("convergence.acceptance")?.value ?? 0.8) * neModulation;
  const scoreBlend = plasticity?.get("convergence.score-blend")?.value ?? 0.3;
  const solProximity = (plasticity?.get("convergence.sol-proximity")?.value ?? 0.7) * neModulation;
  const preemptionConfidence = plasticity?.get("convergence.preemption-confidence")?.value ?? 0.4;
  const planningAcceptance = plasticity?.get("convergence.planning-acceptance")?.value ?? 0.8;

  // Derived thresholds
  const supportsThreshold = acceptance * 0.75;
  const underminesThreshold = acceptance * 0.375;

  return {
    acceptance: Math.min(acceptance, 0.95),
    scoreBlend,
    solProximity: Math.min(solProximity, 0.9),
    preemptionConfidence,
    planningAcceptance: Math.min(planningAcceptance, 0.95),
    supportsThreshold,
    underminesThreshold,
  };
}
```

**Replace hardcoded values** at each site:
- `conviction.ts` — read `scoreBlend`, `supportsThreshold`, `underminesThreshold`
- `sensory-cortex.ts` — read `acceptance`, `solProximity`
- `project.ts` — read `planningAcceptance`
- `thalamus.ts` — read `preemptionConfidence`

Each site receives plasticity via its existing parameter chain (config/hooks/thalamus already thread through the rhythm factories).

## Change 3: Learning signal — dopamine-driven adjustment

**`src/subcortical/hooks.ts`** — In `computeDopamineSignal()`, after the existing `applyPlasticityProjection()` call, add convergence plasticity:

```ts
private applyConvergencePlasticity(
  dopamine: DopamineSignal,
  convergence: number | null,
  taskId: string,
): void {
  if (!this.plasticity || convergence === null) return;

  const rate = 0.01; // Very slow — thresholds should move gradually
  const phasic = dopamine.aggregate;

  // Acceptance: positive dopamine → can accept at lower convergence → nudge down
  this.plasticity.update("convergence.acceptance", -rate * phasic, "dopamine", taskId);

  // Score blend: high convergence + positive dopamine → trust convergence more
  if (convergence > 0.5) {
    this.plasticity.update("convergence.score-blend", rate * phasic * 0.5, "dopamine", taskId);
  }

  // SoL proximity: moves with acceptance
  this.plasticity.update("convergence.sol-proximity", -rate * phasic * 0.7, "dopamine", taskId);
}
```

**Call site:** In `computeDopamineSignal()`, after plasticity projection:
```ts
// Convergence threshold plasticity
const taskConvergence = /* read from OrchestratorResult.convergence passed through */;
this.applyConvergencePlasticity(signal, taskConvergence, taskId);
```

**Threading:** The convergence value is already on `OrchestratorResult.convergence` (we threaded it earlier). Pass it through `computeDopamineSignal()` — add it as a field on `cycleData` or as a new parameter.

## Change 4: Preemption confidence learning

Separate from dopamine — driven by preemption success rate.

**In `computeDopamineSignal()`** or a separate rest-cycle step, check:
```ts
const fmAccuracy = this.cerebellum.getFailureModeAccuracy();
if (fmAccuracy.sampleCount >= 5) {
  // High preemption rate → lower confidence threshold (preempt more aggressively)
  // Low preemption rate → raise threshold (be more selective)
  const preemptionDelta = (fmAccuracy.preemptionRate - 0.5) * 0.005;
  this.plasticity.update("convergence.preemption-confidence", -preemptionDelta, "preemption", taskId);
}
```

## Change 5: Planning acceptance learning

Driven by drift signal. After each phase gate or task-dispatch check:

```ts
// If drift detected → planning threshold was too low
if (driftDetected && driftSeverity === "high") {
  plasticity.update("convergence.planning-acceptance", 0.01, "drift", taskId);
}
// If no drift → planning threshold is fine or overcautious
if (!driftDetected) {
  plasticity.update("convergence.planning-acceptance", -0.003, "no-drift", taskId);
}
```

This fires during between-tasks processing when the drift monitor reports.

## Files to modify

| File | Change |
|---|---|
| `src/types/plasticity.ts` | 5 new connection declarations |
| `src/kernel/convergence-config.ts` | **NEW** — `readConvergence()` with NE modulation + derived thresholds |
| `src/kernel/conviction.ts` | Read blend/supports/undermines from plasticity |
| `src/brainstem/rhythms/sensory-cortex.ts` | Read acceptance + solProximity from plasticity |
| `src/brainstem/rhythms/project.ts` | Read planningAcceptance from plasticity |
| `src/kernel/thalamus.ts` | Read preemptionConfidence from plasticity |
| `src/subcortical/hooks.ts` | `applyConvergencePlasticity()` in dopamine pipeline |

## Verification

- `npx tsc --noEmit`
- Plastic connections registered (check `plasticity:initialized` event)
- After 10+ tasks: thresholds have moved from defaults (check plasticity snapshot in dashboard)
- High-quality projects: acceptance threshold drifts lower (system learns to accept sooner)
- Low-quality projects: acceptance threshold drifts higher (system becomes more cautious)
- NE modulation: same task with high NE uses higher effective threshold than with low NE

## What this completes

Every convergence threshold in the system is now:
1. **Declared** as a plastic connection with bounded range
2. **Read** through a centralized helper with NE modulation
3. **Learned** via dopamine signal (acceptance, blend, SoL proximity), preemption success rate (preemption confidence), or drift signal (planning acceptance)

The system starts with the defaults we chose today. Over time, it learns what works for this Parsifal, this project type, this domain. The thresholds converge to what's actually right — not what we guessed.
