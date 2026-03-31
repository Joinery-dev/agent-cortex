/**
 * Narrator — transforms raw ContentEntry records into human-readable StepNarrative.
 * Each content kind has a specialized narrator that extracts the most meaningful
 * information and presents it in a way that makes Cortex's thinking visible.
 */

import type {
  ContentEntry,
  ContentKind,
  BrainRegion,
  StepNarrative,
  NarrativeSection,
  NarrativeContentType,
} from "./types.js";

// ─── Region mapping for actors ──────────────────────────────────

const COMPONENT_REGION_MAP: Record<string, BrainRegion> = {
  thalamus: "thalamus",
  planner: "prefrontal-cortex",
  "quick-triage": "prefrontal-cortex",
  "attention-scheduler": "attention-scheduler",
  "working-memory": "working-memory",
  "drift-monitor": "drift-monitor",
  conviction: "conviction",
  "cognitive-flexibility": "cognitive-flexibility",
  "world-model": "world-model",
  inhibitor: "prefrontal-cortex",
  "budget-allocator": "budget-allocator",
  sensory: "sensory-cortex",
  motor: "motor-cortex",
  premotor: "motor-cortex",
  proprioception: "motor-cortex",
  cerebellum: "cerebellum",
  hippocampus: "hippocampus",
  "basal-ganglia": "basal-ganglia",
  gate: "basal-ganglia",
  dopamine: "dopamine",
  norepinephrine: "norepinephrine",
  ne: "norepinephrine",
  plasticity: "plasticity",
  exteroception: "exteroception",
  pns: "pns",
  brainstem: "brainstem",
  runner: "brainstem",
  llm: "thalamus",
  structured: "thalamus",
  evaluation: "sensory-cortex",
  consultation: "sensory-cortex",
  resolution: "sensory-cortex",
  tension: "sensory-cortex",
};

function getActorRegion(component: string): BrainRegion {
  // Try exact match first
  if (COMPONENT_REGION_MAP[component]) return COMPONENT_REGION_MAP[component];
  // Try prefix match
  const prefix = component.split("-")[0];
  if (prefix && COMPONENT_REGION_MAP[prefix]) return COMPONENT_REGION_MAP[prefix];
  return "unknown";
}

// ─── JSON helper ────────────────────────────────────────────────

function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  let cleaned = text.trim();

  // Strip markdown fences
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline >= 0) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ─── Section builder ────────────────────────────────────────────

function section(
  label: string,
  content: string,
  contentType: NarrativeContentType = "prose",
  expandedByDefault = false,
): NarrativeSection {
  return {
    label,
    expandedByDefault,
    content,
    contentType,
    byteSize: Buffer.byteLength(content, "utf-8"),
  };
}

// ─── LLM response summarizer ────────────────────────────────────

