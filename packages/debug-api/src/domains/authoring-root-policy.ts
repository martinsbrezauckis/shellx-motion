import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

interface ApprovedRoot {
  lexical: string;
  canonical: string;
}

export class AuthoringRootPolicyError extends Error {
  readonly code = "authoring_path_not_approved";

  constructor(message: string) {
    super(message);
    this.name = "AuthoringRootPolicyError";
  }
}

/** Enforce a host-configured input boundary without disclosing rejected paths. */
export async function assertConfiguredAuthoringInputRoot(
  path: string,
  roots: string[] | undefined,
): Promise<void> {
  if (roots === undefined) return;
  const message = "Procedural package must be inside an approved authoring input root and may not traverse symbolic links.";
  try {
    const approved = await canonicalizeRoots(roots);
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AuthoringRootPolicyError(message);
    const canonical = await realpath(lexical);
    for (const root of approved) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical)) return;
    }
    throw new AuthoringRootPolicyError(message);
  } catch (error) {
    if (error instanceof AuthoringRootPolicyError) throw error;
    throw new AuthoringRootPolicyError(message);
  }
}

/** Enforce a host-configured output boundary for existing or not-yet-created directories. */
export async function assertConfiguredAuthoringOutputRoot(
  path: string,
  roots: string[] | undefined,
): Promise<void> {
  if (roots === undefined) return;
  const message = "Procedural package output must be inside an approved authoring output root and may not traverse symbolic links.";
  try {
    const approved = await canonicalizeRoots(roots);
    const lexical = resolve(path);
    const canonical = await canonicalPathForSafety(lexical);
    const entry = await lstat(lexical).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new AuthoringRootPolicyError(message);
    }
    for (const root of approved) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical, true)) return;
    }
    throw new AuthoringRootPolicyError(message);
  } catch (error) {
    if (error instanceof AuthoringRootPolicyError) throw error;
    throw new AuthoringRootPolicyError(message);
  }
}

async function canonicalizeRoots(roots: string[]): Promise<ApprovedRoot[]> {
  if (roots.length === 0) throw new AuthoringRootPolicyError("Configured authoring roots must not be empty.");
  return Promise.all(roots.map(async (root) => {
    const lexical = resolve(root);
    const entry = await lstat(lexical);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new AuthoringRootPolicyError("Configured authoring roots must be existing non-symbolic-link directories.");
    }
    return { lexical, canonical: await realpath(lexical) };
  }));
}

async function hasNoSymlinkBelowRoot(root: string, candidate: string, allowMissing = false): Promise<boolean> {
  const relation = relative(root, candidate);
  if (relation === "") return true;
  let cursor = root;
  for (const segment of relation.split(/[\\/]+/)) {
    cursor = join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return false;
    } catch (error) {
      if (allowMissing && isMissingPathError(error)) return true;
      throw error;
    }
  }
  return true;
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const lexical = resolve(path);
  try {
    return await realpath(lexical);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parent = resolve(lexical, "..");
    return parent === lexical ? lexical : join(await canonicalPathForSafety(parent), basename(lexical));
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
