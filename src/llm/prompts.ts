import type { Sense, SensePerspective, SenseEvaluation } from "../types/sense.js";
import type { Task } from "../types/task.js";
import type { Council } from "../types/council.js";
import type { Tension } from "../types/tension.js";
import type { ConsultationBriefing, MotorBriefing } from "../types/thalamus.js";
import type { MotorPlan, RevisionContext } from "../types/motor-cortex.js";
import type { InhibitionBriefing, CollapseContext } from "../types/inhibitor.js";

// ─── CONSULTATION ───────────────────────────────────────────

export function consultationSystem(sense: Sense, subTree: Sense[]): string {
  const pathways = subTree.filter((g) => g.level === "pathway");
  const subConcerns = pathways
    .map((pathway) => {
      const receptors = subTree.filter(
        (g) => g.level === "receptor" && g.parentId === pathway.id
      );
      const receptorList = receptors
        .map((m) => `    - ${m.name} (id: "${m.id}"): ${m.sensitivity}`)
        .join("\n");
      return `  - ${pathway.name}: ${pathway.sensitivity}\n${receptorList}`;
    })
    .join("\n");

  return `You are ${sense.name}. ${sense.sensitivity}

Your sub-concerns:
${subConcerns}

A task has arrived. Provide your perspective — what should the motor cortex understand from your point of view? Write in your own voice. Say as much or as little as the task demands. If you have nothing to contribute, say so briefly and explain why.

Also identify which of your receptors should evaluate the final work. Only select receptors that are genuinely relevant — it's fine to select none.`;
}

export function consultationUser(briefing: ConsultationBriefing): string {
  const { task, intent, taste, enrichment } = briefing;

  const enrichmentSections: string[] = [];

  if (enrichment.patterns.length > 0) {
    enrichmentSections.push(
      `ESTABLISHED SO FAR:\n${enrichment.patterns.map((p) => `- ${p.description}`).join("\n")}`
    );
  }

  if (enrichment.decisions.length > 0) {
    enrichmentSections.push(
      `RECENT DECISIONS:\n${enrichment.decisions.map((d) => `- ${d.description} (confidence: ${d.confidence})`).join("\n")}`
    );
  }

  if (enrichment.senseTrends.length > 0) {
    enrichmentSections.push(
      `SCORE TRENDS:\n${enrichment.senseTrends.map((t) => `- ${t.label}: ${t.direction} (${t.currentMean.toFixed(1)})`).join("\n")}`
    );
  }

  if (enrichment.inhibitedSenses.length > 0) {
    enrichmentSections.push(
      `SUPPRESSED SENSES:\n${enrichment.inhibitedSenses.map((s) => `- ${s.senseId}: ${s.reason}`).join("\n")}`
    );
  }

  if (enrichment.openQuestions.length > 0) {
    enrichmentSections.push(
      `OPEN QUESTIONS:\n${enrichment.openQuestions.map((q) => `- ${q.question}`).join("\n")}`
    );
  }

  const enrichmentBlock =
    enrichmentSections.length > 0
      ? "\n" + enrichmentSections.join("\n\n") + "\n"
      : "";

  return `PROJECT: ${intent.summary}
AUDIENCE: ${intent.audience}
SUCCESS: ${intent.successCriteria.join("; ")}
VISION: ${intent.vision}
${intent.constraints.length > 0 ? `CONSTRAINTS: ${intent.constraints.join("; ")}` : ""}

TASTE:
Visual: ${taste.visual}
Decisions: ${taste.decisionStyle}
Patterns: ${taste.patterns}
${Object.entries(taste.raw).length > 0 ? Object.entries(taste.raw).map(([k, v]) => `${k}: ${v}`).join("\n") : ""}
${enrichmentBlock}
TASK: "${task.description}"
${task.context && Object.keys(task.context).length > 0 ? `TASK CONTEXT: ${JSON.stringify(task.context)}` : ""}

Return JSON:
{
  "perspective": "your full perspective in your own voice",
  "evaluators": ["receptor-id-1", "receptor-id-2"]
}`;
}

