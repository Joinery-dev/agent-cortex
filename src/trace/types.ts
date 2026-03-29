/**
 * Trace module types — everything the trace infrastructure needs.
 */

import type { CortexEvent, EventSeverity, RhythmContext } from "../events.js";

// Re-export for convenience
export type { CortexEvent, EventSeverity, RhythmContext };

// ─── Brain regions ──────────────────────────────────────────────

export type BrainRegion =
  | "prefrontal-cortex"
  | "thalamus"
  | "sensory-cortex"
  | "motor-cortex"
  | "brainstem"
  | "hippocampus"
  | "cerebellum"
  | "basal-ganglia"
  | "amygdala"
  | "pns"
  | "dopamine"
  | "norepinephrine"
  | "plasticity"
  | "working-memory"
  | "attention-scheduler"
  | "drift-monitor"
  | "conviction"
  | "cognitive-flexibility"
  | "world-model"
  | "inhibitor"
  | "budget-allocator"
  | "unknown";

// ─── Trace entry (one per event) ────────────────────────────────

export interface TraceEntry {
  seq: number;
  event: CortexEvent;
  region: BrainRegion;
  component: string;
  rhythmContext: RhythmContext | null;
  parentRhythmId: string | null;
  taskId: string | null;
  microTs: number;
  deltaMs: number;
}

// ─── Edges (causal links between entries) ───────────────────────

export interface TraceEdge {
  fromSeq: number;
  toSeq: number;
  relation: string;
}

// ─── Query filter ───────────────────────────────────────────────

export interface TraceFilter {
  region?: BrainRegion | BrainRegion[];
  component?: string | string[];
  taskId?: string;
  rhythmId?: string;
  eventType?: string | string[];
  severity?: EventSeverity | EventSeverity[];
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}

// ─── Slice (query result) ───────────────────────────────────────

export interface TraceSlice {
  entries: TraceEntry[];
  edges: TraceEdge[];
  total: number;
}

// ─── Stepper ────────────────────────────────────────────────────

export type StepGranularity =
  | "event"
  | "phase"
  | "cycle"
  | "task"
  | "llm"
  | "rhythm"
  | "content";

export interface StepperState {
  mode: "off" | "replay" | "live";
  granularity: StepGranularity;
  currentSeq: number;
  maxSeq: number;
  paused: boolean;
  autoAdvanceMs: number | null;
}

// ─── Waterfall ──────────────────────────────────────────────────

export interface WaterfallSpan {
  id: string;
  label: string;
  region: BrainRegion;
  startSeq: number;
  endSeq: number | null;
  startMs: number;
  endMs: number | null;
  phase: string | null;
  children: WaterfallSpan[];
}

export interface WaterfallMarker {
  seq: number;
  label: string;
  region: BrainRegion;
  ms: number;
}

// ─── Flow graph ─────────────────────────────────────────────────

export interface FlowNode {
  id: string;
  label: string;
  region: BrainRegion;
  eventCount: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string;
  count: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ─── Content tracking ───────────────────────────────────────────

export type ContentKind =
  | "llm-call"
  | "structured-parse"
  | "briefing"
  | "consultation"
  | "evaluation"
  | "motor-plan"
  | "motor-work"
  | "self-assessment"
  | "tension"
  | "tension-resolution"
  | "conviction"
  | "gate-decision"
  | "explore-path"
  | "reconsultation"
  | "ne-computation"
  | "flexibility"
  | "dopamine";

export interface ContentBlock {
  label: string;
  text: string;
  bytes: number;
  structured?: unknown;
}

export interface ContentRouting {
  destinations: string[];
  consumedBy?: string;
}

export interface ContentEntry {
  id: number;
  eventSeq: number | null;
  kind: ContentKind;
  timestamp: string;
  component: string;
  taskId: string | null;
  inputs: ContentBlock[];
  outputs: ContentBlock[];
  routing?: ContentRouting;
  purpose?: string;
  model?: string;
  tokens?: { input: number; output: number };
  costDollars?: number;
}

// ─── Narrative ──────────────────────────────────────────────────

export type NarrativeContentType =
  | "prose"
  | "prompt"
  | "response"
  | "code"
  | "json"
  | "diff";

export interface NarrativeSection {
  label: string;
  expandedByDefault: boolean;
  content: string;
  contentType: NarrativeContentType;
  byteSize: number;
}

export interface StepNarrative {
  contentId: number;
  eventSeq: number | null;
  kind: ContentKind;
  headline: string;
  summary: string;
  actor: string;
  actorRegion: BrainRegion;
  timestamp: string;
  sections: NarrativeSection[];
}
