/**
 * Trace collector — subscribes to the CortexEventBus and captures every event
 * into indexed, queryable trace entries with causal edges and waterfall spans.
 */

import { bus } from "../events.js";
import type {
  CortexEvent,
  BrainRegion,
  TraceEntry,
  TraceEdge,
  TraceFilter,
  TraceSlice,
  WaterfallSpan,
  WaterfallMarker,
  FlowNode,
  FlowEdge,
  FlowGraph,
} from "./types.js";

// ─── Region classification ──────────────────────────────────────

const REGION_MAP: [string, BrainRegion][] = [
  ["attention-scheduler:", "attention-scheduler"],
  ["working-memory:", "working-memory"],
  ["drift-monitor:", "drift-monitor"],
  ["conviction:", "conviction"],
  ["cognitive-flexibility:", "cognitive-flexibility"],
  ["world-model:", "world-model"],
  ["inhibitor:", "inhibitor"],
  ["budget:", "budget-allocator"],
  ["planner:", "prefrontal-cortex"],
  ["quick-triage:", "prefrontal-cortex"],
  ["prospective:", "prefrontal-cortex"],
  ["pfc:", "prefrontal-cortex"],
  ["thalamus:", "thalamus"],
  ["pipeline:", "thalamus"],
  ["briefing:", "thalamus"],
  ["sensory:", "sensory-cortex"],
  ["sense:", "sensory-cortex"],
  ["consultation:", "sensory-cortex"],
  ["evaluation:", "sensory-cortex"],
  ["tension:", "sensory-cortex"],
  ["resolution:", "sensory-cortex"],
  ["motor:", "motor-cortex"],
  ["premotor:", "motor-cortex"],
  ["proprioception:", "motor-cortex"],
  ["efference:", "motor-cortex"],
  ["rhythm:", "brainstem"],
  ["build-cycle:", "brainstem"],
  ["task-dispatch:", "brainstem"],
  ["project:", "brainstem"],
  ["homeostasis:", "brainstem"],
  ["runner:", "brainstem"],
  ["hippocampus:", "hippocampus"],
  ["episode:", "hippocampus"],
  ["potentiation:", "hippocampus"],
  ["cerebellum:", "cerebellum"],
  ["prediction:", "cerebellum"],
  ["forward-model:", "cerebellum"],
  ["basal-ganglia:", "basal-ganglia"],
  ["gate:", "basal-ganglia"],
  ["routine:", "basal-ganglia"],
  ["amygdala:", "amygdala"],
  ["urgency:", "amygdala"],
  ["exteroception:", "exteroception"],
  ["pns:", "pns"],
  ["tool:", "pns"],
  ["dopamine:", "dopamine"],
  ["reward:", "dopamine"],
  ["norepinephrine:", "norepinephrine"],
  ["ne:", "norepinephrine"],
  ["arousal:", "norepinephrine"],
  ["plasticity:", "plasticity"],
  ["llm:", "thalamus"],
  ["structured:", "thalamus"],
  ["cost:", "brainstem"],
];

// ─── Causal sequences ───────────────────────────────────────────

const CAUSAL_SEQUENCES: [string, string][] = [
  ["thalamus:briefing-assembled", "sensory:consultation-start"],
  ["sensory:consultation-complete", "sensory:evaluation-start"],
  ["sensory:evaluation-complete", "sensory:tension-detected"],
  ["sensory:tension-detected", "sensory:resolution-start"],
  ["sensory:resolution-complete", "conviction:assessment-start"],
  ["conviction:assessment-complete", "motor:plan-start"],
  ["motor:plan-complete", "motor:build-start"],
  ["motor:build-complete", "motor:proprioception-start"],
  ["rhythm:phase-change", "thalamus:briefing-start"],
  ["planner:plan-complete", "task-dispatch:start"],
  ["task-dispatch:task-assigned", "rhythm:start"],
  ["cerebellum:prediction-complete", "norepinephrine:compute"],
  ["gate:decision", "rhythm:phase-change"],
  ["dopamine:reward-signal", "hippocampus:episode-record"],
  ["hippocampus:episode-record", "plasticity:update"],
];

// ─── Collector ──────────────────────────────────────────────────

export class TraceCollector {
  private entries: TraceEntry[] = [];
  private edges: TraceEdge[] = [];
  private nextSeq = 0;
  private baseSeq = 0; // offset: entries[seq - baseSeq] = entry with that seq
  private maxEntries: number;
  private startTs = performance.now();
  private lastTs = performance.now();
  private listening = false;
  private listener: ((event: CortexEvent) => void) | null = null;