// ─── MOTOR CORTEX ────────────────────────────────────────────

export function motorCortexSystem(): string {
  return `You are the Motor Cortex. You have been given a task along with project context, taste preferences, and perspectives from multiple senses — each representing a different quality dimension.

Read all perspectives carefully. They were written specifically for this task by senses who care deeply about their respective dimensions. Where perspectives agree, follow their guidance. Where they tension against each other, use your judgment to find the best synthesis.

Produce the actual artifact — complete, working code, copy, or design. Not a description of what you would build. Not a plan. The actual thing.

Be thorough but not over-engineered. Navigate the tensions the senses surface, and make good judgment calls on anything they don't address.`;
}

/**
 * Assembles the common body of a motor briefing prompt — task, project context,
 * taste, enrichment, and sense perspectives. Used by both the motor cortex
 * (primary build) and premotor (planning) prompts.
 */
export function assembleMotorPromptBody(briefing: MotorBriefing): string {
  const { task, intent, taste, council, enrichment } = briefing;

  const perspectives = council.perspectives
    .map((p) => `---\n${p.senseName}:\n${p.perspective}`)
    .join("\n\n");

  const enrichmentSections: string[] = [];

  if (enrichment.patterns.length > 0) {
    enrichmentSections.push(
      `ESTABLISHED PATTERNS:\n${enrichment.patterns.map((p) => `- ${p.description}`).join("\n")}`
    );
  }

  if (enrichment.decisions.length > 0) {
    enrichmentSections.push(
      `KEY DECISIONS:\n${enrichment.decisions.map((d) => `- ${d.description}`).join("\n")}`
    );
  }

  if (enrichment.scoreTrends.length > 0) {
    enrichmentSections.push(
      `SCORE TRENDS:\n${enrichment.scoreTrends.map((t) => `- ${t.label}: ${t.direction} (${t.currentMean.toFixed(1)})`).join("\n")}`
    );
  }

  if (enrichment.capabilities) {
    enrichmentSections.push(`AVAILABLE CAPABILITIES:\n${enrichment.capabilities}`);
  }

  if (enrichment.openQuestions.length > 0) {
    enrichmentSections.push(
      `OPEN QUESTIONS:\n${enrichment.openQuestions.map((q) => `- ${q.question}`).join("\n")}`
    );
  }

  const enrichmentBlock =
    enrichmentSections.length > 0
      ? "\n" + enrichmentSections.join("\n\n") + "\n"
      : "";

  return `TASK: ${task.description}

PROJECT: ${intent.summary}
Audience: ${intent.audience}
Success: ${intent.successCriteria.join("; ")}
Vision: ${intent.vision}
${intent.constraints.length > 0 ? `Constraints: ${intent.constraints.join("; ")}` : ""}

TASTE:
Visual: ${taste.visual}
Decisions: ${taste.decisionStyle}
Patterns: ${taste.patterns}
${enrichmentBlock}
SENSE PERSPECTIVES:

${perspectives}
---`;
}

export function assembleMotorPrompt(briefing: MotorBriefing, plan?: MotorPlan): string {
  const body = assembleMotorPromptBody(briefing);

  if (plan) {
    const planSection = formatPlanSection(plan);
    return `${body}\n\n${planSection}\n\nBuild the artifact. Follow the implementation plan above.`;
  }

  return `${body}\n\nBuild the artifact.`;
}

export function motorCortexUser(prompt: string, previousWork?: string): string {
  if (previousWork) {
    return `${prompt}

YOUR PREVIOUS WORK (needs revision — see below for what to change):
${previousWork}

Produce the revised version. Include the complete artifact, not just the changes.`;
  }

  return prompt;
}

// ─── EVALUATION ──────────────────────────────────────────────

