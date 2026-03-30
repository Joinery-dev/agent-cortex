/**
 * Graph Builder Experiments
 *
 * Tests approaches for Shael Dependency Wiring (Phase B.2).
 *
 * Experiment A: All-in-one — LLM outputs provides, consumes, deps, AND affinity groups
 * Experiment B: Provides/consumes only — LLM identifies semantic map, deps derived algorithmically
 * Experiment C: Two-pass — LLM does semantic mapping, then second LLM wires deps + affinities
 * Experiment D: Inline — decomposer produces shaels WITH provides/consumes in one call
 * Experiment E: Algorithmic deps + affinity-only LLM — mechanical deps, LLM only for affinity
 *
 * Uses a hierarchical project (healthcare patient portal) with full shaela→shael→shael→shana
 * depth to stress-test dependency wiring across nesting levels.
 *
 * Run: npx tsx examples/graph-builder-experiments.ts [a|b|c|d|e|all]
 */

import { z } from "zod";
import { callStructured } from "../src/llm/structured.js";
import { SHAELA_WORLDVIEW } from "../src/types/worldview.js";

// ─── Test Data: Hierarchical Decomposition ─────────────────────────
//
// Shaela: "How do we create a patient portal that connects patients,
//          providers, and administrators into a coherent healthcare experience?"
//
// The decomposition produces a TREE of nested questions:
//   shaela (project)
//     └─ shael (phase-level questions)
//          └─ shael (feature-level questions)
//               └─ shana (buildable in one cycle)
//
// The graph builder must wire dependencies ACROSS all levels of nesting.

interface Shael {
  id: string;
  description: string;
  level: "shael" | "shana";
  phaseGroup: string;
  parentId: string | null;
  gateCondition: string;
}

const SHAELA_DESCRIPTION = "How do we create a patient portal that connects patients, providers, and administrators into a coherent healthcare experience?";

/**
 * 22 shaels across 4 phases, 3 nesting levels.
 * Phase-level shaels contain feature-level shaels which contain shana.
 * This mirrors a real decomposition where the graph builder sees the full tree.
 */
