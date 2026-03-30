/**
 * Project Discovery — figures out what kind of project this is.
 *
 * Uses innate tools (Read, Glob, Grep, Bash) to examine the project
 * directory and produce a ProjectProfile. Handles all three entry points:
 *   Greenfield — nothing on disk → kind: "greenfield"
 *   Mid-project — code exists, work remains
 *   Existing — full project
 *
 * This is Cortex's "day one" at a new job: open the repo, read
 * package.json, check the structure, find the dev command, understand
 * the tech stack.
 */

import { z } from "zod";
import type { ProjectProfile, ProjectKind } from "../types/runtime.js";
import { agenticCall } from "../llm/client.js";
import type { ActivatedToolSet } from "../types/pns.js";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const log = createLogger("project-discovery");

const RuntimeConfigSchema = z.object({
  name: z.string(),
  startCommand: z.string(),
  cwd: z.string().optional(),
  port: z.number(),
  readinessPath: z.string().optional(),
  readinessTimeoutSeconds: z.number().optional(),
});

const ProjectProfileSchema = z.object({
  kind: z.enum(["web-app", "api", "library", "cli", "monorepo", "static-site", "mobile", "greenfield", "unknown"]),
  language: z.string(),
  frameworks: z.array(z.string()),
  packageManager: z.string().optional(),
  runtimes: z.array(RuntimeConfigSchema),
  testCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  entryPoints: z.array(z.string()),
  entryPoint: z.enum(["greenfield", "mid-project", "existing"]),
});

const SYSTEM_PROMPT = `You are examining a software project directory to understand what it is and how to work with it.

Your job is to figure out:
1. What kind of project is this? (web app, API, library, CLI, monorepo, static site, mobile app, or greenfield if nothing exists)
2. What language and frameworks does it use?
3. How do you start it for development? (dev server command, port)
4. How do you test it?
5. How do you build it?
6. How do you lint it?
7. What are the key entry points?

HOW TO INVESTIGATE:
- Start with Glob to see the top-level structure
- Read package.json, requirements.txt, Cargo.toml, go.mod, or whatever package file exists
- Check for framework-specific config files (next.config.*, vite.config.*, tsconfig.json, etc.)
- Read the README if it exists
- Look at the scripts section of package.json for dev/test/build/lint commands
- If nothing exists (empty or near-empty directory), this is a greenfield project

For runtimes: figure out the dev server command and port. Common patterns:
- Next.js: "npm run dev" or "npx next dev", port 3000
- Vite: "npm run dev" or "npx vite", port 5173
- Create React App: "npm start", port 3000
- Express/Node API: check the start script and source for port
- Django: "python manage.py runserver", port 8000
- Flask: "flask run" or "python app.py", port 5000
- Rails: "rails server", port 3000
- Static: "npx serve" or "python -m http.server", port 3000/8000
- If it's a library with no runtime, return empty runtimes array

When done, respond with ONLY a JSON block:
{
  "kind": "web-app|api|library|cli|monorepo|static-site|mobile|greenfield|unknown",
  "language": "typescript|python|rust|go|ruby|java|etc",
  "frameworks": ["next.js", "tailwind", "prisma"],
  "packageManager": "npm|yarn|pnpm|pip|cargo|go|null",
  "runtimes": [{ "name": "dev-server", "startCommand": "npm run dev", "port": 3000, "readinessPath": "/" }],
  "testCommand": "npm test" or null,
  "buildCommand": "npm run build" or null,
  "lintCommand": "npm run lint" or null,
  "entryPoints": ["src/app/page.tsx", "src/index.ts"],
  "entryPoint": "greenfield|mid-project|existing"
}`;

const USER_PROMPT = `Examine the project in the current directory. Figure out what it is, how to run it, and what tools it uses. Start by looking at the file structure, then dig into config files.`;

/**
 * Discover project characteristics by reading the project directory.
 * Uses an agentic LLM call with innate read-only tools.
 */
export async function discoverProject(
  cwd: string,
  model: string,
  toolSet: ActivatedToolSet,
): Promise<ProjectProfile> {
  log.info("Discovering project", { cwd });

  const result = await agenticCall(
    "agenticMotor", // reuse purpose — this is a motor-like task
    model,
    SYSTEM_PROMPT,
    USER_PROMPT,
    toolSet,
    { maxTurns: 8 },
  );

  // Parse the structured result
  const jsonMatch = result.summary.match(/\{[\s\S]*"kind"[\s\S]*\}/);
  let profile: ProjectProfile;

  if (jsonMatch) {
    try {
      const parsed = ProjectProfileSchema.parse(JSON.parse(jsonMatch[0]));
      profile = {
        ...parsed,
        runtimes: parsed.runtimes.map((r) => ({
          ...r,
          readinessPath: r.readinessPath ?? "/",
          readinessTimeoutSeconds: r.readinessTimeoutSeconds ?? 30,
        })),
        rootDir: cwd,
        discoveredAt: new Date(),
      };
    } catch {
      log.warn("Failed to parse discovery result, using fallback", {
        summaryLength: result.summary.length,
      });
      profile = fallbackProfile(cwd);
    }
  } else {
    log.warn("No JSON found in discovery result, using fallback");
    profile = fallbackProfile(cwd);
  }

  emit("project:discovered", {
    kind: profile.kind,
    language: profile.language,
    frameworks: profile.frameworks,
    runtimeCount: profile.runtimes.length,
    entryPoint: profile.entryPoint,
  });

  log.info("Project discovered", {
    kind: profile.kind,
    language: profile.language,
    frameworks: profile.frameworks,
    runtimes: profile.runtimes.map((r) => r.name),
    entryPoint: profile.entryPoint,
  });

  return profile;
}

function fallbackProfile(cwd: string): ProjectProfile {
  return {
    kind: "unknown",
    language: "unknown",
    frameworks: [],
    runtimes: [],
    entryPoints: [],
    rootDir: cwd,
    discoveredAt: new Date(),
    entryPoint: "existing",
  };
}
