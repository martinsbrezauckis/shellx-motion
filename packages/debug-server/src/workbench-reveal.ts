/**
 * workbench-reveal.ts — open an artifact's containing folder in the OS file manager.
 *
 * Role: implement `POST /workbench/reveal`. MCP agents create render/preview/
 * connector artifacts that a user then cannot find on disk; the Engine Room
 * receipt cards call this endpoint to reveal the artifact in the platform file
 * manager (Files/Finder/Explorer).
 *
 * Security invariants:
 * - The requested path is validated against the server's authenticated artifact
 *   roots (scratch, receipts, and any operator-configured `--artifact-root`).
 *   Arbitrary filesystem paths are rejected; there is no path-from-query escape.
 * - The path is realpath-contained and symlinks are refused, reusing the same
 *   no-escape rule as the bounded artifact reader.
 * - The OS opener is spawned shell-free with an argv array, so a path can never be
 *   interpreted as a shell command. The opener is injectable for tests.
 *
 * Dependencies: node:child_process (spawn, no shell), node:fs/promises, node:path.
 */
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The concrete target the opener is asked to reveal. */
export interface RevealTarget {
  /** Canonical path of the artifact itself. */
  path: string;
  /** Canonical containing directory to open/select in. */
  directory: string;
  /** Host platform, so the opener can pick the right file-manager command. */
  platform: NodeJS.Platform;
}

/** An injectable OS opener; the default spawns the platform file manager. */
export type RevealOpener = (target: RevealTarget) => Promise<{ ok: true } | { ok: false; message: string }>;

/** Result envelope for a reveal request. */
export type RevealResult =
  | { ok: true; revealed: string; platform: NodeJS.Platform }
  | { ok: false; status: number; code: string; message: string };

/**
 * Validate an artifact path against the authenticated roots and reveal its
 * containing folder through the provided OS opener.
 *
 * @param requestedPath Absolute artifact path supplied by the authenticated client.
 * @param roots Authenticated artifact roots the path must resolve inside.
 * @param opener The OS opener (default reveals in the platform file manager).
 * @returns A typed success or error result.
 */
export async function runWorkbenchReveal(requestedPath: unknown, roots: string[], opener: RevealOpener): Promise<RevealResult> {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "" || requestedPath.includes("\0") || !isAbsolute(requestedPath)) {
    return { ok: false, status: 400, code: "invalid_reveal_path", message: "Reveal requests require an absolute artifact path." };
  }
  const resolvedPath = resolve(requestedPath);

  let facts: Awaited<ReturnType<typeof lstat>>;
  try {
    facts = await lstat(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404, code: "reveal_target_not_found", message: "The reveal target was not found." };
    }
    return { ok: false, status: 400, code: "unsafe_reveal_target", message: "The reveal target could not be opened safely." };
  }
  if (facts.isSymbolicLink()) {
    return { ok: false, status: 400, code: "unsafe_reveal_target", message: "The reveal target must not be a symlink." };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolvedPath);
  } catch {
    return { ok: false, status: 400, code: "unsafe_reveal_target", message: "The reveal target could not be resolved safely." };
  }
  if (!(await isInsideRoots(canonicalPath, roots))) {
    return { ok: false, status: 403, code: "reveal_target_outside_roots", message: "The reveal target is outside the authenticated artifact roots." };
  }

  const directory = facts.isDirectory() ? canonicalPath : dirname(canonicalPath);
  const opened = await opener({ path: canonicalPath, directory, platform: process.platform });
  if (!opened.ok) {
    return { ok: false, status: 500, code: "reveal_failed", message: `The OS file manager could not be opened: ${opened.message}` };
  }
  return { ok: true, revealed: directory, platform: process.platform };
}

/** True when the canonical path resolves inside at least one canonical root. */
async function isInsideRoots(canonicalPath: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(root);
      const rel = relative(canonicalRoot, canonicalPath);
      if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
        return true;
      }
    } catch {
      // A missing/unreadable root never widens reveal access.
    }
  }
  return false;
}

/**
 * Build the default OS opener. It selects the artifact in the platform file
 * manager where supported (macOS `open -R`, Windows `explorer /select,`) and
 * otherwise opens the containing directory (`xdg-open`). Every launch is
 * shell-free with an argv array.
 */
export function createDefaultRevealOpener(): RevealOpener {
  return (target) => spawnRevealCommand(revealCommandFor(target));
}

/** Resolve the file-manager command and argv for the host platform. */
function revealCommandFor(target: RevealTarget): { command: string; args: string[] } {
  if (target.platform === "darwin") {
    return { command: "open", args: ["-R", target.path] };
  }
  if (target.platform === "win32") {
    // explorer's select syntax takes a single "/select,<path>" token.
    return { command: "explorer.exe", args: [`/select,${target.path}`] };
  }
  // Linux/other: xdg-open cannot select a file, so open the containing folder.
  return { command: "xdg-open", args: [target.directory] };
}

/**
 * Spawn the file-manager command shell-free and resolve as soon as the child
 * process launches. File managers stay resident, so waiting for exit is wrong;
 * a spawn error (missing binary) is surfaced as a typed failure.
 */
function spawnRevealCommand(plan: { command: string; args: string[] }): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    try {
      const child = spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolvePromise({ ok: false, message: error instanceof Error ? error.message : String(error) });
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolvePromise({ ok: true });
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}
