/**
 * Identity-bound admission for caller-selected output paths.
 *
 * Path containment alone is not authority: a symlink or a directory replacement can make the
 * same lexical string address a different object. Output writers therefore capture every parent
 * directory identity before they create, remove, link, or rename a leaf, then revalidate that
 * whole route immediately before the operation. On POSIX we additionally reject a non-sticky
 * group/world-writable ancestor (or one owned by an unrelated uid), because a private child does
 * not stop another principal from renaming it through such a parent. On Windows we query every
 * existing route directory's raw DACL and fail closed when another principal can replace it or,
 * at the final parent/private destination, create or replace its children.
 */
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { canonicalDirectory, canonicalRouteDirectories, collectEntireExistingRoute } from "./output-path-canonical-directory";
import { OutputPathTopologyError } from "./output-path-topology-error";
import { captureTrustedWorkspaceParentRoute } from "./output-path-trusted-route";
import type { TrustedWorkspaceAnchorRoute } from "./output-path-trusted-workspace";

export { OutputPathTopologyError } from "./output-path-topology-error";

export type OutputPathIdentity = { dev: number; ino: number };
export type OutputDirectoryAuthorityOptions = {
  /** Motion-created control state: POSIX 0700 and a Windows DACL protected from unrelated writers. */
  private?: boolean;
  /** Caller-selected output which Motion will populate: authority-safe and child-safe, but POSIX 0755 is valid. */
  requiresChildWrite?: boolean;
  /** A retained store may be reopened only when its selected root excludes unrelated child creators. */
  requireExclusiveChildAuthority?: boolean;
};

export type OutputDirectoryReservationOptions = {
  allowExistingContents?: boolean;
  /** Retained Motion control state must stay private even when reopened for resume. */
  requirePrivate?: boolean;
  /** Retained state may be reopened only when unrelated principals cannot create children in its selected root. */
  requireExclusiveChildAuthority?: boolean;
  /** A fresh operation owns only a leaf it created atomically; a pre-seeded directory is refused. */
  requireAbsent?: boolean;
  /** A read authority may retain only a root that already exists; it never creates configuration. */
  requireExisting?: boolean;
};

/** Minimal retained directory contract that can cross trusted package boundaries. */
export interface RetainedDirectoryAuthority {
  readonly path: string;
  assertCurrent(): Promise<void>;
}

export type OutputPathLeafIdentity =
  | { kind: "missing" }
  | { kind: "file" | "directory" | "symlink" | "other"; dev: number; ino: number };

type CapturedDirectory = OutputPathIdentity & { path: string; requiresChildWrite: boolean };

export class OutputPathTopology {
  private constructor(readonly targetPath: string, readonly parentPath: string, private readonly directories: readonly CapturedDirectory[], private readonly trustedWorkspaceAnchor: TrustedWorkspaceAnchorRoute | undefined) {}

  static async acquire(path: string): Promise<OutputPathTopology> {
    const targetPath = resolve(path);
    const parentPath = dirname(targetPath);
    const route = await captureParentDirectories(parentPath, targetPath, true);
    return new OutputPathTopology(targetPath, parentPath, route.directories, route.trustedWorkspaceAnchor);
  }

  /**
   * Capture the existing route without creating missing parents. Consumers that only read a file
   * retain this object through the read, so a later pathname recheck cannot accept a root or
   * intermediate-directory replacement.
   */
  static async inspect(path: string): Promise<OutputPathTopology> {
    const targetPath = resolve(path);
    const parentPath = dirname(targetPath);
    const route = await captureParentDirectories(parentPath, targetPath, false);
    return new OutputPathTopology(targetPath, parentPath, route.directories, route.trustedWorkspaceAnchor);
  }

  /** Revalidate the captured lexical route before an output path operation. */
  async assertCurrent(): Promise<void> {
    await this.trustedWorkspaceAnchor?.assertCurrent();
    const actualDirectories = await canonicalRouteDirectories(this.directories);
    for (let index = 0; index < this.directories.length; index += 1) {
      const directory = this.directories[index]!;
      const actual = actualDirectories[index]!;
      if (actual.dev !== directory.dev || actual.ino !== directory.ino) {
        throw new OutputPathTopologyError("Output parent topology changed after admission; Motion left the output path untouched.", directory.path);
      }
    }
  }
}