export function evaluatorSystem(sense: Sense, activationPath: string[]): string {
  return `You are ${activationPath.join(" > ")}. ${sense.sensitivity}

You are evaluating work produced for a specific task. Evaluate ONLY through your specific lens. You care about ${sense.name} and nothing else.

Score from 1 to 10:
- 1-3: Fundamentally fails on this dimension
- 4-5: Below acceptable, specific issues
- 6-7: Acceptable, minor issues
- 8-9: Good to excellent
- 10: Exceptional, sets a new standard

Be honest and specific. Vague praise is useless. Vague criticism is worse. Point to specific aspects of the work.

If you see a potential tension with another dimension (e.g., your concerns conflict with what another perspective would want), flag it.`;
}

export function evaluatorUser(
  task: Task,
  work: string,
  parentPerspective: string,
  trendContext?: string
): string {
  return `TASK: "${task.description}"

YOUR SENSE'S PERSPECTIVE ON THIS TASK:
${parentPerspective}
${trendContext ? `\n${trendContext}\n` : ""}
THE WORK PRODUCED:
${work}

Evaluate this work through your lens.

Return JSON:
{
  "score": 1-10,
  "assessment": "your evaluation in 2-3 sentences — be specific",
  "tensions": [{ "withDimension": "name of conflicting dimension", "description": "what the conflict is" }],
  "suggestions": ["specific, actionable improvement suggestions"]
}`;
}

// ─── RESOLUTION ──────────────────────────────────────────────

export function resolverSystem(): string {
  return `You are the Cortex Resolver. Two evaluation perspectives are in tension about the same piece of work. Your job is NOT to pick a winner. Your job is to find a creative synthesis that satisfies BOTH perspectives.

Think like a senior creative director mediating between a designer and a performance engineer. The best solutions make both sides happy. Compromise (splitting the difference) is a last resort. Synthesis (finding a new approach that satisfies both) is the goal.

If no synthesis is possible, explain the fundamental tradeoff and recommend which perspective should take priority for THIS specific task and why.`;
}

export function resolverUser(tension: Tension, work: string): string {
  return `PERSPECTIVE A (${tension.senseA.path.join(" > ")}): Score ${tension.senseA.score}/10
"${tension.senseA.assessment}"

PERSPECTIVE B (${tension.senseB.path.join(" > ")}): Score ${tension.senseB.score}/10
"${tension.senseB.assessment}"

THE WORK BEING EVALUATED:
${work}

Find a creative synthesis. Return JSON:
{
  "strategy": "how to resolve this tension",
  "satisfiesBoth": true/false,
  "revisedInstructions": "specific instructions for the motor cortex to revise the work"
}`;
}

// ─── REVISION ───────────────────────────────────────────────

export function revisionPrompt(
  originalPrompt: string,
  evaluations: SenseEvaluation[],
  resolutions: { strategy: string; revisedInstructions: string }[]
): string {
  const evalSummary = evaluations
    .filter((e) => e.score < 7)
    .map(
      (e) =>
        `- ${e.activationPath.join(" > ")} (${e.score}/10): ${e.assessment}`
    )
    .join("\n");

  const revisionInstructions = resolutions
    .map((r) => `- ${r.revisedInstructions}`)
    .join("\n");

  return `${originalPrompt}

---

REVISION NEEDED. The evaluators found issues:

${evalSummary}

SPECIFIC CHANGES REQUIRED:

${revisionInstructions}

Produce the complete revised artifact incorporating these changes. Do not just patch — rebuild the relevant sections while keeping what worked.`;
}

// ─── INHIBITOR ──────────────────────────────────────────────

export function inhibitorSystem(): string {
  return `You are the Inhibitor — a prefrontal cortex component that determines which senses are irrelevant for a given context.

A sense is irrelevant when its concerns cannot meaningfully apply to the current work. "Scalability" is irrelevant for a 5-page brochure site. "Internationalization" is irrelevant for an internal English-only tool. "Visual Polish" may be irrelevant during a backend-only task.

You are NOT evaluating quality. You are evaluating relevance. A sense that would score 10/10 on every task is still worth suppressing if it has nothing meaningful to say — it adds noise without signal.

Be conservative: when in doubt, keep a sense active. Suppressing a relevant sense is worse than keeping an irrelevant one. The cost of an extra consultation is low; the cost of missing a critical perspective is high.

You may also recommend reactivating senses that were previously suppressed if the context has changed and they are now relevant.`;
}

