/**
 * Host-owned filesystem authority for final and batch rendering.
 *
 * This is intentionally separate from authoring-root-policy: rendering has a
 * different caller boundary and must not change the established authoring
 * compatibility behaviour.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  createTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor
} from "@shellx-motion/core/internal/trusted-host-workspace";

interface ApprovedRoot {
  lexical: string;
  canonical: string;
}

export interface RenderRootPolicy {
  /** A transport boundary (the debug server) must declare every render root. */
  enforce: boolean;
  packageRoots?: string[];
  inputRoots?: string[];
  outputRoots?: string[];
}

/** Root identity retained after the host admitted an external render input. */
export interface AdmittedRenderInputRoot {
  readonly root: string;
  /** POSIX identity fence retained through the eventual stable-file open. */
  readonly workspaceAnchor?: TrustedWorkspaceAnchor;
}

export class RenderRootPolicyError extends Error {
  readonly code = "render_path_not_approved";

  constructor(message: string) {
    super(message);
    this.name = "RenderRootPolicyError";
  }
}

export function renderRootPolicyIsActive(policy: RenderRootPolicy): boolean {
  return policy.enforce || policy.packageRoots !== undefined || policy.inputRoots !== undefined || policy.outputRoots !== undefined;
}

export async function assertConfiguredRenderPackageRoot(
  path: string,
  policy: RenderRootPolicy,
  subject = "Render packageRoot",
): Promise<void> {
  if (!renderRootPolicyIsActive(policy)) return;
  await assertInputDirectory(path, policy.packageRoots, subject, "render package roots");
}

/** Retain the package root identity while a batch opens its package documents. */
export async function admitConfiguredRenderPackageRoot(
  path: string,
  policy: RenderRootPolicy,
  subject = "Render packageRoot",
): Promise<AdmittedRenderInputRoot | undefined> {
  if (!renderRootPolicyIsActive(policy)) return undefined;
  const roots = await canonicalizeRoots(policy.packageRoots, "render package roots");
  const message = `${subject} must be inside an approved render package roots and may not traverse symbolic links.`;
  try {
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new RenderRootPolicyError(message);
    const canonical = await realpath(lexical);
    for (const root of roots) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical)) {
        const workspaceAnchor = process.platform === "win32" ? undefined : await createRenderWorkspaceAnchor(lexical, subject);
        return { root: lexical, ...(workspaceAnchor ? { workspaceAnchor } : {}) };
      }
    }
    throw new RenderRootPolicyError(message);
  } catch (error) {
    if (error instanceof RenderRootPolicyError) throw error;
    throw new RenderRootPolicyError(message);
  }
}

/**
 * Admit an external regular file and retain the *particular host root* which
 * admitted it. The caller passes this object to the eventual stable reader;
 * it must never recompute authority from a request argument later.
 */
export async function admitConfiguredRenderInputFile(
  path: string,
  policy: RenderRootPolicy,
  subject = "Render input file",
): Promise<AdmittedRenderInputRoot | undefined> {
  if (!renderRootPolicyIsActive(policy)) return undefined;
  const roots = await canonicalizeRoots(policy.inputRoots, "render input roots");
  const message = `${subject} must be a regular file inside an approved render input root and may not traverse symbolic links.`;
  try {
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new RenderRootPolicyError(message);
    const canonical = await realpath(lexical);
    for (const root of roots) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical)) {
        const workspaceAnchor = process.platform === "win32" ? undefined : await createRenderWorkspaceAnchor(root.lexical, subject);
        return { root: root.lexical, ...(workspaceAnchor ? { workspaceAnchor } : {}) };
      }
    }
    throw new RenderRootPolicyError(message);
  } catch (error) {
    if (error instanceof RenderRootPolicyError) throw error;
    throw new RenderRootPolicyError(message);
  }
}

export async function assertConfiguredRenderOutputDirectory(
  path: string,
  policy: RenderRootPolicy,
  subject = "Render output directory",
): Promise<void> {
  if (!renderRootPolicyIsActive(policy)) return;
  await assertOutput(path, policy.outputRoots, subject, false);
}

export async function assertConfiguredRenderOutputFile(
  path: string,
  policy: RenderRootPolicy,
  subject = "Render output file",
): Promise<void> {
  if (!renderRootPolicyIsActive(policy)) return;
  await assertOutput(path, policy.outputRoots, subject, true);
}

async function assertInputDirectory(path: string, roots: string[] | undefined, subject: string, rootName: string): Promise<void> {
  const message = `${subject} must be inside an approved ${rootName} and may not traverse symbolic links.`;
  try {
    const approved = await canonicalizeRoots(roots, rootName);
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new RenderRootPolicyError(message);
    const canonical = await realpath(lexical);
    for (const root of approved) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical)) return;
    }
    throw new RenderRootPolicyError(message);
  } catch (error) {
    if (error instanceof RenderRootPolicyError) throw error;
    throw new RenderRootPolicyError(message);
  }
}

async function assertOutput(path: string, roots: string[] | undefined, subject: string, file: boolean): Promise<void> {
  const noun = file ? "file" : "directory";
  const message = `${subject} must be a ${noun} inside an approved render output root and may not traverse symbolic links.`;
  try {
    const approved = await canonicalizeRoots(roots, "render output roots");
    const lexical = resolve(path);
    const entry = await lstat(lexical).catch((error: unknown) => isMissingPathError(error) ? null : Promise.reject(error));
    if (entry && (entry.isSymbolicLink() || (file ? !entry.isFile() : !entry.isDirectory()))) {
      throw new RenderRootPolicyError(message);
    }
    const canonical = entry ? await realpath(lexical) : await canonicalPathForSafety(lexical);
    for (const root of approved) {
      if (isInside(root.lexical, lexical)
        && isInside(root.canonical, canonical)
        && await hasNoSymlinkBelowRoot(root.lexical, lexical, true)) return;
    }
    throw new RenderRootPolicyError(message);
  } catch (error) {
    if (error instanceof RenderRootPolicyError) throw error;
    throw new RenderRootPolicyError(message);
  }
}

async function canonicalizeRoots(roots: string[] | undefined, rootName: string): Promise<ApprovedRoot[]> {
  if (!roots?.length) throw new RenderRootPolicyError(`Configured ${rootName} must not be empty.`);
  return await Promise.all(roots.map(async (root) => {
    const lexical = resolve(root);
    const entry = await lstat(lexical);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RenderRootPolicyError(`Configured ${rootName} must be existing non-symbolic-link directories.`);
    }
    return { lexical, canonical: await realpath(lexical) };
  }));
}

async function createRenderWorkspaceAnchor(root: string, subject: string): Promise<TrustedWorkspaceAnchor> {
  try {
    return await createTrustedWorkspaceAnchor(root);
  } catch (error) {
    throw new RenderRootPolicyError(`${subject} render input root could not retain its host identity: ${error instanceof Error ? error.message : "unsafe root"}`);
  }
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
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
