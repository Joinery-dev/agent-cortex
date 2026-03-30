/**
 * Trace module — observe everything Cortex does.
 *
 * Collector captures events, ContentStore tracks content,
 * Stepper enables replay, Narrator makes it human-readable,
 * Server exposes it all via HTTP + SSE.
 */

export { TraceCollector, getTraceCollector, resetTraceCollector } from "./collector.js";
export { ContentStore, getContentStore, resetContentStore, contentBlock } from "./content-store.js";
export { TraceStepper } from "./stepper.js";
export { handleTraceRequest } from "./server.js";
export { narrate, narrateAll } from "./narrator.js";

export type {
  BrainRegion,
  TraceEntry,
  TraceEdge,
  TraceFilter,
  TraceSlice,
  StepGranularity,
  StepperState,
  WaterfallSpan,
  WaterfallMarker,
  FlowNode,
  FlowEdge,
  FlowGraph,
  ContentKind,
  ContentBlock,
  ContentRouting,
  ContentEntry,
  NarrativeContentType,
  NarrativeSection,
  StepNarrative,
} from "./types.js";