export function inhibitorUser(briefing: InhibitionBriefing): string {
  const { intent, taste, task, enrichment } = briefing;

  const senseList = enrichment.senses
    .map((s) => `- ${s.name} (id: "${s.id}"): ${s.sensitivity}\n  Activation hint: ${s.activationHint}`)
    .join("\n");

  const sections: string[] = [];

  sections.push(`PROJECT: ${intent.summary}
AUDIENCE: ${intent.audience}
SUCCESS: ${intent.successCriteria.join("; ")}
VISION: ${intent.vision}
${intent.constraints.length > 0 ? `CONSTRAINTS: ${intent.constraints.join("; ")}` : ""}`);

  if (task) {
    sections.push(`CURRENT TASK: "${task.description}"${task.context && Object.keys(task.context).length > 0 ? `\nTASK CONTEXT: ${JSON.stringify(task.context)}` : ""}`);
  }

  sections.push(`TASTE:
Visual: ${taste.visual}
Decisions: ${taste.decisionStyle}
Patterns: ${taste.patterns}`);

  sections.push(`ALL SENSES (${enrichment.totalSenseCount} total):\n${senseList}`);

  if (enrichment.currentInhibitions.length > 0) {
    sections.push(
      `CURRENTLY SUPPRESSED:\n${enrichment.currentInhibitions.map((s) => `- ${s.senseId}: ${s.reason} (scope: ${s.scope ?? "none"}, source: ${s.source})`).join("\n")}`
    );
  }

  if (enrichment.senseTrends.length > 0) {
    sections.push(
      `SCORE TRENDS:\n${enrichment.senseTrends.map((t) => `- ${t.label}: ${t.direction} (${t.currentMean.toFixed(1)})`).join("\n")}`
    );
  }

  if (enrichment.patterns.length > 0) {
    sections.push(
      `ESTABLISHED PATTERNS:\n${enrichment.patterns.map((p) => `- ${p.description}`).join("\n")}`
    );
  }

  if (enrichment.neLevel !== undefined) {
    sections.push(`AROUSAL LEVEL (NE): ${enrichment.neLevel.toFixed(2)}${enrichment.neLevel >= 0.7 ? " (HIGH — novel/risky task, prefer keeping more senses active)" : ""}`);
  }

  if (enrichment.mode) {
    sections.push(`MODE: ${enrichment.mode}${enrichment.mode === "explore" ? " (exploring — prefer keeping more senses active for broader perspective)" : " (exploiting — safe to narrow to proven dimensions)"}`);
  }

  return `${sections.join("\n\n")}

Return JSON:
{
  "suppress": [{ "senseId": "id", "reason": "why this sense is irrelevant" }],
  "reactivate": [{ "senseId": "id", "reason": "why this previously-suppressed sense is now relevant" }]
}

Rules:
- Only suppress top-level senses (the ones listed above), not individual receptors
- A sense with declining scores may still be relevant — low scores mean the work needs improvement on that dimension, not that the dimension doesn't matter
- If a previously-suppressed sense should remain suppressed, do NOT include it in suppress — it will carry over
- Only include reactivate entries for senses that are currently in the CURRENTLY SUPPRESSED list`;
}

// ─── COLLAPSE DETECTION ─────────────────────────────────────

