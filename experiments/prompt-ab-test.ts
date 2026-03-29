/**
 * Consultation System Prompt A/B Test
 *
 * Tests whether different consultation system prompts produce better built artifacts.
 *
 * Flow per trial:
 *   1. Consult all 3 senses using the variant's system prompt
 *   2. Feed perspectives into motor cortex → build HTML
 *   3. Save HTML to experiments/ab-results/{variant}/{task}.html
 *   4. Optionally run LLM-as-judge on the HTML artifacts
 *
 * Variants (base × modifier):
 *   A: Preamble + Task focused       (.1 base, .2 +hint, .3 +few-shot)
 *   B: No preamble + Task focused    (.1 base, .2 +hint, .3 +few-shot)
 *   C: Preamble + Shaela terminology (.1 base, .2 +hint, .3 +few-shot)
 *   D: Recommended                   (.1 base, .2 +hint, .3 +few-shot)
 *
 * Run: npx tsx experiments/prompt-ab-test.ts [flags]
 *   --judge           Run LLM-as-judge on built artifacts
 *   --task=<1|2|3>    Run only one task
 *   --variant=<id>    Filter variants (e.g. "a", "a.1", "*.2")
 *   --dry-run         Print matrix without LLM calls
 *   --open            Open all generated HTML files in browser when done
 */

import { z } from "zod";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { callStructured } from "../src/llm/structured.js";
import {
  SHAELA_PREAMBLE,
  consultationUser,
  motorCortexSystem,
  assembleMotorPrompt,
} from "../src/llm/prompts.js";
import { CORRECTNESS_TREE } from "../src/senses/personas/correctness.js";
import { DESIGN_TREE } from "../src/senses/personas/design.js";
import { INTENT_ALIGNMENT_TREE } from "../src/senses/personas/intent-alignment.js";
import type { Sense, SensePerspective } from "../src/types/sense.js";
import type {
  ConsultationBriefing,
  MotorBriefing,
} from "../src/types/thalamus.js";
import type { ProjectIntent, TasteProfile } from "../src/types/intent.js";
import type { Consultation } from "../src/types/consultation.js";

// ─── Zod Schemas ──────────────────────────────────────────────

const FiringSchema = z.object({
  receptorId: z.string(),
  signal: z.string(),
  intensity: z.number().min(0).max(1),
});

const ConsultationOutput = z.object({
  firings: z.array(FiringSchema),
  guidance: z.string(),
  stake: z.number().min(0).max(1),
});

const BuildResult = z.object({
  html: z.string(),
  reasoning: z.string(),
});

const JudgeResult = z.object({
  rankings: z.array(
    z.object({
      variantId: z.string(),
      scores: z.object({
        visualQuality: z.number().min(1).max(10),
        intentAlignment: z.number().min(1).max(10),
        tasteMatch: z.number().min(1).max(10),
        craftAndPolish: z.number().min(1).max(10),
      }),
      total: z.number(),
      notes: z.string(),
    })
  ),
  winner: z.string(),
  reasoning: z.string(),
});

// ─── Prompt Variant Definitions ───────────────────────────────

type SystemPromptFn = (sense: Sense, subTree: Sense[]) => string;

interface VariantDef {
  id: string;
  name: string;
  fn: SystemPromptFn;
}

function buildSubConcerns(subTree: Sense[]): string {
  const pathways = subTree.filter((g) => g.level === "pathway");
  return pathways
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
}

// ─── Modifiers ────────────────────────────────────────────────

function activationHintBlock(sense: Sense): string {
  return sense.activationHint
    ? `\nActivation guidance: ${sense.activationHint}\n`
    : "";
}

const FEW_SHOT_EXAMPLE = `
EXAMPLE (different sense, different task — for format reference only):

Task: "Add a contact form to the homepage"
Sense: SECURITY

{
  "firings": [
    { "receptorId": "security.data-protection.input-sanitization", "signal": "Contact form accepts user-supplied text (name, email, message) that will be stored and possibly displayed — XSS and injection surface", "intensity": 0.8 },
    { "receptorId": "security.data-protection.data-transmission", "signal": "Form submission sends PII (email, name) over the network — needs HTTPS and appropriate headers", "intensity": 0.6 }
  ],
  "guidance": "Sanitize all form inputs server-side before storage. Use HTTPS for the form submission endpoint. Add CSRF protection. Don't reflect raw user input back into the page without escaping. Rate-limit submissions to prevent spam abuse.",
  "stake": 0.45
}

Note: only 2 of 25+ receptors fired. The rest (authentication, authorization, audit logging, compliance, etc.) had nothing to detect on a simple contact form. That selectivity is correct.

YOUR TURN — apply the same selectivity to the actual task below:
`;

