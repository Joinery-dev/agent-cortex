/**
 * Explore Phase — divergent path generation and selection.
 *
 * Generates 3-5 approach sketches from the current state to the
 * manifested future. Selection criterion: surprise × quality —
 * the most creative path that still clears the quality floor.
 *
 * Skipped in exploit mode (BG routine confidence ≥ 0.7) or when
 * no path clears the quality floor. Degrades gracefully on LLM failure.
 */

/** A single divergent path sketch. */
export interface ExplorePath {
  /** Short name for this path (e.g., "Progressive Enhancement Cascade"). */
  name: string;
  /** 2-4 sentence description of the approach strategy. */
  approach: string;
  /** 1-3 archetype tags from the fixed APPROACH_ARCHETYPES vocabulary. */
  archetypeTags: string[];
  /** Why this path diverges from the obvious approach. */
  divergenceRationale: string;
  /** Key tradeoffs the builder should know about. */
  tradeoffs: string[];
  /** Which sense concerns this path particularly serves or sacrifices. */
  senseAlignment: {
    serves: string[];
    sacrifices: string[];
  };
  /** LLM self-assessed quality (0-1). How well does this path serve the manifested future? */
  quality: number;
  /** LLM self-assessed surprise (0-1). How much does this defy the conventional approach? */
  surprise: number;
}

/** Full result of the explore phase. */
export type ExploreResult = ExploreSelected | ExploreSkipped;

export interface ExploreSelected {
  kind: "selected";
  /** All generated paths. */
  paths: ExplorePath[];
  /** The path that won selection. */
  selected: ExplorePath;
  /** Combined score: surprise × quality. */
  selectionScore: number;
  /** Why this path was selected over others. */
  selectionRationale: string;
}

export interface ExploreSkipped {
  kind: "skipped";
  reason: "exploit-mode" | "no-path-clears-floor" | "llm-failure";
  detail?: string;
}

/** Quality floor — paths below this are rejected. */
export const EXPLORE_QUALITY_FLOOR = 0.5;