  // ── Indexes ─────────────────────────────────────────────────
  private byRegion = new Map<BrainRegion, number[]>();
  private byComponent = new Map<string, number[]>();
  private byTask = new Map<string, number[]>();
  private byRhythm = new Map<string, number[]>();
  private byType = new Map<string, number[]>();
  private bySeverity = new Map<string, number[]>();

  // ── Waterfall tracking ──────────────────────────────────────
  private activeSpans = new Map<string, WaterfallSpan>();
  private completedSpans: WaterfallSpan[] = [];
  private markers: WaterfallMarker[] = [];

  // ── Entry listeners ─────────────────────────────────────────
  private entryListeners: ((entry: TraceEntry) => void)[] = [];

  // ── Last event by type (for causal edge detection) ──────────
  private lastByType = new Map<string, number>();

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.startTs = performance.now();
    this.lastTs = this.startTs;

    this.listener = (event: CortexEvent) => this.ingest(event);
    bus.onCortex(this.listener);
  }

  stop(): void {
    if (!this.listening || !this.listener) return;
    this.listening = false;
    bus.removeListener("cortex", this.listener);
    this.listener = null;
  }

  reset(): void {
    this.stop();
    this.entries = [];
    this.edges = [];
    this.nextSeq = 0;
    this.baseSeq = 0;
    this.startTs = performance.now();
    this.lastTs = this.startTs;
    this.byRegion.clear();
    this.byComponent.clear();
    this.byTask.clear();
    this.byRhythm.clear();
    this.byType.clear();
    this.bySeverity.clear();
    this.activeSpans.clear();
    this.completedSpans = [];
    this.markers = [];
    this.entryListeners = [];
    this.lastByType.clear();
  }

  // ── Ingest ────────────────────────────────────────────────────

  ingest(event: CortexEvent): TraceEntry {
    const now = performance.now();
    const seq = this.nextSeq++;
    const region = this.classifyRegion(event.type);
    const component = event.type.split(":")[0] ?? "unknown";
    const taskId = (event.data?.taskId as string) ??
      event.rhythmContext?.taskId ?? null;
    const rhythmContext = event.rhythmContext ?? null;
    const parentRhythmId = rhythmContext?.parentRhythmId ?? null;

    const entry: TraceEntry = {
      seq,
      event,
      region,
      component,
      rhythmContext,
      parentRhythmId,
      taskId,
      microTs: now - this.startTs,
      deltaMs: now - this.lastTs,
    };

    this.lastTs = now;
    this.entries.push(entry);

    // Index
    this.addToIndex(this.byRegion, region, seq);
    this.addToIndex(this.byComponent, component, seq);
    if (taskId) this.addToIndex(this.byTask, taskId, seq);
    if (rhythmContext?.rhythmId) {
      this.addToIndex(this.byRhythm, rhythmContext.rhythmId, seq);
    }
    this.addToIndex(this.byType, event.type, seq);
    this.addToIndex(this.bySeverity, event.severity, seq);

    // Causal edges
    this.detectCausalEdges(event.type, seq);

    // Waterfall spans
    this.updateWaterfall(entry);

    // Notify listeners
    for (const fn of this.entryListeners) {
      try {
        fn(entry);
      } catch {
        // Don't let listener errors break collection
      }
    }

    // Rotate if over capacity
    if (this.entries.length > this.maxEntries) {
      this.rotate();
    }

    return entry;
  }

  // ── Query ─────────────────────────────────────────────────────

  query(filter: TraceFilter = {}): TraceSlice {
    let candidates: TraceEntry[];

    // Start with the most selective index
    if (filter.taskId && this.byTask.has(filter.taskId)) {
      const seqs = this.byTask.get(filter.taskId)!;
      candidates = seqs.map((s) => this.getBySeq(s)!).filter(Boolean);
    } else if (filter.rhythmId && this.byRhythm.has(filter.rhythmId)) {
      const seqs = this.byRhythm.get(filter.rhythmId)!;
      candidates = seqs.map((s) => this.getBySeq(s)!).filter(Boolean);
    } else {
      candidates = [...this.entries];
    }

    // Apply filters
    candidates = candidates.filter((e) => {
      if (filter.region) {
        const regions = Array.isArray(filter.region) ? filter.region : [filter.region];
        if (!regions.includes(e.region)) return false;
      }
      if (filter.component) {
        const components = Array.isArray(filter.component) ? filter.component : [filter.component];
        if (!components.includes(e.component)) return false;
      }
      if (filter.taskId && e.taskId !== filter.taskId) return false;
      if (filter.rhythmId && e.rhythmContext?.rhythmId !== filter.rhythmId) return false;
      if (filter.eventType) {
        const types = Array.isArray(filter.eventType) ? filter.eventType : [filter.eventType];
        if (!types.includes(e.event.type)) return false;
      }
      if (filter.severity) {
        const severities = Array.isArray(filter.severity) ? filter.severity : [filter.severity];
        if (!severities.includes(e.event.severity)) return false;
      }
      if (filter.fromSeq != null && e.seq < filter.fromSeq) return false;
      if (filter.toSeq != null && e.seq > filter.toSeq) return false;
      return true;
    });

    const total = candidates.length;
    if (filter.limit && candidates.length > filter.limit) {
      candidates = candidates.slice(0, filter.limit);
    }

    // Collect edges that connect entries in the result
    const seqSet = new Set(candidates.map((e) => e.seq));
    const relevantEdges = this.edges.filter(
      (edge) => seqSet.has(edge.fromSeq) || seqSet.has(edge.toSeq),
    );

    return { entries: candidates, edges: relevantEdges, total };
  }

  // ── Seq-based access ─────────────────────────────────────────

  private getBySeq(seq: number): TraceEntry | undefined {
    const idx = seq - this.baseSeq;
    if (idx < 0 || idx >= this.entries.length) return undefined;
    return this.entries[idx];
  }

  // ── Accessors ─────────────────────────────────────────────────

  getEntry(seq: number): TraceEntry | undefined {
    return this.getBySeq(seq);
  }

  getAll(): TraceEntry[] {
    return [...this.entries];
  }

  getEdges(): TraceEdge[] {
    return [...this.edges];
  }

  get size(): number {
    return this.entries.length;
  }

  getTypes(): string[] {
    return [...this.byType.keys()];
  }

  getComponents(): string[] {
    return [...this.byComponent.keys()];
  }

  getTasks(): string[] {
    return [...this.byTask.keys()];
  }

  // ── Waterfall ─────────────────────────────────────────────────

  getWaterfall(): { spans: WaterfallSpan[]; markers: WaterfallMarker[] } {
    const allSpans = [
      ...this.completedSpans,
      ...this.activeSpans.values(),
    ];
    return { spans: allSpans, markers: [...this.markers] };
  }

  // ── Flow graph ────────────────────────────────────────────────

  getFlowGraph(): FlowGraph {
    const nodeMap = new Map<string, FlowNode>();
    const edgeMap = new Map<string, FlowEdge>();

    for (const entry of this.entries) {
      const nodeId = entry.region;
      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          label: nodeId,
          region: entry.region,
          eventCount: 0,
        });
      }
      nodeMap.get(nodeId)!.eventCount++;
    }

    for (const edge of this.edges) {
      const from = this.getBySeq(edge.fromSeq);
      const to = this.getBySeq(edge.toSeq);
      if (!from || !to) continue;

      const key = `${from.region}->${to.region}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          from: from.region,
          to: to.region,
          label: edge.relation,
          count: 0,
        });
      }
      edgeMap.get(key)!.count++;
    }

    return {
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  }

  // ── Listeners ─────────────────────────────────────────────────

  onEntry(listener: (entry: TraceEntry) => void): () => void {
    this.entryListeners.push(listener);
    return () => {
      const idx = this.entryListeners.indexOf(listener);
      if (idx >= 0) this.entryListeners.splice(idx, 1);
    };
  }

  // ── Summary ───────────────────────────────────────────────────

  get totalIngested(): number {
    return this.nextSeq;
  }

  getSummary(): {
    totalEvents: number;
    totalIngested: number;
    totalEdges: number;
    regions: Record<string, number>;
    components: Record<string, number>;
    tasks: string[];
    severities: Record<string, number>;
  } {
    const regions: Record<string, number> = {};
    for (const [region, seqs] of this.byRegion) {
      regions[region] = seqs.length;
    }

    const components: Record<string, number> = {};
    for (const [comp, seqs] of this.byComponent) {
      components[comp] = seqs.length;
    }

    const severities: Record<string, number> = {};
    for (const [sev, seqs] of this.bySeverity) {
      severities[sev] = seqs.length;
    }

    return {
      totalEvents: this.entries.length,
      totalIngested: this.nextSeq,
      totalEdges: this.edges.length,
      regions,
      components,
      tasks: [...this.byTask.keys()],
      severities,
    };
  }

  // ── Buffer rotation ─────────────────────────────────────────

  private rotate(): void {
    const keep = Math.floor(this.maxEntries / 2);
    const cutIndex = this.entries.length - keep;
    this.entries = this.entries.slice(cutIndex);
    this.baseSeq += cutIndex;

    // Rebuild all indexes from surviving entries
    this.rebuildIndexes();

    // Trim edges to only reference surviving entries
    this.edges = this.edges.filter(
      (e) => e.fromSeq >= this.baseSeq && e.toSeq >= this.baseSeq,
    );

    // Trim completed spans
    this.completedSpans = this.completedSpans.filter(
      (s) => (s.endSeq ?? s.startSeq) >= this.baseSeq,
    );

    // Trim markers
    this.markers = this.markers.filter((m) => m.seq >= this.baseSeq);

    // Trim lastByType — remove entries pointing to evicted seqs
    for (const [type, seq] of this.lastByType) {
      if (seq < this.baseSeq) this.lastByType.delete(type);
    }
  }

  private rebuildIndexes(): void {
    this.byRegion.clear();
    this.byComponent.clear();
    this.byTask.clear();
    this.byRhythm.clear();
    this.byType.clear();
    this.bySeverity.clear();

    for (const entry of this.entries) {
      this.addToIndex(this.byRegion, entry.region, entry.seq);
      this.addToIndex(this.byComponent, entry.component, entry.seq);
      if (entry.taskId) this.addToIndex(this.byTask, entry.taskId, entry.seq);
      if (entry.rhythmContext?.rhythmId) {
        this.addToIndex(this.byRhythm, entry.rhythmContext.rhythmId, entry.seq);
      }
      this.addToIndex(this.byType, entry.event.type, entry.seq);
      this.addToIndex(this.bySeverity, entry.event.severity, entry.seq);
    }
  }

  // ── Internal ──────────────────────────────────────────────────

  private classifyRegion(eventType: string): BrainRegion {
    for (const [prefix, region] of REGION_MAP) {
      if (eventType.startsWith(prefix)) return region;
    }
    return "unknown";
  }

  private addToIndex<K>(map: Map<K, number[]>, key: K, seq: number): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(seq);
    } else {
      map.set(key, [seq]);
    }
  }

  private detectCausalEdges(eventType: string, seq: number): void {
    // Check if this event type is the "to" in any causal sequence
    for (const [fromType, toType] of CAUSAL_SEQUENCES) {
      if (eventType === toType) {
        const fromSeq = this.lastByType.get(fromType);
        if (fromSeq != null) {
          this.edges.push({
            fromSeq,
            toSeq: seq,
            relation: `${fromType} -> ${toType}`,
          });
        }
      }
    }
    this.lastByType.set(eventType, seq);
  }

  private updateWaterfall(entry: TraceEntry): void {
    const type = entry.event.type;
    const rhythmId = entry.rhythmContext?.rhythmId;

    if (type === "rhythm:start" && rhythmId) {
      const span: WaterfallSpan = {
        id: rhythmId,
        label: (entry.event.data?.rhythmType as string) ?? rhythmId,
        region: entry.region,
        startSeq: entry.seq,
        endSeq: null,
        startMs: entry.microTs,
        endMs: null,
        phase: entry.rhythmContext?.phase ?? null,
        children: [],
      };

      // Nest under parent if applicable
      const parentId = entry.parentRhythmId;
      if (parentId && this.activeSpans.has(parentId)) {
        this.activeSpans.get(parentId)!.children.push(span);
      }

      this.activeSpans.set(rhythmId, span);
    } else if (type === "rhythm:complete" && rhythmId) {
      const span = this.activeSpans.get(rhythmId);
      if (span) {
        span.endSeq = entry.seq;
        span.endMs = entry.microTs;
        this.activeSpans.delete(rhythmId);
        this.completedSpans.push(span);
      }
    } else if (type === "rhythm:phase-change" && rhythmId) {
      const span = this.activeSpans.get(rhythmId);
      if (span) {
        span.phase = (entry.event.data?.phase as string) ?? span.phase;
      }
      // Also add a marker
      this.markers.push({
        seq: entry.seq,
        label: `Phase: ${entry.event.data?.phase ?? "unknown"}`,
        region: entry.region,
        ms: entry.microTs,
      });
    } else if (type === "gate:decision") {
      this.markers.push({
        seq: entry.seq,
        label: `Gate: ${entry.event.data?.decision ?? "unknown"}`,
        region: entry.region,
        ms: entry.microTs,
      });
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let singleton: TraceCollector | null = null;

export function getTraceCollector(): TraceCollector {
  if (!singleton) {
    singleton = new TraceCollector();
  }
  return singleton;
}

export function resetTraceCollector(): void {
  if (singleton) singleton.reset();
  singleton = null;
}