const SHAELS: Shael[] = [
  // ── Phase: Foundation ─────────────────────────────────────────
  // Phase-level shael
  {
    id: "f1",
    description: "The clinical data model must represent patients, providers, encounters, conditions, medications, labs, and their temporal relationships — faithfully enough to support clinical decision-making",
    level: "shael",
    phaseGroup: "foundation",
    parentId: null,
    gateCondition: "Schema handles a realistic patient record with history, medications, labs, and provider relationships",
  },
  // Shana within f1
  {
    id: "f1a",
    description: "Define the core entity schemas — Patient, Provider, Encounter — with demographic, credentialing, and temporal fields",
    level: "shana",
    phaseGroup: "foundation",
    parentId: "f1",
    gateCondition: "Core entities instantiate with valid data and relate to each other correctly",
  },
  {
    id: "f1b",
    description: "Define the clinical schemas — Condition, Medication, LabResult, Allergy — linked to encounters and patients with effective date ranges",
    level: "shana",
    phaseGroup: "foundation",
    parentId: "f1",
    gateCondition: "Clinical data links to patients and encounters with temporal validity",
  },
  // Phase-level shael
  {
    id: "f2",
    description: "The identity and access boundary must enforce HIPAA-grade separation — patients see only their own data, providers see only their panel, administrators see aggregate without PII",
    level: "shael",
    phaseGroup: "foundation",
    parentId: null,
    gateCondition: "Each role can only access data within its authorization scope, verified by automated tests",
  },
  {
    id: "f2a",
    description: "Implement role-based access control with patient, provider, and admin roles — including the provider-patient relationship that gates clinical data access",
    level: "shana",
    phaseGroup: "foundation",
    parentId: "f2",
    gateCondition: "RBAC enforces role boundaries; provider can only see patients in their panel",
  },
  {
    id: "f2b",
    description: "Build the audit trail — every data access logged with who, what, when, why — required for HIPAA compliance",
    level: "shana",
    phaseGroup: "foundation",
    parentId: "f2",
    gateCondition: "All data access events are logged immutably with sufficient detail for compliance audit",
  },
  // Phase-level shael
  {
    id: "f3",
    description: "The design language must feel calm, trustworthy, and accessible — WCAG AA minimum, clear typography hierarchy, consistent across patient and provider interfaces",
    level: "shael",
    phaseGroup: "foundation",
    parentId: null,
    gateCondition: "Component library passes WCAG AA, renders consistently across patient and provider views",
  },

  // ── Phase: Patient Experience ─────────────────────────────────
  {
    id: "p1",
    description: "Patients must see their health record as a coherent narrative — conditions, medications, lab trends, upcoming appointments — not a database dump",
    level: "shael",
    phaseGroup: "patient-experience",
    parentId: null,
    gateCondition: "A patient can view their complete health summary with temporal context and trends",
  },
  {
    id: "p1a",
    description: "Build the health summary view — active conditions, current medications, recent labs with trend indicators, allergies — organized by clinical relevance not data table",
    level: "shana",
    phaseGroup: "patient-experience",
    parentId: "p1",
    gateCondition: "Health summary renders with real patient data, organized by clinical priority",
  },
  {
    id: "p1b",
    description: "Build the encounter history view — past visits displayed as a timeline with provider, reason, outcomes, and linked clinical data per encounter",
    level: "shana",
    phaseGroup: "patient-experience",
    parentId: "p1",
    gateCondition: "Encounter timeline renders chronologically with drill-down to per-encounter details",
  },
  {
    id: "p2",
    description: "Appointment scheduling must balance patient convenience with provider availability — request, confirm, reschedule, cancel — with appropriate lead time rules",
    level: "shael",
    phaseGroup: "patient-experience",
    parentId: null,
    gateCondition: "A patient can request, confirm, reschedule, and cancel appointments within business rules",
  },
  {
    id: "p3",
    description: "Secure messaging between patients and their care team — threaded, asynchronous, with the ability to attach documents and route to the appropriate provider",
    level: "shael",
    phaseGroup: "patient-experience",
    parentId: null,
    gateCondition: "Messages deliver between patient and their care team with attachment support and routing",
  },
  {
    id: "p4",
    description: "Prescription management from the patient side — view active prescriptions, request refills, see fulfillment status, understand interactions and instructions",
    level: "shael",
    phaseGroup: "patient-experience",
    parentId: null,
    gateCondition: "Patient can view prescriptions, request refills, and see fulfillment status",
  },

  // ── Phase: Provider Experience ────────────────────────────────
  {
    id: "v1",
    description: "Providers must have a clinical dashboard — their patient panel, today's schedule, pending messages, outstanding lab results, action items — all at a glance",
    level: "shael",
    phaseGroup: "provider-experience",
    parentId: null,
    gateCondition: "Provider dashboard shows panel, schedule, messages, labs, and action items in one view",
  },
  {
    id: "v2",
    description: "Clinical documentation — providers record encounter notes, update problem lists, prescribe medications, order labs — with appropriate clinical decision support",
    level: "shael",
    phaseGroup: "provider-experience",
    parentId: null,
    gateCondition: "Provider can document an encounter, update conditions/medications, and order labs from one workflow",
  },
  {
    id: "v2a",
    description: "Build the encounter note workflow — structured templates with free-text, auto-populated from patient context, saved as part of the encounter record",
    level: "shana",
    phaseGroup: "provider-experience",
    parentId: "v2",
    gateCondition: "Encounter note saves with structured and free-text fields, linked to the encounter",
  },
  {
    id: "v2b",
    description: "Build the prescribing workflow — medication search, dosage selection, interaction checking against patient's active meds and allergies, e-prescribe submission",
    level: "shana",
    phaseGroup: "provider-experience",
    parentId: "v2",
    gateCondition: "Provider can prescribe with interaction checking and the prescription appears in patient's record",
  },
  {
    id: "v3",
    description: "Appointment management from the provider side — view schedule, confirm/reschedule patient requests, manage availability slots, handle walk-ins",
    level: "shael",
    phaseGroup: "provider-experience",
    parentId: null,
    gateCondition: "Provider can manage their schedule, respond to requests, and set availability",
  },

  // ── Phase: Administration & Infrastructure ────────────────────
  {
    id: "a1",
    description: "Administrative reporting — patient population analytics, appointment utilization, provider productivity, compliance status — aggregate views without exposing PII",
    level: "shael",
    phaseGroup: "admin-infrastructure",
    parentId: null,
    gateCondition: "Admin can view aggregate analytics across all dimensions without seeing individual patient data",
  },
  {
    id: "a2",
    description: "Notification infrastructure — appointment reminders, lab result availability, message alerts, prescription status changes — delivered via appropriate channel per patient preference",
    level: "shael",
    phaseGroup: "admin-infrastructure",
    parentId: null,
    gateCondition: "Notifications fire on all trigger events and route through patient-preferred channels",
  },
  {
    id: "a2a",
    description: "Build the notification dispatch engine — event-driven, channel-aware (email, SMS, push), preference-respecting, with delivery tracking and retry",
    level: "shana",
    phaseGroup: "admin-infrastructure",
    parentId: "a2",
    gateCondition: "Dispatch engine routes events through correct channels with retry and delivery confirmation",
  },
  {
    id: "a2b",
    description: "Define notification trigger rules — which clinical and scheduling events produce notifications, to whom, with what urgency and content template",
    level: "shana",
    phaseGroup: "admin-infrastructure",
    parentId: "a2",
    gateCondition: "Trigger rules cover all lifecycle events with appropriate urgency classification",
  },
];

const MANIFESTED_FUTURE = `A patient portal where healthcare feels coherent, not fragmented. Patients see their health as a narrative — conditions, medications, lab trends, encounters — organized by clinical relevance, not database structure. They schedule appointments, message their care team, manage prescriptions, and receive timely notifications through their preferred channels. Providers have a clinical dashboard that surfaces what matters: their panel, today's schedule, pending messages, outstanding labs, action items. They document encounters with structured templates auto-populated from patient context, prescribe with interaction checking, and manage their availability. Administrators see the system's health through aggregate analytics — utilization, productivity, compliance — without exposing individual patient data. The whole system enforces HIPAA-grade access boundaries: patients see only their data, providers see only their panel, audit trails capture every access. The visual language is calm and trustworthy, WCAG AA accessible, consistent across every interface. Notifications keep everyone informed at the right time through the right channel.`;

