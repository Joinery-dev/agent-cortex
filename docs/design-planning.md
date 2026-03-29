# Planning — Design Document

*The full planning process for Agent Cortex, from arrival of a shaela to generative completion.*

---

## Vocabulary

| Word | Root | Meaning | In the system |
|------|------|---------|---------------|
| **Shaela** | sha'al (שאל) | The great question | Project-level decomposition |
| **Shael** | sha'al (שאל) | A nested question | Any intermediate planning level |
| **Shana** | shana (שנה) | The transformation | Leaf-level, lived through one sensory cortex cycle |
| **Shalem** | shalem (שלם) | Wholeness — the embodiment | Completed artifact + understanding gained |

Shaela contains shaels. Shaels contain shaels at any depth. At the leaf, a shael becomes a shana — specific enough to be lived through one cycle. When a shana completes, a shalem emerges.

---

## The Planning Process

### 0. Arrival

A project arrives as a shaela — a great question. The system sees a question to be lived, not a work order to execute.

### 1. Manifestation (Phase A) — Interactive

Before decomposing anything, the system imagines the answer. Three sub-phases:

**1a. Inquiry.** Each activated sense queries the question-asker (not always human — could be PFC for a sub-shael, or another system when Cortex is invoked as a service) using the escalation/askUser pathway. Each sense asks clarifying questions from its perspective until it feels it understands what the shaela is asking. Design asks about visual intent. Performance asks about scale constraints. Security asks about the threat surface. Intent Alignment asks about the audience.

**1b. Synthesis.** The Motor Cortex synthesizes the senses' perspectives into a **manifested future** — concrete enough that someone could look at a real artifact and say "yes, that matches" or "no, that doesn't." Not a feature list. The actual finished thing, described from every dimension the senses care about.

Tensions about the *vision* get resolved here. Design wants rich imagery, Performance wants fast loads. That tension is resolved now, not discovered during execution.

**1c. Approval.** The manifested future goes back to the question-asker: "Is this what you see?" The question-asker confirms, redirects, or asks for refinement. Loop back to 1a or 1b until approved.

Output: a manifested future with per-sense contributions and resolved tensions, approved by the question-asker.

### 2. Decomposition (Phase B.1)

A single LLM call reasons **backward** from the manifested future.

Starting from the completed outcome: what must be true immediately before this exists? What must be true before that? Work backward until you reach the current state (nothing exists yet).

The output is **shaels, not shana.** Not "create the database migration" — that's too granular. These are questions at the right resolution: "The data model must capture X", "The authentication boundary must exist before Y."

Each shael has:
- `id`, `description`, `level` (shael or shana), `phaseGroup`, `parentId` (null for roots)
- `gateCondition` — what must be true when this shael completes
- `necessity`, `formJustification`, `scopeJustification` — Jensen's three gates (already filtered)
- Suggested ordering hints (treated as unreliable — decomposer is bad at wiring)

Every proposed node passes three gates:
1. **Existence:** Does this need to exist? What breaks without it?
2. **Form:** Does it need to be THIS? Could a simpler question suffice?
3. **Scope:** Does it need this scope? Could it be smaller?

**Critical constraint:** B.1 does NOT produce provides/consumes, dependencies, or affinity groups. Experiment D showed that asking the decomposer to do backward reasoning AND semantic mapping simultaneously degraded decomposition quality — 60% over-decomposition (35 nodes instead of 22) because the provides/consumes framing changed how it thought about problem structure. The decomposer's job is to identify the right questions. Semantic mapping is a different cognitive task.

Output: a tree of shaels (and possibly shana at leaves), with phase groups and necessity justifications. No dependency information.

### 3. Shael Dependency Wiring (Phase B.2)

Three steps: LLM → algorithm → LLM. This is the core structural contribution of the planning pipeline.

#### Step 1: Semantic Mapping (LLM)

A single LLM call that sees every node in the shael tree simultaneously and identifies, for each node, what capabilities it produces and what capabilities it requires.