// ─── Base Framings ────────────────────────────────────────────

interface BaseFraming {
  id: string;
  name: string;
  build: (
    sense: Sense,
    subTree: Sense[],
    mods: { hint: boolean; fewShot: boolean }
  ) => string;
}

const BASES: BaseFraming[] = [
  {
    id: "a",
    name: "Preamble + Task Focused",
    build: (sense, subTree, mods) => {
      const subConcerns = buildSubConcerns(subTree);
      return `${SHAELA_PREAMBLE}

You are ${sense.name}. ${sense.sensitivity}
${mods.hint ? activationHintBlock(sense) : ""}
Your areas of expertise:
${subConcerns}

You've been asked to evaluate a task. Review it through your areas of expertise listed above. For each area that's relevant to this task:
- Identify what you detect — be specific and concrete, not generic
- Rate the intensity (0.0–1.0): how central is this to the task?

Areas with nothing to contribute should be skipped entirely. Silence is a signal — not every task needs your input.

Then provide your guidance: what does the builder need to do from your perspective? Be actionable and direct, not a list of concerns. Write in your own voice.

Rate your stake (0.0–1.0): if this task shipped without your input at all, how much would be lost? Be honest — a 0.1 is fine if this task barely touches your domain.
${mods.fewShot ? FEW_SHOT_EXAMPLE : ""}
Return JSON:
{
  "firings": [
    { "receptorId": "receptor-id", "signal": "what this receptor detected", "intensity": 0.0-1.0 }
  ],
  "guidance": "actionable direction for the builder from this dimension",
  "stake": 0.0-1.0
}`;
    },
  },

  {
    id: "b",
    name: "No Preamble + Task Focused",
    build: (sense, subTree, mods) => {
      const subConcerns = buildSubConcerns(subTree);
      return `You are ${sense.name}. ${sense.sensitivity}
${mods.hint ? activationHintBlock(sense) : ""}
Your areas of expertise:
${subConcerns}

You've been asked to evaluate a task. Review it through your areas of expertise listed above. For each area that's relevant to this task:
- Identify what you detect — be specific and concrete, not generic
- Rate the intensity (0.0–1.0): how central is this to the task?

Areas with nothing to contribute should be skipped entirely. Silence is a signal — not every task needs your input.

Then provide your guidance: what does the builder need to do from your perspective? Be actionable and direct, not a list of concerns. Write in your own voice.

Rate your stake (0.0–1.0): if this task shipped without your input at all, how much would be lost? Be honest — a 0.1 is fine if this task barely touches your domain.
${mods.fewShot ? FEW_SHOT_EXAMPLE : ""}
Return JSON:
{
  "firings": [
    { "receptorId": "receptor-id", "signal": "what this receptor detected", "intensity": 0.0-1.0 }
  ],
  "guidance": "actionable direction for the builder from this dimension",
  "stake": 0.0-1.0
}`;
    },
  },

  {
    id: "c",
    name: "Preamble + Shaela Terminology",
    build: (sense, subTree, mods) => {
      const subConcerns = buildSubConcerns(subTree);
      return `${SHAELA_PREAMBLE}

You are ${sense.name}. ${sense.sensitivity}
${mods.hint ? activationHintBlock(sense) : ""}
Your pathways and receptors:
${subConcerns}

A shana has arrived — a question specific enough to be lived in one cycle. Let it propagate through your pathways. Each receptor that resonates with this shana should fire. Receptors that find no question within their domain should remain silent — the absence of signal is itself understanding.

For each receptor that fires:
- Name what it detected — the specific question-within-the-question that your receptor perceives
- Rate the intensity (0.0–1.0): how deeply does this shana live within this receptor's domain?

Then provide GUIDANCE. Based on what your receptors detected, what understanding must the builder embody for this shana to become shalem? Not a list of concerns — the shape of the answer as seen from your dimension. Write in your own voice.

Rate your stake in this shana (0.0–1.0): if this question were answered without your dimension's input, how much understanding would be lost? Be honest — not every shana asks something of you. If none of your receptors fire, your stake is 0.
${mods.fewShot ? FEW_SHOT_EXAMPLE : ""}
Return JSON:
{
  "firings": [
    { "receptorId": "receptor-id", "signal": "what this receptor detected", "intensity": 0.0-1.0 }
  ],
  "guidance": "actionable direction for the builder from this dimension",
  "stake": 0.0-1.0
}`;
    },
  },

  {
    id: "d",
    name: "Recommended",
    build: (sense, subTree, mods) => {
      const subConcerns = buildSubConcerns(subTree);
      return `${SHAELA_PREAMBLE}

You are ${sense.name}. ${sense.sensitivity}
${mods.hint ? activationHintBlock(sense) : ""}
Your pathways and receptors:
${subConcerns}

A task needs your expert consultation. Read it through your lens and form a perspective.

Not every task needs your input equally. Some tasks are central to your domain. Others barely touch it. Be honest about which this is — a low stake or even zero stake is a valuable signal, not a failure.

If this task is relevant to your domain:
1. Which of your receptors actually detect something? For each, report what it found and how central it is (intensity 0.0–1.0). Skip receptors with nothing to detect.
2. Synthesize: based on those detections, what does the builder need from your dimension? Not a checklist — your perspective as an expert. Say it in your own voice, with the specificity the task warrants.

If this task barely touches your domain, say so briefly and set a low stake.
${mods.fewShot ? FEW_SHOT_EXAMPLE : ""}
Return JSON:
{
  "firings": [
    { "receptorId": "receptor-id", "signal": "what this receptor detected", "intensity": 0.0-1.0 }
  ],
  "guidance": "actionable direction for the builder from this dimension",
  "stake": 0.0-1.0
}`;
    },
  },
];

