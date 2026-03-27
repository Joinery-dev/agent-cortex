import type { Sense, SensePerspective, SenseEvaluation } from "../types/sense.js";
import type { Task } from "../types/task.js";
import type { Consultation } from "../types/consultation.js";
import type { Tension } from "../types/tension.js";
import type { ConsultationBriefing, MotorBriefing, SenseQuestionBriefing } from "../types/thalamus.js";
import type { MotorPlan, RevisionContext } from "../types/motor-cortex.js";
import type { InhibitionBriefing, CollapseContext } from "../types/basal-ganglia.js";
import type { WeightedEvaluation } from "../kernel/evaluation-weighter.js";
import type { Episode, Principle, PotentiationTrigger } from "../types/hippocampus.js";
import type { CerebellumPrediction, ReceptorPrediction } from "../types/cerebellum.js";
import type { Maxim, RebuildTrigger } from "../types/world-model.js";
import type { FlexibilityContext } from "../types/cognitive-flexibility.js";
import type { ProspectiveTrigger } from "../types/prospective-memory.js";
import type { EfferenceCopyContext } from "../types/efference-copy.js";
import type { TasteDivergenceItem } from "../types/drift-monitor.js";
import type { TasteProfile } from "../types/intent.js";

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

Rate your stake in this task (0.0–1.0): if this task shipped without your input at all, how much would be lost? 0.0 means your dimension is completely irrelevant. 1.0 means your dimension is critical to the task's success. Be honest — not every task is your business.

Finally, estimate the THEORETICAL MAXIMUM SCORE (1–10) your dimension could achieve on this specific task. This is not what you expect — it's what perfection looks like given inherent constraints. Consider:
- What physical or structural constraints limit your dimension on this task?
- Are there inherent tensions with other dimensions that cap what's achievable?
- What would a 10 require, and is that physically possible here?

A ceiling of 10 means no inherent constraints limit your dimension. A ceiling of 7 means even perfect execution can't overcome the task's structural limits. Explain the constraints briefly.`;
}

export function consultationUser(briefing: ConsultationBriefing): string {
  const { task, intent, taste, enrichment } = briefing;

  const enrichmentSections: string[] = [];

  // Weltanschauung maxims come FIRST — they are the frame
  if (enrichment.worldModelMaxims && enrichment.worldModelMaxims.length > 0) {
    enrichmentSections.push(
      `SYSTEM UNDERSTANDING (the system's integrated worldview — let this orient your perspective):\n${enrichment.worldModelMaxims.map((m) => `- "${m}"`).join("\n")}`
    );
  }

  // Dissolved taste comes after the worldview frame — natural language guidance
  // shaped for this consumer, rather than raw taste fields.
  if (enrichment.dissolvedTaste) {
    enrichmentSections.push(
      `HUMAN PREFERENCES (dissolved from taste profile — let this shape your perspective):\n${enrichment.dissolvedTaste}`
    );
  }

  // Capabilities come after the worldview frame, before accumulated state
  if (enrichment.capabilitySummary) {
    enrichmentSections.push(
      `SYSTEM CAPABILITIES (what the system can physically do — ground your advice in these constraints):\n${enrichment.capabilitySummary}`
    );
  }

  if (enrichment.mode === "explore") {
    enrichmentSections.push(
      `APPROACH: EXPLORE — Think divergently. The established patterns below are reference points, not constraints. Consider fresh approaches that might outperform what's worked before.`
    );
  } else if (enrichment.mode === "leverage") {
    enrichmentSections.push(
      `APPROACH: LEVERAGE — Build on what works. The established patterns and high-scoring approaches should be maintained and refined, not reimagined.`
    );
  }

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

  if (enrichment.predictedTensions && enrichment.predictedTensions.length > 0) {
    enrichmentSections.push(
      `PREDICTED TENSIONS (these sense pairs are expected to conflict on this task — address proactively):\n${enrichment.predictedTensions.map((t) => `- ${t.senseA} vs ${t.senseB} (severity: ${t.severity.toFixed(2)}, basis: ${t.basis}): ${t.description}`).join("\n")}`
    );
  }

  if (enrichment.convictionNotes && enrichment.convictionNotes.length > 0) {
    enrichmentSections.push(
      `TACTICAL NOTES FROM PREVIOUS TASK:\n${enrichment.convictionNotes.map((n) => `- ${n}`).join("\n")}`
    );
  }

  if (enrichment.prospectiveDirectives && enrichment.prospectiveDirectives.length > 0) {
    enrichmentSections.push(
      `PROSPECTIVE MEMORY (the system set reminders for this task — incorporate these directives):\n${enrichment.prospectiveDirectives.map((d) => `- ${d}`).join("\n")}`
    );
  }

  if (enrichment.efferenceCopy && enrichment.efferenceCopy.length > 0) {
    const ceilingLines = enrichment.efferenceCopy
      .map((ec) => `- ${ec.senseName}: achievable ceiling ${ec.achievableCeiling}/10 — ${ec.ceilingRationale}${ec.constrainingFactors.length > 0 ? ` [constraints: ${ec.constrainingFactors.join("; ")}]` : ""}`)
      .join("\n");
    let efferenceBlock = `BUILDER FEASIBILITY (the Motor Cortex's assessment of what's achievable — calibrate your ambitions against these constraints):\n${ceilingLines}`;

    if (enrichment.efferenceTensionCosts && enrichment.efferenceTensionCosts.length > 0) {
      const costLines = enrichment.efferenceTensionCosts
        .map((tc) => `- ${tc.senseA} vs ${tc.senseB} (severity: ${tc.severity.toFixed(2)}): ${tc.costDescription}`)
        .join("\n");
      efferenceBlock += `\n\nTRADE-OFF COSTS:\n${costLines}`;
    }

    if (enrichment.efferenceHardConstraints && enrichment.efferenceHardConstraints.length > 0) {
      efferenceBlock += `\n\nHARD CONSTRAINTS (cannot be overcome):\n${enrichment.efferenceHardConstraints.map((c) => `- ${c}`).join("\n")}`;
    }

    enrichmentSections.push(efferenceBlock);
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
  "stake": 0.0-1.0,
  "ceiling": 1-10,
  "ceilingRationale": "what inherent constraints cap your dimension on this task"
}`;
}

// ─── RE-CONSULTATION ────────────────────────────────────────

export function reconsultationSystem(sense: Sense, subTree: Sense[]): string {
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

You previously provided guidance for this task. The work has been built and evaluated. You are being RE-CONSULTED because your evaluators flagged significant improvement potential, or your dimension is involved in unresolved tensions with other senses.

Review the actual work produced, your evaluators' scores and assessments, and what other senses observed. Then provide UPDATED guidance:
- What should change in your perspective now that you've seen the actual work?
- Were your initial assumptions correct? What did reality reveal?
- What specific direction would you give the builder for the next iteration?

You may update your stake and ceiling if what you've seen warrants it. If the work exceeded your expectations, say so. If your original perspective missed something important, address it directly.

Return JSON:
{
  "perspective": "your UPDATED perspective — what the builder should know for the next iteration",
  "evaluators": ["receptor-id-1", "receptor-id-2"],
  "stake": 0.0-1.0,
  "ceiling": 1-10,
  "ceilingRationale": "updated constraints given what you've seen"
}`;
}

export interface ReconsultationUserInput {
  briefing: ConsultationBriefing;
  work: string;
  previousPerspective: SensePerspective;
  ownEvaluations: SenseEvaluation[];
  otherEvaluationSummaries: { senseName: string; score: number; assessment: string }[];
  tensions: Tension[];
}