// ─── Shared utilities ──────────────────────────────────────────────

function formatShaelTree(): string {
  const roots = SHAELS.filter(s => s.parentId === null);
  const lines: string[] = [];
  for (const root of roots) {
    lines.push(`${root.id} [${root.level}]: ${root.description}`);
    lines.push(`  Phase: ${root.phaseGroup} | Gate: ${root.gateCondition}`);
    const children = SHAELS.filter(s => s.parentId === root.id);
    for (const child of children) {
      lines.push(`  └─ ${child.id} [${child.level}]: ${child.description}`);
      lines.push(`     Gate: ${child.gateCondition}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatShaelFlat(): string {
  return SHAELS.map(s => {
    const indent = s.parentId ? "  " : "";
    const parent = s.parentId ? ` (child of ${s.parentId})` : "";
    return `${indent}${s.id} [${s.level}]${parent}: ${s.description}\n${indent}  Phase: ${s.phaseGroup} | Gate: ${s.gateCondition}`;
  }).join("\n\n");
}

// ─── Shared types ──────────────────────────────────────────────────

interface ProvideConsume {
  capability: string;
  description: string;
}

interface SemanticMapEntry {
  id: string;
  provides: ProvideConsume[];
  consumes: ProvideConsume[];
}

interface DerivedGraph {
  deps: Map<string, string[]>;
  affinityGroups: Array<{ name: string; shaelIds: string[]; sharedCapability: string }>;
}

/**
 * Algorithmically derive dependencies from provides/consumes mapping.
 */
function deriveDependencies(shaels: SemanticMapEntry[]): DerivedGraph {
  // Build capability → provider map
  const providers = new Map<string, string[]>();
  for (const shael of shaels) {
    for (const p of shael.provides) {
      if (!providers.has(p.capability)) providers.set(p.capability, []);
      providers.get(p.capability)!.push(shael.id);
    }
  }

  // Derive dependencies
  const deps = new Map<string, string[]>();
  for (const shael of shaels) {
    const shaelDeps: string[] = [];
    for (const c of shael.consumes) {
      const capProviders = providers.get(c.capability) ?? [];
      for (const provider of capProviders) {
        if (provider !== shael.id && !shaelDeps.includes(provider)) {
          shaelDeps.push(provider);
        }
      }
    }
    deps.set(shael.id, shaelDeps);
  }

  // Detect affinity (shared capability, not all hard-dep-connected)
  const capabilityTouchers = new Map<string, Set<string>>();
  for (const shael of shaels) {
    for (const p of shael.provides) {
      if (!capabilityTouchers.has(p.capability)) capabilityTouchers.set(p.capability, new Set());
      capabilityTouchers.get(p.capability)!.add(shael.id);
    }
    for (const c of shael.consumes) {
      if (!capabilityTouchers.has(c.capability)) capabilityTouchers.set(c.capability, new Set());
      capabilityTouchers.get(c.capability)!.add(shael.id);
    }
  }

  const affinityGroups: DerivedGraph["affinityGroups"] = [];
  for (const [capability, touchers] of capabilityTouchers) {
    if (touchers.size >= 2) {
      const ids = [...touchers];
      const allHardDeps = ids.every((id, i) =>
        ids.every((otherId, j) => i === j || deps.get(id)?.includes(otherId) || deps.get(otherId)?.includes(id))
      );
      if (!allHardDeps) {
        affinityGroups.push({ name: capability, shaelIds: ids, sharedCapability: capability });
      }
    }
  }

  return { deps, affinityGroups };
}

function validateTopologicalOrder(
  order: string[],
  deps: Map<string, string[]> | Array<{ from: string; to: string }>,
): { valid: boolean; violations: string[] } {
  const posMap = new Map(order.map((id, i) => [id, i]));
  const violations: string[] = [];

  // Normalize to Map
  let depMap: Map<string, string[]>;
  if (Array.isArray(deps)) {
    depMap = new Map();
    for (const d of deps) {
      if (!depMap.has(d.from)) depMap.set(d.from, []);
      depMap.get(d.from)!.push(d.to);
    }
  } else {
    depMap = deps;
  }

  for (const [from, tos] of depMap) {
    const fromPos = posMap.get(from) ?? -1;
    for (const to of tos) {
      const toPos = posMap.get(to) ?? -1;
      if (toPos >= fromPos) {
        violations.push(`${from} (pos ${fromPos}) depends on ${to} (pos ${toPos})`);
      }
    }
  }

  const allIds = new Set(SHAELS.map(s => s.id));
  const missing = [...allIds].filter(id => !posMap.has(id));
  if (missing.length) violations.push(`missing from order: ${missing.join(", ")}`);

  return { valid: violations.length === 0, violations };
}

function printDepsTable(deps: Map<string, string[]>): void {
  let totalEdges = 0;
  const roots: string[] = [];
  for (const [id, d] of deps) {
    totalEdges += d.length;
    if (d.length === 0) roots.push(id);
  }
  console.log(`  Total dependency edges: ${totalEdges}`);
  console.log(`  Root nodes (no deps): ${roots.join(", ")}`);

  // Detect cycles
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let hasCycle = false;
  function dfs(id: string): void {
    if (inStack.has(id)) { hasCycle = true; return; }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    for (const dep of deps.get(id) ?? []) dfs(dep);
    inStack.delete(id);
  }
  for (const id of deps.keys()) dfs(id);
  if (hasCycle) console.log("  ⚠ CYCLE DETECTED in dependency graph");
  else console.log("  ✓ No cycles");
}

// ─── Experiment A: All-in-One ──────────────────────────────────────

const ExperimentASchema = z.object({
  reasoning: z.string(),
  shaels: z.array(z.object({
    id: z.string(),
    provides: z.array(z.string()),
    consumes: z.array(z.string()),
    dependsOn: z.array(z.string()),
  })),
  affinityGroups: z.array(z.object({
    name: z.string(),
    shaelIds: z.array(z.string()),
    sharedBoundary: z.string(),
  })),
  topologicalOrder: z.array(z.string()),
});

type ExperimentAResult = z.infer<typeof ExperimentASchema>;

function experimentASystem(): string {
  return `${SHAELA_WORLDVIEW.preamble}

You are the Graph Builder — Phase B.2: Shael Dependency Wiring.

You see ALL shaels from the decomposition simultaneously — a TREE of nested questions at different levels (shael = architectural question, shana = buildable in one cycle). Your job: wire the dependency graph ACROSS all nesting levels.

For each shael/shana, identify:
- PROVIDES: What understanding, artifacts, or capabilities does this produce?
- CONSUMES: What must already exist for this to be lived?

Wire DEPENDENCIES from provides/consumes — ordering constraints across any nesting level. A shana in one branch may depend on a shael in another.

Identify AFFINITY GROUPS — nodes that share a boundary and create mutual constraints without hard dependencies. Especially important across nesting levels: a patient-facing shana and a provider-facing shana may share a clinical data contract.

Produce a TOPOLOGICAL ORDER that respects all dependencies.

This is COARSE, ARCHITECTURAL wiring at every level. Output a valid JSON object.`;
}

function experimentAUser(): string {
  return `SHAELA
${SHAELA_DESCRIPTION}

MANIFESTED FUTURE
${MANIFESTED_FUTURE}

DECOMPOSITION (tree of shaels and shana)
${formatShaelTree()}

Wire the full dependency graph across all nesting levels. Return JSON:
{
  "reasoning": "how you analyzed provides/consumes across the tree",
  "shaels": [
    { "id": "f1", "provides": ["what it produces"], "consumes": ["what it needs"], "dependsOn": ["ids"] }
  ],
  "affinityGroups": [
    { "name": "group-name", "shaelIds": ["f1", "p1"], "sharedBoundary": "what boundary they share" }
  ],
  "topologicalOrder": ["f1", "f1a", "..."]
}`;
}

// ─── Experiment B: Provides/Consumes Only, Algorithmic Deps ────────

const SemanticMapSchema = z.object({
  reasoning: z.string(),
  shaels: z.array(z.object({
    id: z.string(),
    provides: z.array(z.object({
      capability: z.string(),
      description: z.string(),
    })),
    consumes: z.array(z.object({
      capability: z.string(),
      description: z.string(),
    })),
  })),
});

type SemanticMapResult = z.infer<typeof SemanticMapSchema>;

function semanticMapSystem(): string {
  return `${SHAELA_WORLDVIEW.preamble}

You are the Graph Builder — Phase B.2: Semantic Mapping.

You see a TREE of nested questions (shael = architectural, shana = buildable). Your job: identify what each node PROVIDES and CONSUMES across all levels. Do NOT wire dependencies — that's done algorithmically.

Use STRUCTURED TOKENS — a short capability name and description. Tokens must be CONSISTENT: if one node provides "clinical-data-model" another must consume "clinical-data-model", not "patient-data" or "data-schema".

A shana within a parent shael inherits context but may provide/consume independently. A shana can consume capabilities from a different branch of the tree.

Output a valid JSON object.`;
}

function semanticMapUser(): string {
  return `SHAELA
${SHAELA_DESCRIPTION}

MANIFESTED FUTURE
${MANIFESTED_FUTURE}

DECOMPOSITION
${formatShaelFlat()}

For each node (shael and shana), identify provides and consumes with consistent tokens.

Return JSON:
{
  "reasoning": "how you analyzed capabilities across the tree",
  "shaels": [
    {
      "id": "f1",
      "provides": [{ "capability": "clinical-data-model", "description": "what this means" }],
      "consumes": [{ "capability": "auth-boundary", "description": "why needed" }]
    }
  ]
}`;
}

// ─── Experiment C: Two-Pass (semantic map → LLM wiring) ────────────

const WiringSchema = z.object({
  reasoning: z.string(),
  dependencies: z.array(z.object({
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  })),
  affinityGroups: z.array(z.object({
    name: z.string(),
    shaelIds: z.array(z.string()),
    sharedBoundary: z.string(),
    coDesignRisk: z.string(),
  })),
  topologicalOrder: z.array(z.string()),
});

type WiringResult = z.infer<typeof WiringSchema>;

function wiringSystem(): string {
  return `${SHAELA_WORLDVIEW.preamble}

You are the Graph Builder — Phase B.2, Pass 2: Dependency Wiring.

You have a semantic map of what each node (shael and shana) provides and consumes. Wire the full dependency graph.

DEPENDENCIES: If A consumes a capability B provides, A depends on B. Express as directed edges. Dependencies can cross nesting levels — a shana may depend on a shael from another branch.

AFFINITY GROUPS: Nodes sharing a boundary with mutual constraints even without hard deps. For each group, identify the CO-DESIGN RISK — what goes wrong if these are built without awareness of each other?

TOPOLOGICAL ORDER: Valid execution ordering respecting all dependencies.

Output a valid JSON object.`;
}

function wiringUser(semanticMap: SemanticMapResult): string {
  const descriptions = SHAELS.map(s => {
    const parent = s.parentId ? ` (child of ${s.parentId})` : "";
    return `${s.id} [${s.level}]${parent}: ${s.description}`;
  }).join("\n");

  const map = semanticMap.shaels.map(s => {
    const provides = s.provides.map(p => `    provides: "${p.capability}" — ${p.description}`).join("\n");
    const consumes = s.consumes.map(c => `    consumes: "${c.capability}" — ${c.description}`).join("\n");
    return `${s.id}:\n${provides}\n${consumes}`;
  }).join("\n\n");

  return `SHAEL DESCRIPTIONS
${descriptions}

SEMANTIC MAP
${map}

Wire deps, identify affinity groups with co-design risks, produce topological order.

Return JSON:
{
  "reasoning": "how you wired from the semantic map",
  "dependencies": [{ "from": "p1a", "to": "f1", "reason": "why" }],
  "affinityGroups": [{
    "name": "group", "shaelIds": ["p1a", "v2a"],
    "sharedBoundary": "what they share", "coDesignRisk": "what breaks"
  }],
  "topologicalOrder": ["f1", "f1a", "..."]
}`;
}

// ─── Experiment D: Inline provides/consumes in decomposer ──────────

const DecomposerInlineSchema = z.object({
  reasoning: z.string(),
  shaels: z.array(z.object({
    id: z.string(),
    description: z.string(),
    level: z.enum(["shael", "shana"]),
    phaseGroup: z.string(),
    parentId: z.string().nullable(),
    gateCondition: z.string(),
    provides: z.array(z.object({
      capability: z.string(),
      description: z.string(),
    })),
    consumes: z.array(z.object({
      capability: z.string(),
      description: z.string(),
    })),
  })),
});

type DecomposerInlineResult = z.infer<typeof DecomposerInlineSchema>;

function decomposerInlineSystem(): string {
  return `${SHAELA_WORLDVIEW.preamble}

You are the Planner — Phase B.1: Decomposition with Semantic Mapping.

Given a manifested future, reason BACKWARD to produce a tree of nested questions:
- Shaels: architectural questions that contain smaller questions
- Shana: questions specific enough to be lived in one build cycle

Organize into phases. Every node passes three gates:
1. EXISTENCE: What breaks without this? If nothing, cut it.
2. FORM: Could something simpler work? If yes, simplify.
3. SCOPE: Could it be smaller? If yes, shrink.

FOR EACH NODE, also identify:
- PROVIDES: Capabilities this node produces. Use consistent structured tokens.
- CONSUMES: Capabilities this node requires. Use the SAME tokens as provides elsewhere.

The provides/consumes mapping will be used to wire dependencies mechanically. Consistent tokens are critical — if one node provides "auth-boundary" and another consumes "authentication", that's a miss.

This is a combined call: decomposition + semantic mapping in one step. Both must be high quality.

Output a valid JSON object.`;
}

function decomposerInlineUser(): string {
  return `SHAELA
${SHAELA_DESCRIPTION}

MANIFESTED FUTURE
${MANIFESTED_FUTURE}

Reason backward from the manifested future. Produce a hierarchical decomposition (shaels containing shana) WITH provides/consumes tokens for each node.

Return JSON:
{
  "reasoning": "backward reasoning trace",
  "shaels": [
    {
      "id": "f1",
      "description": "question to be lived",
      "level": "shael",
      "phaseGroup": "foundation",
      "parentId": null,
      "gateCondition": "what must be true when complete",
      "provides": [{ "capability": "clinical-data-model", "description": "what" }],
      "consumes": [{ "capability": "auth-boundary", "description": "why" }]
    }
  ]
}`;
}

// ─── Experiment E: Algorithmic deps + affinity-only LLM ────────────

const AffinityOnlySchema = z.object({
  reasoning: z.string(),
  affinityGroups: z.array(z.object({
    name: z.string(),
    shaelIds: z.array(z.string()),
    sharedBoundary: z.string(),
    coDesignRisk: z.string(),
  })),
  depCorrections: z.array(z.object({
    action: z.enum(["add", "remove"]),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  })),
});

type AffinityOnlyResult = z.infer<typeof AffinityOnlySchema>;

function affinityOnlySystem(): string {
  return `${SHAELA_WORLDVIEW.preamble}

You are the Graph Builder — Phase B.2: Affinity Analysis.

Dependencies have already been derived algorithmically from provides/consumes tokens. Your job is TWO things:

1. AFFINITY GROUPS: Identify shaels/shana that share a boundary and create mutual constraints even without hard dependencies. For each group, articulate the CO-DESIGN RISK — what specifically goes wrong if these are built without awareness of each other? Be concrete: name the contract that breaks, the data shape that diverges, the UX that becomes inconsistent.

2. DEPENDENCY CORRECTIONS: Review the algorithmically-derived dependencies. If any are wrong (e.g., direction is inverted, a dep was missed because tokens didn't match, or a dep exists that shouldn't), propose corrections. Only flag genuine errors — the algorithm is correct given the tokens, so corrections mean the tokens were misleading.

Output a valid JSON object.`;
}

function affinityOnlyUser(semanticMap: SemanticMapResult, algDeps: Map<string, string[]>): string {
  const descriptions = SHAELS.map(s => {
    const parent = s.parentId ? ` (child of ${s.parentId})` : "";
    return `${s.id} [${s.level}]${parent}: ${s.description}`;
  }).join("\n");

  const map = semanticMap.shaels.map(s => {
    const provides = s.provides.map(p => `"${p.capability}"`).join(", ");
    const consumes = s.consumes.map(c => `"${c.capability}"`).join(", ");
    return `${s.id}: provides [${provides}] | consumes [${consumes}]`;
  }).join("\n");

  const depLines: string[] = [];
  for (const [from, tos] of algDeps) {
    for (const to of tos) depLines.push(`${from} → ${to}`);
  }

  return `SHAEL DESCRIPTIONS
${descriptions}

SEMANTIC MAP (capability tokens)
${map}

ALGORITHMICALLY-DERIVED DEPENDENCIES
${depLines.join("\n")}

Identify affinity groups with co-design risks. Flag any dependency corrections.

Return JSON:
{
  "reasoning": "your analysis",
  "affinityGroups": [{
    "name": "group",
    "shaelIds": ["p1a", "v2a"],
    "sharedBoundary": "what they share",
    "coDesignRisk": "what breaks if built in isolation"
  }],
  "depCorrections": [
    { "action": "add", "from": "x", "to": "y", "reason": "why this dep was missed" }
  ]
}`;
}

// ─── Analysis functions ────────────────────────────────────────────

function analyzeA(result: ExperimentAResult): void {
  console.log("\n  === Experiment A: All-in-One ===");
  console.log(`  Reasoning: ${result.reasoning.length} chars`);
  console.log(`  Nodes wired: ${result.shaels.length} / ${SHAELS.length}`);

  const deps = new Map<string, string[]>();
  for (const s of result.shaels) deps.set(s.id, s.dependsOn);
  printDepsTable(deps);

  console.log(`  Affinity groups: ${result.affinityGroups.length}`);
  for (const g of result.affinityGroups) {
    console.log(`    ${g.name}: [${g.shaelIds.join(", ")}] — ${g.sharedBoundary.slice(0, 120)}`);
  }

  const { valid, violations } = validateTopologicalOrder(result.topologicalOrder, deps);
  console.log(`  Topo order: ${result.topologicalOrder.join(" → ")}`);
  if (valid) console.log("  ✓ Topological order valid");
  else violations.forEach(v => console.log(`  ⚠ ${v}`));

  // Check cross-level deps (the interesting part for hierarchical)
  const crossLevel: string[] = [];
  for (const s of result.shaels) {
    const node = SHAELS.find(n => n.id === s.id);
    for (const dep of s.dependsOn) {
      const depNode = SHAELS.find(n => n.id === dep);
      if (node && depNode && node.level !== depNode.level) {
        crossLevel.push(`${s.id}[${node.level}] → ${dep}[${depNode.level}]`);
      }
    }
  }
  if (crossLevel.length) {
    console.log(`  Cross-level deps (${crossLevel.length}): ${crossLevel.join(", ")}`);
  }
}

function analyzeB(result: SemanticMapResult): DerivedGraph {
  console.log("\n  === Experiment B: Semantic Map + Algorithmic Deps ===");
  console.log(`  Reasoning: ${result.reasoning.length} chars`);
  console.log(`  Nodes mapped: ${result.shaels.length} / ${SHAELS.length}`);

  const allProvides = new Set<string>();
  const allConsumes = new Set<string>();
  for (const s of result.shaels) {
    for (const p of s.provides) allProvides.add(p.capability);
    for (const c of s.consumes) allConsumes.add(c.capability);
  }
  console.log(`  Capability tokens — provides: ${allProvides.size}, consumes: ${allConsumes.size}`);

  const unresolved = [...allConsumes].filter(c => !allProvides.has(c));
  if (unresolved.length) console.log(`  ⚠ Unresolved consumes: ${unresolved.join(", ")}`);
  else console.log("  ✓ All consumes resolved");

  const graph = deriveDependencies(result.shaels);
  printDepsTable(graph.deps);

  console.log(`  Algorithmic affinity groups: ${graph.affinityGroups.length}`);
  for (const g of graph.affinityGroups) {
    console.log(`    ${g.name}: [${g.shaelIds.join(", ")}]`);
  }

  return graph;
}

function analyzeC(semanticMap: SemanticMapResult, wiring: WiringResult): void {
  console.log("\n  === Experiment C: Two-Pass ===");
  console.log(`  Pass 1 reasoning: ${semanticMap.reasoning.length} chars`);
  console.log(`  Pass 2 reasoning: ${wiring.reasoning.length} chars`);
  console.log(`  Dependency edges: ${wiring.dependencies.length}`);

  // Show cross-level deps
  const crossLevel: string[] = [];
  for (const d of wiring.dependencies) {
    const from = SHAELS.find(s => s.id === d.from);
    const to = SHAELS.find(s => s.id === d.to);
    if (from && to && from.level !== to.level) {
      crossLevel.push(`${d.from}[${from.level}] → ${d.to}[${to.level}]`);
    }
  }
  if (crossLevel.length) {
    console.log(`  Cross-level deps (${crossLevel.length}): ${crossLevel.join(", ")}`);
  }

  console.log(`  Affinity groups: ${wiring.affinityGroups.length}`);
  for (const g of wiring.affinityGroups) {
    console.log(`    ${g.name}: [${g.shaelIds.join(", ")}]`);
    console.log(`      co-design risk: ${g.coDesignRisk.slice(0, 150)}...`);
  }

  const { valid, violations } = validateTopologicalOrder(wiring.topologicalOrder, wiring.dependencies);
  console.log(`  Topo order: ${wiring.topologicalOrder.join(" → ")}`);
  if (valid) console.log("  ✓ Topological order valid");
  else violations.forEach(v => console.log(`  ⚠ ${v}`));

  // Compare LLM deps vs algorithmic from pass 1
  const { deps: algDeps } = deriveDependencies(semanticMap.shaels);
  const llmSet = new Set(wiring.dependencies.map(d => `${d.from}->${d.to}`));
  const algSet = new Set<string>();
  for (const [from, tos] of algDeps) for (const to of tos) algSet.add(`${from}->${to}`);

  const onlyLLM = [...llmSet].filter(d => !algSet.has(d));
  const onlyAlg = [...algSet].filter(d => !llmSet.has(d));
  if (onlyLLM.length) console.log(`  LLM-only deps (not algorithmic): ${onlyLLM.join(", ")}`);
  if (onlyAlg.length) console.log(`  Algorithmic-only (LLM missed): ${onlyAlg.join(", ")}`);
  if (!onlyLLM.length && !onlyAlg.length) console.log("  ✓ LLM deps match algorithmic exactly");
}

function analyzeD(result: DecomposerInlineResult): DerivedGraph {
  console.log("\n  === Experiment D: Inline Provides/Consumes in Decomposer ===");
  console.log(`  Reasoning: ${result.reasoning.length} chars`);
  console.log(`  Nodes produced: ${result.shaels.length}`);

  const shaelCount = result.shaels.filter(s => s.level === "shael").length;
  const shanaCount = result.shaels.filter(s => s.level === "shana").length;
  console.log(`  Shaels: ${shaelCount}, Shana: ${shanaCount}`);

  const phases = new Set(result.shaels.map(s => s.phaseGroup));
  console.log(`  Phases: ${[...phases].join(", ")}`);

  // Check tree structure
  const roots = result.shaels.filter(s => s.parentId === null);
  const withParent = result.shaels.filter(s => s.parentId !== null);
  const orphans = withParent.filter(s => !result.shaels.find(p => p.id === s.parentId));
  console.log(`  Roots: ${roots.length}, Children: ${withParent.length}`);
  if (orphans.length) console.log(`  ⚠ Orphans (parent not found): ${orphans.map(o => o.id).join(", ")}`);

  // Semantic mapping quality
  const allProvides = new Set<string>();
  const allConsumes = new Set<string>();
  for (const s of result.shaels) {
    for (const p of s.provides) allProvides.add(p.capability);
    for (const c of s.consumes) allConsumes.add(c.capability);
  }
  console.log(`  Capability tokens — provides: ${allProvides.size}, consumes: ${allConsumes.size}`);

  const unresolved = [...allConsumes].filter(c => !allProvides.has(c));
  if (unresolved.length) console.log(`  ⚠ Unresolved consumes: ${unresolved.join(", ")}`);
  else console.log("  ✓ All consumes resolved");

  const graph = deriveDependencies(result.shaels);
  printDepsTable(graph.deps);

  return graph;
}

function analyzeE(semanticMap: SemanticMapResult, affinity: AffinityOnlyResult, algDeps: Map<string, string[]>): void {
  console.log("\n  === Experiment E: Algorithmic Deps + Affinity-Only LLM ===");
  console.log(`  Reasoning: ${affinity.reasoning.length} chars`);

  console.log(`  Affinity groups: ${affinity.affinityGroups.length}`);
  for (const g of affinity.affinityGroups) {
    console.log(`    ${g.name}: [${g.shaelIds.join(", ")}]`);
    console.log(`      co-design risk: ${g.coDesignRisk.slice(0, 150)}...`);
  }

  console.log(`  Dep corrections: ${affinity.depCorrections.length}`);
  for (const c of affinity.depCorrections) {
    console.log(`    ${c.action}: ${c.from} → ${c.to} — ${c.reason}`);
  }

  // Apply corrections
  if (affinity.depCorrections.length) {
    const corrected = new Map<string, string[]>();
    for (const [k, v] of algDeps) corrected.set(k, [...v]);
    for (const c of affinity.depCorrections) {
      if (c.action === "add") {
        if (!corrected.has(c.from)) corrected.set(c.from, []);
        if (!corrected.get(c.from)!.includes(c.to)) corrected.get(c.from)!.push(c.to);
      } else {
        const arr = corrected.get(c.from);
        if (arr) corrected.set(c.from, arr.filter(d => d !== c.to));
      }
    }
    console.log("  After corrections:");
    printDepsTable(corrected);
  }
}

// ─── Runners ───────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6-20250514";

async function runA(): Promise<void> {
  console.log("\nRunning Experiment A (all-in-one)...");
  const result = await callStructured<ExperimentAResult>(
    "planner", MODEL, experimentASystem(), experimentAUser(), ExperimentASchema, 12288,
  );
  analyzeA(result);
}

async function runB(): Promise<{ result: SemanticMapResult; graph: DerivedGraph }> {
  console.log("\nRunning Experiment B (semantic map → algorithmic deps)...");
  const result = await callStructured<SemanticMapResult>(
    "planner", MODEL, semanticMapSystem(), semanticMapUser(), SemanticMapSchema, 12288,
  );
  const graph = analyzeB(result);
  return { result, graph };
}

async function runC(): Promise<void> {
  console.log("\nRunning Experiment C (two-pass)...");
  console.log("  Pass 1: semantic mapping...");
  const pass1 = await callStructured<SemanticMapResult>(
    "planner", MODEL, semanticMapSystem(), semanticMapUser(), SemanticMapSchema, 12288,
  );
  console.log("  Pass 2: wiring from semantic map...");
  const pass2 = await callStructured<WiringResult>(
    "planner", MODEL, wiringSystem(), wiringUser(pass1), WiringSchema, 12288,
  );
  analyzeC(pass1, pass2);
}

async function runD(): Promise<void> {
  console.log("\nRunning Experiment D (inline decomposer + provides/consumes)...");
  const result = await callStructured<DecomposerInlineResult>(
    "planner", MODEL, decomposerInlineSystem(), decomposerInlineUser(), DecomposerInlineSchema, 16384,
  );
  analyzeD(result);
}

async function runE(): Promise<void> {
  console.log("\nRunning Experiment E (algorithmic deps + affinity-only LLM)...");
  console.log("  Step 1: semantic mapping...");
  const semanticMap = await callStructured<SemanticMapResult>(
    "planner", MODEL, semanticMapSystem(), semanticMapUser(), SemanticMapSchema, 12288,
  );
  console.log("  Step 2: derive deps algorithmically...");
  const { deps } = deriveDependencies(semanticMap.shaels);
  printDepsTable(deps);
  console.log("  Step 3: affinity-only LLM call...");
  const affinity = await callStructured<AffinityOnlyResult>(
    "planner", MODEL, affinityOnlySystem(), affinityOnlyUser(semanticMap, deps), AffinityOnlySchema, 12288,
  );
  analyzeE(semanticMap, affinity, deps);
}

// ─── Main ──────────────────────────────────────────────────────────

const which = process.argv[2]?.toLowerCase() ?? "all";

console.log("Graph Builder Experiments — Hierarchical Test Case");
console.log(`Shaela: "${SHAELA_DESCRIPTION}"`);
console.log(`Shaels: ${SHAELS.filter(s => s.level === "shael").length}, Shana: ${SHAELS.filter(s => s.level === "shana").length}, Total: ${SHAELS.length}`);
console.log(`Phases: ${[...new Set(SHAELS.map(s => s.phaseGroup))].join(", ")}`);
console.log(`Model: ${MODEL}`);
console.log(`Running: ${which}\n`);

try {
  if (which === "a" || which === "all") await runA();
  if (which === "b" || which === "all") await runB();
  if (which === "c" || which === "all") await runC();
  if (which === "d" || which === "all") await runD();
  if (which === "e" || which === "all") await runE();

  if (which === "all") {
    console.log("\n" + "=".repeat(60));
    console.log("KEY QUESTIONS ANSWERED");
    console.log("=".repeat(60));
    console.log(`
Compare:
- A vs C: Does splitting semantic mapping from wiring improve affinity quality?
- B vs E: Does the affinity-only LLM beat algorithmic affinity detection?
- D vs B: Does inlining provides/consumes in the decomposer degrade quality?
- C vs E: Does the full-wiring Pass 2 add value over affinity-only?
- Cross-level deps: Which approach best handles shana→shael dependencies?
`);
  }
} catch (err) {
  console.error(`\nExperiment failed: ${err}`);
  process.exit(1);
}
