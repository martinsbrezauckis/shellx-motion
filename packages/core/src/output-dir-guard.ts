/**
 * Destructive-output guard for the ShellX Motion CLI and connectors.
 *
 * Caller-selected output paths may be forced, but force is not authority to follow a symlinked or
 * cross-principal-mutable parent. Every mutating branch acquires the shared output topology and
 * rechecks its parent/leaf identities immediately before rm, mkdir, or unlink. A changed object is
 * refused and preserved; the guard never compensates with a second delete or rollback.
 */
import { lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  assertOutputDirectoryIdentity,
  assertOutputLeafIdentity,
  captureOutputDirectoryIdentity,
  captureOutputLeaf,
  inspectOutputPathTopology,
  OutputPathTopology,
  OutputPathTopologyError,
  type OutputPathIdentity,
  type OutputPathLeafIdentity
} from "./output-path-topology";

export type OutputDirGuardErrorCode =
  | "output_dir_not_empty"
  | "output_path_not_a_directory"
  | "output_dir_unreadable"
  | "output_path_exists"
  | "frames_dir_escapes_root"
  /** Parent topology is symlinked, retargeted, or writable by an unrelated POSIX principal. */
  | "output_path_unsafe_parent";

export type OutputDirGuardError = {
  code: OutputDirGuardErrorCode;
  message: string;
  /** The exact lexical component or target that was refused. */
  path: string;
};

export type OutputDirGuardResult = { ok: true } | { ok: false; error: OutputDirGuardError };

export type PrepareOutputDirOptions = {
  /** `true` when the command was invoked with `--force`; replaces only the admitted leaf. */
  force: boolean;
};

/** Make a caller-selected directory safe to write, refusing an unsafe or occupied target. */
export async function prepareOutputDir(path: string, options: PrepareOutputDirOptions): Promise<OutputDirGuardResult> {
  return await prepareDirectory(path, options.force);
}

/**
 * Read-only preflight for connector batches. It validates every existing parent component but
 * intentionally creates nothing; a mutating caller acquires the same topology again before use.
 */
export async function refuseUnsafeOutputDirReuse(path: string): Promise<OutputDirGuardError | null> {
  try {
    await inspectOutputPathTopology(path);
  } catch (error) {
    return topologyRefusal(error, path);
  }
  const existing = await outputLeaf(path);
  if (existing.kind !== "directory") return await refusalForDirectory(path, existing);
  let identity: OutputPathIdentity;
  try {
    identity = await captureOutputDirectoryIdentity(path, "Output directory destination", { requiresChildWrite: true });
  } catch (error) {
    return topologyRefusal(error, path);
  }
  const refusal = await refusalForDirectory(path, existing);
  if (refusal) return refusal;
  try {
    await inspectOutputPathTopology(path);
    await assertOutputDirectoryIdentity(path, identity, "Output directory destination", { requiresChildWrite: true });
    return null;
  } catch (error) {
    return topologyRefusal(error, path);
  }
}

export type PrepareFramesDirOptions = PrepareOutputDirOptions & {
  /** `false` only for Motion's own default scratch root, never for a caller-supplied path. */
  callerSupplied: boolean;
  /** A package-derived frames path must remain lexically below this expected root. */
  withinRoot?: string;
};

/**
 * Prepare an empty frames directory. Motion's own default scratch root may be cleared without
 * `--force`; that exception still receives topology admission and identity-bound removal.
 */
export async function prepareFramesDir(path: string, options: PrepareFramesDirOptions): Promise<OutputDirGuardResult> {
  if (options.withinRoot !== undefined) {
    const root = resolve(options.withinRoot);
    const target = resolve(path);
    const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
    if (target !== root && !target.startsWith(rootWithSep)) {
      return {
        ok: false,
        error: {
          code: "frames_dir_escapes_root",
          message: `Refusing to prepare a frames directory outside its root: resolved to ${target}, which is outside ${root}.`,
          path: target
        }
      };
    }
  }
  // A missing property from a stale JavaScript caller is guarded, not granted the scratch wipe.
  return await prepareDirectory(path, options.force || options.callerSupplied === false);
}

/**
 * Guard a single-file deliverable. Force may unlink only the exact non-directory leaf captured
 * after parent admission; a symlink leaf is unlinked rather than followed, preserving its target.
 */
export async function prepareOutputFile(path: string, options: PrepareOutputDirOptions): Promise<OutputDirGuardResult> {
  let topology: OutputPathTopology;
  try {
    topology = await OutputPathTopology.acquire(path);
  } catch (error) {
    return { ok: false, error: topologyRefusal(error, path) };
  }
  const existing = await outputLeaf(path);
  if (existing.kind === "missing") return { ok: true };
  if (existing.kind === "directory") {
    return { ok: false, error: fileExistsRefusal(path, "Output path is an existing directory; Motion will not delete a directory to write a file, with or without --force.") };
  }
  if (!options.force) {
    return { ok: false, error: fileExistsRefusal(path, "Output file already exists; choose another --out path, or pass --force to overwrite it.") };
  }
  if (existing.kind !== "file" && existing.kind !== "symlink") {
    return { ok: false, error: fileExistsRefusal(path, "Output path is not a regular file or symbolic link; Motion left it intact.") };
  }
  try {
    await topology.assertCurrent();
    await assertOutputLeafIdentity(path, existing, "Output file destination");
    await unlink(path);
  } catch (error) {
    return { ok: false, error: topologyRefusal(error, path) };
  }
  return { ok: true };
}

