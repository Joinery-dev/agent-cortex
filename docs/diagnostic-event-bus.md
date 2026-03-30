# Diagnostic Event Bus — Implementation Spec

## Problem

Cortex emits operational events everywhere (`emit("rhythm:phase-change", ...)`) but has no error detection, diagnostic context capture, or observability into *what went wrong and why*. When an LLM returns garbage, a pipeline gets null input, or the gate makes a bad judgment, there's no way to diagnose the failure after the fact.

## Design

Enrich the existing event bus with severity levels, automatic rhythm context, decision context capture on failures, persistent logging, and a diagnostic load vital sign.

### Principle: Additive, Not Replacement

All existing `emit()` calls continue to work unchanged — they become `trace` severity. New diagnostic capabilities are layered on top. No component needs to change unless it wants to emit diagnostics.

---

## 1. Enriched CortexEvent Type

```typescript
// src/events.ts

type EventSeverity = "trace" | "info" | "warn" | "error" | "critical";

interface RhythmContext {
  rhythmId: string;
  rhythmType: string;       // "build-cycle" | "sensory-cortex" | "task-dispatch" | "project"
  phase: RhythmPhase;       // "prepare" | "execute" | "integrate" | "gate"
  cycle: number;
  taskId?: string;
  parentRhythmId?: string;
}

interface DiagnosticContext {
  /** What component produced this diagnostic. */
  component: string;
  /** What was expected vs what was received. */
  expected?: string;
  received?: string;
  /** The prompt that was sent (for LLM failures). */
  prompt?: string;
  /** The raw LLM response (for parse failures). */
  rawResponse?: string;
  /** The Zod validation error (for schema failures). */
  validationError?: string;
  /** Retry count at time of failure. */
  retryCount?: number;
  /** Arbitrary structured context the component wants to capture. */
  snapshot?: Record<string, unknown>;
}

interface CortexEvent {
  type: string;
  timestamp: string;
  severity: EventSeverity;
  data: Record<string, unknown>;
  /** Auto-injected from the rhythm context stack. Null for events outside rhythms. */
  rhythmContext: RhythmContext | null;
  /** Present on warn/error/critical. The "what led to this" data. */
  diagnosticContext?: DiagnosticContext;
}
```

---

## 2. Rhythm Context Stack

The event bus maintains a stack of active rhythm contexts. The runner pushes on rhythm start, pops on rhythm end. Every `emit()` automatically inherits the top of the stack.

```typescript
// src/events.ts

class CortexEventBus extends EventEmitter {
  private contextStack: RhythmContext[] = [];

  pushContext(ctx: RhythmContext): void { ... }
  popContext(): void { ... }
  updatePhase(phase: RhythmPhase): void { ... }  // mutates top of stack
  updateCycle(cycle: number): void { ... }

  private getCurrentContext(): RhythmContext | null {
    return this.contextStack.at(-1) ?? null;
  }
}
```

**Integration point:** `src/brainstem/runner.ts` — the runner calls `bus.pushContext()` at rhythm start, `bus.updatePhase()` at each phase transition, `bus.updateCycle()` at cycle increment, and `bus.popContext()` at rhythm end/cleanup.

---

## 3. Emit Functions

```typescript
// Existing — becomes trace by default
function emit(type: string, data?: Record<string, unknown>): void;

// New — explicit severity
function emitInfo(type: string, data?: Record<string, unknown>): void;
function emitWarn(type: string, data: Record<string, unknown>, diagnostic: DiagnosticContext): void;
function emitError(type: string, data: Record<string, unknown>, diagnostic: DiagnosticContext): void;
function emitCritical(type: string, data: Record<string, unknown>, diagnostic: DiagnosticContext): void;
```

- `emit()` → severity `trace`, no diagnostic context required
- `emitInfo()` → severity `info`, no diagnostic context required
- `emitWarn/Error/Critical()` → diagnostic context required (enforced by signature)

---

## 4. Severity-Based Routing

```
trace    → in-memory buffer only (existing behavior, dashboard SSE)
info     → in-memory buffer + persistent log
warn     → in-memory buffer + persistent log + increment diagnostic counter
error    → in-memory buffer + persistent log + increment diagnostic counter
critical → in-memory buffer + persistent log + increment diagnostic counter + emit homeostasis alert
```

---

## 5. Persistent Log

Append-only JSON lines file. One per session, rotated by project.

```
~/.agent-cortex/diagnostics/{projectId}/{sessionId}.jsonl
```

Each line is a JSON-serialized CortexEvent (info+ severity only). No rotation logic needed — sessions are finite. The dashboard can read these for a diagnostic history view.

---

## 6. Diagnostic Load Vital Sign

New vital sign on HomeostasisMonitor:

```typescript
diagnosticLoad: number;  // 0-1, rolling rate of warn+ events per minute
```

**Thresholds:**
- Below 0.3 → healthy (occasional warnings are normal)
- 0.3-0.7 → elevated (something is systematically off)
- Above 0.7 → critical (Cortex is failing frequently)

