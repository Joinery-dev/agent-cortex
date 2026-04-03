# Hierarchical Cortex Composition

## The problem

A Cortex can be directed by a human (HumanParsifal) or run autonomously (AutonomousParsifal). But it can't delegate real work to a child Cortex, and a child Cortex can't be directed by a parent Cortex. The ParsifaInterface exists but the CortexParsifal implementation doesn't.

This means Cortex is stuck at one level of hierarchy. Complex projects that would benefit from decomposition into semi-autonomous sub-agents all run through a single Motor Cortex — one LLM session with tools. There's no cognitive depth between "plan the approach" and "write the code."

## What hierarchical composition enables

A parent Cortex delegates a task to a child Cortex. The child plans, builds, evaluates, and delivers — with its own cognitive loop. The parent evaluates the child's output through its own senses. The parent's gate decides accept/revise. The child learns from its work. The parent learns from the child's experience.

This is recursive. The child can delegate to grandchildren. The hierarchy bottoms out when a Cortex's Motor Cortex executes directly (LLM + tools). Depth is adaptive — simple tasks execute directly, complex tasks spawn children.

## Three new pieces

### 1. CortexParsifal

A parent Cortex acts as the Parsifal for a child. When the child asks a question, the parent reasons from its own cognition — world model, awareness, task gestalt — and answers. If the parent can't answer, it chains upward to its own Parsifal.

```typescript
class CortexParsifal implements ParsifaInterface {
  private parent: Cortex;
  private chainUpward: ParsifaInterface;

  capabilities: ParsifaCapabilities = {
    canInquire: true,      // parent reasons about child's questions
    canApprove: true,      // parent judges child's vision
    canEscalate: true,     // parent handles escalations (or chains up)
    canFeedbackTaste: true, // parent applies its own taste
    canNotify: true,       // parent stores as WM observations
  };
}
```

**ask() behavior:**
- `inquiry` → Parent's communication function reasons about the question using parent's world model and awareness. Returns a reasoned answer, not a human one. If uncertain (conviction < threshold), chains to `chainUpward.ask()`.
- `approval` → Parent evaluates the child's vision proposal against its own understanding. Auto-approves if aligned with parent's intent, redirects if not.
- `escalation` → Parent tries to resolve from its own knowledge. If it can't (severity too high, out of scope), chains to its own Parsifal. This creates a filtering hierarchy — only genuinely hard questions reach the human.
- `clarification` → Parent answers from world model maxims and awareness.

**notify() behavior:**
- Stores child notifications as WM observations in the parent. The parent becomes aware of what the child is experiencing. These feed into the parent's awareness buffer.

**The chain-upward mechanism:**
```
Child escalates → CortexParsifal (parent) tries to answer
  → Can answer? Return answer. Child continues.
  → Can't answer? Chain to parent's own Parsifal.
    → If parent's Parsifal is HumanParsifal → human sees the question
    → If parent's Parsifal is another CortexParsifal → recurse
    → If parent's Parsifal is AutonomousParsifal → self-resolve or fail
```

At every level, the question gets filtered through more cognition. The human only sees questions that no Cortex in the hierarchy could resolve.

### 2. Motor Cortex delegation

The Motor Cortex currently has two modes: text-only and agentic. Add a third: **child Cortex delegation**.

