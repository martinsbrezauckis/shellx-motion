import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const moduleSourceCheckoutRoot = resolve(import.meta.dirname, "../../..");

/** Normalizes Win32 extended-length and UNC spellings before any CLI path admission. */
export function normalizeWindowsExtendedPath(path: string): string {
  return path
    .replace(/^\\+\?\\+UNC\\+/i, "\\\\")
    .replace(/^\\+\?\\+/, "");
}

export function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/**
 * Resolves an input like the main CLI: prefer an existing process-cwd path,
 * then the source-checkout caller retained by pnpm in INIT_CWD.
 */
export function resolveCliInputPath(path: string): string {
  const normalizedPath = normalizeWindowsExtendedPath(path);
  if (isAbsolute(normalizedPath) || isWindowsAbsolutePath(normalizedPath)) return normalizedPath;
  const cwdPath = resolve(normalizedPath);
  if (existsSync(cwdPath)) return cwdPath;
  return resolve(cliCallerRoot(), normalizedPath);
}

/** Resolves output paths from INIT_CWD for source-checkout commands, else process cwd. */
export function resolveCliOutputPath(path: string): string {
  const normalizedPath = normalizeWindowsExtendedPath(path);
  if (isAbsolute(normalizedPath) || isWindowsAbsolutePath(normalizedPath)) return normalizedPath;
  return resolve(cliCallerRoot(), normalizedPath);
}

/** Ignore an inherited parent INIT_CWD that merely contains this source checkout. */
function cliCallerRoot(): string {
  const sourceRoot = sourceCheckoutRoot();
  const initCwd = process.env.INIT_CWD ? resolve(normalizeWindowsExtendedPath(process.env.INIT_CWD)) : undefined;
  if (!initCwd) return process.cwd();
  if (sourceRoot && initCwd !== sourceRoot && isInsideOrEqual(initCwd, sourceRoot)) return sourceRoot;
  return initCwd;
}

function sourceCheckoutRoot(): string | undefined {
  return existsSync(join(moduleSourceCheckoutRoot, "pnpm-workspace.yaml"))
    && existsSync(join(moduleSourceCheckoutRoot, "packages", "cli", "package.json"))
    ? moduleSourceCheckoutRoot
    : undefined;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child));
}