// ─── Generate All Variants ────────────────────────────────────

const MODIFIERS: Array<{
  suffix: string;
  label: string;
  hint: boolean;
  fewShot: boolean;
}> = [
  { suffix: "1", label: "base", hint: false, fewShot: false },
  { suffix: "2", label: "+ hint", hint: true, fewShot: false },
  { suffix: "3", label: "+ few-shot", hint: false, fewShot: true },
];

const VARIANTS: VariantDef[] = BASES.flatMap((base) =>
  MODIFIERS.map((mod) => ({
    id: `${base.id}.${mod.suffix}`,
    name: `${base.name} ${mod.label}`,
    fn: (sense: Sense, subTree: Sense[]) =>
      base.build(sense, subTree, { hint: mod.hint, fewShot: mod.fewShot }),
  }))
);

// ─── Test Senses ──────────────────────────────────────────────

interface TestSense {
  id: string;
  label: string;
  root: Sense;
  subTree: Sense[];
}

const TEST_SENSES: TestSense[] = [
  {
    id: "correctness",
    label: "CORRECTNESS",
    root: CORRECTNESS_TREE[0],
    subTree: CORRECTNESS_TREE.slice(1),
  },
  {
    id: "design",
    label: "DESIGN",
    root: DESIGN_TREE[0],
    subTree: DESIGN_TREE.slice(1),
  },
  {
    id: "intent-alignment",
    label: "INTENT ALIGNMENT",
    root: INTENT_ALIGNMENT_TREE[0],
    subTree: INTENT_ALIGNMENT_TREE.slice(1),
  },
];

// ─── Test Tasks ───────────────────────────────────────────────

const INTENT: ProjectIntent = {
  id: "mikes-painting",
  summary:
    "A website for Mike's Painting, a residential painting contractor in Columbus, Ohio. Mike has been in business for 15 years. His reputation is everything — most work comes from referrals and neighbors seeing his trucks in the driveway.",
  audience:
    "Homeowners in suburban Columbus considering interior or exterior painting. Age 35-65. Looking for someone trustworthy to let into their home.",
  successCriteria: [
    "Visitor feels this is a legitimate, established business within 3 seconds",
    "Easy path to requesting a free estimate",
    "Works well on mobile phones",
    "Feels warm and personal, not corporate",
  ],
  constraints: [
    "Mobile-first — many visitors will be on phones",
    "Must feel trustworthy and established",
    "Simple to maintain — Mike is not technical",
  ],
  vision:
    "A warm, professional online presence that feels like a trusted neighbor, not a corporate entity or a fly-by-night operation.",
  keyDecisions: [],
  driftLog: [],
};