export class MotionOutputGuardError extends Error {
  constructor(readonly code: OutputDirGuardErrorCode, message: string, readonly path: string) {
    super(message);
    this.name = "MotionOutputGuardError";
    Object.setPrototypeOf(this, MotionOutputGuardError.prototype);
  }
}

/** Throw a guard result's refusal with its code intact, or return when it is safe to proceed. */
export function assertOutputDirGuard(result: OutputDirGuardResult): void {
  if (result.ok) return;
  throw new MotionOutputGuardError(result.error.code, result.error.message, result.error.path);
}

async function prepareDirectory(path: string, destructive: boolean): Promise<OutputDirGuardResult> {
  let topology: OutputPathTopology;
  try {
    topology = await OutputPathTopology.acquire(path);
  } catch (error) {
    return { ok: false, error: topologyRefusal(error, path) };
  }
  const existing = await outputLeaf(path);
  if (!destructive) {
    if (existing.kind === "directory") {
      let identity: OutputPathIdentity;
      try {
        identity = await captureOutputDirectoryIdentity(path, "Output directory destination", { requiresChildWrite: true });
      } catch (error) {
        return { ok: false, error: topologyRefusal(error, path) };
      }
      const refusal = await refusalForDirectory(path, existing);
      if (refusal) return { ok: false, error: refusal };
      try {
        await topology.assertCurrent();
        await assertOutputDirectoryIdentity(path, identity, "Output directory destination", { requiresChildWrite: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: topologyRefusal(error, path) };
      }
    }
    const refusal = await refusalForDirectory(path, existing);
    if (refusal) return { ok: false, error: refusal };
    try {
      await topology.assertCurrent();
      await assertOutputLeafIdentity(path, existing, "Output directory destination");
      await mkdir(path, { mode: 0o700 });
      const identity = await captureOutputDirectoryIdentity(path, "Output directory destination", { private: true });
      await topology.assertCurrent();
      await assertOutputDirectoryIdentity(path, identity, "Output directory destination", { private: true });
    } catch (error) {
      return { ok: false, error: topologyRefusal(error, path) };
    }
    return { ok: true };
  }
  try {
    if (existing.kind !== "missing") {
      if (existing.kind === "directory") {
        await captureOutputDirectoryIdentity(path, "Forced output directory destination", { requiresChildWrite: true });
      }
      await topology.assertCurrent();
      await assertOutputLeafIdentity(path, existing, "Forced output directory destination");
      await rm(path, { recursive: true, force: true });
    }
    await topology.assertCurrent();
    await mkdir(path, { mode: 0o700 });
    const identity = await captureOutputDirectoryIdentity(path, "Output directory destination", { private: true });
    await topology.assertCurrent();
    await assertOutputDirectoryIdentity(path, identity, "Output directory destination", { private: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: topologyRefusal(error, path) };
  }
}

async function refusalForDirectory(path: string, existing: OutputPathLeafIdentity): Promise<OutputDirGuardError | null> {
  if (existing.kind === "missing") return null;
  if (existing.kind !== "directory") {
    return {
      code: "output_path_not_a_directory",
      path,
      message: `Output path already exists and is not a directory: ${path}. Nothing was written or deleted.`
    };
  }
  try {
    const entries = await readdir(path);
    if (entries.length === 0) return null;
    return {
      code: "output_dir_not_empty",
      path,
      message: `Output directory is not empty: ${path} (${entries.length} existing ${entries.length === 1 ? "entry" : "entries"}). Nothing was written or deleted.`
    };
  } catch (error) {
    return {
      code: "output_dir_unreadable",
      path,
      message: `Output directory could not be read: ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Nothing was written or deleted.`
    };
  }
}

async function outputLeaf(path: string): Promise<OutputPathLeafIdentity> {
  return await captureOutputLeaf(path);
}

function fileExistsRefusal(path: string, message: string): OutputDirGuardError {
  return { code: "output_path_exists", path, message: `${message} Nothing was written or deleted.` };
}

function topologyRefusal(error: unknown, fallbackPath: string): OutputDirGuardError {
  const path = error instanceof OutputPathTopologyError ? error.path : fallbackPath;
  const message = error instanceof Error ? error.message : String(error);
  return { code: "output_path_unsafe_parent", path, message: `Output path topology is unsafe: ${message}` };
}
