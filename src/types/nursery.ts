/**
 * Nursery — runtime stress-testing of completed phase artifacts.
 *
 * The nursery is Cortex's interoception: feeling its code running.
 * After a phase gate passes, the nursery exercises artifacts at runtime
 * and observes what happens. Graduation = absence of findings, not a
 * score threshold.
 *
 * Build Cycle asks: "Is this good code?"
 * Evaluation asks:  "Does this satisfy the senses?"
 * Phase Gate asks:  "Do the pieces cohere?"
 * Nursery asks:     "Does it survive contact with reality?"
 */

import type { EvaluatorObservation } from "./sense.js";
import type { TaskGraphNode } from "./brainstem.js";
import type { OrchestratorResult } from "./orchestrator.js";
import type { SurgeryProposal } from "./graph-surgery.js";

// ─── Runtime Surface Detection ──────────────────────────────────

/** A detected runtime-facing artifact produced by a phase. */
export interface RuntimeSurfaceArea {
  /** What kind of runtime thing was detected. */
  kind:
    | "server"
    | "handler"
    | "pipeline"
    | "stateful-object"
    | "io-wiring"
    | "event-system"
    | "scheduled-job"
    | "cli-tool";
  /** Human-readable description of what was detected. */
  description: string;
  /** Files where this surface area was found. */
  files: string[];
  /** Entry point for exercising this surface (e.g., a listen() call, a main function). */
  entryPoint?: string;
}

/** Result of scanning a phase's completed artifacts for runtime surface area. */
export interface NurserySurfaceScan {
  /** Whether any runtime surface area was detected. The nursery gate. */
  hasRuntimeSurface: boolean;
  /** What was detected — each distinct runtime-facing artifact. */
  surfaceAreas: RuntimeSurfaceArea[];
  /** The phase group that was scanned. */
  phaseGroup: string;
  /** How detection was performed (for diagnostics). */
  scanMethod: "heuristic-content-scan";
}

// ─── Scenarios ──────────────────────────────────────────────────

/** A stress-test scenario proposed by a sense during nursery consultation. */
export interface NurseryScenario {
  id: string;
  /** Which sense proposed this scenario. */
  senseId: string;
  senseName: string;
  /** What this scenario tests, in human terms. */
  description: string;
  /** How the observer should exercise the artifact — natural language instructions. */
  exerciseMethod: string;
  /** What healthy behavior looks like — so the observer knows what "broken" means. */
  expectedBehavior: string;
  /** Which surface area this scenario targets. */
  surfaceArea: RuntimeSurfaceArea;
  /** Critical scenarios block graduation; standard scenarios produce fix tasks. */
  severity: "critical" | "standard";
}

// ─── Findings ───────────────────────────────────────────────────

/** An observed runtime problem — something that only manifests when the artifact runs. */
export interface NurseryFinding {
  id: string;
  /** Which scenario produced this finding. */
  scenarioId: string;
  /** Which sense identified this as a problem. */
  senseId: string;
  senseName: string;
  /** What went wrong, in human terms. */
  description: string;
  /** The raw observations that ground this finding. */
  evidence: EvaluatorObservation[];
  /** The sense's suggested fix direction (not a prescription — the motor decides how). */
  suggestedFix: string;
  /** Critical findings typically trigger rework; standard findings trigger insert. */
  severity: "critical" | "standard";
}

// ─── Nursery Rhythm Context/Result ──────────────────────────────

/** What the nursery rhythm needs to start. */
export interface NurseryContext {
  /** Which phase group is being nursed. */
  phaseGroup: string;
  /** The surface scan results from post-phase detection. */
  surfaceScan: NurserySurfaceScan;
  /** Task results from the completed phase — so the nursery knows what was built. */
  taskResults: Map<string, OrchestratorResult>;
  /** The live task graph. */
  graph: TaskGraphNode[];
  /** Which tasks are complete (needed for graph surgery). */
  completedTaskIds: Set<string>;
  /** NE level — inherited from the phase's last dispatch. */
  neLevel: number;
  /** Which nursery cycle this is (0 = first, 1+ = re-exercise after fixes). */
  cycle: number;
}

/** What the nursery rhythm produces. */
export interface NurseryResult {
  /** Whether the artifact graduated — absence of findings. */
  graduated: boolean;
  /** Findings from this nursery cycle. */
  findings: NurseryFinding[];
  /** Scenarios that were exercised. */
  exercisedScenarios: NurseryScenario[];
  /** Surgery proposals for any findings (source: "nursery"). */
  surgeryProposals: SurgeryProposal[];
  /** How long the nursery ran. */
  durationMs: number;
}
