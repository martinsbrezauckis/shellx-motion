import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function containsPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function nearestExisting(path) {
  let candidate = resolve(path);
  for (;;) {
    try {
      return { path: candidate, facts: await lstat(candidate) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertNoSymlinkComponents(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Public export target may not traverse a symbolic-link directory.");
    }
  }
}

/**
 * Derive the implicit sibling export only from the canonical implementation checkout.
 *
 * A linked worktree shares the canonical checkout's `.git` common directory. Deriving its export
 * relative to the linked checkout would place the result beneath `.worktrees/`, where it can look
 * valid while leaving the configured release surface stale. Callers in linked worktrees must name
 * an explicit governed `--out` target instead.
 */
export function defaultPublicExportTarget(repositoryRoot, manifestTarget, gitCommonDirectory) {
  const repository = resolve(repositoryRoot);
  if (typeof gitCommonDirectory !== "string" || gitCommonDirectory.length === 0) {
    throw new Error("Public export from an unverified checkout requires an explicit --out target.");
  }
  const commonDirectory = resolve(gitCommonDirectory);
  if (basename(commonDirectory) !== ".git" || dirname(commonDirectory) !== repository) {
    throw new Error("Public export from a linked worktree requires an explicit --out target.");
  }
  return resolve(repository, "..", manifestTarget);
}

/**
 * Resolve a destructive export target without accepting the repository, any path inside it, any
 * ancestor that contains it, or a target reached through a symlinked existing prefix.
 */
export async function safePublicExportTarget(repositoryRoot, requestedTarget) {
  const repository = await realpath(resolve(repositoryRoot));
  const requested = resolve(requestedTarget);
  const existing = await nearestExisting(requested);
  await assertNoSymlinkComponents(existing.path);
  if (!existing.facts.isDirectory()) {
    throw new Error("Public export target must have a real directory as its nearest existing path.");
  }
  const canonicalExisting = await realpath(existing.path);
  const target = resolve(canonicalExisting, relative(existing.path, requested));
  if (containsPath(repository, target) || containsPath(target, repository)) {
    throw new Error("Public export target must be disjoint from the implementation tree.");
  }
  return target;
}

/** Refuse a sidecar path that would follow a symlink or replace a non-file entry. */
export async function assertSafePublicExportReceipt(target) {
  const receiptPath = join(dirname(target), `${basename(target)}.EXPORT_RECEIPT.json`);
  try {
    const facts = await lstat(receiptPath);
    if (!facts.isFile() || facts.isSymbolicLink()) {
      throw new Error("Public export receipt must be a regular non-symlink file when it already exists.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return receiptPath;
}

/** Inspect one source entry without ever following a symbolic link. */
export async function publicExportSourceKind(path) {
  const facts = await lstat(path);
  if (facts.isSymbolicLink()) throw new Error(`Public export source contains a symbolic link: ${path}`);
  if (facts.isDirectory()) return "directory";
  if (facts.isFile()) return "file";
  throw new Error(`Public export source is not a regular file or directory: ${path}`);
}