/**
 * A retained output directory for a multi-step producer such as batch expansion. The public path
 * is either created as private Motion state under an admitted topology, or accepted only when its
 * existing authority excludes unrelated writers. A caller retains this object and calls
 * `assertCurrent()` before each new phase instead of treating one initial check as continuing
 * authority.
 */
export class OutputDirectoryReservation implements RetainedDirectoryAuthority {
  private constructor(
    readonly path: string,
    private readonly topology: OutputPathTopology,
    private readonly identity: OutputPathIdentity,
    private readonly privateDirectory: boolean,
    private readonly exclusiveChildAuthority: boolean
  ) {}

  static async acquire(path: string, options: OutputDirectoryReservationOptions = {}): Promise<OutputDirectoryReservation> {
    const targetPath = resolve(path);
    const topology = options.requireExisting
      ? await OutputPathTopology.inspect(targetPath)
      : await OutputPathTopology.acquire(targetPath);
    const initial = await captureOutputLeaf(targetPath);
    if (initial.kind === "missing") {
      if (options.requireExisting) {
        throw new OutputPathTopologyError("Output directory authority requires an existing directory.", targetPath);
      }
      await topology.assertCurrent();
      await assertOutputLeafIdentity(targetPath, initial, "Output directory reservation");
      try {
        await mkdir(targetPath, { mode: 0o700 });
      } catch (error: any) {
        if (error?.code === "EEXIST") {
          throw new OutputPathTopologyError("Output directory reservation was created by another principal after admission; Motion left it intact.", targetPath);
        }
        throw error;
      }
    } else if (initial.kind !== "directory") {
      throw new OutputPathTopologyError("Output directory must be a private directory or absent.", targetPath);
    } else if (options.requireAbsent) {
      throw new OutputPathTopologyError("Output directory reservation already exists; a fresh operation never adopts pre-seeded state.", targetPath);
    }
    const privateDirectory = initial.kind === "missing" || options.requirePrivate === true;
    const authority = privateDirectory
      ? { private: true }
      : { requiresChildWrite: true, requireExclusiveChildAuthority: options.requireExclusiveChildAuthority === true };
    const identity = await captureOutputDirectoryIdentity(targetPath, "Output directory reservation", authority);
    if (!options.allowExistingContents && (await readdir(targetPath)).length !== 0) {
      throw new OutputPathTopologyError("Output directory must be empty before this operation.", targetPath);
    }
    const reservation = new OutputDirectoryReservation(
      targetPath,
      topology,
      identity,
      privateDirectory,
      options.requireExclusiveChildAuthority === true
    );
    await reservation.assertCurrent();
    return reservation;
  }

  async assertCurrent(): Promise<void> {
    await this.topology.assertCurrent();
    await assertOutputDirectoryIdentity(
      this.path,
      this.identity,
      "Output directory reservation",
      this.privateDirectory
        ? { private: true }
        : { requiresChildWrite: true, requireExclusiveChildAuthority: this.exclusiveChildAuthority }
    );
  }
}

/**
 * Read-only topology admission for a preflight. Missing suffixes are intentionally not created;
 * a later mutating caller must acquire an OutputPathTopology before it acts.
 */
export async function inspectOutputPathTopology(path: string): Promise<void> {
  await OutputPathTopology.inspect(path);
}

export async function captureOutputLeaf(path: string): Promise<OutputPathLeafIdentity> {
  const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!facts) return { kind: "missing" };
  return {
    kind: facts.isSymbolicLink() ? "symlink" : facts.isFile() ? "file" : facts.isDirectory() ? "directory" : "other",
    dev: Number(facts.dev),
    ino: Number(facts.ino)
  };
}

export async function assertOutputLeafIdentity(path: string, expected: OutputPathLeafIdentity, label: string): Promise<OutputPathLeafIdentity> {
  const actual = await captureOutputLeaf(path);
  if (!sameLeafIdentity(actual, expected)) {
    throw new OutputPathTopologyError(`${label} changed after Motion captured its identity; Motion left it untouched.`, path);
  }
  return actual;
}

export function sameLeafIdentity(actual: OutputPathLeafIdentity, expected: OutputPathLeafIdentity): boolean {
  return actual.kind === expected.kind
    && (actual.kind === "missing" || (expected.kind !== "missing" && actual.dev === expected.dev && actual.ino === expected.ino));
}

