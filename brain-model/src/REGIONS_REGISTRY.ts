/**
 * REGIONS_REGISTRY — canonical contract for brain region data.
 *
 * Every brain region rendered in the 3D model must have a corresponding entry here.
 * This interface is the single source of truth for region shape — downstream tasks
 * implement against it, they do not define it.
 *
 * Zero entries are seeded here intentionally. Data population is a separate task.
 */

export interface BrainRegionContent {
  /** Short title for the info panel */
  title: string;
  /** Longer descriptive paragraph */
  description: string;
  /** Optional list of key functions */
  functions?: string[];
  /** Optional link to further reading */
  learnMoreUrl?: string;
}

export interface BrainRegion {
  /** Unique identifier, used as React key and URL parameter */
  id: string;
  /** Human-readable name displayed in UI */
  displayName: string;
  /** Name of the mesh/object in the 3D model file (glTF node name) */
  meshName: string;
  /** Accent color for this region (CSS hex string, e.g. '#FF6B6B') */
  accentColor: string;
  /** Icon identifier for info panel glyph (e.g. emoji or icon name) */
  glyphIcon: string;
  /** IDs of connected regions for relationship visualization */
  connections: string[];
  /** Rich content displayed when this region is selected */
  content: BrainRegionContent;
}

/**
 * The registry of all brain regions.
 * Populate this array to add regions to the 3D model.
 */
export const REGIONS_REGISTRY: BrainRegion[] = [
  // Regions will be added in a future task.
  // Example structure:
  // {
  //   id: 'prefrontal-cortex',
  //   displayName: 'Prefrontal Cortex',
  //   meshName: 'PrefrontalCortex_mesh',
  //   accentColor: '#4A90D9',
  //   glyphIcon: '🧠',
  //   connections: ['anterior-cingulate', 'thalamus'],
  //   content: {
  //     title: 'Prefrontal Cortex',
  //     description: 'Executive function, decision-making, and personality expression.',
  //     functions: ['Working memory', 'Impulse control', 'Planning'],
  //   },
  // },
];

export default REGIONS_REGISTRY;