function summarizeLLMResponse(purpose: string | undefined, responseText: string): string {
  const parsed = tryParseJson(responseText);
  const lowerPurpose = (purpose ?? "").toLowerCase();

  if (parsed && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    // Premotor / motor plan
    if (lowerPurpose.includes("premotor") || lowerPurpose.includes("plan")) {
      const approach = obj.approach ?? obj.strategy ?? obj.plan;
      const confidence = obj.confidence ?? obj.feasibility;
      const steps = Array.isArray(obj.steps) ? obj.steps.length : null;
      const parts: string[] = [];
      if (approach) parts.push(`Approach: ${String(approach)}`);
      if (confidence != null) parts.push(`Confidence: ${String(confidence)}`);
      if (steps != null) parts.push(`${steps} steps`);
      if (parts.length > 0) return parts.join(" | ");
    }

    // Evaluation
    if (lowerPurpose.includes("evaluat")) {
      const score = obj.score ?? obj.overall ?? obj.rating;
      const assessment = obj.assessment ?? obj.summary ?? obj.explanation;
      const parts: string[] = [];
      if (score != null) parts.push(`Score: ${String(score)}`);
      if (assessment) parts.push(String(assessment).slice(0, 120));
      if (parts.length > 0) return parts.join(" — ");
    }

    // Motor / build
    if (lowerPurpose.includes("motor") || lowerPurpose.includes("build")) {
      const artifact = obj.artifact ?? obj.code ?? obj.output;
      if (typeof artifact === "string") {
        return `Produced artifact (${artifact.length} chars)`;
      }
      const files = obj.files ?? obj.artifacts;
      if (Array.isArray(files)) {
        return `Produced ${files.length} artifact(s)`;
      }
    }

    // Resolution / tension
    if (lowerPurpose.includes("resol") || lowerPurpose.includes("tension")) {
      const strategy = obj.strategy ?? obj.resolution ?? obj.approach;
      if (strategy) return `Strategy: ${String(strategy).slice(0, 150)}`;
    }

    // Conviction
    if (lowerPurpose.includes("conviction")) {
      const verdict = obj.verdict ?? obj.decision ?? obj.recommendation;
      if (verdict) return `Verdict: ${String(verdict)}`;
    }

    // NE computation
    if (lowerPurpose.includes("norepinephrine") || lowerPurpose.includes("ne ") || lowerPurpose.includes("arousal")) {
      const level = obj.level ?? obj.ne ?? obj.arousal;
      if (level != null) return `NE level: ${String(level)}`;
    }

    // Generic structured response — show top-level keys
    const keys = Object.keys(obj).slice(0, 5);
    return `Structured response with keys: ${keys.join(", ")}`;
  }

  // Plain text — truncate
  if (responseText.length > 200) {
    return responseText.slice(0, 197) + "...";
  }
  return responseText;
}

// ─── Per-kind narrators ─────────────────────────────────────────