const TASTE: TasteProfile = {
  id: "kevin-defaults",
  name: "Kevin's defaults",
  visual:
    "Warm earth tones — rust, forest green, cream, warm grays. Serif or humanist sans-serif for headings. Generous whitespace. Rounded corners.",
  decisionStyle:
    "Prefers simple over clever. Ships good over perfects great. Authentic over polished.",
  communication:
    "Terse updates, show screenshots not descriptions. Don't over-explain.",
  patterns:
    "Always wants a prominent contact/quote CTA. Iterates most on headlines and hero sections.",
  raw: {},
};

function makeBriefing(taskDesc: string, taskId: string): ConsultationBriefing {
  return {
    task: {
      id: taskId,
      description: taskDesc,
      context: {},
      status: "consulting",
      createdAt: new Date(),
      history: [],
    },
    intent: INTENT,
    taste: TASTE,
    enrichment: {
      patterns: [],
      decisions: [],
      senseTrends: [],
      inhibitedSenses: [],
      openQuestions: [],
      completedTaskCount: 0,
    },
    meta: {
      consumer: "ab-test",
      assembledAt: new Date(),
      sources: ["synthetic"],
      enrichmentCounts: {},
    },
  };
}

interface TestTask {
  id: string;
  label: string;
  briefing: ConsultationBriefing;
}

const TEST_TASKS: TestTask[] = [
  {
    id: "1",
    label: "Hero section (visual + strategic)",
    briefing: makeBriefing("Build the homepage hero section", "t1"),
  },
  {
    id: "2",
    label: "Form validation (technical)",
    briefing: makeBriefing(
      "Implement form validation for the estimate request form",
      "t2"
    ),
  },
  {
    id: "3",
    label: "About page content (content-focused)",
    briefing: makeBriefing(
      "Write the About page content describing Mike's 15 years of experience",
      "t3"
    ),
  },
];

// ─── Trial Results ────────────────────────────────────────────

interface ConsultationResult {
  senseId: string;
  senseName: string;
  output: z.infer<typeof ConsultationOutput>;
}

interface TrialResult {
  variantId: string;
  variantName: string;
  taskId: string;
  taskLabel: string;
  consultations: ConsultationResult[];
  html: string;
  motorReasoning: string;
  htmlPath: string;
  consultDurationMs: number;
  buildDurationMs: number;
}

// ─── CLI ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      flags[key] = val ?? true;
    }
  }
  return {
    dryRun: flags["dry-run"] === true,
    judge: flags["judge"] === true,
    open: flags["open"] === true,
    taskFilter: flags["task"] as string | undefined,
    variantFilter: flags["variant"] as string | undefined,
  };
}

// ─── Execution ────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6-20250514";
const RESULTS_DIR = join(import.meta.dirname!, "ab-results");

async function consultSense(
  variant: VariantDef,
  task: TestTask,
  sense: TestSense
): Promise<ConsultationResult> {
  const systemPrompt = variant.fn(sense.root, sense.subTree);
  const userPrompt = consultationUser(task.briefing);

  const result = await callStructured(
    "consultation",
    MODEL,
    systemPrompt,
    userPrompt,
    ConsultationOutput
  );

  return {
    senseId: sense.id,
    senseName: sense.label,
    output: result,
  };
}