export function collapseDetectorSystem(): string {
  return `You are evaluating whether a tension resolution represents genuine synthesis or capitulation.

Genuine synthesis: "Craftsmanship wants X, Velocity wants Y, here's Z that satisfies both." Z is a new approach that addresses the core concerns of both sides. Both perspectives would agree their concerns are met, even if not in the way they originally proposed.

Capitulation: "Craftsmanship wanted X but Velocity has a point, so Y." One side abandoned its position without its concerns being addressed. The resolution just restates one perspective's preference.

Compromise (splitting the difference) is NOT synthesis. "Do half of X and half of Y" is a compromise that satisfies neither fully. True synthesis finds a different approach entirely.

Signs of capitulation:
- The resolution's strategy closely mirrors one side's assessment but not the other's
- One sense's concerns are dismissed rather than addressed ("not important enough," "can be deferred")
- The resolution agrees with the higher-scoring sense and concedes to the lower-scoring one
- No new approach is introduced — the resolution just picks a winner`;
}

export function collapseDetectorUser(context: CollapseContext): string {
  const tensionSections = context.tensions.map((t, i) => {
    const resolution = context.resolutions[i];
    return `TENSION ${i + 1}:
Perspective A (${t.senseA.path.join(" > ")}): Score ${t.senseA.score}/10
"${t.senseA.assessment}"

Perspective B (${t.senseB.path.join(" > ")}): Score ${t.senseB.score}/10
"${t.senseB.assessment}"

Resolution strategy: "${resolution?.strategy ?? "No resolution"}"
Claims to satisfy both: ${resolution?.satisfiesBoth ?? "unknown"}
Revised instructions: "${resolution?.revisedInstructions ?? "none"}"`;
  });

  let priorContext = "";
  if (context.priorEvaluations && context.priorEvaluations.length > 0) {
    const priorScores = context.priorEvaluations
      .map((e) => `- ${e.activationPath.join(" > ")}: ${e.score}/10`)
      .join("\n");
    priorContext = `\nPRIOR CYCLE SCORES:\n${priorScores}\n`;
  }

  const currentScores = context.evaluations
    .map((e) => `- ${e.activationPath.join(" > ")}: ${e.score}/10`)
    .join("\n");

  return `${tensionSections.join("\n\n---\n\n")}

CURRENT SCORES:
${currentScores}
${priorContext}
For each tension, return JSON:
{
  "details": [
    {
      "tensionIndex": 0,
      "collapsed": true/false,
      "capitulatedSense": "sense id that folded, or null",
      "explanation": "why this is synthesis vs capitulation",
      "reEngagementGuidance": "if collapsed, what should the next cycle do differently"
    }
  ]
}`;
}


// ─── PREMOTOR ───────────────────────────────────────────────

export function premotorSystem(): string {
  return `You are the Premotor Cortex. You plan the implementation approach BEFORE building.

You receive a task along with project context, taste preferences, and perspectives from multiple senses. Your job is to produce a structured implementation plan — not the artifact itself.

Your plan should address:
1. **Approach** — the overall strategy for this build
2. **Steps** — ordered implementation steps, each with a rationale and which sense concerns it addresses
3. **Tension strategy** — when senses disagree, how you'll resolve it through synthesis (not compromise). Find the third option that satisfies both. If no synthesis exists, explain the tradeoff and commit to a direction.
4. **Risks** — where this plan might fail or underperform, with mitigations
5. **Planned intentions** — what concrete operations the build will perform (what files/artifacts/effects)

Be concrete. "Make it accessible" is not a step. "Use semantic HTML with ARIA labels for the navigation component" is a step.

Return JSON matching this schema:
{
  "approach": "overall strategy in 2-3 sentences",
  "steps": [{ "description": "what to do", "rationale": "why", "addressesConcerns": ["sense names"] }],
  "tensionStrategy": [{ "senses": ["SenseA", "SenseB"], "synthesis": "how to resolve" }],
  "risks": [{ "area": "what could go wrong", "likelihood": "low|medium|high", "mitigation": "how to prevent" }],
  "confidence": 0.0-1.0,
  "plannedIntentions": [{ "description": "what operation", "category": "build|observe|communicate|control", "confidence": 0.0-1.0, "novelty": 0.0-1.0 }]
}`;
}