export async function captureOutputDirectoryIdentity(
  path: string,
  label: string,
  options: OutputDirectoryAuthorityOptions = {}
): Promise<OutputPathIdentity> {
  const facts = await canonicalDirectory(path, {
    requiresChildWrite: options.private === true || options.requiresChildWrite === true || options.requireExclusiveChildAuthority === true
  });
  if (options.private) assertPrivateDirectoryAuthority(facts, path, label);
  if (options.requireExclusiveChildAuthority) assertExclusiveChildAuthority(facts, path, label);
  return { dev: Number(facts.dev), ino: Number(facts.ino) };
}

export async function assertOutputDirectoryIdentity(
  path: string,
  expected: OutputPathIdentity,
  label: string,
  options: OutputDirectoryAuthorityOptions = {}
): Promise<void> {
  const actual = await captureOutputDirectoryIdentity(path, label, options);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new OutputPathTopologyError(`${label} changed after Motion captured its identity; Motion left it intact.`, path);
  }
}

async function captureParentDirectories(parentPath: string, targetPath: string, createMissing: boolean): Promise<{
  directories: CapturedDirectory[]; trustedWorkspaceAnchor: TrustedWorkspaceAnchorRoute | undefined;
}> {
  const trustedRoute = await captureTrustedWorkspaceParentRoute(parentPath, targetPath, createMissing, async (path, requiresChildWrite) => {
    const facts = await canonicalDirectory(path, { requiresChildWrite });
    return { dev: Number(facts.dev), ino: Number(facts.ino) };
  });
  if (trustedRoute) return trustedRoute;

  const root = parse(parentPath).root;
  const existingRoute = process.platform === "win32" ? await collectEntireExistingRoute(root, parentPath) : null;
  if (existingRoute) {
    const facts = await canonicalRouteDirectories(existingRoute.map((path) => ({ path, requiresChildWrite: path === parentPath })));
    return {
      directories: existingRoute.map((path, index) => ({
        path,
        dev: Number(facts[index]!.dev),
        ino: Number(facts[index]!.ino),
        requiresChildWrite: path === parentPath
      })),
      trustedWorkspaceAnchor: undefined
    };
  }
  let current = root;
  const rootRequiresChildWrite = root === parentPath;
  const rootFacts = await canonicalDirectory(root, { requiresChildWrite: rootRequiresChildWrite });
  const directories: CapturedDirectory[] = [{ path: root, dev: Number(rootFacts.dev), ino: Number(rootFacts.ino), requiresChildWrite: rootRequiresChildWrite }];
  for (const part of parentPath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      if (!createMissing) return { directories, trustedWorkspaceAnchor: undefined };
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const requiresChildWrite = current === parentPath;
    const facts = await canonicalDirectory(current, { requiresChildWrite });
    directories.push({ path: current, dev: Number(facts.dev), ino: Number(facts.ino), requiresChildWrite });
  }
  return { directories, trustedWorkspaceAnchor: undefined };
}

function assertPrivateDirectoryAuthority(facts: Awaited<ReturnType<typeof lstat>>, path: string, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (facts.uid !== process.getuid() || (Number(facts.mode) & 0o077) !== 0) {
    throw new OutputPathTopologyError(`${label} is not a private POSIX directory.`, path);
  }
}

/**
 * A sticky directory protects names that already exist; it does not prevent another principal
 * from creating a new child. Retained receipt stores therefore need their selected root to be
 * owner-controlled, while ordinary caller-selected 0755 output roots remain valid.
 */
function assertExclusiveChildAuthority(facts: Awaited<ReturnType<typeof lstat>>, path: string, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const mode = Number(facts.mode);
  if (facts.uid !== process.getuid()) {
    throw new OutputPathTopologyError(`${label} is not owned by the active POSIX principal for exclusive child authority.`, path);
  }
  if ((mode & 0o300) !== 0o300) {
    throw new OutputPathTopologyError(`${label} does not grant the active POSIX principal write and search authority.`, path);
  }
  if ((mode & 0o022) !== 0) {
    throw new OutputPathTopologyError(`${label} does not provide exclusive child authority: a group or world principal can create children even when sticky-bit protection is present.`, path);
  }
}