function assembleConsultation(
  consultations: ConsultationResult[]
): Consultation {
  const perspectives: SensePerspective[] = consultations.map((c) => ({
    senseId: c.senseId,
    senseName: c.senseName,
    perspective: c.output.guidance,
    evaluators: c.output.firings.map((f) => f.receptorId),
    stake: c.output.stake,
    ceiling: 8, // Not collected in this format — use reasonable default
    ceilingRationale: "N/A (AB test)",
  }));

  return {
    taskId: "ab-test",
    producedAt: new Date(),
    perspectives,
    evaluationPlan: [],
    stakeDistribution: {
      entries: perspectives.map((p) => ({
        senseId: p.senseId,
        senseName: p.senseName,
        stake: p.stake,
      })),
      totalStake: perspectives.reduce((s, p) => s + p.stake, 0),
      meanStake:
        perspectives.reduce((s, p) => s + p.stake, 0) / perspectives.length,
      max: perspectives.reduce((best, p) =>
        p.stake > best.stake ? p : best
      ),
    },
    conditions: {
      activeSenseIds: consultations.map((c) => c.senseId),
      inhibitedSenses: [],
    },
    generation: 0,
  };
}

function assembleMotorBriefing(
  task: TestTask,
  consultation: Consultation
): MotorBriefing {
  return {
    task: task.briefing.task,
    intent: INTENT,
    taste: TASTE,
    consultation,
    enrichment: {
      patterns: [],
      decisions: [],
      scoreTrends: [],
      openQuestions: [],
      capabilities: "HTML, CSS, JavaScript. Single self-contained HTML file.",
    },
    meta: {
      consumer: "ab-test-motor",
      assembledAt: new Date(),
      sources: ["synthetic"],
      enrichmentCounts: {},
    },
  };
}

async function buildArtifact(
  motorBriefing: MotorBriefing
): Promise<{ html: string; reasoning: string }> {
  const systemPrompt = motorCortexSystem();
  const userPrompt =
    assembleMotorPrompt(motorBriefing) +
    `\n\nProduce a single, self-contained HTML file with embedded CSS and any inline JS needed. The output should look great when opened in a browser. Use placeholder images via CSS gradients or SVG shapes — no external image URLs.

Return JSON:
{
  "html": "<!DOCTYPE html>...",
  "reasoning": "key decisions you made while building"
}`;

  return await callStructured(
    "motorCortex",
    MODEL,
    systemPrompt,
    userPrompt,
    BuildResult,
    16384
  );
}

async function runTrial(
  variant: VariantDef,
  task: TestTask
): Promise<TrialResult> {
  // 1. Consult all senses in parallel
  const consultStart = Date.now();
  const consultations = await Promise.all(
    TEST_SENSES.map((sense) => consultSense(variant, task, sense))
  );
  const consultDurationMs = Date.now() - consultStart;

  // 2. Assemble consultation → motor briefing → build
  const consultation = assembleConsultation(consultations);
  const motorBriefing = assembleMotorBriefing(task, consultation);

  const buildStart = Date.now();
  const { html, reasoning } = await buildArtifact(motorBriefing);
  const buildDurationMs = Date.now() - buildStart;

  // 3. Save HTML
  const variantDir = join(RESULTS_DIR, variant.id);
  mkdirSync(variantDir, { recursive: true });
  const htmlPath = join(variantDir, `task-${task.id}.html`);
  writeFileSync(htmlPath, html);

  return {
    variantId: variant.id,
    variantName: variant.name,
    taskId: task.id,
    taskLabel: task.label,
    consultations,
    html,
    motorReasoning: reasoning,
    htmlPath,
    consultDurationMs,
    buildDurationMs,
  };
}

// ─── Display ──────────────────────────────────────────────────

function displayResults(results: TrialResult[]) {
  // Group by task
  const byTask = new Map<string, TrialResult[]>();
  for (const r of results) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, []);
    byTask.get(r.taskId)!.push(r);
  }

  for (const [, trials] of byTask) {
    const { taskLabel } = trials[0];
    console.log(
      `\n${"═".repeat(72)}\nTASK: "${taskLabel}"\n${"═".repeat(72)}`
    );

    for (const trial of trials) {
      const stakes = trial.consultations
        .map(
          (c) =>
            `${c.senseName}: ${c.output.stake.toFixed(2)}`
        )
        .join(", ");
      const firingCounts = trial.consultations
        .map(
          (c) =>
            `${c.senseName}: ${c.output.firings.length}`
        )
        .join(", ");

      console.log(
        `\n  ── ${trial.variantName} (${trial.variantId.toUpperCase()}) ──`
      );
      console.log(`  Stakes: ${stakes}`);
      console.log(`  Firings: ${firingCounts}`);
      console.log(
        `  Timing: consult ${trial.consultDurationMs}ms, build ${trial.buildDurationMs}ms`
      );
      console.log(`  HTML: ${trial.htmlPath}`);
      console.log(`  Motor reasoning: ${trial.motorReasoning.slice(0, 200)}...`);
    }
  }

  // File listing for easy comparison
  console.log(`\n${"═".repeat(72)}\nGENERATED FILES\n${"═".repeat(72)}\n`);
  for (const r of results) {
    console.log(`  ${r.variantId.toUpperCase().padEnd(6)} × task ${r.taskId}: ${r.htmlPath}`);
  }
}