**Brainstem reflex responses:**
- Elevated → spike NE (pay more attention to everything)
- Critical → trigger rest cycle (recalibrate, prune, settle) or escalate to Parsifal

---

## 7. Where to Add Diagnostic Sensors

### LLM Boundaries (12+ call sites)

Wrap `callStructured()` and `call()` in `src/llm/structured.ts` and `src/llm/client.ts`:

- On Zod validation failure → `emitWarn("llm:schema-mismatch", { purpose, model }, { component, prompt, rawResponse, validationError })`
- On max retries exhausted → `emitError("llm:max-retries", { purpose, model, retries }, { component, prompt, rawResponse })`
- On timeout → `emitError("llm:timeout", { purpose, model, timeout }, { component, prompt })`
- On successful retry → `emitInfo("llm:retry-success", { purpose, model, attempt })`

This captures all 12+ LLM call sites automatically since they all go through the shared client.

### Component Boundaries (null/undefined pipeline breaks)

Each component that reads from another should guard and emit:

```typescript
// Example: build-cycle reading motor briefing from gestalt
const motorBriefing = thalamus.forMotorFromGestalt(taskId, consultation);
if (!motorBriefing) {
  emitWarn("pipeline:missing-briefing", { taskId, consumer: "motor" }, {
    component: "build-cycle",
    expected: "MotorBriefing from gestalt",
    received: "null",
    snapshot: { gestaltExists: !!thalamus.getGestalt(taskId), cycle }
  });
}
```

Key pipeline boundaries to instrument:
- Gestalt assembly (world model null, prediction null, SOL null)
- Thalamus briefing extraction (gestalt missing for task)
- Conviction loop inputs (manifested future null, SOL null)
- Dopamine computation (prediction missing → no signal)
- BG routine matching (no episodes → cold start)
- Prospective preparation (cerebellum predictions null)
- Forward briefing dissolution (forward briefing null on gestalt)

### Gate Decisions (full reasoning chain)

Every gate decision should `emitInfo` with the complete reasoning:

```typescript
emitInfo("gate:decision", {
  taskId,
  cycle,
  verdict: gateOutput.accept ? "accept" : "reject",
  convictionLevel: conviction.level,
  convictionVerdict: conviction.verdict,
  solGapRatio: speedOfLight?.compositeGap,
  compositeScore: composite.weightedMean,
  compositeConfidence: composite.confidence,
  tensionCount: tensions.length,
  highTensionCount: tensions.filter(t => t.severity === "high").length,
  collapseDetected: collapseSignal?.collapsed,
  neLevel: effectiveNE,
  strategyUsed: gateOutput.strategyName,
  reason: gateOutput.reason,
});
```

### Learning Boundaries (before/after state)

- Plasticity weight update → `emitInfo("plasticity:update", { connectionId, before, after, delta, dopamineSignal })`
- Potentiation → `emitInfo("potentiation:principle", { principleId, scope, evidenceCount, isContradiction })`
- BG routine promotion → `emitInfo("bg:routine-promoted", { hash, observationCount, activeSenses, suppressedSenses })`
- Episode significance → `emitInfo("hippocampus:episode", { taskId, significance, dopamineSignal })`

---

## 8. Implementation Order

1. **Enrich CortexEvent type + emit functions** — `src/events.ts`. Backward compatible.
2. **Add rhythm context stack** — `src/events.ts` + `src/brainstem/runner.ts`. Push/pop/update calls.
3. **Add persistent log writer** — `src/events.ts` or new `src/diagnostics/log-writer.ts`. Append-only JSONL.
4. **Instrument LLM client** — `src/llm/client.ts` + `src/llm/structured.ts`. Wraps existing error handling with diagnostic emissions.
5. **Add diagnostic load vital sign** — `src/brainstem/homeostasis.ts`. Rolling rate counter.
6. **Instrument gate decisions** — `src/brainstem/rhythms/build-cycle.ts` + `task-dispatch.ts`. Emit full reasoning chain.
7. **Instrument pipeline boundaries** — component by component, guided by which boundaries break most often in practice.
8. **Instrument learning boundaries** — `src/subcortical/hooks.ts`. Before/after state capture.
9. **Dashboard diagnostic view** — `src/dashboard/diagnostics.html` (future). Read JSONL, filter by severity, search by component.

Steps 1-4 are the foundation. Steps 5-8 are incremental. Step 9 is nice-to-have.

---

## 9. What This Enables

- **Post-mortem debugging:** When a task produces bad output, read the diagnostic log. See every gate decision, every LLM failure, every pipeline null, every conviction test — with the full context that led to each.
- **System health monitoring:** Diagnostic load as a vital sign means Cortex reacts to its own failures. High error rate → rest cycle or escalation.
- **Learning from failures:** Diagnostic events are themselves data. The Hippocampus could eventually record "this type of LLM failure correlates with this type of task" and Cortex could learn to avoid those situations.
- **Parsifal debugging:** When escalating to the Parsifal, include the diagnostic trail. Not just "scores are low" but "here's every decision that led here."
