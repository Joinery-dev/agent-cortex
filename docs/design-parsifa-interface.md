# ParsifaInterface: Hierarchical Composition of Cortex Instances

## The problem

The Cortex assumes a human Parsifal. `askUser()` blocks on a Promise waiting for someone to type. Escalations format prose for human reading. Approval detection parses "yes" and "looks good." Every interaction point assumes real-time human availability and natural language comprehension.

This makes Cortex a tool for humans. It can't be:
- A worker inside a parent Cortex (Cortex-as-agent)
- An orchestrator delegating to child Cortices (Cortex-as-orchestrator)
- A fully autonomous system (Cortex-without-Parsifal)
- A recursive hierarchy where Cortices contain Cortices

## The insight

The Parsifal is a role, not a species. What the system needs from a Parsifal is three things:

1. **Answer questions** — inquiry, approval, escalation resolution
2. **Provide direction** — unsolicited input that changes course
3. **Give feedback** — taste responses that shape learning

A human does these through a terminal. A parent Cortex does them through its own cognition. An autonomous system does them through heuristics or by bounding what it attempts.

The interface is the same. The implementation varies.

## ParsifaInterface

```typescript
/**
 * The contract between a Cortex and whatever entity directs it.
 *
 * Three capabilities:
 *   1. Answer questions (synchronous — system blocks until resolved)
 *   2. Receive unsolicited direction (asynchronous — arrives whenever)
 *   3. Provide taste feedback (structured — response to proposals)
 *
 * Implementations:
 *   HumanParsifal    — ConversationTransport + terminal/websocket
 *   CortexParsifal   — parent Cortex instance answers from its own cognition
 *   AutonomousParsifal — self-resolves with heuristics, bounded autonomy
 */
interface ParsifaInterface {
  /**
   * Ask the Parsifal a question and wait for an answer.
   * Used by: inquiry loop, vision approval, escalation delivery.
   *
   * The question is natural language. The answer is natural language.
   * The implementation decides how to produce the answer:
   *   - Human: display question, wait for typing
   *   - Parent Cortex: reason about the question using own context
   *   - Autonomous: apply heuristics or return a bounded default
   */
  ask(question: string, context?: AskContext): Promise<string>;

  /**
   * Deliver a notification that doesn't require a response.
   * Used by: proactive awareness surfacing, status updates, narration.
   *
   * The Parsifal MAY choose to respond (via onDirection callback),
   * but the system doesn't block.
   */
  notify(message: string, category: NotifyCategory): void;

  /**
   * Register handler for unsolicited Parsifal direction.
   * Used by: ConversationCortex.receive() routing.
   *
   * Direction can arrive at any time — mid-task, between tasks, idle.
   * The handler routes it the same way receive() does today:
   * pending question → escalation resolution → observation + action.
   */
  onDirection(handler: (text: string) => void): void;

  /**
   * Present a taste proposal and receive structured feedback.
   * Used by: TasteFeedbackLoop when divergence is detected.
   *
   * Returns null if the Parsifal defers or doesn't support taste feedback.
   */
  proposeTaste?(proposal: TasteProposal): Promise<SatisfactionResponse | null>;

  /**
   * Parsifal capabilities — what this implementation supports.
   * The system adapts its behavior based on what's available:
   *   - No approval capability → skip vision approval loop
   *   - No inquiry capability → skip inquiry rounds, use intent as-is
   *   - No taste feedback → disable taste proposal surfacing
   *   - Has autonomy budget → self-resolve escalations up to threshold
   */
  capabilities: ParsifaCapabilities;
}

interface ParsifaCapabilities {
  /** Can answer open-ended questions (inquiry, approval). */
  canInquire: boolean;
  /** Can approve/reject vision proposals. */
  canApprove: boolean;
  /** Can provide taste feedback (update/keep/nuanced/deferred). */
  canFeedbackTaste: boolean;
  /** Can receive and act on escalations. */
  canEscalate: boolean;
  /** Can receive notifications (narration, awareness surfacing). */
  canNotify: boolean;
  /** Autonomy budget — number of escalations to self-resolve before requiring external help. */
  autonomyBudget?: number;
}

interface AskContext {
  /** What kind of question this is — shapes how implementations handle it. */
  kind: "inquiry" | "approval" | "escalation" | "clarification";
  /** Structured escalation data, if this is an escalation. */
  escalation?: Escalation;
  /** Escalation briefing, if available. */
  briefing?: EscalationBriefing;
  /** For approval: the proposal being approved. */
  proposal?: string;
  /** Severity hint — autonomous implementations use this to decide self-resolve vs escalate. */
  severity?: "low" | "medium" | "high" | "critical";
}

type NotifyCategory =
  | "narration"          // Phase-level event narration
  | "awareness"          // Proactive awareness surfacing
  | "status"             // Status bar update
  | "progress"           // Task/project progress
  | "communication";     // Gate communication message
```

## Three implementations

### HumanParsifal

Wraps the existing ConversationCortex + transport infrastructure. This is what the system does today, just behind the interface.

- `ask()` → formats question through communicate(), broadcasts via transports, blocks on pendingQuestion Promise
- `notify()` → broadcasts via transports (narration, status, messages)
- `onDirection()` → wires to ConversationCortex.receive() routing
- `proposeTaste()` → formats proposal, asks via transport, parses structured response
- All capabilities enabled

