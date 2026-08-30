import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ExistingDirectoryAuthority, type RetainedDirectoryAuthority } from "@shellx-motion/core";

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

/** Return the host-selected lexical input root containing one already-admitted path. */
export function configuredAuthoringInputRoot(
  path: string,
  roots: string[] | undefined,
  subject = "Authoring input file",
): string {
  const lexical = resolve(path);
  const root = roots?.map((candidate) => resolve(candidate)).find((candidate) => isInside(candidate, lexical));
  if (!root) throw new AuthoringRootPolicyError(`${subject} must be inside an approved authoring input root and may not traverse symbolic links.`);
  return root;
}

/** Enforce a host-configured input boundary without disclosing rejected paths. */
export async function assertConfiguredAuthoringInputRoot(
  path: string,
  roots: string[] | undefined,
  subject = "Procedural package",
): Promise<void> {
  const message = `${subject} must be inside an approved authoring input root and may not traverse symbolic links.`;
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

/** Enforce the input boundary for a caller-supplied regular file immediately before opening it. */
export async function assertConfiguredAuthoringInputFile(
  path: string,
  roots: string[] | undefined,
  subject = "Authoring input file",
): Promise<void> {
  const message = `${subject} must be a regular file inside an approved authoring input root and may not traverse symbolic links.`;
  try {
    const approved = await canonicalizeRoots(roots);
    const lexical = resolve(path);
    const entry = await lstat(lexical);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new AuthoringRootPolicyError(message);
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

/** Capture the already-approved input directory identity for a later trusted consumer. */
export async function acquireConfiguredAuthoringInputRootAuthority(
  path: string,
  roots: string[] | undefined,
  subject = "Authoring input directory",
): Promise<RetainedDirectoryAuthority> {
  await assertConfiguredAuthoringInputRoot(path, roots, subject);
  const lexical = resolve(path);
  const authority = await ExistingDirectoryAuthority.acquire(await realpath(lexical));
  await assertConfiguredAuthoringInputRoot(path, roots, subject);
  if (resolve(await realpath(lexical)) !== resolve(authority.path)) {
    throw new AuthoringRootPolicyError(`${subject} changed after admission.`);
  }
  await authority.assertCurrent();
  return authority;
}

/** Capture the canonical parent of one approved input file for adapter-relative asset reads. */
export async function acquireConfiguredAuthoringInputFileDirectoryAuthority(
  path: string,
  roots: string[] | undefined,
  subject = "Authoring input file",
): Promise<RetainedDirectoryAuthority> {
  await assertConfiguredAuthoringInputFile(path, roots, subject);
  const lexical = resolve(path);
  const canonicalFile = await realpath(lexical);
  const authority = await ExistingDirectoryAuthority.acquire(dirname(canonicalFile));
  await assertConfiguredAuthoringInputFile(path, roots, subject);
  if (resolve(dirname(await realpath(lexical))) !== resolve(authority.path)) {
    throw new AuthoringRootPolicyError(`${subject} directory changed after admission.`);
  }
  await authority.assertCurrent();
  return authority;
}

/** Enforce a host-configured output boundary for existing or not-yet-created directories. */
export async function assertConfiguredAuthoringOutputRoot(
  path: string,
  roots: string[] | undefined,
  subject = "Procedural package output",
): Promise<void> {
  const message = `${subject} must be inside an approved authoring output root and may not traverse symbolic links.`;
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

/** Fail closed and validate both sides of one copy-on-write package edit. */
export async function assertConfiguredAuthoringPackageEditRoots(
  inputRoot: string,
  outputRoot: string,
  inputRoots: string[] | undefined,
  outputRoots: string[] | undefined,
  subject = "Motion package edit",
): Promise<void> {
  if (!inputRoots?.length || !outputRoots?.length) {
    throw new AuthoringRootPolicyError(`${subject} requires host-approved authoring input and output roots.`);
  }
  await assertConfiguredAuthoringInputRoot(inputRoot, inputRoots, `${subject} packageRoot`);
  await assertConfiguredAuthoringOutputRoot(outputRoot, outputRoots, `${subject} outDir`);
}

/** Fail closed before creating a package at a caller-named output path. */
export async function assertConfiguredAuthoringPackageCreateRoot(
  outputRoot: string,
  inputRoots: string[] | undefined,
  outputRoots: string[] | undefined,
  subject = "Motion package create",
): Promise<void> {
  if (!inputRoots?.length || !outputRoots?.length) {
    throw new AuthoringRootPolicyError(`${subject} requires host-approved authoring input and output roots.`);
  }
  await assertConfiguredAuthoringOutputRoot(outputRoot, outputRoots, `${subject} packageRoot`);
}

/** Enforce the output boundary for one file without permitting a pre-existing symlink leaf. */
export async function assertConfiguredAuthoringOutputFile(
  path: string,
  roots: string[] | undefined,
  subject = "Authoring output file",
): Promise<void> {
  const message = `${subject} must be inside an approved authoring output root and may not traverse symbolic links.`;
  try {
    const approved = await canonicalizeRoots(roots);
    const lexical = resolve(path);
    const entry = await lstat(lexical).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new AuthoringRootPolicyError(message);
    const canonical = entry ? await realpath(lexical) : await canonicalPathForSafety(lexical);
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

async function canonicalizeRoots(roots: string[] | undefined): Promise<ApprovedRoot[]> {
  if (!roots?.length) throw new AuthoringRootPolicyError("Configured authoring roots must not be empty.");
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
