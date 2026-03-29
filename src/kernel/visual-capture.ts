/**
 * Visual Capture — Playwright screenshots + Web Vitals collection.
 *
 * G5 infrastructure: gives evaluators (especially Design sense) the ability
 * to *see* rendered pages from a running dev server. Produces VisualCaptureResult
 * which is injected into EvaluationContext.
 *
 * Graceful degradation at every level:
 *   - Playwright not installed → returns degraded result, evaluation continues code-only
 *   - Individual route fails → skipped, other routes still captured
 *   - Web Vitals unavailable → screenshots still returned
 *   - Entire capture fails → returns degraded result with reason
 *
 * NE modulation: caller decides how many routes/viewports to capture
 * based on arousal level (build-cycle handles this).
 */

import type {
  VisualCaptureConfig,
  VisualCaptureResult,
  VisualCapture,
  WebVitalsMetrics,
  Viewport,
} from "../types/visual-capture.js";
import { VIEWPORTS } from "../types/visual-capture.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("visual-capture");

// ── Playwright lazy import ──────────────────────────────────────
// Playwright is an optional dependency. If it's not installed the
// system degrades to code-only evaluation — no crash.

type PlaywrightChromium = typeof import("playwright").chromium;

let _chromium: PlaywrightChromium | null | undefined; // undefined = not tried yet

async function getChromium(): Promise<PlaywrightChromium | null> {
  if (_chromium !== undefined) return _chromium;
  try {
    const pw = await import("playwright");
    _chromium = pw.chromium;
    return _chromium;
  } catch {
    log.warn("Playwright not available — visual capture disabled");
    _chromium = null;
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Build a VisualCaptureConfig from NE level and available info.
 *
 * High NE → more routes, more viewports (thorough).
 * Low NE  → fewer routes, desktop only (spot-check).
 */
export function buildCaptureConfig(
  neLevel: number,
  routes?: string[],
): VisualCaptureConfig {
  const captureRoutes = routes && routes.length > 0 ? routes : ["/"];

  let viewports: Viewport[];
  if (neLevel > 0.7) {
    // High arousal: all three viewports
    viewports = [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.mobile];
  } else if (neLevel > 0.5) {
    // Medium: desktop + mobile
    viewports = [VIEWPORTS.desktop, VIEWPORTS.mobile];
  } else {
    // Low: desktop only (spot-check)
    viewports = [VIEWPORTS.desktop];
  }

  return {
    routes: captureRoutes,
    viewports,
    pageTimeoutMs: 8000,
    collectWebVitals: true,
  };
}

/**
 * Capture screenshots and Web Vitals from a running dev server.
 *
 * Returns a VisualCaptureResult — always succeeds, possibly degraded.
 */
export async function captureVisuals(
  runtimeUrl: string,
  config: VisualCaptureConfig,
): Promise<VisualCaptureResult> {
  const chromium = await getChromium();
  if (!chromium) {
    return {
      captures: [],
      webVitals: [],
      degraded: true,
      degradedReason: "Playwright not available",
      failedRoutes: config.routes,
    };
  }

  emit("visual-capture:start", {
    runtimeUrl,
    routes: config.routes,
    viewports: config.viewports.map((v) => v.label),
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    log.warn("Failed to launch browser", { error: String(err) });
    return {
      captures: [],
      webVitals: [],
      degraded: true,
      degradedReason: `Browser launch failed: ${String(err)}`,
      failedRoutes: config.routes,
    };
  }

  const captures: VisualCapture[] = [];
  const webVitals: WebVitalsMetrics[] = [];
  const failedRoutes: string[] = [];
  const timeout = config.pageTimeoutMs ?? 8000;

  try {
    const context = await browser.newContext();

    for (const route of config.routes) {
      const url = `${runtimeUrl}${route}`;

      // Collect Web Vitals once per route (at desktop viewport)
      if (config.collectWebVitals !== false) {
        try {
          const vitals = await measureWebVitals(context, url, timeout);
          webVitals.push({ route, ...vitals });
        } catch (err) {
          log.warn("Web Vitals measurement failed", { route, error: String(err) });
          // Continue — screenshots may still work
        }
      }

      // Screenshot at each viewport
      let routeFailed = true;
      for (const viewport of config.viewports) {
        try {
          const capture = await screenshotRoute(context, url, route, viewport, timeout);
          captures.push(capture);
          routeFailed = false;
        } catch (err) {
          log.warn("Screenshot failed", { route, viewport: viewport.label, error: String(err) });
        }
      }
      if (routeFailed) failedRoutes.push(route);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const degraded = captures.length === 0;
  const result: VisualCaptureResult = {
    captures,
    webVitals,
    degraded,
    degradedReason: degraded ? "All captures failed" : undefined,
    failedRoutes,
  };

  emit("visual-capture:complete", {
    captureCount: captures.length,
    vitalsCount: webVitals.length,
    failedCount: failedRoutes.length,
    degraded,
  });

  log.info("Visual capture complete", {
    captures: captures.length,
    webVitals: webVitals.length,
    failed: failedRoutes.length,
    degraded,
  });

  return result;
}

// ── Internals ───────────────────────────────────────────────────

/** Screenshot a single route at a specific viewport. */
async function screenshotRoute(
  context: import("playwright").BrowserContext,
  url: string,
  route: string,
  viewport: Viewport,
  timeoutMs: number,
): Promise<VisualCapture> {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    const pageTitle = await page.title();

    return {
      route,
      viewport,
      screenshotBase64: screenshotBuffer.toString("base64"),
      capturedAt: new Date().toISOString(),
      pageTitle: pageTitle || undefined,
    };
  } finally {
    await page.close();
  }
}

/** Measure timing-based Web Vitals for a single page. */
async function measureWebVitals(
  context: import("playwright").BrowserContext,
  url: string,
  timeoutMs: number,
): Promise<Omit<WebVitalsMetrics, "route">> {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });

    // Extract performance timing from the browser
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return {};

      // LCP via PerformanceObserver (already buffered entries)
      let lcp: number | undefined;
      const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) {
        lcp = lcpEntries[lcpEntries.length - 1].startTime;
      }

      // CLS via layout-shift entries
      let cls: number | undefined;
      const layoutShiftEntries = performance.getEntriesByType("layout-shift") as
        Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>;
      if (layoutShiftEntries.length > 0) {
        cls = layoutShiftEntries
          .filter((e) => !e.hadRecentInput)
          .reduce((sum, e) => sum + (e.value ?? 0), 0);
      }

      return {
        lcp,
        cls,
        ttfb: nav.responseStart - nav.requestStart || undefined,
        domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime || undefined,
        loadComplete: nav.loadEventEnd - nav.startTime || undefined,
      };
    });

    return metrics;
  } finally {
    await page.close();
  }
}

