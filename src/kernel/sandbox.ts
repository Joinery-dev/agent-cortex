/**
 * Git Branch Sandbox — task isolation through branching.
 *
 * Each task executes in its own git branch. The Motor Cortex works
 * with real tools in the sandbox branch. On approval the branch merges
 * back; on failure it's discarded. This keeps the evaluation loop
 * fully reversible while enabling real file operations.
 *
 * Branch naming: cortex/task/{taskId}
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../util/logger.js";
import { emit } from "../events.js";

const execFileAsync = promisify(execFile);
const log = createLogger("sandbox");

export interface Sandbox {
  /** The task branch name (e.g., "cortex/task/abc123"). */
  branchName: string;
  /** The branch we forked from — merge target on accept. */
  baseBranch: string;
  /** Working directory for git operations. */
  cwd: string;
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Create a task branch off the current HEAD.
 * Commits any staged changes first to ensure a clean base.
 */
export async function createSandbox(
  taskId: string,
  cwd: string,
): Promise<Sandbox> {
  const branchName = `cortex/task/${taskId}`;

  // Capture current branch as the base
  const baseBranch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  // Create and switch to the task branch
  await git(cwd, ["checkout", "-b", branchName]);

  emit("sandbox:created", { taskId, branchName, baseBranch });
  log.info("Sandbox created", { taskId, branchName, baseBranch });

  return { branchName, baseBranch, cwd };
}

/**
 * Merge the task branch back to the base branch and clean up.
 * This is the "approval" path — the build passed evaluation.
 */
export async function acceptSandbox(sandbox: Sandbox): Promise<void> {
  const { branchName, baseBranch, cwd } = sandbox;

  // Stage and commit any uncommitted work on the task branch
  await commitSandboxWork(sandbox);

  // Switch back to base and merge
  await git(cwd, ["checkout", baseBranch]);
  await git(cwd, ["merge", branchName, "--no-ff", "-m", `cortex: merge ${branchName}`]);

  // Clean up the task branch
  await git(cwd, ["branch", "-d", branchName]);

  emit("sandbox:accepted", { branchName, baseBranch });
  log.info("Sandbox accepted and merged", { branchName, baseBranch });
}

/**
 * Discard the task branch — the build failed or a strategy reset was triggered.
 */
export async function discardSandbox(sandbox: Sandbox): Promise<void> {
  const { branchName, baseBranch, cwd } = sandbox;

  // Switch back to base
  await git(cwd, ["checkout", baseBranch]);

  // Force-delete the task branch
  await git(cwd, ["branch", "-D", branchName]);

  emit("sandbox:discarded", { branchName, baseBranch });
  log.info("Sandbox discarded", { branchName, baseBranch });
}

// ── Inspection ────────────────────────────────────────────────────

/**
 * Get the diff of changes in the sandbox relative to the base branch.
 */
export async function getSandboxDiff(sandbox: Sandbox): Promise<string> {
  // Stage any unstaged changes so they appear in the diff
  await commitSandboxWork(sandbox);
  return git(sandbox.cwd, ["diff", `${sandbox.baseBranch}...${sandbox.branchName}`]);
}

/**
 * List files changed in the sandbox relative to the base branch.
 */
export async function getSandboxChangedFiles(sandbox: Sandbox): Promise<string[]> {
  await commitSandboxWork(sandbox);
  const output = await git(sandbox.cwd, [
    "diff", "--name-only", `${sandbox.baseBranch}...${sandbox.branchName}`,
  ]);
  return output.trim().split("\n").filter(Boolean);
}

/**
 * Read a file's content from the sandbox branch.
 * Returns null if the file doesn't exist on the branch.
 */
export async function readSandboxFile(
  sandbox: Sandbox,
  filePath: string,
): Promise<string | null> {
  try {
    const absolutePath = join(sandbox.cwd, filePath);
    return await readFile(absolutePath, "utf-8");
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Stage and commit any uncommitted changes on the current branch.
 * No-op if the working tree is clean.
 */
async function commitSandboxWork(sandbox: Sandbox): Promise<void> {
  const status = await git(sandbox.cwd, ["status", "--porcelain"]);
  if (status.trim().length === 0) return;

  await git(sandbox.cwd, ["add", "-A"]);
  await git(sandbox.cwd, [
    "commit", "-m", `cortex: work-in-progress on ${sandbox.branchName}`,
    "--allow-empty",
  ]);
}