function narrateLLMCall(entry: ContentEntry): StepNarrative {
  const purpose = entry.purpose ?? "LLM call";
  const model = entry.model ?? "unknown model";
  const tokens = entry.tokens;
  const cost = entry.costDollars;

  const inputText = entry.inputs.map((b) => b.text).join("\n\n");
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");

  const responseSummary = outputText
    ? summarizeLLMResponse(entry.purpose, outputText)
    : "(no response)";

  const headline = `LLM: ${purpose}`;
  const summaryParts: string[] = [responseSummary];
  if (tokens) summaryParts.push(`${tokens.input}→${tokens.output} tokens`);
  if (cost != null) summaryParts.push(`$${cost.toFixed(4)}`);

  const sections: NarrativeSection[] = [];
  sections.push(section("Summary", responseSummary, "prose", true));

  if (inputText) {
    sections.push(section("Prompt", inputText, "prompt", false));
  }
  if (outputText) {
    sections.push(section("Response", outputText, "response", false));
  }

  const meta: string[] = [`Model: ${model}`];
  if (tokens) meta.push(`Tokens: ${tokens.input} in → ${tokens.output} out`);
  if (cost != null) meta.push(`Cost: $${cost.toFixed(4)}`);
  sections.push(section("Meta", meta.join("\n"), "prose", false));

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary: summaryParts.join(" | "),
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateStructuredParse(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText);

  const headline = `Parsed: ${entry.purpose ?? entry.component}`;
  const summary = parsed
    ? `Structured output (${typeof parsed === "object" && parsed !== null ? Object.keys(parsed as Record<string, unknown>).length : 0} fields)`
    : "Parse result";

  const sections: NarrativeSection[] = [];
  if (parsed) {
    sections.push(
      section("Parsed Output", JSON.stringify(parsed, null, 2), "json", true),
    );
  }
  if (entry.inputs.length > 0) {
    sections.push(
      section("Raw Input", entry.inputs.map((b) => b.text).join("\n"), "response", false),
    );
  }

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateBriefing(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Briefing: ${entry.purpose ?? "context assembly"}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    // Extract meaningful sections from the briefing

    // Task info
    if (parsed.task || parsed.taskId || parsed.intent) {
      const taskParts: string[] = [];
      if (parsed.taskId) taskParts.push(`Task: ${String(parsed.taskId)}`);
      if (parsed.intent) taskParts.push(`Intent: ${String(parsed.intent)}`);
      if (parsed.task && typeof parsed.task === "object") {
        const task = parsed.task as Record<string, unknown>;
        if (task.description) taskParts.push(String(task.description));
        if (task.type) taskParts.push(`Type: ${String(task.type)}`);
      }
      if (taskParts.length > 0) {
        sections.push(section("Task", taskParts.join("\n"), "prose", true));
      }
    }

    // Taste / preferences
    if (parsed.taste || parsed.preferences) {
      const taste = parsed.taste ?? parsed.preferences;
      const tasteText = typeof taste === "string"
        ? taste
        : JSON.stringify(taste, null, 2);
      sections.push(section("Taste Profile", tasteText, typeof taste === "string" ? "prose" : "json", false));
    }

    // Consultation context
    if (parsed.consultation || parsed.senses || parsed.perspectives) {
      const consultation = parsed.consultation ?? parsed.senses ?? parsed.perspectives;
      const consultText = typeof consultation === "string"
        ? consultation
        : JSON.stringify(consultation, null, 2);
      sections.push(section("Consultation Context", consultText, typeof consultation === "string" ? "prose" : "json", false));
    }

    // Enrichment / history
    if (parsed.enrichment || parsed.history || parsed.episodes) {
      const enrichment = parsed.enrichment ?? parsed.history ?? parsed.episodes;
      const enrichText = typeof enrichment === "string"
        ? enrichment
        : JSON.stringify(enrichment, null, 2);
      sections.push(section("Enrichment", enrichText, typeof enrichment === "string" ? "prose" : "json", false));
    }

    // Evaluation-specific: receptor context
    if (parsed.receptor || parsed.evaluationContext || parsed.receptorContext) {
      const receptor = parsed.receptor ?? parsed.evaluationContext ?? parsed.receptorContext;
      const receptorText = typeof receptor === "string"
        ? receptor
        : JSON.stringify(receptor, null, 2);
      sections.push(section("Receptor Context", receptorText, typeof receptor === "string" ? "prose" : "json", true));
    }

    // World model state
    if (parsed.worldModel || parsed.worldState) {
      const wm = parsed.worldModel ?? parsed.worldState;
      const wmText = typeof wm === "string" ? wm : JSON.stringify(wm, null, 2);
      sections.push(section("World Model", wmText, typeof wm === "string" ? "prose" : "json", false));
    }

    // Meta / NE / predictions
    if (parsed.meta || parsed.ne || parsed.predictions || parsed.norepinephrine) {
      const metaParts: string[] = [];
      if (parsed.ne != null || parsed.norepinephrine != null) {
        metaParts.push(`NE: ${String(parsed.ne ?? parsed.norepinephrine)}`);
      }
      if (parsed.predictions) {
        metaParts.push(`Predictions: ${JSON.stringify(parsed.predictions)}`);
      }
      if (parsed.meta) {
        metaParts.push(typeof parsed.meta === "string"
          ? parsed.meta
          : JSON.stringify(parsed.meta, null, 2));
      }
      if (metaParts.length > 0) {
        sections.push(section("Meta", metaParts.join("\n"), "prose", false));
      }
    }

    // If we extracted nothing specific, show the full briefing
    if (sections.length === 0) {
      sections.push(section("Full Briefing", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else {
    // Not JSON — show raw
    sections.push(section("Briefing Content", outputText, "prose", true));
  }

  const summary = sections.length > 0
    ? `${sections.length} section(s): ${sections.map((s) => s.label).join(", ")}`
    : "Briefing assembled";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateConsultation(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Consultation: ${entry.purpose ?? entry.component}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    // Sense perspective
    if (parsed.perspective || parsed.analysis || parsed.assessment) {
      const perspective = parsed.perspective ?? parsed.analysis ?? parsed.assessment;
      sections.push(section(
        "Sense Perspective",
        typeof perspective === "string" ? perspective : JSON.stringify(perspective, null, 2),
        typeof perspective === "string" ? "prose" : "json",
        true,
      ));
    }

    // Evaluators / dimensions
    if (parsed.evaluators || parsed.dimensions || parsed.scores) {
      const evaluators = parsed.evaluators ?? parsed.dimensions ?? parsed.scores;
      sections.push(section(
        "Evaluators",
        typeof evaluators === "string" ? evaluators : JSON.stringify(evaluators, null, 2),
        "json",
        false,
      ));
    }

    // Tensions
    if (parsed.tensions || parsed.concerns) {
      const tensions = parsed.tensions ?? parsed.concerns;
      sections.push(section(
        "Tensions Raised",
        typeof tensions === "string" ? tensions : JSON.stringify(tensions, null, 2),
        typeof tensions === "string" ? "prose" : "json",
        true,
      ));
    }

    if (sections.length === 0) {
      sections.push(section("Full Response", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Response", outputText, "prose", true));
  }

  const summary = parsed
    ? `Sense perspective with ${sections.length} section(s)`
    : "Consultation response";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateEvaluation(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Evaluation: ${entry.purpose ?? entry.component}`;
  const sections: NarrativeSection[] = [];
  let score: string | null = null;

  if (parsed) {
    // Score
    if (parsed.score != null || parsed.overall != null || parsed.rating != null) {
      score = String(parsed.score ?? parsed.overall ?? parsed.rating);
      sections.push(section("Score", score, "prose", true));
    }

    // Assessment
    if (parsed.assessment || parsed.explanation || parsed.summary) {
      const assessment = String(parsed.assessment ?? parsed.explanation ?? parsed.summary);
      sections.push(section("Assessment", assessment, "prose", true));
    }

    // Suggestions / improvements
    if (parsed.suggestions || parsed.improvements || parsed.recommendations) {
      const suggestions = parsed.suggestions ?? parsed.improvements ?? parsed.recommendations;
      sections.push(section(
        "Suggestions",
        typeof suggestions === "string" ? suggestions : JSON.stringify(suggestions, null, 2),
        typeof suggestions === "string" ? "prose" : "json",
        true,
      ));
    }

    // Improvement potential
    if (parsed.improvementPotential != null || parsed.potential != null) {
      const potential = String(parsed.improvementPotential ?? parsed.potential);
      sections.push(section("Improvement Potential", potential, "prose", false));
    }

    // Dimensions
    if (parsed.dimensions || parsed.breakdown) {
      const dims = parsed.dimensions ?? parsed.breakdown;
      sections.push(section(
        "Dimensions",
        typeof dims === "string" ? dims : JSON.stringify(dims, null, 2),
        "json",
        false,
      ));
    }

    if (sections.length === 0) {
      sections.push(section("Full Evaluation", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Evaluation", outputText, "prose", true));
  }

  const summary = score
    ? `Score: ${score} — ${sections.length} section(s)`
    : "Evaluation complete";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateMotorPlan(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Motor Plan: ${entry.purpose ?? "approach planning"}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    // Approach
    if (parsed.approach || parsed.strategy) {
      const approach = String(parsed.approach ?? parsed.strategy);
      sections.push(section("Approach", approach, "prose", true));
    }

    // Steps
    if (Array.isArray(parsed.steps)) {
      const stepsText = parsed.steps.map((s, i) =>
        `${i + 1}. ${typeof s === "string" ? s : (s as Record<string, unknown>).description ?? JSON.stringify(s)}`,
      ).join("\n");
      sections.push(section("Steps", stepsText, "prose", true));
    }

    // Confidence / feasibility
    if (parsed.confidence != null || parsed.feasibility != null) {
      sections.push(section(
        "Confidence",
        String(parsed.confidence ?? parsed.feasibility),
        "prose",
        true,
      ));
    }

    // Tension strategy
    if (parsed.tensionStrategy || parsed.tensionHandling) {
      const ts = parsed.tensionStrategy ?? parsed.tensionHandling;
      sections.push(section(
        "Tension Strategy",
        typeof ts === "string" ? ts : JSON.stringify(ts, null, 2),
        typeof ts === "string" ? "prose" : "json",
        false,
      ));
    }

    if (sections.length === 0) {
      sections.push(section("Full Plan", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Plan", outputText, "prose", true));
  }

  const summary = parsed
    ? `${Array.isArray(parsed.steps) ? parsed.steps.length + " steps" : "Plan ready"} | Confidence: ${parsed.confidence ?? parsed.feasibility ?? "?"}`
    : "Motor plan produced";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateMotorWork(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");

  const headline = `Motor Work: ${entry.purpose ?? "build execution"}`;
  const totalBytes = entry.outputs.reduce((sum, b) => sum + b.bytes, 0);

  const sections: NarrativeSection[] = [];
  for (const block of entry.outputs) {
    const contentType: NarrativeContentType = block.label.includes("code") || block.label.includes("artifact")
      ? "code"
      : block.label.includes("diff")
        ? "diff"
        : "response";
    sections.push(section(block.label, block.text, contentType, true));
  }

  if (sections.length === 0 && outputText) {
    sections.push(section("Work Product", outputText, "code", true));
  }

  const summary = `Produced ${totalBytes} bytes across ${entry.outputs.length} output(s)`;

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateSelfAssessment(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Self-Assessment: ${entry.purpose ?? entry.component}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    if (parsed.adherence != null) {
      sections.push(section("Adherence", String(parsed.adherence), "prose", true));
    }
    if (parsed.drift || parsed.driftAreas) {
      const drift = parsed.drift ?? parsed.driftAreas;
      sections.push(section(
        "Drift Areas",
        typeof drift === "string" ? drift : JSON.stringify(drift, null, 2),
        typeof drift === "string" ? "prose" : "json",
        true,
      ));
    }
    if (parsed.corrections || parsed.adjustments) {
      const corr = parsed.corrections ?? parsed.adjustments;
      sections.push(section(
        "Corrections",
        typeof corr === "string" ? corr : JSON.stringify(corr, null, 2),
        typeof corr === "string" ? "prose" : "json",
        false,
      ));
    }
    if (sections.length === 0) {
      sections.push(section("Full Assessment", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Assessment", outputText, "prose", true));
  }

  const summary = parsed?.adherence != null
    ? `Adherence: ${parsed.adherence}`
    : "Self-assessment complete";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateResolution(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Resolution: ${entry.purpose ?? "tension resolution"}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    // Tension being resolved
    if (parsed.tension || parsed.conflict) {
      const tension = String(parsed.tension ?? parsed.conflict);
      sections.push(section("Tension", tension, "prose", true));
    }

    // Resolution strategy
    if (parsed.strategy || parsed.resolution || parsed.approach) {
      const strategy = String(parsed.strategy ?? parsed.resolution ?? parsed.approach);
      sections.push(section("Strategy", strategy, "prose", true));
    }

    // Instructions
    if (parsed.instructions || parsed.directive) {
      const instructions = String(parsed.instructions ?? parsed.directive);
      sections.push(section("Instructions", instructions, "prose", true));
    }

    if (sections.length === 0) {
      sections.push(section("Full Resolution", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Resolution", outputText, "prose", true));
  }

  const summary = parsed?.strategy
    ? `Strategy: ${String(parsed.strategy).slice(0, 100)}`
    : "Resolution complete";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateConviction(entry: ContentEntry): StepNarrative {
  const outputText = entry.outputs.map((b) => b.text).join("\n\n");
  const parsed = tryParseJson(outputText) as Record<string, unknown> | null;

  const headline = `Conviction: ${entry.purpose ?? "assessment"}`;
  const sections: NarrativeSection[] = [];

  if (parsed) {
    if (parsed.verdict || parsed.decision) {
      const verdict = String(parsed.verdict ?? parsed.decision);
      sections.push(section("Verdict", verdict, "prose", true));
    }
    if (parsed.evidence || parsed.reasoning) {
      const evidence = parsed.evidence ?? parsed.reasoning;
      sections.push(section(
        "Evidence",
        typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2),
        typeof evidence === "string" ? "prose" : "json",
        true,
      ));
    }
    if (parsed.shaping || parsed.influence) {
      const shaping = parsed.shaping ?? parsed.influence;
      sections.push(section(
        "Shaping",
        typeof shaping === "string" ? shaping : JSON.stringify(shaping, null, 2),
        typeof shaping === "string" ? "prose" : "json",
        false,
      ));
    }
    if (sections.length === 0) {
      sections.push(section("Full Conviction", JSON.stringify(parsed, null, 2), "json", true));
    }
  } else if (outputText) {
    sections.push(section("Conviction", outputText, "prose", true));
  }

  const summary = parsed?.verdict
    ? `Verdict: ${String(parsed.verdict)}`
    : "Conviction assessment complete";

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

function narrateGeneric(entry: ContentEntry): StepNarrative {
  const headline = `${entry.kind}: ${entry.purpose ?? entry.component}`;
  const sections: NarrativeSection[] = [];

  for (const block of entry.inputs) {
    sections.push(section(`Input: ${block.label}`, block.text, "prose", false));
  }
  for (const block of entry.outputs) {
    sections.push(section(`Output: ${block.label}`, block.text, "prose", true));
  }

  if (sections.length === 0) {
    sections.push(section("(empty)", "No content captured", "prose", true));
  }

  const totalBytes = [...entry.inputs, ...entry.outputs].reduce((s, b) => s + b.bytes, 0);
  const summary = `${entry.inputs.length} input(s), ${entry.outputs.length} output(s) — ${totalBytes} bytes`;

  return {
    contentId: entry.id,
    eventSeq: entry.eventSeq,
    kind: entry.kind,
    headline,
    summary,
    actor: entry.component,
    actorRegion: getActorRegion(entry.component),
    timestamp: entry.timestamp,
    sections,
  };
}

// ─── Narrator dispatch ──────────────────────────────────────────

const KIND_NARRATORS: Record<ContentKind, (entry: ContentEntry) => StepNarrative> = {
  "llm-call": narrateLLMCall,
  "structured-parse": narrateStructuredParse,
  briefing: narrateBriefing,
  consultation: narrateConsultation,
  evaluation: narrateEvaluation,
  "motor-plan": narrateMotorPlan,
  "motor-work": narrateMotorWork,
  "self-assessment": narrateSelfAssessment,
  tension: narrateGeneric,
  "tension-resolution": narrateResolution,
  conviction: narrateConviction,
  "gate-decision": narrateGeneric,
  "explore-path": narrateGeneric,
  reconsultation: narrateConsultation,
  "ne-computation": narrateGeneric,
  flexibility: narrateGeneric,
  dopamine: narrateGeneric,
  checkpoint: narrateGeneric,
  "inquiry-synthesis": narrateGeneric,
  manifestation: narrateGeneric,
};

export function narrate(entry: ContentEntry): StepNarrative {
  const narrator = KIND_NARRATORS[entry.kind] ?? narrateGeneric;
  return narrator(entry);
}

export function narrateAll(entries: ContentEntry[]): StepNarrative[] {
  return entries.map(narrate);
}