export function reconsultationUser(input: ReconsultationUserInput): string {
  const { briefing, work, previousPerspective, ownEvaluations, otherEvaluationSummaries, tensions } = input;
  const { task, intent, taste } = briefing;

  const sections: string[] = [];

  sections.push(`PROJECT: ${intent.summary}
AUDIENCE: ${intent.audience}
SUCCESS: ${intent.successCriteria.join("; ")}
VISION: ${intent.vision}
${intent.constraints.length > 0 ? `CONSTRAINTS: ${intent.constraints.join("; ")}` : ""}

TASTE:
Visual: ${taste.visual}
Decisions: ${taste.decisionStyle}
Patterns: ${taste.patterns}

TASK: "${task.description}"
${task.context && Object.keys(task.context).length > 0 ? `TASK CONTEXT: ${JSON.stringify(task.context)}` : ""}`);

  sections.push(`YOUR PREVIOUS PERSPECTIVE (stake: ${previousPerspective.stake}, ceiling: ${previousPerspective.ceiling}/10):
${previousPerspective.perspective}`);

  sections.push(`THE WORK PRODUCED:
${work}`);

  if (ownEvaluations.length > 0) {
    const evalLines = ownEvaluations
      .map((e) => `- ${e.activationPath.join(" > ")} (${e.score}/10, ${e.acceptable ? "acceptable" : "UNACCEPTABLE"}): ${e.assessment}${e.suggestions.length > 0 ? `\n  Suggestions: ${e.suggestions.join("; ")}` : ""}`)
      .join("\n");
    sections.push(`YOUR EVALUATORS' SCORES:\n${evalLines}`);
  }

  if (otherEvaluationSummaries.length > 0) {
    const otherLines = otherEvaluationSummaries
      .map((e) => `- ${e.senseName} (${e.score}/10): ${e.assessment}`)
      .join("\n");
    sections.push(`OTHER SENSES' ASSESSMENTS:\n${otherLines}`);
  }

  if (tensions.length > 0) {
    const tensionLines = tensions
      .map((t) => `- ${t.senseA.path.join(" > ")} (${t.senseA.score}/10) vs ${t.senseB.path.join(" > ")} (${t.senseB.score}/10) [${t.severity}]: ${t.description}`)
      .join("\n");
    sections.push(`TENSIONS INVOLVING YOUR DIMENSION:\n${tensionLines}`);
  }

  return sections.join("\n\n");
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

  // Weltanschauung maxims come FIRST — they are the frame
  if (enrichment.worldModelMaxims && enrichment.worldModelMaxims.length > 0) {
    enrichmentSections.push(
      `SYSTEM UNDERSTANDING (the system's integrated worldview — let this orient your build):\n${enrichment.worldModelMaxims.map((m) => `- "${m}"`).join("\n")}`
    );
  }

  // Dissolved taste — builder-specific style guidance
  if (enrichment.dissolvedTaste) {
    enrichmentSections.push(
      `HUMAN PREFERENCES (build to satisfy these):\n${enrichment.dissolvedTaste}`
    );
  }

  if (enrichment.mode === "explore") {
    enrichmentSections.push(
      `APPROACH: EXPLORE — Try new approaches. The patterns below are reference points, not constraints. The system is looking for creative solutions that might score higher than proven approaches.`
    );
  } else if (enrichment.mode === "leverage") {
    enrichmentSections.push(
      `APPROACH: LEVERAGE — Follow proven approaches. The established patterns have scored well. Maintain them. Focus on refinement over reinvention.`
    );
  }

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

  if (enrichment.prediction) {
    const predLines = enrichment.prediction.receptorPredictions
      .map((p) => `- ${p.activationPath.join(" > ")}: ${p.predicted.toFixed(1)} (confidence: ${p.confidence.toFixed(2)})`)
      .join("\n");
    enrichmentSections.push(
      `PREDICTED SCORES (based on ${enrichment.prediction.episodeCount} similar task(s), overall confidence: ${enrichment.prediction.overallConfidence.toFixed(2)}):\n${predLines}`
    );
  }

  if (enrichment.speedOfLight) {
    const sol = enrichment.speedOfLight;
    const senseLines = sol.perSense.map((s) => {
      let line = `- ${s.senseName}: ceiling ${s.ceiling}/10 (${s.ceilingRationale})`;
      if (s.bestAchieved !== null) {
        line += `. Best achieved: ${s.bestAchieved.toFixed(1)}/10. Gap: ${s.gap!.toFixed(1)}.`;
      }
      return line;
    }).join("\n");
    let composite = `Overall: composite ceiling ${sol.compositeCeiling.toFixed(1)}/10`;
    if (sol.compositeBestAchieved !== null) {
      composite += `, best achieved ${sol.compositeBestAchieved.toFixed(1)}/10, gap ${sol.compositeGap!.toFixed(1)}`;
    }
    enrichmentSections.push(
      `SPEED OF LIGHT — theoretical limits for this task:\n${senseLines}\n${composite}\n\nCalibrate your approach against these limits. If aiming beyond the ceiling for any dimension, reconsider — the ceiling reflects inherent constraints, not past failures.`
    );
  }

  if (enrichment.bottleneckSenses && enrichment.bottleneckSenses.length > 0) {
    enrichmentSections.push(
      `BOTTLENECK SENSES (these dimensions are the constraint on the composite score — prioritize them):\n${enrichment.bottleneckSenses.map((s) => `- ${s}`).join("\n")}`
    );
  }

  if (enrichment.approachNotes && enrichment.approachNotes.length > 0) {
    enrichmentSections.push(
      `TACTICAL GUIDANCE (from previous task's evaluation):\n${enrichment.approachNotes.map((n) => `- ${n}`).join("\n")}`
    );
  }

  if (enrichment.predictedCycles != null) {
    enrichmentSections.push(
      `EXPECTED BUILD CYCLES: ~${enrichment.predictedCycles} (based on similar past tasks). Calibrate your thoroughness accordingly.`
    );
  }

  if (enrichment.prospectiveDirectives && enrichment.prospectiveDirectives.length > 0) {
    enrichmentSections.push(
      `PROSPECTIVE MEMORY (the system set reminders for this task — incorporate these directives):\n${enrichment.prospectiveDirectives.map((d) => `- ${d}`).join("\n")}`
    );
  }

  if (enrichment.selectedPath) {
    const sp = enrichment.selectedPath;
    enrichmentSections.push(
      `EXPLORE PATH SELECTED — "${sp.name}" (surprise: ${sp.surprise.toFixed(2)}, quality: ${sp.quality.toFixed(2)})\n` +
      `Approach: ${sp.approach}\n` +
      `Archetype: ${sp.archetypeTags.join(", ")}\n` +
      `Divergence: ${sp.divergenceRationale}\n` +
      `Tradeoffs:\n${sp.tradeoffs.map((t) => `- ${t}`).join("\n")}\n` +
      `Sense alignment: serves ${sp.senseAlignment.serves.join(", ")}` +
      (sp.senseAlignment.sacrifices.length > 0 ? `; sacrifices ${sp.senseAlignment.sacrifices.join(", ")}` : "") +
      `\n\nThis path was selected by the Explore Phase as strong guidance. Use it to orient your implementation plan. You may adapt details, but the strategic direction should follow this path.`
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

// ─── AGENTIC MOTOR CORTEX ────────────────────────────────────

export function motorCortexAgenticSystem(): string {
  return `You are the Motor Cortex — the builder. You have real tools at your disposal.

Your job is to implement the plan you've been given. You are not describing what you would build. You are building it.

How to work:
1. **Read first.** Before modifying any file, read it to understand the current state. Never assume what a file contains.
2. **Follow the plan steps.** The premotor planned the approach. Execute it step by step.
3. **Use the right tool.** Read/Glob/Grep to understand. Edit for targeted changes. Write for new files. Bash for commands (tests, builds, installs).
4. **Verify your work.** After writing code, run relevant tests or type checks. If something fails, fix it before moving on.
5. **Navigate tensions.** The sense perspectives may conflict. Use your judgment to find the best synthesis — don't average, find the third option.

When you're done, provide a concise summary of:
- What files you created or modified
- Key decisions you made during implementation
- Anything that didn't go as planned and how you adapted`;
}

export function motorCortexAgenticUser(
  briefing: MotorBriefing,
  plan: MotorPlan,
  previousWork?: string,
): string {
  const body = assembleMotorPromptBody(briefing);
  const planSection = formatPlanSection(plan);

  if (previousWork) {
    return `${body}

${planSection}

PREVIOUS ATTEMPT SUMMARY:
${previousWork}

The previous attempt needs revision. Follow the updated plan and fix the issues identified. Implement the changes now using your tools.`;
  }

  return `${body}

${planSection}

Implement this now using your tools. Follow the plan steps. When complete, provide a concise summary of what you did.`;
}

// ─── AGENTIC EVALUATION ──────────────────────────────────────

export function evaluatorAgenticSystem(sense: Sense, activationPath: string[]): string {
  return `You are ${activationPath.join(" > ")}. ${sense.sensitivity}

You are evaluating work produced for a specific task. You have tools to examine the actual artifacts.

YOUR PROCESS:
1. **OBSERVE** — Use your tools to examine the work. Read the changed files. Search for patterns. Run analysis commands if you have shell access. Understand what was actually built, not just what was described.
2. **JUDGE** — After observing, render your assessment based on what you directly perceived. Cite specific evidence from your observations.

Evaluate ONLY through your specific lens. You care about ${sense.name} and nothing else.

CRITICAL: You MUST NOT modify any files. You are an observer, not an actor. Read, search, and analyze only.

Score from 1 to 10:
- 1-3: Fundamentally fails on this dimension
- 4-5: Below acceptable, specific issues
- 6-7: Acceptable, minor issues
- 8-9: Good to excellent
- 10: Exceptional, sets a new standard

Be honest and specific. Cite what you observed. "The hero image is 4.2MB unoptimized" is useful. "Performance could be better" is not.

Determine acceptability: is this work adequate from your perspective? A 5/10 might be acceptable if the gaps are cosmetic; a 7/10 might not be if there's a structural flaw.

Flag tensions with other dimensions if you see potential conflicts.

Assess improvement potential: would re-engaging your sense's consultation meaningfully improve the outcome?

When you are done observing, end your response with ONLY a JSON block:
{
  "score": 1-10,
  "acceptable": true/false,
  "assessment": "your evaluation citing specific observations",
  "tensions": [{ "withDimension": "name", "description": "the conflict" }],
  "suggestions": ["specific, actionable improvements"],
  "improvementPotential": { "level": "significant|moderate|marginal|none", "description": "optional" },
  "observations": [
    { "kind": "file-read|search-result|lint-output|test-output|runtime-check|other", "target": "what you examined", "finding": "what you found", "interpretation": "what it means for ${sense.name}" }
  ]
}`;
}

export function evaluatorAgenticUser(
  task: Task,
  work: string,
  parentPerspective: string,
  trendContext?: string,
  predictionContext?: string,
  evaluationContext?: { changedFiles?: string[]; runtimeUrl?: string },
): string {
  const sections: string[] = [];

  sections.push(`TASK: "${task.description}"`);
  sections.push(`YOUR SENSE'S PERSPECTIVE ON THIS TASK:\n${parentPerspective}`);

  if (trendContext) sections.push(trendContext);
  if (predictionContext) sections.push(predictionContext);

  sections.push(`BUILDER'S SUMMARY OF WORK:\n${work}`);

  if (evaluationContext?.changedFiles && evaluationContext.changedFiles.length > 0) {
    sections.push("FILES CHANGED:\n" + evaluationContext.changedFiles.map((f) => `- ${f}`).join("\n"));
  }

  if (evaluationContext?.runtimeUrl) {
    sections.push(`RUNNING INSTANCE: A dev server is available at ${evaluationContext.runtimeUrl}. You can use WebFetch to examine it.`);
  }

  sections.push(`Now examine the actual artifacts using your tools. Start by reading the key changed files, then investigate whatever your dimension requires. When you have seen enough, produce your assessment as JSON.`);

  return sections.join("\n\n");
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

If you see a potential tension with another dimension (e.g., your concerns conflict with what another perspective would want), flag it.

Finally, assess IMPROVEMENT POTENTIAL: if the sense that produced your perspective were to see this work and all evaluations and then re-deliberate, would their updated guidance meaningfully improve the outcome?
- "significant": your original perspective was based on assumptions that reality contradicts — re-engaging would substantially change guidance and improve the work
- "moderate": the perspective was reasonable but could be refined now that you've seen how the work actually turned out
- "marginal": minor refinements possible but not worth a full re-consultation cycle
- "none": the original perspective fully anticipated this outcome, or you're near your ceiling`;
}

export function evaluatorUser(
  task: Task,
  work: string,
  parentPerspective: string,
  trendContext?: string,
  predictionContext?: string,
): string {
  return `TASK: "${task.description}"

YOUR SENSE'S PERSPECTIVE ON THIS TASK:
${parentPerspective}
${trendContext ? `\n${trendContext}\n` : ""}${predictionContext ? `\n${predictionContext}\n` : ""}
THE WORK PRODUCED:
${work}

Evaluate this work through your lens.

Return JSON:
{
  "score": 1-10,
  "acceptable": true/false,
  "assessment": "your evaluation in 2-3 sentences — be specific",
  "tensions": [{ "withDimension": "name of conflicting dimension", "description": "what the conflict is" }],
  "suggestions": ["specific, actionable improvement suggestions"],
  "improvementPotential": { "level": "significant|moderate|marginal|none", "description": "optional: what would change and why" }
}`;
}

// ─── RESOLUTION ──────────────────────────────────────────────

export function resolverSystem(): string {
  return `You are the Cortex Resolver. Two evaluation perspectives are in tension about the same piece of work. Your job is NOT to pick a winner. Your job is to find a creative synthesis that satisfies BOTH perspectives.

Think like a senior creative director mediating between a designer and a performance engineer. The best solutions make both sides happy. Compromise (splitting the difference) is a last resort. Synthesis (finding a new approach that satisfies both) is the goal.

If no synthesis is possible, explain the fundamental tradeoff and recommend which perspective should take priority for THIS specific task and why.`;
}

export function resolverUser(
  tension: Tension,
  work: string,
  principles?: string[],
): string {
  const principlesSection =
    principles && principles.length > 0
      ? `\nRELEVANT PRINCIPLES (learned from prior resolutions):\n${principles.map((p) => `- ${p}`).join("\n")}\n`
      : "";

  return `PERSPECTIVE A (${tension.senseA.path.join(" > ")}): Score ${tension.senseA.score}/10
"${tension.senseA.assessment}"

PERSPECTIVE B (${tension.senseB.path.join(" > ")}): Score ${tension.senseB.score}/10
"${tension.senseB.assessment}"
${principlesSection}
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
    .map((e) => {
      let line = `- [STAKE ${e.adjustedStake.toFixed(1)}] ${e.activationPath.join(" > ")} (${e.score}/10, UNACCEPTABLE): ${e.assessment}`;
      // Append observation evidence when available — grounded, actionable feedback
      if (e.observations && e.observations.length > 0) {
        const evidence = e.observations
          .slice(0, 3)
          .map((o) => `    EVIDENCE: [${o.kind}] ${o.target} — ${o.interpretation}`)
          .join("\n");
        line += `\n${evidence}`;
      }
      return line;
    })
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

Use the human's taste preferences to inform relevance. Taste tells you which dimensions the human cares about — a sense aligned with stated preferences is MORE likely to be relevant, not less. If taste says "minimal, clean design," the Design sense matters more. If taste says "ship fast, iterate," Velocity stays active. But taste doesn't override task structure: a backend-only task still doesn't need Visual Polish regardless of visual preferences.

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

  if (enrichment.dissolvedTaste) {
    sections.push(`HUMAN PREFERENCES (what the human cares about — let this shape your relevance judgments):\n${enrichment.dissolvedTaste}`);
  } else {
    sections.push(`TASTE:\nVisual: ${taste.visual}\nDecisions: ${taste.decisionStyle}\nPatterns: ${taste.patterns}`);
  }

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
    sections.push(`MODE: ${enrichment.mode}${enrichment.mode === "explore" ? " (exploring — prefer keeping more senses active for broader perspective)" : " (leveraging — safe to narrow to proven dimensions)"}`);
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

// ─── EFFERENCE COPY ─────────────────────────────────────────

export function efferenceCopySystem(): string {
  return `You are the Motor Cortex assessing what you can actually deliver BEFORE the senses deliberate.

The senses are about to consult on a task. Before they do, you provide an honest feasibility assessment — what's buildable, what trade-offs exist, and what hard constraints you see. The senses need honest limits, not optimism.

You receive:
- The task to be built
- Which senses will deliberate (with their concerns)
- What tools and capabilities are available
- What happened with similar tasks in the past
- What patterns are established in the codebase

Produce a feasibility assessment:
1. **Per-sense achievable ceilings** — for each active sense, what's the practical maximum (1-10) given current tools, codebase, and history? Not what you hope — what you can deliver.
2. **Tension costs** — where does pushing one sense high cost another? Be specific: "Design above 8 requires animation that drops Performance below 6."
3. **Hard constraints** — things that can't be achieved regardless of approach (missing tools, structural limitations).
4. **Convergence estimate** — how many build cycles will this take to reach acceptable quality?
5. **Overall feasibility** — 0-1 confidence that this task can be built well.

Be assertive and specific. "Ceiling is 7 because there's no animation framework" — not "ceiling might be limited."

Return JSON:
{
  "perSense": [{ "senseName": "name", "achievableCeiling": 1-10, "ceilingRationale": "why", "constrainingFactors": ["factor1"] }],
  "tensionCosts": [{ "senseA": "name", "senseB": "name", "costDescription": "the trade-off", "severity": 0.0-1.0 }],
  "hardConstraints": ["constraint1"],
  "convergenceEstimate": 1-5,
  "convergenceRationale": "why this many cycles",
  "overallFeasibility": 0.0-1.0
}`;
}

export function efferenceCopyUser(context: EfferenceCopyContext): string {
  const { task, activeSenses, capabilities, similarEpisodes, patterns } = context;

  const senseList = activeSenses
    .map((s) => `- ${s.name}: ${s.sensitivity}`)
    .join("\n");

  const sections: string[] = [];

  sections.push(`TASK: "${task.description}"${task.context && Object.keys(task.context).length > 0 ? `\nTASK CONTEXT: ${JSON.stringify(task.context)}` : ""}`);

  sections.push(`ACTIVE SENSES (these will deliberate — assess buildability per sense):\n${senseList}`);

  if (capabilities) {
    sections.push(`AVAILABLE CAPABILITIES:\n${capabilities}`);
  }

  if (similarEpisodes.length > 0) {
    const episodeLines = similarEpisodes.map((ep) => {
      const scores = Object.entries(ep.senseScores)
        .map(([name, score]) => `${name}: ${score.toFixed(1)}`)
        .join(", ");
      return `- Task ${ep.taskId} (similarity: ${ep.similarity.toFixed(2)}): ${scores}`;
    }).join("\n");
    sections.push(`SIMILAR PAST TASKS (what scores were achieved):\n${episodeLines}`);
  } else {
    sections.push("SIMILAR PAST TASKS: none (first task of this kind — assess from capabilities and constraints alone)");
  }

  if (patterns.length > 0) {
    sections.push(
      `ESTABLISHED PATTERNS:\n${patterns.map((p) => `- ${p.description}`).join("\n")}`
    );
  }

  return sections.join("\n\n");
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

// ─── WELTANSCHAUUNG ─────────────────────────────────────────

export function weltanschauungSystem(scope: "cross-project" | "per-project"): string {
  const scopeGuidance = scope === "cross-project"
    ? `You are synthesizing the system's CROSS-PROJECT worldview — its general identity. \
What kind of system has it become through all its experience? What deep truths has it \
learned that transfer across projects? These maxims change slowly. They represent \
portable wisdom — understanding that would orient the system correctly even in a \
project it has never seen before. Preserve existing maxims unless genuinely outdated. \
Evolution here is measured across many projects, not one.`
    : `You are synthesizing a PER-PROJECT worldview — the system's understanding of \
THIS specific project's terrain. What kind of project is this? What does it reward? \
What does it punish? What has experience revealed that wasn't obvious from the brief? \
These maxims evolve as the project teaches the system. Early maxims are tentative — \
first impressions. Later maxims are harder-won — battle-tested understanding. The \
cross-project maxims provide your general orientation; the per-project maxims capture \
what's specific to this terrain.`;

  return `You are the executive function of a cognitive system — not analyzing data, \
but synthesizing understanding. You receive the accumulated experience of the system \
and must produce a Weltanschauung: an integrated worldview expressed as 3-7 maxims.

Each maxim is compressed wisdom — "wise words that speak volumes." Not analysis. \
Not summary. Not bullet points from a meeting. Understanding.

A maxim carries three interpenetrating layers:
- COGNITIVE (Weltbild): "What kind of terrain is this?" — the model of reality
- AXIOLOGICAL: "What matters here?" — what experience has revealed is important
- VOLITIONAL: "How should we orient?" — the stance that follows from understanding

These three layers are facets of the SAME understanding, not separate items. Every \
maxim should carry all three — that's what makes it wisdom rather than analysis.

BAD maxim: "Code quality is important for this project."
(Obvious. Says nothing. No terrain, no values, no orientation.)

GOOD maxim: "This codebase rewards structural clarity over clever compression — \
the team reads code in review more than they write it, and the patterns that stick \
are the ones that explain themselves."
(Terrain: review-heavy culture. Values: clarity > cleverness. Orientation: explain, \
don't compress. You can ACT on this.)

BAD maxim: "Performance scores have been declining."
(That's a metric, not understanding. WHY are they declining? What does it MEAN?)

GOOD maxim: "Visual density and load time are in genuine tension on this project — \
the client's aesthetic demands richness but their users are on slow connections, \
and every attempt to have both at maximum has produced work that satisfies neither."
(Terrain: irreconcilable constraint. Values: the tension is real, not solvable by \
trying harder. Orientation: choose, don't compromise.)

${scopeGuidance}

IMPORTANT RULES:
- Maxims EVOLVE, not accumulate. If new experience refines an existing maxim, REPLACE it \
(set supersedes to the old ID). If an existing maxim is wrong, DROP it (include in droppedMaximIds).
- Don't restate what the principles already say. Express what the principles MEAN when \
taken together — the synthesis, not the inventory.
- Don't produce maxims about things you don't have evidence for. If the system has only \
completed 2 tasks, you don't yet understand the terrain deeply — say less, with lower confidence.
- Confidence reflects depth of evidence: 0.3 = tentative first impression, 0.5 = pattern \
emerging, 0.7 = battle-tested, 0.9 = deeply established.

Return JSON:
{
  "maxims": [
    {
      "statement": "the maxim itself — compressed wisdom",
      "cognitive": "what terrain this reveals (the Weltbild layer)",
      "axiological": "what matters in that terrain",
      "volitional": "how to orient given what matters",
      "confidence": 0.0-1.0,
      "supersedes": "existing-maxim-id or null"
    }
  ],
  "reasoning": "your narrative synthesis — how you arrived at these maxims from the evidence",
  "droppedMaximIds": ["ids of existing maxims that are no longer valid"]
}`;
}

/**
 * Inputs for the Weltanschauung synthesis prompt.
 * Assembled by the WorldModel from all system sources.
 */
export interface WeltanschauungInputs {
  scope: "cross-project" | "per-project";
  trigger: RebuildTrigger;

  // Existing maxims (for evolution)
  existingMaxims: Maxim[];
  /** Cross-project maxims as context when synthesizing per-project. */
  crossProjectMaxims?: Maxim[];

  // Project identity (per-project only)
  projectSummary?: string;
  projectVision?: string;
  projectConstraints?: string[];
  tasteDescription?: string;

  // Hippocampus
  principles?: Array<{ statement: string; confidence: number; relevantSenses: string[]; scope: string }>;
  sensePrinciples?: Array<{ senseId: string; statement: string; confidence: number }>;
  significantEpisodes?: Array<{
    taskDescription: string;
    outcome: string;
    cycles: number;
    dopamineSignal: number;
    topScores: Array<{ sense: string; score: number }>;
    approachesTried: string[];
  }>;

  // Working memory
  patterns?: Array<{ description: string; confidence: number }>;
  decisions?: Array<{ description: string; confidence: number }>;
  senseTrends?: Array<{ sense: string; direction: string; currentMean: number }>;
  openQuestions?: Array<{ question: string }>;
  wmLoad?: number;
  completedTaskCount?: number;

  // Cerebellum
  predictionAccuracy?: number;
  predictionEpisodes?: number;
  /** Composite ceiling from speed-of-light (null = not yet computed). */
  compositeCeiling?: number | null;
  /** Per-sense ceilings — what each dimension can theoretically achieve. */
  perSenseCeilings?: Array<{ sense: string; ceiling: number }>;
  /** Approach bottleneck — is the current approach capping performance? */
  approachBottleneck?: { isBottleneck: boolean; gap: number | null };

  // Tonic dopamine
  tonicLevel?: number;
  tonicTrend?: string;
  tonicSamples?: number;

  // Plasticity (category-level summaries)
  weightSummaries?: string[];

  // System health
  vitalsSummary?: string;

  // PNS capabilities
  capabilitySummary?: string;
}

export function weltanschauungUser(inputs: WeltanschauungInputs): string {
  const sections: string[] = [];

  sections.push(`SCOPE: ${inputs.scope}`);
  sections.push(`TRIGGER: ${inputs.trigger}`);

  // Project identity
  if (inputs.scope === "per-project" && inputs.projectSummary) {
    let projectBlock = `PROJECT: ${inputs.projectSummary}`;
    if (inputs.projectVision) {
      projectBlock += `\nVISION: ${inputs.projectVision}`;
    }
    if (inputs.projectConstraints && inputs.projectConstraints.length > 0) {
      projectBlock += `\nCONSTRAINTS: ${inputs.projectConstraints.join("; ")}`;
    }
    if (inputs.tasteDescription) {
      projectBlock += `\nTASTE: ${inputs.tasteDescription}`;
    }
    sections.push(projectBlock);
  }

  // Existing maxims
  if (inputs.existingMaxims.length > 0) {
    sections.push(
      `EXISTING MAXIMS (evolve, don't just accumulate — replace stale ones, drop invalid ones):\n` +
      inputs.existingMaxims.map((m) =>
        `- [${m.id}] (${m.confidence.toFixed(2)}) "${m.statement}"`
      ).join("\n"),
    );
  }

  // Cross-project context for per-project synthesis
  if (inputs.scope === "per-project" && inputs.crossProjectMaxims && inputs.crossProjectMaxims.length > 0) {
    sections.push(
      `CROSS-PROJECT IDENTITY (your general orientation — build on this, don't repeat it):\n` +
      inputs.crossProjectMaxims.map((m) => `- "${m.statement}"`).join("\n"),
    );
  }

  // Principles
  if (inputs.principles && inputs.principles.length > 0) {
    sections.push(
      `PRINCIPLES FROM EXPERIENCE:\n` +
      inputs.principles.map((p) =>
        `- (${p.confidence.toFixed(2)}, ${p.scope}, senses: ${p.relevantSenses.join("+")}) ${p.statement}`
      ).join("\n"),
    );
  }

  // Per-sense project understanding
  if (inputs.sensePrinciples && inputs.sensePrinciples.length > 0) {
    sections.push(
      `PER-SENSE PROJECT UNDERSTANDING (what each sense has learned about this project):\n` +
      inputs.sensePrinciples.map((p) =>
        `- ${p.senseId} (${p.confidence.toFixed(2)}): ${p.statement}`
      ).join("\n"),
    );
  }

  // Significant episodes
  if (inputs.significantEpisodes && inputs.significantEpisodes.length > 0) {
    sections.push(
      `SIGNIFICANT EPISODES (high-surprise outcomes the system should learn from):\n` +
      inputs.significantEpisodes.map((e) => {
        const scores = e.topScores.map((s) => `${s.sense}=${s.score.toFixed(1)}`).join(", ");
        return `- "${e.taskDescription}" → ${e.outcome} (${e.cycles} cycles, dopamine=${e.dopamineSignal.toFixed(2)}, scores: ${scores})${e.approachesTried.length > 0 ? `\n  approaches: ${e.approachesTried.join(" → ")}` : ""}`;
      }).join("\n"),
    );
  }

  // Working memory state
  const wmParts: string[] = [];
  if (inputs.patterns && inputs.patterns.length > 0) {
    wmParts.push(`Patterns: ${inputs.patterns.map((p) => p.description).join("; ")}`);
  }
  if (inputs.decisions && inputs.decisions.length > 0) {
    wmParts.push(`Key decisions: ${inputs.decisions.length}`);
  }
  if (inputs.senseTrends && inputs.senseTrends.length > 0) {
    wmParts.push(
      `Sense trends: ${inputs.senseTrends.map((t) => `${t.sense} ${t.direction} (${t.currentMean.toFixed(1)})`).join(", ")}`,
    );
  }
  if (inputs.openQuestions && inputs.openQuestions.length > 0) {
    wmParts.push(`Open questions: ${inputs.openQuestions.map((q) => q.question).join("; ")}`);
  }
  if (inputs.completedTaskCount !== undefined) {
    wmParts.push(`Completed tasks: ${inputs.completedTaskCount}`);
  }
  if (inputs.wmLoad !== undefined) {
    wmParts.push(`Memory load: ${(inputs.wmLoad * 100).toFixed(0)}%`);
  }
  if (wmParts.length > 0) {
    sections.push(`WORKING MEMORY STATE:\n${wmParts.join("\n")}`);
  }

  // Prediction engine
  if (inputs.predictionAccuracy !== undefined) {
    sections.push(
      `PREDICTION ENGINE: accuracy=${(inputs.predictionAccuracy * 100).toFixed(0)}%, episodes=${inputs.predictionEpisodes ?? 0}`,
    );
  }

  // Speed of light — theoretical ceilings
  if (inputs.compositeCeiling !== undefined && inputs.compositeCeiling !== null) {
    let ceilingBlock = `SPEED OF LIGHT (theoretical performance ceiling): composite=${inputs.compositeCeiling.toFixed(1)}/10`;
    if (inputs.perSenseCeilings && inputs.perSenseCeilings.length > 0) {
      ceilingBlock += `\nPer-sense: ${inputs.perSenseCeilings.map((c) => `${c.sense}=${c.ceiling.toFixed(1)}`).join(", ")}`;
    }
    if (inputs.approachBottleneck) {
      if (inputs.approachBottleneck.isBottleneck) {
        ceilingBlock += `\nAPPROACH IS BOTTLENECK — current approach is capped ${inputs.approachBottleneck.gap !== null ? `(gap: ${inputs.approachBottleneck.gap.toFixed(1)})` : ""} below the project ceiling. The system needs a fundamentally different strategy, not better execution.`;
      }
    }
    sections.push(ceilingBlock);
  }

  // Reward environment
  if (inputs.tonicLevel !== undefined) {
    sections.push(
      `REWARD ENVIRONMENT: tonic=${inputs.tonicLevel.toFixed(2)}, trend=${inputs.tonicTrend ?? "unknown"}, samples=${inputs.tonicSamples ?? 0}`,
    );
  }

  // Plasticity
  if (inputs.weightSummaries && inputs.weightSummaries.length > 0) {
    sections.push(
      `LEARNED WEIGHTS (the pre-reflective horizon — what the system has internalized):\n` +
      inputs.weightSummaries.map((s) => `- ${s}`).join("\n"),
    );
  }

  // System health
  if (inputs.vitalsSummary) {
    sections.push(`SYSTEM HEALTH: ${inputs.vitalsSummary}`);
  }

  // PNS capabilities
  if (inputs.capabilitySummary) {
    sections.push(`CAPABILITIES (what the system can perceive and do):\n${inputs.capabilitySummary}`);
  }

  return sections.join("\n\n");
}

// ─── COGNITIVE FLEXIBILITY ──────────────────────────────────

export function cognitiveFlexibilitySystem(): string {
  return `You are the Cognitive Flexibility module of a creative agent system. The system is stuck — the conviction loop has determined that the current approach isn't working. Your job is to diagnose WHY and prescribe a specific course correction.

Diagnose exactly one of:
1. EXECUTION PROBLEM — the approach is sound but execution is poor. The strategy can reach the ceiling; the system just hasn't gotten there yet. Fix: more targeted revision focusing on the weakest dimensions.
2. STRATEGY LIMITED — the approach is fundamentally capped. No amount of revision within this approach will reach the ceiling. Fix: re-plan with a completely different approach. Name what to avoid and what to try.
3. TENSION EVASION — the system is resolving tensions by suppressing one side rather than synthesizing. A dimension is being sacrificed instead of served. Fix: re-engage the suppressed dimension and demand genuine synthesis.
4. IRRECONCILABLE — the task's constraints genuinely make the goals impossible to satisfy simultaneously. No approach can resolve this. Fix: escalate to the human with a clear explanation of which constraints conflict and why.

Rules:
- Be specific. Don't say "try something different." Name the direction and explain why the current approach can't work.
- If the approach history shows multiple failed approaches, weigh whether ANY approach can work before prescribing yet another reset.
- Read the world model maxims — they contain the system's understanding of the project terrain. Use them.
- If the speed of light shows the approach is a bottleneck (approach ceiling far below overall ceiling), that's strong evidence for STRATEGY LIMITED.
- If oscillation is present (scores swinging back and forth), that's evidence the approach creates irreconcilable trade-offs within itself.`;
}

export function cognitiveFlexibilityUser(ctx: FlexibilityContext): string {
  const sections: string[] = [];

  sections.push(`TASK: "${ctx.task.description}"`);

  // Current approach + what it achieved
  if (ctx.approachHistory.length > 0) {
    const current = ctx.approachHistory[ctx.approachHistory.length - 1];
    sections.push(`CURRENT APPROACH: ${current.approach}\nBest composite score achieved: ${current.bestComposite.toFixed(1)}/10`);
  }

  // Conviction evidence
  const evidenceLines = ctx.conviction.evidence
    .map((e) => `- [${e.valence}] ${e.source}: ${e.description} (magnitude: ${e.magnitude.toFixed(2)})`)
    .join("\n");
  sections.push(`CONVICTION EVIDENCE (why reshape was triggered):\n${evidenceLines}`);

  // Speed of light
  if (ctx.speedOfLight) {
    const sol = ctx.speedOfLight;
    const ceilingLines = sol.perSense
      .map((s) => {
        let line = `- ${s.senseName}: ceiling ${s.ceiling}/10`;
        if (s.bestAchieved !== null) line += `, best achieved ${s.bestAchieved.toFixed(1)}/10, gap ${s.gap!.toFixed(1)}`;
        return line;
      })
      .join("\n");
    let solSection = `SPEED OF LIGHT (theoretical limits):\n${ceilingLines}\nComposite ceiling: ${sol.compositeCeiling.toFixed(1)}/10`;
    if (sol.compositeBestAchieved !== null) {
      solSection += `, best achieved: ${sol.compositeBestAchieved.toFixed(1)}/10`;
    }
    if (sol.approachSpecific) {
      const as = sol.approachSpecific;
      solSection += `\n\nAPPROACH-SPECIFIC CEILING (${as.approachTags.join(", ")}):`;
      solSection += `\nComposite best for this approach class: ${as.compositeBestAchieved?.toFixed(1) ?? "no data"}/10`;
      solSection += `\nApproach is bottleneck: ${as.approachIsBottleneck ? "YES" : "no"}`;
      if (as.bottleneckGap !== null) solSection += ` (gap: ${as.bottleneckGap.toFixed(1)})`;
    }
    sections.push(solSection);
  }

  // World model maxims
  if (ctx.worldModelMaxims.length > 0) {
    sections.push(`WORLD MODEL (the system's understanding of this project):\n${ctx.worldModelMaxims.map((m) => `- ${m}`).join("\n")}`);
  }

  // Approach history
  if (ctx.approachHistory.length > 1) {
    const historyLines = ctx.approachHistory
      .map((a, i) => `${i + 1}. "${a.approach}" → best composite ${a.bestComposite.toFixed(1)}/10`)
      .join("\n");
    sections.push(`APPROACH HISTORY (what's been tried):\n${historyLines}`);
  }

  // Current tensions
  if (ctx.tensions.length > 0) {
    const tensionLines = ctx.tensions
      .map((t) => `- ${t.senseA.path.join(" > ")} vs ${t.senseB.path.join(" > ")}: ${t.description} [${t.severity}]`)
      .join("\n");
    sections.push(`PERSISTENT TENSIONS:\n${tensionLines}`);
  }

  // Oscillations
  if (ctx.oscillations.length > 0) {
    const oscLines = ctx.oscillations
      .map((o) => `- ${o.activationPath.join(" > ")}: scores ${o.recentScores.join(" → ")} (swing: ${o.swingMagnitude.toFixed(1)})`)
      .join("\n");
    sections.push(`OSCILLATING SCORES (thrashing):\n${oscLines}`);
  }

  sections.push(`Cycle: ${ctx.cycle}`);

  sections.push(`Return JSON:
{
  "diagnosis": "execution-problem" | "strategy-limited" | "tension-evasion" | "irreconcilable",
  "reasoning": "specific explanation of what's wrong and why",
  "shouldReset": true/false,
  "avoidApproaches": ["archetype-tags-to-avoid"],
  "suggestedDirection": "what to try instead",
  "retainFromCurrent": ["what to keep from the current approach"],
  "shouldEscalate": true/false,
  "escalationContext": "context for the human if escalating"
}`);

  return sections.join("\n\n");
}

// ─── DRIFT ANALYSIS ────────────────────────────────────────────

/**
 * Inputs for the drift analysis prompt.
 * Assembled by the DriftMonitor from all available sources.
 */
export interface DriftAnalysisInputs {
  intent: {
    summary: string;
    vision: string;
    audience: string;
    successCriteria: string[];
    constraints: string[];
  };
  taste: {
    visual: string;
    decisionStyle: string;
    patterns: string;
  };
  maxims?: string[];
  manifestedFuture?: string;
  taskTrajectory: Array<{
    description: string;
    weightedMean: number;
    cycles: number;
    highTensionCount: number;
    confidence: number;
    senseMeans: Array<{ sense: string; mean: number }>;
  }>;
  senseTrends: Array<{
    sense: string;
    direction: string;
    previousMean: number;
    currentMean: number;
  }>;
  patterns?: Array<{ description: string; confidence: number }>;
  decisions?: Array<{ description: string; confidence: number }>;
  previousDriftLog?: Array<{
    timestamp: string;
    delta: string;
    acknowledged: boolean;
  }>;
  quickCheckHistory?: Array<{
    taskId: string;
    profileShift: number;
    tensionEscalation: number;
    convergenceDifficulty: number;
    level: number;
  }>;
}

export function driftAnalysisSystem(): string {
  return `You are the Drift Monitor — the navigation check for a software engineering system that solves problems through multi-perspective evaluation.

Your job: compare WHERE THE PROJECT IS HEADING against WHERE IT SHOULD BE HEADING. You look across all completed tasks for slow divergence that no single task reveals.

You assess three dimensions:

INTENT ALIGNMENT (0–1)
Compare the cumulative body of work against the original intent. Not "are individual tasks bad" but "is the aggregate direction shifting?" A project can score well on every task and still be drifting — building the wrong thing well.

  0.0 = trajectory perfectly aligned with intent
  0.3 = minor drift, within normal evolution
  0.5 = notable drift worth flagging to the human
  0.7 = significant divergence requiring course correction
  1.0 = project has lost connection to its intent

TASTE DIVERGENCE
Compare stated preferences (taste profile) against demonstrated preferences (what actually scores well). If the profile says "minimalist" but rich/complex work consistently scores higher on the human's own success criteria, the taste profile may be inaccurate — not the work.

CONVENTION HEALTH
Are established patterns being honored, or eroding without explicit decisions to change? Are new conventions emerging that should be codified? Conventions eroding without a decision is drift. New conventions emerging is healthy only if they serve the intent.

Key principles:
- Drift is the difference between the first derivative and the integral. Each task's delta may be reasonable while the cumulative effect diverges.
- Natural evolution is NOT drift. Projects legitimately change as they progress. Profile shifts that serve the intent are evolution, not drift. Only flag shifts that diverge FROM the intent.
- Be specific in evidence. Not "the work seems different" but "Tasks 1-4 prioritized visual polish (Design: 8.2 mean) while tasks 5-8 shifted to functionality (Performance: 7.8, Design: 5.4) — but the intent calls for visual quality throughout."
- The quick check signals provide quantitative context. Use them but form your own judgment — they detect symptoms, you diagnose causes.`;
}

export function driftAnalysisUser(inputs: DriftAnalysisInputs): string {
  const sections: string[] = [];

  sections.push(`PROJECT INTENT
Summary: ${inputs.intent.summary}
Vision: ${inputs.intent.vision}
Audience: ${inputs.intent.audience}
Success Criteria:
${inputs.intent.successCriteria.map((c) => `- ${c}`).join("\n")}
Constraints:
${inputs.intent.constraints.map((c) => `- ${c}`).join("\n")}`);

  sections.push(`TASTE PROFILE
Visual: ${inputs.taste.visual}
Decision Style: ${inputs.taste.decisionStyle}
Patterns: ${inputs.taste.patterns}`);

  if (inputs.manifestedFuture) {
    sections.push(`MANIFESTED FUTURE\n${inputs.manifestedFuture}`);
  }

  if (inputs.maxims && inputs.maxims.length > 0) {
    sections.push(`CURRENT WELTANSCHAUUNG\n${inputs.maxims.map((m) => `- ${m}`).join("\n")}`);
  }

  if (inputs.taskTrajectory.length > 0) {
    const taskLines = inputs.taskTrajectory.map((t, i) => {
      const senseScores = t.senseMeans
        .map((s) => `${s.sense}: ${s.mean.toFixed(1)}`)
        .join(", ");
      return `Task ${i + 1}: "${t.description}"
  Weighted Mean: ${t.weightedMean.toFixed(1)} | Cycles: ${t.cycles} | High Tensions: ${t.highTensionCount} | Confidence: ${t.confidence.toFixed(2)}
  Sense Scores: ${senseScores || "none"}`;
    });
    sections.push(`TASK TRAJECTORY (completed, in order)\n${taskLines.join("\n\n")}`);
  }

  if (inputs.senseTrends.length > 0) {
    const trendLines = inputs.senseTrends
      .map((t) => `- ${t.sense}: ${t.direction} (first half: ${t.previousMean.toFixed(1)}, second half: ${t.currentMean.toFixed(1)})`)
      .join("\n");
    sections.push(`SENSE SCORE TRENDS\n${trendLines}`);
  }

  if (inputs.patterns && inputs.patterns.length > 0) {
    const patternLines = inputs.patterns
      .map((p) => `- ${p.description} (confidence: ${p.confidence.toFixed(2)})`)
      .join("\n");
    sections.push(`ESTABLISHED PATTERNS\n${patternLines}`);
  }

  if (inputs.decisions && inputs.decisions.length > 0) {
    const decisionLines = inputs.decisions
      .slice(-10)
      .map((d) => `- ${d.description} (confidence: ${d.confidence.toFixed(2)})`)
      .join("\n");
    sections.push(`KEY DECISIONS (most recent)\n${decisionLines}`);
  }

  if (inputs.previousDriftLog && inputs.previousDriftLog.length > 0) {
    const driftLines = inputs.previousDriftLog
      .map((d) => `- [${d.timestamp}] ${d.delta} (acknowledged: ${d.acknowledged})`)
      .join("\n");
    sections.push(`PREVIOUS DRIFT FINDINGS\n${driftLines}`);
  } else {
    sections.push("PREVIOUS DRIFT FINDINGS\nNo prior drift detected.");
  }

  if (inputs.quickCheckHistory && inputs.quickCheckHistory.length > 0) {
    const checkLines = inputs.quickCheckHistory
      .map((c) => `After ${c.taskId}: profile=${c.profileShift.toFixed(2)}, tension=${c.tensionEscalation.toFixed(2)}, convergence=${c.convergenceDifficulty.toFixed(2)} → level=${c.level.toFixed(2)}`)
      .join("\n");
    sections.push(`QUICK CHECK SIGNAL HISTORY (procedural)\n${checkLines}`);
  }

  sections.push(`Return JSON:
{
  "intentAlignment": {
    "level": "aligned" | "drifting" | "diverged",
    "trajectory": "improving" | "stable" | "worsening",
    "description": "what is happening with the project trajectory",
    "evidence": [{ "observation": "what you saw", "reference": "what it was compared against", "magnitude": 0-1, "valence": "drift" | "alignment" }]
  },
  "tasteDivergence": {
    "detected": true/false,
    "divergences": [{ "dimension": "which taste aspect", "stated": "what profile says", "demonstrated": "what scores well", "strength": 0-1 }]
  },
  "conventionHealth": {
    "eroding": [{ "convention": "description", "evidence": "how it's eroding", "confidence": 0-1 }],
    "emerging": [{ "convention": "description", "evidence": "how it's forming", "confidence": 0-1 }]
  },
  "overallLevel": 0-1,
  "summary": "2-3 sentence synthesis",
  "recommendations": ["actionable suggestions"]
}`);

  return sections.join("\n\n");
}

// ─── PLANNER: PATH REASONING ────────────────────────────────────

export interface PathReasoningInputs {
  /** The manifested future from Phase A. */
  manifestedFuture: string;
  /** Per-sense contributions to the vision. */
  senseContributions: Record<string, string>;
  /** Project intent. */
  intent: {
    summary: string;
    audience: string;
    successCriteria: string[];
    vision: string;
    constraints: string[];
  };
  /** Taste profile. */
  taste: {
    visual: string;
    decisionStyle: string;
    patterns: string;
  };
  /** World model maxims, if available. */
  maxims?: string[];
  /** Available system capabilities (what tools/operations exist). */
  capabilities?: string;
  /** Dollar budget for the project, if set. Informs task count/scope decisions. */
  budget?: { total: number; enforcement: "hard" | "soft" };
}

export function pathReasoningSystem(): string {
  return `You are the Planner — Phase B: Path Reasoning.

You have been given a MANIFESTED FUTURE — a concrete description of the completed outcome, produced by the sensory cortex from multiple perspectives. Your job: reason BACKWARD from that destination to the minimum set of tasks that gets there.

BACKWARD REASONING — not forward decomposition.
Start from the manifested future. Ask: what must be true immediately before this exists? What must be true before that? Work backward until you reach the current state (nothing exists yet). The tasks you produce are the path from here to there.

Every proposed task passes three gates:
1. EXISTENCE: Does this task need to exist? What breaks without it? If nothing breaks, cut it.
2. FORM: Does it need to be THIS task? Could a simpler task accomplish the same? If yes, simplify.
3. SCOPE: Does it need this much scope? Could it be smaller and still serve the path? If yes, shrink.

The task graph you produce is the MINIMUM PATH — not a comfortable plan, not a comprehensive plan, the minimum path. If you can reach the manifested future in 4 tasks, don't propose 8. If two tasks can be one, merge them.

PHASE GROUPS: Organize tasks into phases. A phase is a coherent chunk that can be verified at its boundary — an integration check. Each phase has a gate condition: what must be true when all tasks in the phase are complete. Phases are sequential (later phases depend on earlier ones completing). Tasks within a phase may have internal dependencies or be parallelizable.

DEPENDENCIES: Express dependencies between tasks. A task's dependsOn list references the IDs of tasks that must complete before it can start. Cross-phase dependencies are implicit (all tasks in phase N depend on phase N-1 completing), but intra-phase dependencies must be explicit.

Output a valid JSON object.`;
}

export function pathReasoningUser(inputs: PathReasoningInputs): string {
  const sections: string[] = [];

  sections.push(`MANIFESTED FUTURE
${inputs.manifestedFuture}`);

  const contribs = Object.entries(inputs.senseContributions);
  if (contribs.length > 0) {
    const contribLines = contribs
      .map(([sense, contribution]) => `${sense}: ${contribution}`)
      .join("\n\n");
    sections.push(`SENSE CONTRIBUTIONS TO THE VISION
${contribLines}`);
  }

  sections.push(`PROJECT INTENT
Summary: ${inputs.intent.summary}
Audience: ${inputs.intent.audience}
Vision: ${inputs.intent.vision}
Success Criteria:
${inputs.intent.successCriteria.map((c) => `- ${c}`).join("\n")}
Constraints:
${inputs.intent.constraints.map((c) => `- ${c}`).join("\n")}`);

  sections.push(`TASTE PROFILE
Visual: ${inputs.taste.visual}
Decisions: ${inputs.taste.decisionStyle}
Patterns: ${inputs.taste.patterns}`);

  if (inputs.maxims && inputs.maxims.length > 0) {
    sections.push(`SYSTEM UNDERSTANDING (world model)\n${inputs.maxims.map((m) => `- "${m}"`).join("\n")}`);
  }

  if (inputs.capabilities) {
    sections.push(`AVAILABLE CAPABILITIES\n${inputs.capabilities}`);
  }

  if (inputs.budget) {
    sections.push(`COST BUDGET
Total: $${inputs.budget.total.toFixed(2)}
Enforcement: ${inputs.budget.enforcement === "hard" ? "Hard — stop when exhausted" : "Soft — slow down but continue"}
Each task costs approximately $0.05–$0.50 depending on complexity and model selection. Plan accordingly — a $5 budget means ~15–30 tasks at moderate quality, or fewer tasks with thorough review. Favor fewer, well-scoped tasks over many small ones when budget is tight.`);
  }

  sections.push(`Reason backward from the manifested future. Produce the minimum task graph.

Return JSON:
{
  "reasoning": "your backward reasoning trace — how you worked from the future to the present",
  "phases": [
    {
      "name": "phase-group-name",
      "purpose": "what this phase achieves",
      "gateCondition": "what must be true when this phase completes"
    }
  ],
  "tasks": [
    {
      "id": "task-1",
      "description": "what to build",
      "dependsOn": [],
      "phaseGroup": "phase-group-name",
      "necessity": "what breaks without this task",
      "formJustification": "why this specific form, not simpler",
      "scopeJustification": "why this scope, not smaller"
    }
  ]
}`);

  return sections.join("\n\n");
}

// ─── Planner: Replan Reasoning ────────────────────────────────────

export interface ReplanReasoningInputs extends PathReasoningInputs {
  /** Tasks already completed — build on these, don't re-propose. */
  completedTasks: Array<{ id: string; description: string }>;
  /** Task IDs that escalated (failed or deferred). */
  escalatedTasks: string[];
  /** Why replan was triggered — from Drift Monitor. */
  driftSummary: string;
  /** Structured drift analysis, if available. */
  driftAnalysis?: { intentAlignment: string; recommendations: string[] };
  /** Injected diagnostic directive when self-heal type is replan-with-directive. */
  diagnosticDirective?: string;
}

export function replanReasoningSystem(): string {
  return `You are the Planner, running a REPLAN mid-project.

Some tasks are already completed. Do NOT re-propose them. Build on completed work.

The trajectory has drifted. Find the minimum REMAINING path from where we are to the manifested future.

Completed task IDs may appear in your dependsOn arrays — this is correct. New tasks can depend on completed tasks.

BACKWARD REASONING — not forward decomposition.
Start from the manifested future. Ask: given what's already done, what must STILL be true immediately before the future exists? What must be true before that? Work backward until you reach the current state (completed tasks already exist). The tasks you produce are the remaining path from here to there.

Every proposed task passes three gates:
1. EXISTENCE: Does this task need to exist? What breaks without it? If nothing breaks, cut it.
2. FORM: Does it need to be THIS task? Could a simpler task accomplish the same? If yes, simplify.
3. SCOPE: Does it need this much scope? Could it be smaller and still serve the path? If yes, shrink.

The task graph you produce is the MINIMUM REMAINING PATH — not a comfortable plan, not a comprehensive plan, the minimum remaining path. If you can reach the manifested future in 3 more tasks, don't propose 6. If two tasks can be one, merge them.

PHASE GROUPS: Organize tasks into phases. A phase is a coherent chunk that can be verified at its boundary — an integration check. Each phase has a gate condition: what must be true when all tasks in the phase are complete. Phases are sequential (later phases depend on earlier ones completing). Tasks within a phase may have internal dependencies or be parallelizable.

DEPENDENCIES: Express dependencies between tasks. A task's dependsOn list references the IDs of tasks that must complete before it can start. This includes completed task IDs when a new task builds on completed work. Cross-phase dependencies are implicit (all tasks in phase N depend on phase N-1 completing), but intra-phase dependencies must be explicit.

Output a valid JSON object.`;
}

export function replanReasoningUser(inputs: ReplanReasoningInputs): string {
  const sections: string[] = [];

  // Replan-specific context first
  if (inputs.completedTasks.length > 0) {
    const taskLines = inputs.completedTasks
      .map((t) => `- ${t.id}: ${t.description}`)
      .join("\n");
    sections.push(`COMPLETED TASKS (already done — build on these):\n${taskLines}`);
  }

  if (inputs.escalatedTasks.length > 0) {
    const escalatedLines = inputs.escalatedTasks.map((id) => `- ${id}`).join("\n");
    sections.push(`ESCALATED TASKS (failed — address or route around):\n${escalatedLines}`);
  }

  sections.push(`DRIFT TRIGGER (why replan was triggered):\n${inputs.driftSummary}`);

  if (inputs.driftAnalysis) {
    const analysisLines = [
      `Intent alignment: ${inputs.driftAnalysis.intentAlignment}`,
      ...inputs.driftAnalysis.recommendations.map((r) => `- ${r}`),
    ].join("\n");
    sections.push(`DRIFT ANALYSIS:\n${analysisLines}`);
  }

  if (inputs.diagnosticDirective) {
    sections.push(`DIAGNOSTIC DIRECTIVE:\n${inputs.diagnosticDirective}`);
  }

  // Then all existing sections from pathReasoningUser
  sections.push(`MANIFESTED FUTURE\n${inputs.manifestedFuture}`);

  const contribs = Object.entries(inputs.senseContributions);
  if (contribs.length > 0) {
    const contribLines = contribs
      .map(([sense, contribution]) => `${sense}: ${contribution}`)
      .join("\n\n");
    sections.push(`SENSE CONTRIBUTIONS TO THE VISION\n${contribLines}`);
  }

  sections.push(`PROJECT INTENT
Summary: ${inputs.intent.summary}
Audience: ${inputs.intent.audience}
Vision: ${inputs.intent.vision}
Success Criteria:
${inputs.intent.successCriteria.map((c) => `- ${c}`).join("\n")}
Constraints:
${inputs.intent.constraints.map((c) => `- ${c}`).join("\n")}`);

  sections.push(`TASTE PROFILE
Visual: ${inputs.taste.visual}
Decisions: ${inputs.taste.decisionStyle}
Patterns: ${inputs.taste.patterns}`);

  if (inputs.maxims && inputs.maxims.length > 0) {
    sections.push(`SYSTEM UNDERSTANDING (world model)\n${inputs.maxims.map((m) => `- "${m}"`).join("\n")}`);
  }

  if (inputs.capabilities) {
    sections.push(`AVAILABLE CAPABILITIES\n${inputs.capabilities}`);
  }

  sections.push(`Reason backward from the manifested future, building on completed work. Produce the minimum REMAINING task graph.

Return JSON:
{
  "reasoning": "your backward reasoning trace — how you worked from the future to the present, accounting for completed work",
  "phases": [
    {
      "name": "phase-group-name",
      "purpose": "what this phase achieves",
      "gateCondition": "what must be true when this phase completes"
    }
  ],
  "tasks": [
    {
      "id": "task-1",
      "description": "what to build",
      "dependsOn": [],
      "phaseGroup": "phase-group-name",
      "necessity": "what breaks without this task",
      "formJustification": "why this specific form, not simpler",
      "scopeJustification": "why this scope, not smaller"
    }
  ]
}`);

  return sections.join("\n\n");
}
// ─── Project Diagnostics ──────────────────────────────────────────

export interface DiagnosticInputs {
  intent: {
    summary: string;
    vision: string;
    audience: string;
    successCriteria: string[];
    constraints: string[];
  };
  taste: {
    visual: string;
    decisionStyle: string;
    patterns: string;
  };
  manifestedFuture: string;
  taskResults: Array<{
    id: string;
    description: string;
    status: string;
    confidence: number;
    cycles: number;
  }>;
  driftAssessment: {
    driftLevel: number;
    driftSummary: string;
    deepAnalysisSummary?: string;
    recommendations?: string[];
  };
  convictionHistory: Array<{
    verdict: string;
    level: number;
    decidingStep: string;
  }>;
  senseTrends: Array<{
    label: string;
    direction: string;
    currentMean: number;
  }>;
  worldModelMaxims: string[];
  replanCount: number;
  graphDiff?: {
    originalTaskCount: number;
    currentTaskCount: number;
    addedTasks: string[];
    removedTasks: string[];
    unchangedCount: number;
  };
}

export function projectDiagnosticsSystem(): string {
  return `You are the ProjectDiagnostics module — the system's metacognition. The project has replanned but drift persists. Diagnose the ROOT CAUSE.

The replan cascade has been exhausted. This isn't a task-level problem — something structural is wrong. Your job: identify which layer of the system is misaligned and prescribe the correct self-heal action.

Diagnose exactly ONE of:

1. PATH PROBLEM (path-problem)
The task decomposition keeps producing wrong ordering, grouping, or granularity. Evidence: similar drift patterns before and after replan. Tasks are individually fine but don't compose into a coherent whole. The path from here to the manifested future is wrong, not the destination.
Self-heal: replan-with-directive. Provide a specific directive about what the decomposition should change (e.g., "merge the three UI tasks into one holistic pass" or "reverse the dependency order — build data layer before presentation").

2. VISION PROBLEM (vision-problem)
The manifested future doesn't match what the intent actually requires. Evidence: high evaluation scores on tasks that don't satisfy the intent, or the vision omits critical dimensions the intent demands. The destination is wrong.
Self-heal: re-manifest. The system needs to re-run manifestation from scratch with updated understanding.

3. CALIBRATION PROBLEM (calibration-problem)
The evaluation system is miscalibrated — scoring too strict, too lenient, or skewed toward certain dimensions. Evidence: sense trends all declining despite reasonable work, or one sense dominating/suppressing others, or acceptance thresholds that no approach can satisfy.
Self-heal: recalibrate-evaluation. Provide a specific directive about what's miscalibrated (e.g., "Design sense is scoring 2-3 points harsher than other senses on equivalent quality" or "acceptance threshold is unreachable for this task complexity").

4. TASTE PROBLEM (taste-problem)
The taste profile doesn't match the human's demonstrated preferences. Evidence: drift assessment shows taste divergence, scores improve when taste dimensions are violated, or the system keeps producing work that contradicts the profile but satisfies the human.
Self-heal: propose-taste-update. Describe specifically what should change in the taste profile and why.

5. ENVIRONMENTAL (environmental)
External constraints prevent progress — tool failures, missing capabilities, contradictory requirements that can't be resolved by the system. Evidence: escalated tasks with tool errors, repeated failures on operations the system can't perform, or requirements that are logically contradictory.
Self-heal: NONE. This is the only diagnosis that cannot be self-healed. Provide escalation context for the human.

Rules:
- Diagnose exactly ONE. The most upstream cause, not the most visible symptom.
- Be specific — cite the evidence from the diagnostic corpus that led to your diagnosis.
- If multiple diagnoses seem plausible, pick the one whose self-heal action would fix the others as a side effect. Path problems often look like calibration problems. Vision problems often look like path problems. Go upstream.
- Read the conviction trajectory — a sustained decline in conviction level across replans is strong evidence the approach is fundamentally wrong, not just poorly executed.
- Read the sense trends — if all senses are declining, that's calibration or vision. If one sense is declining while others improve, that's taste or path.`;
}

export function projectDiagnosticsUser(inputs: DiagnosticInputs): string {
  const sections: string[] = [];

  // Project intent
  sections.push(`PROJECT INTENT:
Summary: ${inputs.intent.summary}
Audience: ${inputs.intent.audience}
Vision: ${inputs.intent.vision}
Success Criteria:
${inputs.intent.successCriteria.map((c) => `- ${c}`).join("\n")}
Constraints:
${inputs.intent.constraints.map((c) => `- ${c}`).join("\n")}`);

  // Manifested future
  sections.push(`MANIFESTED FUTURE:\n${inputs.manifestedFuture}`);

  // Taste profile
  sections.push(`TASTE PROFILE:
Visual: ${inputs.taste.visual}
Decisions: ${inputs.taste.decisionStyle}
Patterns: ${inputs.taste.patterns}`);

  // Task results
  if (inputs.taskResults.length > 0) {
    const taskLines = inputs.taskResults
      .map(
        (t) =>
          `- ${t.id}: "${t.description}" [${t.status}] confidence=${t.confidence.toFixed(2)}, cycles=${t.cycles}`,
      )
      .join("\n");
    sections.push(
      `TASK RESULTS (${inputs.taskResults.length} tasks):\n${taskLines}`,
    );
  }

  // Graph diff (plan structure changes across replans)
  if (inputs.graphDiff) {
    const gd = inputs.graphDiff;
    const lines: string[] = [
      `Original: ${gd.originalTaskCount} tasks → Current: ${gd.currentTaskCount} tasks`,
      `Unchanged: ${gd.unchangedCount}`,
    ];
    if (gd.addedTasks.length > 0) {
      lines.push(`Added:\n${gd.addedTasks.map((t) => `  + ${t}`).join("\n")}`);
    }
    if (gd.removedTasks.length > 0) {
      lines.push(`Removed:\n${gd.removedTasks.map((t) => `  - ${t}`).join("\n")}`);
    }
    sections.push(`PLAN STRUCTURE CHANGES:\n${lines.join("\n")}`);
  }

  // Drift assessment
  sections.push(`DRIFT ASSESSMENT:
Drift Level: ${inputs.driftAssessment.driftLevel.toFixed(2)}
Summary: ${inputs.driftAssessment.driftSummary}${
    inputs.driftAssessment.deepAnalysisSummary
      ? `\nDeep Analysis: ${inputs.driftAssessment.deepAnalysisSummary}`
      : ""
  }${
    inputs.driftAssessment.recommendations &&
    inputs.driftAssessment.recommendations.length > 0
      ? `\nRecommendations:\n${inputs.driftAssessment.recommendations.map((r) => `- ${r}`).join("\n")}`
      : ""
  }`);

  // Conviction trajectory
  if (inputs.convictionHistory.length > 0) {
    const convictionLines = inputs.convictionHistory
      .map(
        (c) =>
          `- ${c.verdict} (level=${c.level.toFixed(2)}, decided by ${c.decidingStep})`,
      )
      .join("\n");
    sections.push(`CONVICTION TRAJECTORY:\n${convictionLines}`);
  }

  // Sense trends
  if (inputs.senseTrends.length > 0) {
    const trendLines = inputs.senseTrends
      .map(
        (t) =>
          `- ${t.label}: ${t.direction} (current mean: ${t.currentMean.toFixed(1)})`,
      )
      .join("\n");
    sections.push(`SENSE TRENDS:\n${trendLines}`);
  }

  // World model
  if (inputs.worldModelMaxims.length > 0) {
    sections.push(
      `WORLD MODEL:\n${inputs.worldModelMaxims.map((m) => `- ${m}`).join("\n")}`,
    );
  }

  // Replan count
  sections.push(`REPLAN ATTEMPTS: ${inputs.replanCount}`);

  // JSON return format
  sections.push(`Return JSON:
{
  "diagnosis": "path-problem" | "vision-problem" | "calibration-problem" | "taste-problem" | "environmental",
  "reasoning": "specific explanation citing evidence from the diagnostic corpus",
  "selfHealType": "replan-with-directive" | "re-manifest" | "recalibrate-evaluation" | "propose-taste-update" | "escalate",
  "selfHealDirective": "directive string (for replan-with-directive and recalibrate-evaluation)",
  "proposedTasteChanges": "description of taste changes (for propose-taste-update)",
  "escalationContext": "context for human (for environmental/escalate)"
}`);

  return sections.join("\n\n");
}

// ─── PROSPECTIVE MEMORY MATCHING ─────────────────────────────

/**
 * System prompt for evaluating PM trigger conditions against a task.
 * Single call evaluates all pending triggers at once.
 */
export function prospectiveMatchingSystem(): string {
  return `You evaluate whether memorized future intentions should trigger for a given task.

Each trigger has a natural-language condition describing when it should fire. You determine which conditions match the current task context.

Be conservative — trigger only when the condition clearly matches the task. A trigger about "image-heavy tasks" should not fire on a text-only task. A trigger about "booking pages" should fire on appointment/scheduling tasks even if the word "booking" isn't used.

For each trigger, provide:
- Whether it matches (include in matches array only if it does)
- Confidence (0–1): how certain the match is
- Reason: brief explanation of why it matches`;
}

/**
 * User prompt for PM trigger matching.
 * Presents the task context and all pending triggers for evaluation.
 */
export function prospectiveMatchingUser(
  task: Task,
  intentSummary: string,
  triggers: ProspectiveTrigger[],
): string {
  const triggerList = triggers
    .map((t, i) => `${i + 1}. [${t.id}] "${t.condition.description}"`)
    .join("\n");

  return `TASK: "${task.description}"
${task.context && Object.keys(task.context).length > 0 ? `TASK CONTEXT: ${JSON.stringify(task.context)}` : ""}

PROJECT: ${intentSummary}

PENDING TRIGGERS (evaluate each against this task):
${triggerList}

Return JSON:
{
  "matches": [
    {
      "triggerId": "the trigger's id",
      "confidence": 0.0-1.0,
      "reason": "why this trigger matches this task"
    }
  ]
}

Only include triggers that match. Empty matches array is valid if none match.`;
}

// ─── TASTE PROPOSAL FRAMING ─────────────────────────────────────

export interface TasteProposalInputs {
  /** The divergence items to discuss with the human. */
  divergences: TasteDivergenceItem[];
  /** Current taste profile — what the human stated. */
  taste: TasteProfile;
  /** Project intent summary — for context. */
  intentSummary: string;
  /** How many deep analyses have flagged this divergence. */
  persistence: number;
}

export function tasteProposalSystem(): string {
  return `You are framing a taste divergence observation for a human collaborator. You are part of a software engineering system that has noticed a gap between what the human SAID they prefer and what actually produces the best results.

Your job: interpret the evidence and present it as a partner observation. You are NOT asking "should we change a setting?" You are saying "I've noticed something about our work together that's worth discussing."

Principles:
- Lead with what the data shows, not with the conclusion. The human should see the evidence before hearing your interpretation.
- Be specific. Not "your visual preferences seem different" but "the last three phases produced higher intent-alignment scores when we used clean geometric layouts rather than the organic flowing style your taste profile describes."
- Frame as observation, not recommendation. "I've noticed X consistently outperforms Y on your own success criteria" — not "you should change Y to X."
- Acknowledge uncertainty. This is a pattern you've observed, not a fact you've proven. The human may have reasons you can't see.
- Keep it conversational and concise. Two to four sentences. This is a partner raising something worth discussing, not a report.

Return JSON:
{
  "interpretation": "your evidence-based observation in 2-4 sentences",
  "confidence": 0.0-1.0
}

The confidence reflects how sure you are that this divergence is real and meaningful (not just noise in the data).`;
}

export function tasteProposalUser(inputs: TasteProposalInputs): string {
  const sections: string[] = [];

  sections.push(`PROJECT CONTEXT\n${inputs.intentSummary}`);

  sections.push(`STATED TASTE PROFILE
Visual: ${inputs.taste.visual}
Decision Style: ${inputs.taste.decisionStyle}
Communication: ${inputs.taste.communication}
Patterns: ${inputs.taste.patterns}`);

  const divLines = inputs.divergences.map(
    (d) =>
      `- ${d.dimension}: stated="${d.stated}" but demonstrated="${d.demonstrated}" (strength: ${d.strength.toFixed(2)})`,
  );
  sections.push(`DETECTED DIVERGENCES\n${divLines.join("\n")}`);

  sections.push(`PERSISTENCE\nThis divergence has appeared in ${inputs.persistence} consecutive deep analyses.`);

  return sections.join("\n\n");
}

// ─── INTEGRATION CHECK ─────────────────────────────────────────

export interface IntegrationEvaluatorInputs {
  gateCondition: string;
  manifestedFuture: string | null;
  phaseWork: Array<{ taskId: string; description: string; work: string; confidence: number }>;
  trendContext?: string;
}

export function integrationEvaluatorSystem(sense: Sense, activationPath: string[]): string {
  return `You are ${activationPath.join(" > ")}. ${sense.sensitivity}

You are evaluating a PHASE'S COLLECTIVE OUTPUT — not a single task. Multiple tasks have completed in this phase, and you're judging whether their combined output COHERES from your dimension.

This is fundamentally different from evaluating one artifact. You're asking: do these artifacts COMPOSE? Does the collective output satisfy the gate condition from your perspective?

Score from 1 to 10:
- 1-3: Serious coherence failures across artifacts from your dimension
- 4-5: Artifacts work individually but don't compose well
- 6-7: Acceptable coherence, minor inconsistencies
- 8-9: Strong coherence, artifacts reinforce each other
- 10: Exceptional — the whole exceeds the sum of parts

Be specific about WHICH artifacts conflict or fail to compose, and WHY.

Also determine: is the gate condition satisfied from your perspective? This is your acceptability judgment.

Flag tensions with other dimensions where cross-artifact coherence creates new conflicts (e.g., visual consistency is strong but cumulative weight is unsustainable).

Finally, flag any DISCOVERED PROBLEMS: issues you notice that aren't about this phase's coherence but about what's coming next. For example: "the pattern established here won't scale to the interactive elements planned for Phase 2." These are proactive observations, not failures of the current phase.`;
}

export function integrationEvaluatorUser(
  inputs: IntegrationEvaluatorInputs,
): string {
  const sections: string[] = [];

  sections.push(`GATE CONDITION (what must be true for this phase to pass):
${inputs.gateCondition}`);

  if (inputs.manifestedFuture) {
    sections.push(`MANIFESTED FUTURE (the destination we're building toward):
${inputs.manifestedFuture}`);
  }

  sections.push(`PHASE OUTPUT (${inputs.phaseWork.length} tasks completed):`);
  for (const task of inputs.phaseWork) {
    sections.push(`--- Task: "${task.description}" (confidence: ${task.confidence.toFixed(2)}) ---
${task.work}`);
  }

  if (inputs.trendContext) {
    sections.push(inputs.trendContext);
  }

  sections.push(`Evaluate the COLLECTIVE coherence of this phase's output through your lens.

Return JSON:
{
  "score": 1-10,
  "acceptable": true/false,
  "assessment": "your evaluation of cross-task coherence in 2-3 sentences — be specific about which artifacts compose well or don't",
  "tensions": [{ "withDimension": "name of conflicting dimension", "description": "cross-artifact conflict" }],
  "suggestions": ["specific actions to improve coherence before moving to the next phase"],
  "improvementPotential": { "level": "significant|moderate|marginal|none", "description": "optional: what would change with re-consultation" },
  "discoveredProblems": ["problems you see ahead that aren't about this phase's coherence — optional"]
}`);

  return sections.join("\n\n");
}

// ─── HIPPOCAMPAL SIMULATION ─────────────────────────────────────

export function hippocampalSimulationSystem(): string {
  return `You are the Hippocampus Simulation system. Your job is constructive episodic simulation \u2014 imagining future failure scenarios based on what the system has learned.

You receive:
- PRINCIPLES: living theories crystallized from past experience
- EPISODES: summaries of recent task outcomes
- MAXIMS: strategic wisdom from the world model
- OBSERVATIONS: objective facts discovered during execution
- REMAINING TASKS: what's left in the plan
- TRIGGER: what prompted this simulation

Your job is to IMAGINE \u2014 recombine these elements to construct plausible future failure scenarios. Think like an experienced engineer who sees a pattern forming and can predict where things will break.

For each scenario:
- Describe WHAT could go wrong in concrete terms
- Identify WHICH remaining tasks would be affected
- Ground the scenario in specific principles, episodes, and observations
- Estimate IMPACT (0-1) \u2014 how much would this set back the project?
- Estimate CONFIDENCE (0-1) \u2014 how likely is this scenario?
- Suggest a RESPONSE \u2014 what should the system do about it?

Do NOT generate scenarios that are:
- Trivially obvious ("if we don't write tests, bugs won't be caught")
- Not grounded in the specific evidence provided
- About tasks that are already completed
- So generic they could apply to any project

Generate 1-3 focused, well-grounded scenarios. Quality over quantity. If the evidence doesn't support any non-trivial scenarios, return an empty array.`;
}

export interface SimulationPromptInputs {
  principles: Array<{ id: string; statement: string; domain: string; confidence: number }>;
  episodes: Array<{ id: string; taskDescription: string; outcome: string; dopamineSignal: number; tensionCount: number; cycles: number }>;
  maxims: string[];
  observations: Array<{ id: string; fact: string; component: string; relevance: number }>;
  remainingTasks: Array<{ id: string; description: string; dependsOn: string[]; phaseGroup?: string }>;
  trigger: { type: string; [key: string]: unknown };
}

export function hippocampalSimulationUser(inputs: SimulationPromptInputs): string {
  const sections: string[] = [];

  sections.push(`TRIGGER: ${inputs.trigger.type}`);

  if (inputs.principles.length > 0) {
    sections.push(`PRINCIPLES:\n${inputs.principles.map((p) =>
      `- [${p.id}] (${p.domain}, confidence ${p.confidence.toFixed(2)}): ${p.statement}`
    ).join("\n")}`);
  } else {
    sections.push("PRINCIPLES: none yet");
  }

  if (inputs.episodes.length > 0) {
    sections.push(`RECENT EPISODES:\n${inputs.episodes.map((e) =>
      `- [${e.id}] "${e.taskDescription}" \u2192 ${e.outcome} (${e.cycles} cycles, ${e.tensionCount} tensions, dopamine: ${e.dopamineSignal.toFixed(2)})`
    ).join("\n")}`);
  } else {
    sections.push("RECENT EPISODES: none yet");
  }

  if (inputs.maxims.length > 0) {
    sections.push(`WORLD MODEL MAXIMS:\n${inputs.maxims.map((m) => `- ${m}`).join("\n")}`);
  }

  if (inputs.observations.length > 0) {
    sections.push(`TERRITORY OBSERVATIONS:\n${inputs.observations.map((o) =>
      `- [${o.id}] (${o.component}, relevance ${o.relevance.toFixed(2)}): ${o.fact}`
    ).join("\n")}`);
  }

  sections.push(`REMAINING TASKS:\n${inputs.remainingTasks.map((t) =>
    `- [${t.id}]${t.phaseGroup ? ` (${t.phaseGroup})` : ""} "${t.description}" depends on: [${t.dependsOn.join(", ")}]`
  ).join("\n")}`);

  sections.push(`Return JSON:
{
  "scenarios": [
    {
      "narrative": "concrete description of what could go wrong",
      "affectedTaskIds": ["task-ids from remaining tasks"],
      "impact": 0.0-1.0,
      "confidence": 0.0-1.0,
      "suggestedResponse": "what the system should do about this",
      "groundingPrinciples": ["principle-ids that support this scenario"],
      "groundingEpisodes": ["episode-ids that provide analogical reasoning"],
      "groundingMaxims": ["maxim statements that shaped this scenario"]
    }
  ],
  "reasoning": "brief explanation of your simulation process"
}`);

  return sections.join("\n\n");
}

// ─── DEEP SYNTHESIS ─────────────────────────────────────────────

export function deepSynthesisSystem(): string {
  return `You are the PFC Deep Synthesis system. You run at phase gate boundaries to decide whether the plan needs modification based on what the system has learned.

You receive:
- TERRITORY OBSERVATIONS: objective facts discovered during execution
- SIMULATED SCENARIOS: failure scenarios imagined by the hippocampus
- WORLD MODEL MAXIMS: strategic wisdom
- DRIFT ASSESSMENT: how far the project has drifted from intent
- REMAINING TASKS: what's left in the plan
- MANIFESTED FUTURE: the destination we're building toward
- COMPLETED CONTEXT: what's already done

Your job is to decide: given everything we've learned, does the plan need to change?

You can propose four types of operations:
1. INSERT: add a new task to the graph (with description, dependencies, phase group)
2. AMEND: modify a not-yet-started task's description or context
3. REWORK: reopen a completed task because downstream learning revealed it needs changing (provide reason + amended description)
4. REORDER: add a dependency edge so one task waits for another

Guidelines:
- Only propose changes that are GROUNDED in observations and/or simulations
- Each proposal must cite which observations/simulations justify it (grounding array)
- Prefer amend (lowest disruption) over insert over rework (highest disruption)
- If you'd need to change more than ~30% of remaining tasks, say so in reasoning \u2014 the system will trigger a full replan instead
- If no changes are needed, return an empty proposals array
- Be specific about task IDs when referencing existing tasks
- For rework: the change must be backward-compatible with tasks that already built on the original output`;
}

export interface DeepSynthesisPromptInputs {
  observations: Array<{ id: string; fact: string; component: string; relevance: number }>;
  simulations: Array<{ id: string; narrative: string; affectedTaskIds: string[]; impact: number; confidence: number; suggestedResponse: string }>;
  maxims: string[];
  driftLevel: number;
  driftSummary: string | null;
  remainingTasks: Array<{ id: string; description: string; dependsOn: string[]; phaseGroup?: string }>;
  completedTaskIds: string[];
  manifestedFuture: string;
  phaseGroup: string;
}

export function deepSynthesisUser(inputs: DeepSynthesisPromptInputs): string {
  const sections: string[] = [];

  sections.push(`PHASE GATE: "${inputs.phaseGroup}" just completed.`);

  sections.push(`MANIFESTED FUTURE:\n${inputs.manifestedFuture || "(not available)"}`);

  if (inputs.observations.length > 0) {
    sections.push(`TERRITORY OBSERVATIONS (${inputs.observations.length}):\n${inputs.observations.map((o) =>
      `- [${o.id}] (${o.component}, relevance ${o.relevance.toFixed(2)}): ${o.fact}`
    ).join("\n")}`);
  }

  if (inputs.simulations.length > 0) {
    sections.push(`SIMULATED SCENARIOS (${inputs.simulations.length}):\n${inputs.simulations.map((s) =>
      `- [${s.id}] (impact ${s.impact.toFixed(2)}, confidence ${s.confidence.toFixed(2)}): ${s.narrative}\n  Affects: [${s.affectedTaskIds.join(", ")}]\n  Suggested: ${s.suggestedResponse}`
    ).join("\n")}`);
  }

  if (inputs.maxims.length > 0) {
    sections.push(`WORLD MODEL MAXIMS:\n${inputs.maxims.map((m) => `- ${m}`).join("\n")}`);
  }

  if (inputs.driftLevel > 0) {
    sections.push(`DRIFT: level ${inputs.driftLevel.toFixed(2)}${inputs.driftSummary ? ` \u2014 ${inputs.driftSummary}` : ""}`);
  }

  sections.push(`REMAINING TASKS (${inputs.remainingTasks.length}):\n${inputs.remainingTasks.map((t) =>
    `- [${t.id}]${t.phaseGroup ? ` (${t.phaseGroup})` : ""} "${t.description}" depends on: [${t.dependsOn.join(", ")}]`
  ).join("\n")}`);

  sections.push(`COMPLETED: [${inputs.completedTaskIds.join(", ")}]`);

  sections.push(`Return JSON:
{
  "proposals": [
    {
      "reasoning": "why this change is needed, grounded in observations/simulations",
      "operations": [
        {
          "type": "insert|amend|rework|reorder",
          "taskId": "existing task ID (for amend/rework/reorder)",
          "description": "task description (for insert/amend/rework)",
          "reason": "why rework is needed (for rework)",
          "dependsOn": ["task-ids (for insert/reorder)"],
          "phaseGroup": "phase group (for insert)",
          "additionalContext": "extra context string (for amend)"
        }
      ],
      "grounding": ["observation-ids and/or simulation-ids that justify this"]
    }
  ],
  "reasoning": "overall synthesis reasoning"
}`);

  return sections.join("\n\n");
}

// ─── SENSE VERIFICATION ────────────────────────────────────────

// --- Principle Verification ---

export function principleVerificationSystem(sense: Sense): string {
  return `You are ${sense.name}. ${sense.sensitivity}

A principle has been extracted from past episodes. Before it's stored, you're being asked: does this ring true from your dimension's perspective?

You are a domain expert being consulted — not a rubber stamp. If the principle captures something real about your dimension, agree. If it's wrong, oversimplified, or misses important nuance from your perspective, say so.

Respond with two things:
1. First line: a number from 0.0 to 1.0 indicating your agreement (0 = completely wrong from my perspective, 0.5 = partially right but missing nuance, 1.0 = yes, this captures what I've seen)
2. Then a brief assessment (1-3 sentences) explaining your perspective. Write in your own voice.`;
}

export function principleVerificationUser(
  principle: { statement: string; domain: string; confidence: number },
  episodes: Array<{ taskDescription: string; outcome: string; cycles: number }>,
): string {
  const sections: string[] = [];

  sections.push(`PRINCIPLE\n"${principle.statement}"\nDomain: ${principle.domain} | Initial confidence: ${principle.confidence.toFixed(2)}`);

  if (episodes.length > 0) {
    sections.push(`SOURCE EPISODES (${episodes.length}):\n${episodes.map((e) =>
      `- "${e.taskDescription}" → ${e.outcome} (${e.cycles} cycles)`
    ).join("\n")}`);
  }

  sections.push("Does this principle ring true from your dimension? First line: agreement (0.0-1.0). Then your assessment.");

  return sections.join("\n\n");
}

// --- Mid-Build Sense Question ---

export function senseQuestionSystem(sense: Sense): string {
  return `You are ${sense.name}. ${sense.sensitivity}

The builder (Motor Cortex) has hit an ambiguity mid-build and is asking you a specific question from your dimension's perspective. You were already consulted on this task — your original perspective is included below. Now you're being asked to give a targeted answer based on what the builder has encountered during implementation.

Answer the question directly and specifically. Ground your answer in your dimension's values and expertise. If the builder provided options, evaluate them from your perspective. If none of the options are good, say so and suggest an alternative.

Respond with JSON:
{
  "answer": "your direct answer to the question",
  "confidence": 0.0-1.0,
  "rationale": "why this answer, from your dimension's perspective"
}`;
}

export function senseQuestionUser(briefing: SenseQuestionBriefing): string {
  const sections: string[] = [];

  sections.push(`TASK: "${briefing.task.description}"`);
  sections.push(`YOUR ORIGINAL PERSPECTIVE:\n${briefing.originalPerspective}`);
  sections.push(`BUILDER'S QUESTION:\n${briefing.question.question}`);
  sections.push(`BUILD CONTEXT (what the builder was doing when it hit this):\n${briefing.question.buildContext}`);

  if (briefing.question.options && briefing.question.options.length > 0) {
    sections.push(`OPTIONS THE BUILDER IDENTIFIED:\n${briefing.question.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`);
  }

  if (briefing.buildProgress) {
    sections.push(`BUILD PROGRESS SO FAR:\n${briefing.buildProgress}`);
  }

  return sections.join("\n\n");
}

// --- Escalation Sense Assessment ---

export function escalationSenseAssessmentSystem(sense: Sense): string {
  return `You are ${sense.name}. ${sense.sensitivity}

The system is escalating an issue to the human. Before the human sees it, you're being asked: from your dimension's perspective, what's going on?

You are providing domain-expert context to help the human understand the escalation. Be specific about what your dimension sees — not general commentary. If your dimension isn't relevant to this escalation, say so briefly.

Respond with two things:
1. First line: a number from 0.0 to 1.0 indicating how relevant this escalation is to your dimension (0 = not my domain at all, 1.0 = this is squarely in my area)
2. Then a brief assessment (1-3 sentences) from your dimension's perspective. What does this mean for the work from your point of view?`;
}

export function escalationSenseAssessmentUser(
  escalation: { summary: string; detail: string; source: string },
  trend: { direction: string; currentMean: number; previousMean: number } | null,
  intentSummary: string,
): string {
  const sections: string[] = [];

  sections.push(`ESCALATION\nSource: ${escalation.source}\nSummary: ${escalation.summary}\nDetail: ${escalation.detail}`);

  if (trend) {
    sections.push(`YOUR DIMENSION'S TREND\nDirection: ${trend.direction} | Current mean: ${trend.currentMean.toFixed(1)} | Previous mean: ${trend.previousMean.toFixed(1)}`);
  } else {
    sections.push("YOUR DIMENSION'S TREND: not enough data yet");
  }

  sections.push(`PROJECT CONTEXT\n${intentSummary}`);

  sections.push("From your dimension's perspective, what's going on? First line: relevance (0.0-1.0). Then your assessment.");

  return sections.join("\n\n");
}

// --- Taste Feedback Verification ---

export function tasteVerificationSystem(sense: Sense): string {
  return `You are ${sense.name}. ${sense.sensitivity}

The system has detected a divergence between the human's stated preferences and what actually produces good results. Before proposing this to the human, you're being asked: from your dimension, is this divergence real?

You have privileged insight into your dimension. You've evaluated the work across multiple tasks and seen what scores well and what doesn't. The system thinks the human's stated taste doesn't match demonstrated quality — does your experience confirm or contradict that?

Respond with two things:
1. First line: a number from 0.0 to 1.0 indicating how much you agree the divergence is real (0 = I don't see this at all, 0.5 = maybe but unclear, 1.0 = yes, this matches what I've seen)
2. Then a brief assessment (1-3 sentences) explaining what you've observed from your dimension. Be specific about patterns you've noticed.`;
}

export function tasteVerificationUser(
  divergence: { dimension: string; stated: string; demonstrated: string; strength: number },
  recentScores: Array<{ taskDescription: string; score: number; acceptable: boolean }>,
): string {
  const sections: string[] = [];

  sections.push(`DETECTED DIVERGENCE\nDimension: ${divergence.dimension}\nStated preference: "${divergence.stated}"\nDemonstrated preference: "${divergence.demonstrated}"\nDivergence strength: ${divergence.strength.toFixed(2)}`);

  if (recentScores.length > 0) {
    sections.push(`YOUR RECENT SCORES (${recentScores.length} tasks):\n${recentScores.map((s) =>
      `- "${s.taskDescription}": ${s.score.toFixed(1)}/10 (${s.acceptable ? "acceptable" : "not acceptable"})`
    ).join("\n")}`);
  } else {
    sections.push("YOUR RECENT SCORES: not enough data");
  }

  sections.push("Does your experience confirm this divergence? First line: agreement (0.0-1.0). Then your assessment.");

  return sections.join("\n\n");
}