### CortexParsifal

A parent Cortex instance acts as the Parsifal. When the child escalates or asks a question, the parent reasons about it using its own cognition.

- `ask()` → parent's communication function reasons about the question in context of the parent's world model, awareness buffer, and task gestalt. Returns a reasoned answer, not a human one.
- `notify()` → stores as WM observation in the parent. Parent becomes aware of child's state.
- `onDirection()` → rarely fires. Parent Cortex sends direction at task boundaries, not mid-task.
- `proposeTaste()` → parent applies its own taste profile. No interactive negotiation.
- Capabilities: canInquire (limited — bounded rounds), canApprove (yes, using own judgment), canEscalate (yes, but may chain upward to parent's own Parsifal), canFeedbackTaste (auto-resolve from parent taste)

The key design: when a child asks a question, the parent doesn't just forward it to the human. The parent THINKS about it. "My child Cortex working on the auth system is asking whether to use JWT or sessions. Given what I know about the project architecture and the Parsifal's taste..." The parent's answer comes from its own understanding.

If the parent can't answer (too uncertain, outside its knowledge), it chains the escalation upward to ITS Parsifal. The human only sees questions that no Cortex in the hierarchy could resolve.

### AutonomousParsifal

No external entity. The Cortex operates within bounded autonomy.

- `ask(question, context)` → heuristic resolution based on context:
  - Inquiry questions: return "" (skip inquiry, use intent as-is)
  - Approval: auto-approve (the system trusts its own vision synthesis)
  - Escalation: attempt self-resolution up to `autonomyBudget`. Uses communication function to reason about the escalation as if it were the Parsifal. If budget exhausted → throw to signal "cannot continue."
  - Clarification: return best-guess from world model
- `notify()` → logs but doesn't display
- `onDirection()` → no-op (no one to send direction)
- `proposeTaste()` → auto-defer (no external taste authority)
- Capabilities: canInquire=false, canApprove=true (auto), canEscalate=limited (budget), canFeedbackTaste=false

## Where it connects

### Brainstem initialization

Currently the Brainstem has two paths: `setAskUser(callback)` or `setConversationTransport(transport)`. These collapse into one:

```typescript
// Replace both setAskUser and setConversationTransport with:
setParsifal(parsifa: ParsifaInterface): void {
  this.parsifa = parsifa;

  // Wire askUser for backward compatibility with project rhythm
  this.askUser = (question: string) => parsifa.ask(question, { kind: "clarification" });

  // Wire escalation delivery
  this.escalationHandler.setDeliveryAdapter({
    deliver: async (escalation, briefing) => {
      const answer = await parsifa.ask(
        formatEscalationForParsifal(escalation, briefing),
        { kind: "escalation", escalation, briefing, severity: escalation.severity },
      );
      return { answer, resolvedAt: new Date() };
    },
  });

  // Wire direction handler
  parsifa.onDirection((text) => this.conversationCortex.receive(text));

  // Activate conversation cortex for awareness surfacing / narration
  this.conversationCortex.activate();
}
```

### Project rhythm

The approval and inquiry loops currently check `if (interaction)`. They'd check `if (parsifa.capabilities.canInquire)` and `if (parsifa.capabilities.canApprove)` instead. Same code paths, just gated by capabilities rather than callback existence.

### Motor Cortex delegation (future)

When Cortex-as-orchestrator delegates to a child Cortex:

```typescript
// Inside Motor Cortex, when task complexity warrants delegation:
const child = new Cortex({ intent: taskIntent, taste: parentTaste, worldview: parentWorldview });
child.setParsifal(new CortexParsifal(parentCortex));
const result = await child.run(taskDescription);
```

The parent's evaluation senses assess the child's result. The parent's gate decides accept/revise. But the work was done by a full cognitive agent, not a single LLM call.

### Learning propagation (future)

After a child completes:

```typescript
// Parent ingests child's experience
const childEpisodes = child.getHippocampus().getRecentEpisodes();
const childPrinciples = child.getHippocampus().getActivePrinciples();
parentHippocampus.ingestChildExperience(childEpisodes, childPrinciples);
```

The parent learns from its children's work — not just the outcome, but the process. "When I delegated auth to a child Cortex, it struggled with X for 4 cycles before discovering Y." That becomes a principle the parent uses when delegating similar work in the future.

## What to build first

1. **ParsifaInterface + ParsifaCapabilities types** — the contract
2. **HumanParsifal** — wraps existing ConversationCortex + transport infrastructure
3. **Brainstem.setParsifal()** — single entry point replacing setAskUser + setConversationTransport
4. **AutonomousParsifal** — simplest non-human implementation, enables headless mode
5. **CortexParsifal + Motor Cortex delegation** — the hierarchical composition

Steps 1-4 are refactoring (same behavior, new interface). Step 5 is new capability.

## What doesn't change

The cognitive architecture stays the same. Rhythm, evaluation, conviction, learning, awareness, self-model — none of this changes. The Parsifal interface is the ONLY thing that varies across modes.

Same substrate. Different relationship to the entity that directs it.