/**
 * Summarize visual captures as a human-readable string for evaluator prompts.
 * This is the bridge between raw captures and what senses actually see.
 */
export function summarizeVisualCaptures(result: VisualCaptureResult): string {
  if (result.degraded && result.captures.length === 0) {
    return `VISUAL CAPTURE: Degraded — ${result.degradedReason ?? "unknown reason"}. Evaluate from code only.`;
  }

  const sections: string[] = [];
  sections.push("VISUAL CAPTURES:");

  // Group captures by route
  const byRoute = new Map<string, VisualCapture[]>();
  for (const c of result.captures) {
    const list = byRoute.get(c.route) ?? [];
    list.push(c);
    byRoute.set(c.route, list);
  }

  for (const [route, caps] of byRoute) {
    const viewportList = caps.map((c) => `${c.viewport.label} (${c.viewport.width}x${c.viewport.height})`).join(", ");
    const title = caps[0].pageTitle ? ` — "${caps[0].pageTitle}"` : "";
    sections.push(`  ${route}${title}: captured at ${viewportList}`);
  }

  // Web Vitals summary
  if (result.webVitals.length > 0) {
    sections.push("\nWEB VITALS:");
    for (const v of result.webVitals) {
      const parts: string[] = [];
      if (v.lcp !== undefined) parts.push(`LCP: ${Math.round(v.lcp)}ms`);
      if (v.cls !== undefined) parts.push(`CLS: ${v.cls.toFixed(3)}`);
      if (v.ttfb !== undefined) parts.push(`TTFB: ${Math.round(v.ttfb)}ms`);
      if (v.domContentLoaded !== undefined) parts.push(`DCL: ${Math.round(v.domContentLoaded)}ms`);
      if (v.loadComplete !== undefined) parts.push(`Load: ${Math.round(v.loadComplete)}ms`);
      sections.push(`  ${v.route}: ${parts.length > 0 ? parts.join(", ") : "no metrics available"}`);
    }
  }

  if (result.failedRoutes.length > 0) {
    sections.push(`\nFAILED ROUTES: ${result.failedRoutes.join(", ")}`);
  }

  return sections.join("\n");
}