**Decision logic** (in Motor Cortex's execute method):

```
if shouldDelegate(plan, briefing, neLevel):
  → spawn child Cortex with narrowed intent
  → parent's Thalamus assembles context for child (forChild briefing)
  → child runs full cognitive loop
  → result conforms to MotorCortexResult shape
else if plan.requiresAgentic && pns:
  → agentic mode (current behavior)
else:
  → text-only mode (current behavior)
```

**Delegation decision signals:**
- Plan confidence < 0.5 AND multiple risks — the Motor is uncertain, a full cognitive loop would do better
- Plan has 5+ steps — complex enough to benefit from sub-planning
- Prior failure on this task (revision cycle) AND failure classified as approach-bottleneck — a different approach needs real planning, not just revision
- NE > 0.7 AND task has multi-sense tension — high-stakes task with competing concerns benefits from a child that can evaluate its own work
- Task budget sufficient to absorb the overhead of a full child loop

**What the child receives:**
- Intent narrowed to the subtask (task description → intent summary)
- Parent's taste profile (inherited)
- Parent's worldview (inherited via runWithWorldview context)
- Relevant parent world model maxims (curated by parent's Thalamus)
- Relevant parent principles (from hippocampus, scoped to active senses)
- Parent awareness insights (filtered for relevance to the subtask)

**What the child returns:**
The child's `OrchestratorResult` gets mapped to `MotorCortexResult`:
- `work` ← child's final artifact summary
- `agenticResult` ← synthesized from child's execution stats (cycles, cost, changed files)
- `plan` ← child's premotor plan (the parent sees how the child planned)
- `selfAssessment` ← child's final conviction/confidence
- `intentions` ← child's decision log

The build-cycle doesn't know whether Motor used agentic mode or child delegation. The interface is the same.

### 3. Learning propagation

After a child Cortex completes, its experience flows to the parent.

**Episode propagation:**
```typescript
// After child completes, parent ingests child episodes
hippocampus.ingestChildEpisodes(childProjectId, childEpisodes);
```

New method on Hippocampus: `ingestChildEpisodes(projectId, episodes)`:
- Validates episode structure
- Stores with a `source: "child-cortex"` marker on extraction context
- Runs contradiction detection against parent's principles
- Triggers potentiation if density threshold met (child's cluster of episodes may reveal a principle the parent hasn't learned yet)

**Principle propagation:**
```typescript
// Child principles that reached high confidence → offer to parent
hippocampus.ingestChildPrinciples(childPrinciples);
```

New method on Hippocampus: `ingestChildPrinciples(principles)`:
- Only accepts principles with confidence > 0.7 (child was confident)
- Sets scope to "cross-project" (child's learning applies generally)
- Initial confidence in parent = child confidence * 0.7 (trust discount)
- Runs sense verification in parent context before accepting
- Tags extraction context with `trigger: { type: "child-ingestion", childProjectId }`

**Vicarious learning:**
The parent doesn't just get the child's results — it gets the child's *experience*. "When my child tried approach X, it failed for Y reason" becomes a principle the parent uses when delegating similar work in the future. The hierarchy gets smarter over time.

## Implementation sequence

### Phase 1: CortexParsifal (the hinge piece)

1. `src/kernel/cortex-parsifal.ts` — implement ParsifaInterface using parent Cortex's communication function for reasoning
2. Wire chain-upward: parent's own `parsifa` is the fallback for questions the parent can't answer
3. Test: parent Cortex creates child Cortex with CortexParsifal, child escalates, parent resolves

### Phase 2: Motor delegation

4. Add `shouldDelegate()` heuristic to Motor Cortex
5. Add `primaryProduceViaChild()` method — spawn child Cortex, run, map result
6. Add `forChild()` briefing method to Thalamus — curated context for child inheritance
7. Map child `OrchestratorResult` to `MotorCortexResult`
8. Build-cycle sees no difference — delegation is transparent

### Phase 3: Learning propagation

9. Add `ingestChildEpisodes()` to Hippocampus
10. Add `ingestChildPrinciples()` to Hippocampus
11. Wire propagation into Motor delegation flow (after child completes)
12. Add `PotentiationTrigger` variant for child-ingestion

### Phase 4: CLI entry point

13. `bin/cortex` — CLI entry point (`cortex "fix the auth bug"`)
14. Interactive REPL mode with HumanParsifal
15. Autonomous mode (`cortex --autonomous "fix the auth bug"`)
16. Project context reading (CLAUDE.md equivalent)

## What doesn't change

The cognitive architecture. Rhythm, evaluation, conviction, learning, awareness, self-model — all the same. A child Cortex is a full Cortex. The only new code is:
- CortexParsifal (how a parent answers a child's questions)
- Motor delegation (when/how to spawn a child)
- Learning propagation (how child experience flows upward)
- Thalamus.forChild() (what context the child inherits)

The hierarchy is emergent, not hardcoded. There's no "orchestrator Cortex" class. Any Cortex becomes an orchestrator when its Motor decides to delegate. Any Cortex becomes a worker when it's created with a CortexParsifal. Same code, different role.
