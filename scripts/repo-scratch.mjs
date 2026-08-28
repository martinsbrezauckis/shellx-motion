/**
 * Private repository-owned scratch preparation for release/profile gates.
 *
 * A checked release command may use `.scratch`, but it must never turn an
 * umask-derived shared directory into authority for later destructive output
 * operations. This helper creates the root at 0700 when it is absent and
 * refuses every unsafe pre-existing state. It deliberately never chmods,
 * deletes, or otherwise repairs an existing path.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class RepoScratchError extends Error {
  constructor(code, path, message) {
    super(message);
    this.code = code;
    this.path = path;
    Object.setPrototypeOf(this, RepoScratchError.prototype);
  }
}

/**
 * Return the canonical private `.scratch` root belonging to this repository.
 *
 * POSIX checks require the current uid and no group/world permissions. On
 * Windows, Node exposes neither POSIX ownership nor ACL authority, so this
 * retains the portable non-link/canonical-directory checks without claiming an
 * ACL guarantee it cannot verify.
 */
export async function preparePrivateRepoScratch(repoRoot) {
  const canonicalRepoRoot = resolve(repoRoot);
  const scratchRoot = join(canonicalRepoRoot, ".scratch");
  const parentRoute = await captureCanonicalDirectoryRoute(dirname(scratchRoot));
  let first = await lstatIfPresent(scratchRoot);
  if (!first) {
    try {
      await mkdir(scratchRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new RepoScratchError(
          "repo_scratch_create_failed",
          scratchRoot,
          `Motion release scratch could not be created privately (${error?.code ?? "unknown error"}); refusing to continue.`
        );
      }
    }
    first = await lstatRequired(scratchRoot);
  }

  await assertPrivateRepoScratch(scratchRoot, first);
  const route = await captureCanonicalDirectoryRoute(scratchRoot);
  const scratchEntry = route.at(-1);
  if (!scratchEntry || scratchEntry.path !== scratchRoot || scratchEntry.dev !== first.dev || scratchEntry.ino !== first.ino) {
    throw unsafeScratch(scratchRoot, "it changed while Motion was admitting it");
  }
  // The root was admitted before creation, then the entire route (including
  // scratch) is rechecked after creation. A release gate may immediately rm
  // below this root only after this identity-bound admission succeeds.
  await assertDirectoryRouteCurrent(parentRoute);
  await assertDirectoryRouteCurrent(route);
  return scratchRoot;
}

/**
 * Admit an existing release-owned descendant before a profile gate removes or
 * replaces it. Missing descendants are permitted: callers create those with
 * an explicit 0700 mode after this function returns. Existing components must
 * remain private Motion-owned directories, so this never turns a umask-made
 * shared directory into an authority to remove.
 */
export async function assertPrivateRepoScratchPath(repoRoot, targetPath) {
  const scratchRoot = await preparePrivateRepoScratch(repoRoot);
  const target = resolve(targetPath);
  const suffix = relative(scratchRoot, target);
  if (suffix === "" || suffix === ".") return scratchRoot;
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw unsafeScratch(target, "it is outside this repository's private release scratch root");
  }

  const scratchRoute = await captureCanonicalDirectoryRoute(scratchRoot);
  await assertPrivateRepoScratch(scratchRoot, scratchRoute.at(-1).facts);
  const descendantRoute = await captureExistingPrivateDescendantRoute(
    scratchRoot,
    suffix.split(sep).filter(Boolean)
  );
  await assertDirectoryRouteCurrent([...scratchRoute, ...descendantRoute]);
  return target;
}

async function captureExistingPrivateDescendantRoute(parentPath, parts) {
  const [part, ...remaining] = parts;
  if (!part) return [];
  const current = join(parentPath, part);
  const facts = await lstatIfPresent(current);
  if (!facts) return [];
  const entry = await canonicalDirectory(current);
  await assertPrivateRepoScratch(current, entry.facts);
  return [entry, ...await captureExistingPrivateDescendantRoute(current, remaining)];
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new RepoScratchError(
      "repo_scratch_inspection_failed",
      path,
      `Motion release scratch could not be inspected (${error?.code ?? "unknown error"}); refusing to continue.`
    );
  }
}

async function lstatRequired(path) {
  const facts = await lstatIfPresent(path);
  if (!facts) throw unsafeScratch(path, "it disappeared while Motion was creating or checking it");
  return facts;
}

async function captureCanonicalDirectoryRoute(targetPath) {
  return captureCanonicalDirectoryEntries(canonicalDirectoryPaths(targetPath));
}

function canonicalDirectoryPaths(targetPath) {
  const normalizedTarget = resolve(targetPath);
  const root = parse(normalizedTarget).root;
  return normalizedTarget.slice(root.length).split(sep).filter(Boolean).reduce(
    (paths, part) => [...paths, join(paths.at(-1), part)],
    [root]
  );
}

async function captureCanonicalDirectoryEntries(paths) {
  const [path, ...remaining] = paths;
  if (!path) return [];
  return [await canonicalDirectory(path), ...await captureCanonicalDirectoryEntries(remaining)];
}

async function assertDirectoryRouteCurrent(route) {
  for (const expected of route) {
    const current = await canonicalDirectory(expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw unsafeScratch(expected.path, "a canonical ancestor changed after Motion captured its identity");
    }
  }
}

async function canonicalDirectory(path) {
  const facts = await lstatIfPresent(path);
  if (!facts || !facts.isDirectory() || facts.isSymbolicLink()) {
    throw unsafeScratch(path, "it is not a canonical non-symbolic-link directory");
  }
  const canonical = await realpath(path).catch((error) => {
    throw unsafeScratch(path, `its canonical path could not be read (${error?.code ?? "unknown error"})`);
  });
  if (canonical !== path) throw unsafeScratch(path, "it is not a canonical repository-local directory");
  assertPosixAncestorAuthority(path, facts);
  return { path, dev: facts.dev, ino: facts.ino, facts };
}

function assertPosixAncestorAuthority(path, facts) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (facts.uid !== uid && facts.uid !== 0) {
    throw unsafeScratch(path, "it is owned by an unrelated POSIX principal");
  }
  if ((Number(facts.mode) & 0o022) !== 0 && (Number(facts.mode) & 0o1000) === 0) {
    throw unsafeScratch(path, "it is group- or world-writable without sticky-bit protection");
  }
}

async function assertPrivateRepoScratch(path, facts) {
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw unsafeScratch(path, "it is not a regular non-symbolic-link directory");
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (facts.uid !== process.getuid()) {
    throw unsafeScratch(path, "it is not owned by the current POSIX user");
  }
  if ((Number(facts.mode) & 0o077) !== 0) {
    throw unsafeScratch(path, "it is not private to the current POSIX user (expected mode 0700)");
  }
}

function unsafeScratch(path, reason) {
  return new RepoScratchError(
    "repo_scratch_unsafe",
    path,
    `Motion release scratch is unsafe because ${reason}: ${path}. Motion did not modify it; use a fresh checkout or inspect and repair this path outside the release command.`
  );
}