// ─── LLM-as-Judge ─────────────────────────────────────────────

async function runJudge(results: TrialResult[]) {
  console.log(
    `\n${"═".repeat(72)}\nJUDGE EVALUATION\n${"═".repeat(72)}`
  );

  const judgeSystem = `You are evaluating HTML artifacts built by a motor cortex that received guidance from different sense consultation prompts. All artifacts were built for the same task, same project, same taste profile — the only difference is how the senses were prompted during consultation, which shaped the guidance the builder received.

You are judging THE BUILT ARTIFACT, not the consultation. Score each on these dimensions (1–10):

1. VISUAL QUALITY (1–10): Does it look good? Is the layout clean, the typography considered, the spacing intentional? Does it feel professionally designed or thrown together?

2. INTENT ALIGNMENT (1–10): Does it serve the project's purpose? For Mike's Painting: does a visitor feel this is a legitimate, established, trustworthy business? Is there a clear path to requesting an estimate? Does it feel warm and personal, not corporate?

3. TASTE MATCH (1–10): Does it match the stated preferences? Warm earth tones (rust, forest green, cream, warm grays), serif or humanist sans-serif headings, generous whitespace, rounded corners, prominent CTA, simple over clever, authentic over polished.

4. CRAFT AND POLISH (1–10): Is the HTML well-structured? Is the CSS clean? Are there nice touches — hover states, transitions, responsive design, attention to detail? Does it feel like someone cared?

Score each variant, compute total (sum of 4 dimensions, max 40), declare a winner with reasoning.`;

  // Group by task
  const byTask = new Map<string, TrialResult[]>();
  for (const r of results) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, []);
    byTask.get(r.taskId)!.push(r);
  }

  const judgeResults: Array<{
    taskLabel: string;
    judge: z.infer<typeof JudgeResult>;
  }> = [];

  for (const [, trials] of byTask) {
    const { taskLabel } = trials[0];

    let userPrompt = `TASK: "${taskLabel}"

PROJECT: ${INTENT.summary}
AUDIENCE: ${INTENT.audience}
SUCCESS CRITERIA: ${INTENT.successCriteria.join("; ")}
VISION: ${INTENT.vision}

TASTE:
Visual: ${TASTE.visual}
Decisions: ${TASTE.decisionStyle}
Patterns: ${TASTE.patterns}

─── BUILT ARTIFACTS ───
`;

    for (const trial of trials) {
      userPrompt += `
══ ${trial.variantName} (${trial.variantId.toUpperCase()}) ══
Motor reasoning: ${trial.motorReasoning}

HTML:
${trial.html}

`;
    }

    console.log(`\n  Judging: ${taskLabel}...`);

    try {
      const judge = await callStructured(
        "evaluation",
        MODEL,
        judgeSystem,
        userPrompt,
        JudgeResult,
        8192
      );
      judgeResults.push({ taskLabel, judge });

      console.log(`  Winner: ${judge.winner}`);
      console.log(`  Reasoning: ${judge.reasoning}`);
      for (const r of judge.rankings) {
        const s = r.scores;
        console.log(
          `    ${r.variantId.padEnd(6)}: visual=${s.visualQuality} intent=${s.intentAlignment} taste=${s.tasteMatch} craft=${s.craftAndPolish} total=${r.total}`
        );
        if (r.notes) console.log(`      ${r.notes}`);
      }
    } catch (err) {
      console.error(`  Judge failed for ${taskLabel}:`, err);
    }
  }

  // Aggregate
  if (judgeResults.length > 0) {
    console.log(
      `\n${"═".repeat(72)}\nJUDGE AGGREGATE\n${"═".repeat(72)}`
    );

    const totals = new Map<
      string,
      { total: number; count: number; wins: number }
    >();
    for (const jr of judgeResults) {
      for (const r of jr.judge.rankings) {
        if (!totals.has(r.variantId)) {
          totals.set(r.variantId, { total: 0, count: 0, wins: 0 });
        }
        const entry = totals.get(r.variantId)!;
        entry.total += r.total;
        entry.count++;
        if (r.variantId === jr.judge.winner) entry.wins++;
      }
    }

    console.log(
      "\n  Variant                       Mean Total (/40)   Wins"
    );
    for (const [id, data] of totals) {
      const mean = data.total / data.count;
      console.log(
        `  ${id.padEnd(30)} ${mean.toFixed(1).padEnd(18)} ${data.wins}/${data.count}`
      );
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs();

  let variants = VARIANTS;
  let tasks = TEST_TASKS;

  if (flags.variantFilter) {
    const filter = flags.variantFilter;
    if (filter.includes("*")) {
      const regex = new RegExp(
        "^" + filter.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
      );
      variants = variants.filter((v) => regex.test(v.id));
    } else if (filter.includes(".")) {
      variants = variants.filter((v) => v.id === filter);
    } else {
      variants = variants.filter((v) => v.id.startsWith(filter + "."));
    }
    if (variants.length === 0) {
      console.error(
        `No variants matched: ${filter}. Available: ${VARIANTS.map((v) => v.id).join(", ")}`
      );
      process.exit(1);
    }
  }
  if (flags.taskFilter) {
    tasks = tasks.filter((t) => t.id === flags.taskFilter);
    if (tasks.length === 0) {
      console.error(
        `Unknown task: ${flags.taskFilter}. Options: 1, 2, 3`
      );
      process.exit(1);
    }
  }

  // Matrix is variant × task (senses are always all 3)
  const matrix: Array<{ variant: VariantDef; task: TestTask }> = [];
  for (const variant of variants) {
    for (const task of tasks) {
      matrix.push({ variant, task });
    }
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("  Consultation System Prompt A/B Test");
  console.log(`${"═".repeat(72)}`);
  console.log(
    `  Variants: ${variants.map((v) => v.id.toUpperCase()).join(", ")}`
  );
  console.log(`  Tasks: ${tasks.map((t) => t.label).join(", ")}`);
  console.log(`  Senses: ${TEST_SENSES.map((s) => s.label).join(", ")} (all, per trial)`);
  console.log(
    `  Trials: ${matrix.length} (each = 3 consultations + 1 build)`
  );
  console.log(`  Model: ${MODEL}`);
  if (flags.judge) console.log(`  Judge: enabled`);

  if (flags.dryRun) {
    console.log("\n  [DRY RUN — no LLM calls]\n");
    console.log("  Matrix:");
    for (const { variant, task } of matrix) {
      console.log(`    ${variant.id.toUpperCase()} × ${task.label}`);
    }
    console.log(
      `\n  LLM calls: ${matrix.length * 3} consultations + ${matrix.length} builds = ${matrix.length * 4} total`
    );
    return;
  }

  // Execute
  const results: TrialResult[] = [];
  let completed = 0;

  for (const { variant, task } of matrix) {
    completed++;
    console.log(
      `\n  [${completed}/${matrix.length}] ${variant.id.toUpperCase()} × ${task.label}`
    );
    process.stdout.write("    Consulting 3 senses...");

    try {
      const result = await runTrial(variant, task);
      results.push(result);
      console.log(
        ` done (${result.consultDurationMs}ms). Building... done (${result.buildDurationMs}ms). → ${result.htmlPath}`
      );
    } catch (err) {
      console.error(`\n    FAILED:`, err);
    }
  }

  console.log(
    `\n  Completed ${results.length}/${matrix.length} trials.`
  );

  displayResults(results);

  if (flags.judge && results.length > 0) {
    await runJudge(results);
  }

  if (flags.open && results.length > 0) {
    console.log("\n  Opening HTML files in browser...");
    for (const r of results) {
      try {
        execSync(`open "${r.htmlPath}"`);
      } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