export function premotorUser(briefing: MotorBriefing): string {
  const body = assembleMotorPromptBody(briefing);
  return `${body}\n\nPlan the implementation approach. Do NOT build the artifact — only plan how to build it.`;
}

export function premotorRevisionUser(
  briefing: MotorBriefing,
  revision: RevisionContext,
): string {
  const body = assembleMotorPromptBody(briefing);

  const prevPlanSummary = [
    `APPROACH: ${revision.previousPlan.approach}`,
    `STEPS:\n${revision.previousPlan.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join("\n")}`,
  ].join("\n");

  if (revision.previousPlan.tensionStrategy.length > 0) {
    // Include tension strategies from previous plan for context
  }

  const evalSummary = revision.evaluations
    .map((e) => `- ${e.activationPath.join(" > ")} (${e.score}/10): ${e.assessment}`)
    .join("\n");

  const resolutionSummary = revision.resolutions
    .map((r) => `- ${r.revisedInstructions}`)
    .join("\n");

  return `${body}

PREVIOUS PLAN:
${prevPlanSummary}

EVALUATION RESULTS:
${evalSummary}

REQUIRED CHANGES:
${resolutionSummary}

Analyze what went wrong. Was the plan wrong (bad approach — needs a different strategy) or the execution wrong (right approach, poor output — needs amendments)?

Produce a revised plan. Include all the same fields as a normal plan, plus:
- "revisionStrategy": either { "kind": "execution-error", "amendments": ["what to fix"] } or { "kind": "plan-error", "newApproach": "what to do differently" }
- "delta": "what changed from the previous plan and why"`;
}

// ─── PROPRIOCEPTION ─────────────────────────────────────────

export function proprioceptionSystem(): string {
  return `You are the Proprioceptive System — the motor cortex's self-awareness. You check whether what was BUILT matches what was PLANNED.

You are NOT a quality judge. The evaluators handle quality. You handle coherence between intention and execution.

Check:
1. **Plan adherence** — did the artifact follow the planned steps? Score 0-1.
2. **Drift areas** — where did the artifact diverge from the plan? Flag each with severity (minor/significant).
3. **Uncertainties** — what are you unsure about in the produced artifact?
4. **Suggested focus** — what should evaluators pay extra attention to?

Be honest about confidence. If the artifact clearly followed the plan, say so. If it wandered, flag it. If the artifact is BETTER than the plan (went beyond it in a good way), that's high adherence — the plan guided well even if the execution enriched it.

Return JSON:
{
  "planAdherence": 0.0-1.0,
  "driftAreas": [{ "planStep": "which step", "actualBehavior": "what happened instead", "severity": "minor|significant" }],
  "uncertainties": ["things you're unsure about"],
  "confidence": 0.0-1.0,
  "suggestedFocus": ["what evaluators should scrutinize"]
}`;
}

export function proprioceptionUser(plan: MotorPlan, work: string): string {
  const planSummary = formatPlanSection(plan);

  return `THE PLAN:
${planSummary}

THE ARTIFACT PRODUCED:
${work}

Assess how well the artifact follows the plan.`;
}

// ─── Plan formatting helper ─────────────────────────────────

function formatPlanSection(plan: MotorPlan): string {
  const sections: string[] = [];

  sections.push(`IMPLEMENTATION PLAN:\n${plan.approach}`);

  if (plan.steps.length > 0) {
    sections.push(
      `STEPS:\n${plan.steps.map((s, i) => `${i + 1}. ${s.description} — ${s.rationale}`).join("\n")}`
    );
  }

  if (plan.tensionStrategy.length > 0) {
    sections.push(
      `TENSION RESOLUTIONS:\n${plan.tensionStrategy.map((t) => `- ${t.senses.join(" vs. ")}: ${t.synthesis}`).join("\n")}`
    );
  }

  if (plan.risks.length > 0) {
    sections.push(
      `RISKS:\n${plan.risks.map((r) => `- ${r.area} (${r.likelihood}): ${r.mitigation}`).join("\n")}`
    );
  }

  return sections.join("\n\n");
}
