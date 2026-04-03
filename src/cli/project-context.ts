/**
 * CLI Project Context — auto-discover project context without LLM calls.
 *
 * Reads project structure from the filesystem to populate intent:
 *   1. .cortex/config.json — explicit project config (if present)
 *   2. package.json / Cargo.toml / go.mod — tech stack detection
 *   3. git context — current branch, recent commits
 *   4. Saved taste profile — from ~/.agent-cortex/taste-profile.json
 *   5. References — from ~/.agent-cortex/references.json
 *
 * No LLM calls. Pure filesystem inspection. Fast enough for CLI cold start.
 * The full LLM-assisted ProjectDiscovery runs later in the project rhythm.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ProjectIntent, TasteProfile } from "../types/intent.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("project-context");

// ─── Config file ──────────────────────────────────────────────

/**
 * Optional .cortex/config.json at project root.
 *
 * Minimal — only what can't be auto-discovered or learned.
 * The system learns conventions, preferences, and patterns.
 * Config is for bootstrapping intent + references.
 */
export interface CortexProjectConfig {
  /** Project summary — overrides auto-generated summary. */
  summary?: string;
  /** Target audience. */
  audience?: string;
  /** Success criteria — what "done" looks like. */
  successCriteria?: string[];
  /** Constraints — limitations the system must respect. */
  constraints?: string[];
  /** Vision — the aspiration beyond the immediate task. */
  vision?: string;
  /** References — external system pointers. */
  references?: Array<{
    label: string;
    value: string;
    category: string;
    detail?: string;
  }>;
}

async function loadCortexConfig(cwd: string): Promise<CortexProjectConfig | null> {
  const configPath = join(cwd, ".cortex", "config.json");
  try {
    await access(configPath);
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as CortexProjectConfig;
  } catch {
    return null;
  }
}

// ─── Package detection ────────────────────────────────────────

interface PackageInfo {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function loadPackageJson(cwd: string): Promise<PackageInfo | null> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageInfo;
  } catch {
    return null;
  }
}

function detectTechStack(pkg: PackageInfo | null): string[] {
  if (!pkg) return [];
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack: string[] = [];

  // Frameworks
  if (all["next"]) stack.push("Next.js");
  if (all["react"]) stack.push("React");
  if (all["vue"]) stack.push("Vue");
  if (all["svelte"] || all["@sveltejs/kit"]) stack.push("SvelteKit");
  if (all["express"]) stack.push("Express");
  if (all["fastify"]) stack.push("Fastify");
  if (all["hono"]) stack.push("Hono");

  // Languages
  if (all["typescript"] || all["tsx"]) stack.push("TypeScript");

  // Testing
  if (all["vitest"]) stack.push("Vitest");
  if (all["jest"]) stack.push("Jest");
  if (all["playwright"] || all["@playwright/test"]) stack.push("Playwright");

  // Styling
  if (all["tailwindcss"]) stack.push("Tailwind CSS");

  // Database
  if (all["prisma"] || all["@prisma/client"]) stack.push("Prisma");
  if (all["drizzle-orm"]) stack.push("Drizzle");

  return stack;
}

// ─── Git context ──────────────────────────────────────────────

interface GitContext {
  branch: string;
  recentCommits: string[];
  isDirty: boolean;
}

function getGitContext(cwd: string): GitContext | null {
  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    const recentCommits = execSync("git log --oneline -5 2>/dev/null", { cwd, encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const status = execSync("git status --porcelain 2>/dev/null", { cwd, encoding: "utf-8" }).trim();

    return {
      branch,
      recentCommits,
      isDirty: status.length > 0,
    };
  } catch {
    return null;
  }
}

// ─── Taste loading ────────────────────────────────────────────

async function loadSavedTaste(): Promise<TasteProfile | null> {
  try {
    const { loadTasteProfile } = await import("../taste/store.js");
    return loadTasteProfile();
  } catch {
    return null;
  }
}

// ─── Main: assemble project context ───────────────────────────

export interface DiscoveredContext {
  intent: Partial<ProjectIntent>;
  taste: TasteProfile | null;
  references: CortexProjectConfig["references"];
  techStack: string[];
  gitContext: GitContext | null;
  configFound: boolean;
}

/**
 * Discover project context from the filesystem. No LLM calls.
 * Returns partial intent (merge with CLI args), saved taste, and references.
 */
export async function discoverProjectContext(cwd: string): Promise<DiscoveredContext> {
  // Parallel discovery
  const [config, pkg, savedTaste] = await Promise.all([
    loadCortexConfig(cwd),
    loadPackageJson(cwd),
    loadSavedTaste(),
  ]);

  const gitCtx = getGitContext(cwd);
  const techStack = detectTechStack(pkg);

  // Build partial intent from discovered context
  const intent: Partial<ProjectIntent> = {};

  // Config takes priority
  if (config) {
    if (config.summary) intent.summary = config.summary;
    if (config.audience) intent.audience = config.audience;
    if (config.successCriteria) intent.successCriteria = config.successCriteria;
    if (config.constraints) intent.constraints = config.constraints;
    if (config.vision) intent.vision = config.vision;
  }

  // Auto-generate constraints from tech stack
  if (techStack.length > 0 && !intent.constraints?.length) {
    intent.constraints = [`Tech stack: ${techStack.join(", ")}`];
  }

  // Package.json enrichment
  if (pkg?.description && !intent.summary) {
    intent.summary = pkg.description;
  }

  log.info("Project context discovered", {
    configFound: !!config,
    packageFound: !!pkg,
    techStack,
    gitBranch: gitCtx?.branch,
    savedTaste: !!savedTaste,
    referenceCount: config?.references?.length ?? 0,
  });

  return {
    intent,
    taste: savedTaste,
    references: config?.references,
    techStack,
    gitContext: gitCtx,
    configFound: !!config,
  };
}