**Output schema:**
```typescript
interface SemanticMapEntry {
  id: string;                    // matches shael/shana id from B.1
  provides: CapabilityToken[];   // what this node produces
  consumes: CapabilityToken[];   // what this node requires
}

interface CapabilityToken {
  capability: string;      // short, consistent token (e.g. "clinical-data-model", "auth-boundary")
  description: string;     // what this capability means in context
}
```

**Prompt contract:**
- Frames the task as building a capability registry across all nesting levels
- Emphasizes token consistency — if one node provides "auth-boundary" another must consume "auth-boundary", not "authentication" or "access-control"
- States that shana within a parent shael may provide/consume independently, and can consume capabilities from a different branch of the tree
- Does NOT ask for dependency wiring, affinity groups, or topological ordering

**Quality signal:** All consumed capabilities should have at least one provider. Unresolved consumes = missing shael (gap in decomposition) or inconsistent token naming. Checkable mechanically after the call. If unresolved consumes exist: retry with a correction prompt, or flag for B.3 review.

#### Step 2: Algorithmic Dependency Derivation (code)

Pure code, no LLM. Derives dependency edges from the semantic map by matching provides→consumes tokens.

**Algorithm:**
1. Build provider index: `Map<capability_token, shael_id[]>`
2. For each node N, for each capability C in N.consumes, for each provider P of C (where P ≠ N): add edge N→P (N depends on P)
3. Cycle detection (Tarjan's or DFS). If cycles found, record them — Step 3 will fix them. Do NOT break cycles algorithmically — direction correction requires semantic understanding.

**What this step gets right:** Mechanical matching is deterministic and provably correct given the token assignments. In experiments, algorithmic deps matched LLM-wired deps exactly when tokens were well-assigned.

**What this step gets wrong (why Step 3 exists):**

1. **Cycles from bidirectional tokens.** When two nodes legitimately interact (e.g. patient scheduling ↔ provider scheduling), the LLM sometimes assigns provides/consumes that create mutual dependencies. The real relationship is affinity (co-design constraint), not bidirectional dependency.
2. **Missing parent→child composition deps.** A parent shael "provides" a composed capability that is only realized when its child shana complete. But the parent doesn't "consume" its children's tokens — the composition relationship isn't expressible in provides/consumes.
3. **Semantic direction inversions.** Occasionally the LLM assigns a consume token that's semantically backwards (e.g., order lifecycle "consumes" notifications, when the lifecycle produces events that notifications consume). The token matching faithfully derives the wrong edge.

#### Step 3: Affinity Analysis + Dependency Correction (LLM)

A second LLM call that sees the shael descriptions, the semantic map, AND the algorithmically-derived dependencies. Two jobs:

**1. Identify affinity groups** — sets of nodes that share a boundary and create mutual constraints even without hard dependencies. For each group: a name, the node IDs, the shared boundary, and a **concrete co-design risk** (what specifically goes wrong if these nodes are built without awareness of each other).

Affinity groups must come from the LLM, not the algorithm. Algorithmic affinity (shared token overlap) produces groups so broad they're meaningless — experiments produced groups containing 8-14 of 22 nodes. Real affinity requires understanding what specifically breaks.

**2. Correct the dependency graph** — review algorithmically-derived deps and propose additions or removals with justification.

**Output schema:**
```typescript
interface AffinityGroup {
  name: string;            // human-readable group name
  shaelIds: string[];      // nodes in this group
  sharedBoundary: string;  // what boundary they share
  coDesignRisk: string;    // what breaks if built without mutual awareness
}

interface DepCorrection {
  action: "add" | "remove";
  from: string;            // node that depends
  to: string;              // node depended on
  reason: string;          // why this correction is needed
}
```

**Prompt contract:**
- Frames deps as already derived and mostly correct — the LLM is a reviewer, not a builder
- Requires co-design risks to be concrete: "name the contract that breaks, the data shape that diverges, the UX that becomes inconsistent"
- For corrections, requires justification: "the algorithm is correct given the tokens, so corrections mean the tokens were misleading or the relationship isn't expressible in provides/consumes"
- Does NOT ask for topological ordering

**What experiments showed Step 3 catches:**
- Removed cycle-breaking edges where bidirectional tokens masked affinity relationships
- Added parent→child composition edges (7 in a 22-node tree in experiment E)
- Added cross-branch edges where one node defines triggers against events another was never told to emit
- Produced affinity groups with specific co-design risks (e.g., "if X saves a note referencing the pre-prescription medication list and Y saves a prescription in a separate transaction, the encounter record will be internally inconsistent")

#### Post-Step 3: Topological Sort

After applying corrections, standard topological sort on the corrected graph. If cycles remain (shouldn't happen — Step 3 was specifically asked to fix them), flag for B.3 review.

#### B.2 Output

```typescript
interface DependencyWiringResult {
  // From Step 1
  semanticMap: SemanticMapEntry[];

  // From Step 2 + Step 3 corrections
  dependencies: Array<{
    from: string;
    to: string;
    source: "algorithmic" | "correction";  // provenance tracking
    reason?: string;                        // present for corrections
  }>;

  // From Step 3
  affinityGroups: AffinityGroup[];
  corrections: DepCorrection[];            // transparency — what the LLM changed and why

  // Computed
  topologicalOrder: string[];
}
```

#### B.2 Cost and Latency

Two LLM calls (Steps 1 and 3). Each is a single Sonnet-class call with ~8K max output tokens. Step 2 is pure computation (sub-millisecond). Total B.2 wall time is roughly 2× a single planning call.

#### B.2 NE Modulation

- **High NE** (novel/complex, immature system): stronger model for Step 1 (semantic mapping precision), thorough Step 3 (review every algorithmic edge)
- **Low NE** (familiar territory, mature system): standard model for Step 1, lighter Step 3 (affinity groups only, skip correction review if no cycles detected)

### 4. PFC Review (Phase B.3)

The conviction loop runs on the plan itself. Full context: manifested future + sense contributions + shael graph + affinity groups + dependency wiring with provenance.

B.3 tests the structural graph against the manifested future:
- **Gap detection:** Is there understanding the manifested future requires that no shael produces? (Unresolved consumes from Step 1 are a strong signal here.)
- **Redundancy detection:** Are two shaels really the same question?
- **Affinity validation:** Do the co-design risks make sense given the manifested future?
- **Correction validation:** Were the dependency corrections from Step 3 justified?

B.2 is structural wiring. B.3 is semantic validation. They're complementary.

Scaled by NE:
- **High NE:** thorough review, may restructure the graph, patches gaps
- **Low NE:** light check or skipped entirely (for familiar territory)

Output: the final project plan — a tree of shaels with meta-dependencies, affinity groups, gate conditions, and capability maps.

### 5. Execution Begins

The Attention Scheduler picks the first ready shael — one whose meta-dependencies are all satisfied (no prior shael it depends on is incomplete). Affinity group membership informs scheduling decisions: if two shaels share an affinity group, the scheduler plans them with awareness of each other.

### 6. Per-Shael: Just-in-Time Planning

When a shael is about to execute, it gets its own planning cycle — the same process at a smaller scale.

**6a. Shael Manifestation (Phase A')**

The shael runs through the sensory cortex. The senses now have context from previous shaels — they know what was *actually produced*, not what was predicted. The manifested future for this shael is grounded in reality.

The inquiry sub-phase (1a) may be lighter here — the question-asker is typically the PFC, not the human, and the context from prior shaels reduces ambiguity.

**6b. Shael Decomposition (Phase B.1')**

Backward reasoning within this shael's scope. Now the output IS shana — leaf-level tasks specific enough to be lived in one sensory cortex cycle. The scope is small (typically 3-8 shana per shael), which is manageable for the LLM.

**6c. Shana Dependency Wiring (Phase B.2')**

The same three-step pipeline runs at phase resolution:
- Step 1: Semantic mapping of shana within this shael
- Step 2: Algorithmic dependency derivation
- Step 3: Affinity analysis + dependency correction (within-shael scope)

**Trigger condition:** Runs for shaels with ≥5 shana or NE ≥ 0.5. Simple shaels with 2-3 tasks don't need a second LLM call — the decomposer's suggestions are adequate at small scale.

**6d. PFC Review (Phase B.3')**

Conviction loop on the shana graph within the shael. Scaled by NE — skipped for familiar-feeling shaels, thorough for novel or high-stakes ones.

### 7. Shana Execution

The scheduler dispatches shana within the shael. Each shana runs through the full sensory cortex rhythm: consult → explore → build → evaluate → resolve. The system lives the question and produces a shalem.

### 8. Phase Gate

When all shana within a shael complete (or escalate), the integration checker runs. The gate condition from the shael's definition is tested: "What must be true when this shael completes?"

The senses evaluate cross-shana coherence — not just "are the individual artifacts good?" but "do they form a coherent answer to the shael's question?"

If the gate fails, replanning happens within the shael's scope, not at the project level.

### 9. Between Shaels

**Fast path** (after every shael): dopamine signal, episode recording, working memory update, routine strengthening.

**Slow path** (at phase group boundaries — when a set of shaels in the same phase completes): deeper drift analysis, crystallization opportunity, potential replanning at the project level.

The system learns from each completed shael. The Hippocampus records the episode. The Cerebellum updates its predictions. The next shael's just-in-time planning benefits from this accumulated understanding.

### 10. Next Shael

The scheduler picks the next ready shael — meta-dependencies satisfied, informed by what was actually produced, with forward briefings from the PFC seeded into every consumer's context.

The cycle repeats: manifest → decompose → wire → review → execute → gate → learn → next.

### 11. Recursive Depth

A shael can contain sub-shaels instead of shana, if the question is too large to decompose directly into tasks. The depth is driven by coherence pressure (Cerebellum speed-of-light estimation), not hardcoded. If the planner produces 15 shana for a shael, that's a signal the shael should have been decomposed into 2-3 sub-shaels first. Necessity gates apply to the hierarchy structure itself — does this level of nesting need to exist?

### 12. Completion and Generative Questions

When all shaels complete and the final integration gate passes:

**12a. Retrospective.** Final evaluation against the manifested future. Learning consolidation — episodes crystallized into principles, predictions recalibrated, connections settled.

**12b. Generative questions.** Now that the shalem exists and the system is living it — what are the next questions that could be asked to live this shalem more deeply?

The shalem isn't an endpoint. It's a seed. The system surfaces questions that *couldn't have been asked* before the shalem existed. Butler's principle: the shaper is shaped. The shalem changes the system's understanding enough to see questions it couldn't see before.

These questions may be:
- **Extensions** — go deeper in the same direction
- **Revisions** — the shalem itself should change based on what the system now understands

These are **proposals, not actions.** They surface to whatever asked the original question (the human, the PFC, another system) with enough context to decide: pursue these questions, take a different direction, or declare completion.

The question-asker decides. The system signals, it doesn't chase its own curiosity without permission.

---

## Design Principles

**Plan the whole shape upfront, detail just-in-time.** The LLM sees the full shaela at the start and decomposes into shaels. But shana within each shael are planned only when that shael is about to execute — grounded in what previous shaels actually produced.

**Wire dependencies at two resolutions.** Meta-deps between shaels (coarse, architectural — LLM is good at this). Task-deps within shaels (fine-grained — Graph Builder's three-step pipeline handles this). Both use the same pipeline; only the scope changes.

**Separate cognitive tasks.** Decomposition (what questions exist) and semantic mapping (what capabilities each question provides/consumes) are different cognitive operations. Combining them in one LLM call degrades both. The pipeline respects this.

**Algorithm where algorithms excel, LLM where judgment is needed.** Provides/consumes → dependency edges is mechanical matching. Affinity groups, direction corrections, and composition edges require semantic understanding. The split is principled, not arbitrary.

**Provenance tracking.** Every dependency edge is tagged as algorithmic or correction-sourced. The PFC review can audit corrections. Trust is granular, not all-or-nothing.

**The same algorithm at every scale.** Manifest → decompose → wire → review → execute → gate. Whether it's the whole project or a single shael within a phase.

**NE modulates thoroughness, not structure.** The pipeline is the same at high and low NE. What changes: model strength for semantic mapping, thoroughness of correction review, whether PFC review runs at all.
