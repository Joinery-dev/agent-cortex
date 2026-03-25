import type { Sense, SensePerspective, SenseEvaluation } from "../types/sense.js";
import type { Task } from "../types/task.js";
import type { Consultation } from "../types/consultation.js";
import type { Tension } from "../types/tension.js";
import type { ConsultationBriefing, MotorBriefing } from "../types/thalamus.js";
import type { MotorPlan, RevisionContext } from "../types/motor-cortex.js";
import type { InhibitionBriefing, CollapseContext } from "../types/basal-ganglia.js";
import type { WeightedEvaluation } from "../kernel/evaluation-weighter.js";
import type { Episode, Principle, PotentiationTrigger } from "../types/hippocampus.js";

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

Also identify which of your receptors should evaluate the final work. Only select receptors that are genuinely relevant — it's fine to select none.

Finally, rate your stake in this task (0.0–1.0): if this task shipped without your input at all, how much would be lost? 0.0 means your dimension is completely irrelevant. 1.0 means your dimension is critical to the task's success. Be honest — not every task is your business.`;
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

  if (enrichment.principles && enrichment.principles.length > 0) {
    enrichmentSections.push(
      `PRINCIPLES FROM EXPERIENCE:\n${enrichment.principles.map((p) => `- (${p.confidence.toFixed(2)} confidence) ${p.statement}`).join("\n")}`
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
  "evaluators": ["receptor-id-1", "receptor-id-2"],
  "stake": 0.0-1.0
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
  const { task, intent, taste, consultation, enrichment } = briefing;

  const perspectives = consultation.perspectives
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

  if (enrichment.principles && enrichment.principles.length > 0) {
    enrichmentSections.push(
      `PRINCIPLES FROM EXPERIENCE:\n${enrichment.principles.map((p) => `- (${p.confidence.toFixed(2)} confidence) ${p.statement}`).join("\n")}`
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

Also determine: is this work acceptable from your perspective? Acceptable means your dimension is adequately served — not perfect, just not failing. A 5/10 might be acceptable if the gaps are cosmetic; a 7/10 might not be if there's a structural flaw. This is your judgment call, not a formula.

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
  "acceptable": true/false,
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
  evaluations: WeightedEvaluation[],
  resolutions: { strategy: string; revisedInstructions: string }[]
): string {
  // Primary: unacceptable evaluations, sorted by impact (stake * distance from 10)
  const unacceptable = evaluations
    .filter((e) => !e.acceptable)
    .sort((a, b) => b.adjustedStake * (10 - b.score) - a.adjustedStake * (10 - a.score));

  // Secondary: acceptable but low-scoring — optional improvements
  const optional = evaluations
    .filter((e) => e.acceptable && e.score < 6)
    .sort((a, b) => b.adjustedStake * (10 - b.score) - a.adjustedStake * (10 - a.score));

  const evalSummary = unacceptable
    .map(
      (e) =>
        `- [STAKE ${e.adjustedStake.toFixed(1)}] ${e.activationPath.join(" > ")} (${e.score}/10, UNACCEPTABLE): ${e.assessment}`
    )
    .join("\n");

  const optionalSummary = optional.length > 0
    ? `\n\nOPTIONAL IMPROVEMENTS (acceptable but could be better):\n${optional
        .map(
          (e) =>
            `- [STAKE ${e.adjustedStake.toFixed(1)}] ${e.activationPath.join(" > ")} (${e.score}/10): ${e.assessment}`
        )
        .join("\n")}`
    : "";

  const revisionInstructions = resolutions
    .map((r) => `- ${r.revisedInstructions}`)
    .join("\n");

  return `${originalPrompt}

---

REVISION NEEDED. Items are ordered by impact (stake × severity). Address high-stake issues first.

${evalSummary}${optionalSummary}

SPECIFIC CHANGES REQUIRED:

${revisionInstructions}

Produce the complete revised artifact incorporating these changes. Do not just patch — rebuild the relevant sections while keeping what worked.`;
}

// ─── BASAL GANGLIA (deliberative fallback) ──────────────────

export function basalGangliaSystem(): string {
  return `You are the Basal Ganglia's deliberative pathway — you determine which senses are irrelevant for a given context.

A sense is irrelevant when its concerns cannot meaningfully apply to the current work. "Scalability" is irrelevant for a 5-page brochure site. "Internationalization" is irrelevant for an internal English-only tool. "Visual Polish" may be irrelevant during a backend-only task.

You are NOT evaluating quality. You are evaluating relevance. A sense that would score 10/10 on every task is still worth suppressing if it has nothing meaningful to say — it adds noise without signal.

Be conservative: when in doubt, keep a sense active. Suppressing a relevant sense is worse than keeping an irrelevant one. The cost of an extra consultation is low; the cost of missing a critical perspective is high.

You may also recommend reactivating senses that were previously suppressed if the context has changed and they are now relevant.`;
}

export function basalGangliaUser(briefing: InhibitionBriefing): string {
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

// ─── POTENTIATION ───────────────────────────────────────────

export function potentiationExtractSystem(): string {
  return `You are the Hippocampus Potentiation system. You receive a cluster of task episodes that share a common pattern. Your job is to extract the principle — what these episodes teach.

A principle is a LIVING THEORY, not a rule. It is:
- DESCRIPTIVE, not prescriptive: "X tends to produce Y because Z" — NOT "you should do X"
- TRANSFERABLE: applicable beyond the specific project these episodes came from
- EXPLANATORY: not just "what happened" but "why it happened"
- FALSIFIABLE: specific enough that a future episode could contradict it
- SENSE-AWARE: identify which quality dimensions (senses) this principle is most relevant to

You also receive the system's existing principles. If any existing principle already covers this pattern, either:
- Return null for the principle (the existing principle is sufficient)
- Return a refined version that supersedes the existing one (set the supersedes field to the existing principle's ID)

Do NOT extract trivial principles ("tasks with more cycles take longer" or "higher scores are better"). The principle should teach the system something it couldn't have known without this specific pattern of episodes.

Return JSON: {
  "principle": {
    "statement": "the principle statement",
    "relevantSenses": ["SENSE_NAME_1", "SENSE_NAME_2"],
    "domain": "a short category like layout-strategy or tension-resolution",
    "confidence": 0.5-0.8,
    "supersedes": "principle-id or null"
  } | null,
  "reasoning": "why you extracted this principle (or why null)"
}`;
}

export function potentiationExtractUser(
  episodes: Episode[],
  existingPrinciples: Principle[],
  trigger: PotentiationTrigger,
): string {
  const sections: string[] = [];

  sections.push(`TRIGGER: ${formatTrigger(trigger)}`);

  sections.push("EPISODES IN CLUSTER:");
  for (const ep of episodes) {
    const senses = ep.senseParticipation
      .map(
        (sp) =>
          `${sp.senseName}: ${sp.finalScore.toFixed(1)}/10 (${sp.acceptable ? "acceptable" : "not acceptable"})`,
      )
      .join("; ");

    const tensions =
      ep.narrative.tensionSnapshots.length > 0
        ? `Tensions: ${ep.narrative.tensionSnapshots
            .map(
              (t) =>
                `${t.senseA} vs ${t.senseB} (${t.severity})${t.resolution ? ` → resolved: ${t.resolution.strategy}` : ""}`,
            )
            .join("; ")}`
        : "No tensions";

    const decisions =
      ep.narrative.decisions.length > 0
        ? `Decisions: ${ep.narrative.decisions.map((d) => d.description).join("; ")}`
        : "";

    sections.push(`
--- Episode: ${ep.taskId} ---
Task: ${ep.narrative.taskDescription}
Outcome: ${ep.narrative.outcome} (${ep.narrative.cycles} cycles, confidence: ${ep.narrative.confidence.toFixed(2)})
Dopamine: ${ep.dopamineSignal.toFixed(3)} (significance: ${ep.significance.toFixed(2)})
Senses: ${senses}
${tensions}
${decisions}
Approaches: ${ep.narrative.approachesTried.join(" → ") || "single approach"}`);
  }

  if (existingPrinciples.length > 0) {
    sections.push("EXISTING PRINCIPLES (do not duplicate):");
    for (const p of existingPrinciples) {
      sections.push(
        `- [${p.id}] (${p.confidence.toFixed(2)} confidence) ${p.statement} [senses: ${p.relevantSenses.join(", ")}]`,
      );
    }
  }

  return sections.join("\n\n");
}

export function potentiationRefineSystem(): string {
  return `You are revising an existing principle in light of contradicting evidence. A principle was extracted from earlier episodes, but a new episode challenges it.

Your options:
1. REFINE: The principle was too broad. Narrow its scope to account for the contradiction.
   Example: "Fragmented layouts underperform" → "Fragmented layouts underperform for scope-heavy content, but work well for browsable categorical content"
2. REPLACE: The principle was fundamentally wrong. Replace it with a better theory.
3. MAINTAIN: The contradicting episode was an outlier. The principle still holds. Do not change the statement.

For REFINE and REPLACE, the revised statement must still be DESCRIPTIVE (not prescriptive), TRANSFERABLE, EXPLANATORY, and FALSIFIABLE.

Return JSON: {
  "action": "refine" | "replace" | "maintain",
  "revisedStatement": "the new statement (required for refine/replace, omit for maintain)",
  "revisedConfidence": 0.0-1.0,
  "reasoning": "why you chose this action"
}`;
}

export function potentiationRefineUser(
  principle: Principle,
  contradictingEpisode: Episode,
): string {
  const sections: string[] = [];

  sections.push(`EXISTING PRINCIPLE:
ID: ${principle.id}
Statement: ${principle.statement}
Confidence: ${principle.confidence.toFixed(2)}
Relevant senses: ${principle.relevantSenses.join(", ")}
Supporting evidence: ${principle.supportingEvidence.length} episodes
Contradicting evidence: ${principle.contradictingEvidence.length} episodes (including this new one)`);

  const ep = contradictingEpisode;
  const senses = ep.senseParticipation
    .map(
      (sp) =>
        `${sp.senseName}: ${sp.finalScore.toFixed(1)}/10 (${sp.acceptable ? "acceptable" : "not acceptable"})`,
    )
    .join("; ");

  sections.push(`CONTRADICTING EPISODE:
Task: ${ep.narrative.taskDescription}
Outcome: ${ep.narrative.outcome} (${ep.narrative.cycles} cycles)
Dopamine: ${ep.dopamineSignal.toFixed(3)} (significance: ${ep.significance.toFixed(2)})
Senses: ${senses}
Approaches: ${ep.narrative.approachesTried.join(" → ") || "single approach"}`);

  if (ep.narrative.tensionSnapshots.length > 0) {
    sections.push(
      `Tensions: ${ep.narrative.tensionSnapshots
        .map(
          (t) =>
            `${t.senseA} vs ${t.senseB}: ${t.description}${t.resolution ? ` → ${t.resolution.strategy}` : ""}`,
        )
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

// ─── SENSE-SCOPED POTENTIATION ─────────────────────────────

export function potentiationSenseExtractSystem(): string {
  return `You are the Hippocampus Potentiation system, operating in SENSE-SCOPED mode. You receive episodes filtered to a single sense's participation in a single project. Your job is to extract what this sense has learned about this project.

A sense-scoped principle captures what a specific quality dimension has discovered through repeated engagement with a project:
- "Design has established: dark, bold palette with generous whitespace. Image-heavy hero sections underperform — the client's content is too dense for visual competition."
- "Engineering has learned: the legacy auth middleware silently swallows errors. Any new endpoint must validate tokens independently until the rewrite ships."

These are different from cross-project principles:
- They are PROJECT-LOCAL: what this sense knows about THIS project specifically
- They are SENSE-SPECIFIC: written from this sense's perspective, in this sense's voice
- They are ACCUMULATED: they synthesize across multiple episodes, not just one
- They are still LIVING THEORIES: they can be refined or contradicted by future episodes
- They are still FALSIFIABLE: specific enough that a future episode could contradict them

You also receive existing principles for this sense+project. If an existing principle already covers the pattern, either:
- Return null (existing principle is sufficient)
- Return a refined version that supersedes it (set supersedes to the existing principle's ID)

Do NOT extract principles that merely restate task descriptions or obvious outcomes.

Return JSON: {
  "principle": {
    "statement": "what this sense has learned, in its own voice",
    "relevantSenses": ["THE_SENSE_NAME"],
    "domain": "a short category like project-palette or api-architecture",
    "confidence": 0.4-0.8,
    "supersedes": "principle-id or null"
  } | null,
  "reasoning": "why you extracted this (or why null)"
}`;
}

export function potentiationSenseExtractUser(
  senseName: string,
  projectId: string,
  episodes: Episode[],
  existingPrinciples: Principle[],
): string {
  const sections: string[] = [];

  sections.push(`SENSE: ${senseName}`);
  sections.push(`PROJECT: ${projectId}`);
  sections.push(`EPISODE COUNT: ${episodes.length}`);

  sections.push(`${senseName.toUpperCase()}'S PARTICIPATION ACROSS EPISODES:`);
  for (const ep of episodes) {
    const senseRecord = ep.senseParticipation.find(
      (sp) => sp.senseName === senseName,
    );
    if (!senseRecord) continue;

    const tensions = ep.narrative.tensionSnapshots
      .filter((t) => t.senseA === senseName || t.senseB === senseName)
      .map(
        (t) =>
          `${t.senseA} vs ${t.senseB} (${t.severity})${t.resolution ? ` → ${t.resolution.strategy}` : ""}`,
      );

    sections.push(`
--- Episode: ${ep.taskId} ---
Task: ${ep.narrative.taskDescription}
Outcome: ${ep.narrative.outcome} (${ep.narrative.cycles} cycles)
${senseName}'s score: ${senseRecord.finalScore.toFixed(1)}/10 (${senseRecord.acceptable ? "acceptable" : "not acceptable"})
${senseName}'s stake: ${senseRecord.stake.toFixed(2)}
${senseName}'s assessment: ${senseRecord.assessment}
Dopamine: ${ep.dopamineSignal.toFixed(3)} (significance: ${ep.significance.toFixed(2)})
${tensions.length > 0 ? `Tensions involving ${senseName}: ${tensions.join("; ")}` : ""}
Approaches: ${ep.narrative.approachesTried.join(" → ") || "single approach"}`);
  }

  if (existingPrinciples.length > 0) {
    sections.push(
      `EXISTING ${senseName.toUpperCase()} PRINCIPLES FOR THIS PROJECT (do not duplicate):`,
    );
    for (const p of existingPrinciples) {
      sections.push(
        `- [${p.id}] (${p.confidence.toFixed(2)} confidence) ${p.statement}`,
      );
    }
  }

  return sections.join("\n\n");
}

function formatTrigger(trigger: PotentiationTrigger): string {
  switch (trigger.type) {
    case "pattern-density":
      return `Pattern density — ${trigger.episodeCount} similar episodes accumulated (${trigger.similarity})`;
    case "surprise":
      return `Surprise — dopamine signal ${trigger.dopamineSignal.toFixed(3)} on task ${trigger.taskId}`;
    case "contradiction":
      return `Contradiction — episode ${trigger.contradictingEpisodeId} contradicts principle ${trigger.principleId}`;
  }
}
