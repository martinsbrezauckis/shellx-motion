import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a directory to its host-canonical identity (for example /var -> /private/var on macOS). */
export async function canonicalAttestedReuseDirectory(pathInput: string, label: string): Promise<string> {
  const path = await realpath(resolve(pathInput));
  if (!(await stat(path)).isDirectory()) throw new Error(`${label} is not a directory`);
  return path;
}

/**
 * Preserve the caller's root-relative target while translating an OS-level root alias to the
 * canonical root. Later directory walks still reject any symlink below that trusted root.
 */
export function canonicalAttestedReusePathInsideRoot(input: {
  requestedRoot: string;
  canonicalRoot: string;
  path: string;
  label: string;
}): string {
  const requestedRoot = resolve(input.requestedRoot);
  const canonicalRoot = resolve(input.canonicalRoot);
  const requestedPath = resolve(input.path);
  const relativePath = attestedReusePathInside(requestedRoot, requestedPath)
    ? relative(requestedRoot, requestedPath)
    : attestedReusePathInside(canonicalRoot, requestedPath)
      ? relative(canonicalRoot, requestedPath)
      : undefined;
  if (relativePath === undefined) throw new Error(`${input.label} escapes its root`);
  const canonicalPath = resolve(canonicalRoot, relativePath);
  if (!attestedReusePathInside(canonicalRoot, canonicalPath)) throw new Error(`${input.label} escapes its root`);
  return canonicalPath;
}

export function attestedReusePathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}
