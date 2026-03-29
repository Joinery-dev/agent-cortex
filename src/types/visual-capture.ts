/**
 * Visual Capture — Playwright screenshots + performance metrics.
 *
 * G5 infrastructure: enables the sensory cortex (especially Design sense)
 * to *see* what the system builds instead of guessing from code. Captures
 * rendered pages and Core Web Vitals from a running dev server.
 *
 * Integration: build-cycle starts runtime → visual capture produces these
 * artifacts → injected into EvaluationContext → evaluator prompts reference
 * them so senses can ground assessment in reality.
 *
 * Graceful degradation: if Playwright is unavailable or capture fails,
 * evaluation continues code-only. Visual capture is enrichment, not a gate.
 */

// ── Capture Configuration ───────────────────────────────────────

/** Viewport preset for screenshot capture. */
export interface Viewport {
  label: string;
  width: number;
  height: number;
}

/** Built-in viewport presets, NE-modulated (high NE = more viewports). */
export const VIEWPORTS = {
  desktop: { label: "desktop", width: 1440, height: 900 } as Viewport,
  tablet: { label: "tablet", width: 768, height: 1024 } as Viewport,
  mobile: { label: "mobile", width: 375, height: 667 } as Viewport,
} as const;

/** Configuration for a visual capture pass. */
export interface VisualCaptureConfig {
  /** Routes to screenshot (relative to runtimeUrl, e.g. ["/", "/about"]). */
  routes: string[];
  /** Viewports to capture per route. */
  viewports: Viewport[];
  /** Per-page timeout in ms. Default: 8000. */
  pageTimeoutMs?: number;
  /** Whether to collect Web Vitals. Default: true. */
  collectWebVitals?: boolean;
}

// ── Capture Results ──────────────────────────────────────────────

/** A single screenshot capture. */
export interface VisualCapture {
  /** Route that was captured (e.g. "/products"). */
  route: string;
  /** Viewport used for this capture. */
  viewport: Viewport;
  /** Screenshot as base64-encoded PNG. */
  screenshotBase64: string;
  /** Timestamp of capture. */
  capturedAt: string;
  /** Page title as rendered. */
  pageTitle?: string;
}

/** Core Web Vitals for a single page. */
export interface WebVitalsMetrics {
  /** Route measured. */
  route: string;
  /** Largest Contentful Paint (ms). */
  lcp?: number;
  /** Cumulative Layout Shift (unitless). */
  cls?: number;
  /** Time to First Byte (ms). */
  ttfb?: number;
  /** DOM content loaded time (ms). */
  domContentLoaded?: number;
  /** Full load time (ms). */
  loadComplete?: number;
}

/** Full result of a visual capture pass. */
export interface VisualCaptureResult {
  /** Individual screenshots. */
  captures: VisualCapture[];
  /** Web Vitals per route (one entry per route, not per viewport). */
  webVitals: WebVitalsMetrics[];
  /** Whether capture was fully successful or degraded. */
  degraded: boolean;
  /** If degraded, what went wrong. */
  degradedReason?: string;
  /** Routes that failed to capture (still tried the rest). */
  failedRoutes: string[];
}
