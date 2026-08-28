/**
 * executable-trust.ts — may Motion RUN what it found by scanning a directory?
 *
 * ROLE
 * ----
 * Motion discovers external tools by enumerating directories it did not create — most importantly
 * Playwright's browser cache, whose location a THIRD-PARTY environment variable
 * (`PLAYWRIGHT_BROWSERS_PATH`) can point anywhere, including at a shared CI / Docker / NFS cache
 * that several principals write. The result of that scan is then SPAWNED, and it is spawned by
 * `shellx-motion doctor` and by `motion.platform.requirements` — a `read_motion`, `mutates:false`
 * pre-flight that an agent is told is safe to call. So "which directories may contribute an
 * executable" is a security decision, not a convenience one, and it belongs in one audited place
 * rather than inline in each scanner.
 *
 * THE TRUST RULE
 * --------------
 * A directory may contribute an executable only when the set of principals who can change what is
 * inside it is a subset of {this user, root}. Concretely, for the directory itself (the TERMINAL
 * directory — a cache root, build, or layout component inside it):
 *
 *   1. its owner is this process's uid, or root (uid 0);
 *   2. it is not writable by "other";
 *   3. it is not writable by "group".
 *
 * and for every ANCESTOR up to the filesystem root, the same, except that group/other write is
 * tolerated when the sticky bit is set.
 *
 * Why each clause:
 *
 *   - OWNERSHIP, not just mode. A directory owned by a third party can be renamed or replaced
 *     wholesale by that party whatever its mode bits say, so a mode-only check is not a check.
 *     Root is trusted because a machine whose root account is hostile is already lost, and because
 *     refusing root-owned directories would refuse `/ms-playwright` in every official Playwright
 *     container image.
 *
 *   - STICKY RESCUES ANCESTORS ONLY. The attack on an ancestor is renaming or deleting the
 *     directory below it and substituting your own; the sticky bit is precisely the rule that
 *     forbids that to non-owners, which is why `mkdtemp` under a 1777 `/tmp` is safe. The attack on
 *     a terminal directory is CREATING a new entry inside it (`chromium-99999`), which the sticky
 *     bit permits. Treating the two the same in either direction would be wrong: strict everywhere
 *     rejects every temp-dir install, lenient everywhere re-opens the original hole.
 *
 * WINDOWS
 * -------
 * `node:fs` exposes no ACL information, and `Stats.uid`/`Stats.mode` on win32 are synthesised.
 * Callers that discover executables must therefore refuse such directories or use another
 * platform-specific authority. The Playwright-cache caller fails closed on win32; this low-level
 * POSIX predicate returns null only because it has no Windows ownership fact to evaluate.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * `node:fs` / `node:path` / `node:process` only, so it stays usable from a failure path.
 * Primary caller: `playwright-browser-cache.ts`.
 */
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

/** Mode bit: writable by users outside the owner and the group. */
const OTHER_WRITABLE = 0o002;
/** Mode bit: writable by members of the directory's group. */
const GROUP_WRITABLE = 0o020;
/** Mode bit: only an entry's owner may rename or delete it (the `/tmp` rule). */
const STICKY = 0o1000;

/** This process's uid, or null on a platform that has none (win32). */
function processUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Whether one directory's owner and mode allow a principal other than this user or root to change
 * what is inside it.
 *
 * @param stats Result of `statSync` on the directory.
 * @param uid This process's uid.
 * @param allowSticky True for ancestors, where the sticky bit forbids the rename substitution that
 *   is the only attack an ancestor enables. False for a terminal directory, where the attack is
 *   creating a new entry and the sticky bit does not forbid it.
 * @returns The reason it is untrusted, or null.
 */
function writableByOthersReason(stats: Stats, uid: number, allowSticky: boolean): string | null {
  if (stats.uid !== uid && stats.uid !== 0) {
    return `it is owned by uid ${stats.uid}, which is neither this user nor root`;
  }
  const rescued = allowSticky && (stats.mode & STICKY) !== 0;
  if ((stats.mode & OTHER_WRITABLE) !== 0 && !rescued) return "it is world-writable";
  if ((stats.mode & GROUP_WRITABLE) !== 0 && !rescued) return "it is group-writable";
  return null;
}

/**
 * Reject a path that reaches its target through a symbolic link.
 *
 * `realpathSync` alone is deliberately not enough: it tells us WHERE a link lands, but the
 * Playwright cache admission rule needs the logical cache layout itself to be canonical. A link
 * inside an otherwise trusted build can be retargeted by whoever controls that link, so every
 * component is inspected with `lstatSync` before the ownership walk follows anything.
 */
