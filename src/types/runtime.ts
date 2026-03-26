/**
 * Runtime & Project Profile — what kind of project this is and how to run it.
 *
 * The system discovers these at intake by reading the project with innate
 * tools (package.json, project structure, config files). The human doesn't
 * declare them — the system looks around and figures it out, just like a
 * new engineer on day one.
 *
 * Three entry points:
 *   Greenfield — nothing on disk. System chooses stack, scaffolds, builds.
 *   Mid-project — code exists, work remains. System maps what's done, continues.
 *   Existing — everything exists. System maps the full system, then works.
 */

// ── Project Profile ──────────────────────────────────────────────
// Discovered by the system during intake. Represents "what kind of
// project is this and how do I interact with it."

export type ProjectKind =
  | "web-app"
  | "api"
  | "library"
  | "cli"
  | "monorepo"
  | "static-site"
  | "mobile"
  | "greenfield"    // nothing exists yet
  | "unknown";

export interface ProjectProfile {
  /** What kind of project this is. */
  kind: ProjectKind;
  /** Primary language. */
  language: string;
  /** Detected frameworks and major libraries. */
  frameworks: string[];
  /** Package manager (npm, yarn, pnpm, pip, cargo, go, etc.). */
  packageManager?: string;
  /** How to start the project for observation. Computed, not declared. */
  runtimes: RuntimeConfig[];
  /** How to run tests. */
  testCommand?: string;
  /** How to build for production. */
  buildCommand?: string;
  /** How to lint/format. */
  lintCommand?: string;
  /** Key entry points and important files. */
  entryPoints: string[];
  /** Project root directory. */
  rootDir: string;
  /** When this profile was discovered. */
  discoveredAt: Date;
  /** Entry point type — was this a fresh project, mid-project, or existing? */
  entryPoint: "greenfield" | "mid-project" | "existing";
}

/** Configuration for a single runtime process. */
export interface RuntimeConfig {
  /** Human-readable label (e.g., "dev-server", "api"). */
  name: string;
  /** Shell command to start the runtime (e.g., "npm run dev"). */
  startCommand: string;
  /** Working directory for the command (relative to project root). */
  cwd?: string;
  /** Port the runtime listens on. */
  port: number;
  /** URL path to use for readiness check (GET request, expect 2xx). Default: "/". */
  readinessPath?: string;
  /** Max seconds to wait for readiness before giving up. Default: 30. */
  readinessTimeoutSeconds?: number;
  /** Shell command to stop the runtime (defaults to killing the process). */
  stopCommand?: string;
  /** Environment variables to set when starting. */
  env?: Record<string, string>;
}

/** A running runtime instance. */
export interface RuntimeInstance {
  config: RuntimeConfig;
  /** The URL the runtime is accessible at (e.g., "http://localhost:3000"). */
  url: string;
  /** Process ID, if managed by us. */
  pid?: number;
  /** When the runtime was started. */
  startedAt: Date;
  /** Whether the readiness check passed. */
  ready: boolean;
}