function nonCanonicalPathReason(path: string): string | null {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const parts = relative(parsed.root, absolute).split(sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    current = current === parsed.root ? `${parsed.root}${parts[index]}` : `${current}${sep}${parts[index]}`;
    let facts: Stats;
    try {
      facts = lstatSync(current);
    } catch {
      return index === parts.length - 1
        ? "it could not be resolved on this filesystem"
        : "one of its parent directories could not be resolved on this filesystem";
    }
    if (facts.isSymbolicLink()) {
      return index === parts.length - 1 ? "it is a symbolic link" : "one of its parent directories is a symbolic link";
    }
  }
  return null;
}

/**
 * Decide whether Motion may execute a binary discovered inside `directory`.
 *
 * Callers should pass a path they have already resolved with `realpathSync` when they also need the
 * resolved value; this function resolves again itself so that it is sound when called on its own.
 *
 * @param directory The directory whose contents would be executed.
 * @param options.ancestors Walk the parents too. Default true. Pass false only when the caller has
 *   ALREADY validated an ancestor of this directory with the walk enabled — one build directory
 *   inside an already-trusted cache root is the case this exists for, and it keeps a scan of N
 *   entries from re-statting the same chain N times.
 * @returns A sentence naming why the directory is untrusted, or null when it may be used. The
 *   sentence is phrased to follow the directory's name ("<name> was skipped because …"), so a
 *   caller can surface a refusal instead of reporting an unexplained "no browser found". It never
 *   embeds a path: the caller decides how to name the directory, and the callers that show this to
 *   a user show it in fields that must not republish a home directory.
 */
export function untrustedExecutableDirectoryReason(
  directory: string,
  options: { ancestors?: boolean; trustedAncestor?: string } = {}
): string | null {
  const canonicalReason = nonCanonicalPathReason(directory);
  if (canonicalReason) return canonicalReason;
  const uid = processUid();
  // See the WINDOWS section of the module header: there is no ownership fact to read here.
  if (uid === null) return null;

  let current: string;
  try {
    current = realpathSync(resolve(directory));
  } catch {
    return "it could not be resolved on this filesystem";
  }
  const trustedAncestor = options.trustedAncestor === undefined ? undefined : resolve(options.trustedAncestor);
  if (trustedAncestor !== undefined) {
    const suffix = relative(trustedAncestor, current);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      return "it is outside the host-verified trusted ancestor";
    }
  }

  let terminal = true;
  for (;;) {
    let stats: Stats;
    try {
      stats = statSync(current);
    } catch {
      return terminal ? "it could not be inspected" : "one of its parent directories could not be inspected";
    }
    if (terminal && !stats.isDirectory()) return "it is not a directory";
    const reason = writableByOthersReason(stats, uid, !terminal);
    // The offending ancestor is deliberately not named. `namei -l <dir>` finds it in one command,
    // and the callers that print this sentence must not republish a home directory to do so.
    if (reason) return terminal ? reason : `one of its parent directories is untrusted: ${reason}`;
    if (terminal && options.ancestors === false) return null;
    if (trustedAncestor !== undefined && current === trustedAncestor) return null;
    terminal = false;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Decide whether a discovered executable leaf may be run.
 *
 * This is intentionally separate from the directory predicate: a directory can be trusted while
 * a group-writable regular file inside it can still be replaced in place. Callers that already
 * checked every parent component may pass `ancestors: false` to avoid repeating that walk.
 */
export function untrustedExecutableFileReason(
  file: string,
  options: { ancestors?: boolean } = {}
): string | null {
  const canonicalReason = nonCanonicalPathReason(file);
  if (canonicalReason) return canonicalReason;

  let facts: Stats;
  try {
    facts = lstatSync(resolve(file));
  } catch {
    return "it could not be resolved on this filesystem";
  }
  if (!facts.isFile()) return "it is not a regular file";
  if ((facts.mode & 0o111) === 0) return "it is not executable";

  const uid = processUid();
  if (uid === null) return null;
  const reason = writableByOthersReason(facts, uid, false);
  if (reason) return reason;
  if (options.ancestors === false) return null;
  return untrustedExecutableDirectoryReason(dirname(file));
}

/**
 * Whether `candidate` resolves to something inside `root`.
 *
 * `existsSync` and `spawn` both follow symlinks, so a symlinked cache entry is executed wherever it
 * points. Both sides are resolved before the comparison because a prefix test on unresolved strings
 * is defeated by a symlink at any component, and `..` inside the candidate.
 *
 * @param root Directory the candidate must not escape.
 * @param candidate Path to test.
 * @returns True when the resolved candidate is `root` itself or lies beneath it.
 */
export function resolvesInside(root: string, candidate: string): boolean {
  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    resolvedRoot = realpathSync(resolve(root));
    resolvedCandidate = realpathSync(resolve(candidate));
  } catch {
    return false;
  }
  // `relative` rather than a string prefix: a prefix test reads `/cache-evil` as inside `/cache`,
  // and it has to be written twice to cover both separators. An empty result means "the same
  // directory"; anything starting `..` or absolute means the candidate escaped.
  const step = relative(resolvedRoot, resolvedCandidate);
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}
