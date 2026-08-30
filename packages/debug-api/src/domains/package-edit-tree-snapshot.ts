import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "@shellx-motion/core";
import { PackageEditTransactionError } from "./package-edit-transaction-error.js";

const MAX_PACKAGE_EDIT_FILES = 20_000;
const MAX_PACKAGE_EDIT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PACKAGE_EDIT_DEPTH = 32;
const MAX_PACKAGE_EDIT_PATH_BYTES = 4_096;

interface SnapshotState {
  files: number;
  bytes: number;
  entries: Map<string, string>;
  /**
   * File-system identities retained only for a same-stage recheck.  Source-to-stage copying
   * intentionally compares `entries` only: a copy must receive new file identities.
   */
  identities: Map<string, string>;
}

export interface PackageEditTreeSnapshotOptions {
  /** Refuse every file whose link count is not exactly one. */
  readonly requireSingleLink?: boolean;
}

/** Bounded no-follow source/stage snapshot for legacy package COW checks. */
export async function snapshotPackageEditTree(root: string, options: PackageEditTreeSnapshotOptions = {}): Promise<SnapshotState> {
  // Keep identities non-enumerable: this narrow same-stage aid must not alter the existing
  // content-snapshot shape consumed by legacy receipts, tests, or source-to-stage comparisons.
  const state = { files: 0, bytes: 0, entries: new Map<string, string>() } as SnapshotState;
  Object.defineProperty(state, "identities", { value: new Map<string, string>(), enumerable: false });
  await snapshotDirectory(root, "", 0, state, options);
  return state;
}

export function samePackageEditTreeSnapshot(left: SnapshotState, right: SnapshotState): boolean {
  if (left.files !== right.files || left.bytes !== right.bytes || left.entries.size !== right.entries.size) return false;
  for (const [path, value] of left.entries) if (right.entries.get(path) !== value) return false;
  return true;
}

/**
 * Portable, best-effort same-stage recheck.  It proves the exact bytes, tree names, and the
 * identity Node reports for each regular file and directory.  It is deliberately not the Linux
 * descriptor-relative closed inventory: a same-UID writer can still race after this recheck and
 * before rename, so flows requiring that stronger guarantee must select `closedInventory` and are
 * refused outside Linux until a native descriptor/DACL primitive is implemented there.
 */
export function samePackageEditTreeIdentitySnapshot(left: SnapshotState, right: SnapshotState): boolean {
  if (!samePackageEditTreeSnapshot(left, right) || left.identities.size !== right.identities.size) return false;
  for (const [path, value] of left.identities) if (right.identities.get(path) !== value) return false;
  return true;
}

async function snapshotDirectory(root: string, relativeDir: string, depth: number, state: SnapshotState, options: PackageEditTreeSnapshotOptions): Promise<void> {
  if (depth > MAX_PACKAGE_EDIT_DEPTH) {
    throw new PackageEditTransactionError("package_limit_exceeded", `Package tree exceeds ${MAX_PACKAGE_EDIT_DEPTH} directory levels.`);
  }
  const directoryPath = relativeDir ? join(root, relativeDir) : root;
  const before = await lstat(directoryPath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new PackageEditTransactionError("unsupported_source_entry", `Package directory is not a regular directory: ${relativeDir || "."}`);
  }
  if (relativeDir) {
    const portable = toPortablePath(relativeDir);
    state.entries.set(portable, "dir");
    state.identities.set(portable, directoryIdentity(before));
  }
  const entries = (await readdir(directoryPath, { withFileTypes: true, encoding: "utf8" }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    if (Buffer.byteLength(relativePath, "utf8") > MAX_PACKAGE_EDIT_PATH_BYTES) {
      throw new PackageEditTransactionError("package_limit_exceeded", `Package path exceeds ${MAX_PACKAGE_EDIT_PATH_BYTES} bytes.`);
    }
    const absolutePath = join(root, relativePath);
    const stat = await lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new PackageEditTransactionError("unsupported_source_entry", `Package edit source contains a symbolic link: ${toPortablePath(relativePath)}`);
    }
    if (stat.isDirectory()) {
      await snapshotDirectory(root, relativePath, depth + 1, state, options);
      continue;
    }
    if (!stat.isFile()) {
      throw new PackageEditTransactionError("unsupported_source_entry", `Package edit source contains a non-regular entry: ${toPortablePath(relativePath)}`);
    }
    state.files += 1;
    state.bytes += Number(stat.size);
    if (state.files > MAX_PACKAGE_EDIT_FILES || state.bytes > MAX_PACKAGE_EDIT_BYTES) {
      throw new PackageEditTransactionError("package_limit_exceeded", "Package edit source exceeds the bounded file or byte limit.");
    }
    if (options.requireSingleLink && stat.nlink !== 1n) {
      throw new PackageEditTransactionError("unsupported_source_entry", `Package edit source contains a non-single-link file: ${toPortablePath(relativePath)}`);
    }
    const sha256 = await hashRegularFile(absolutePath, stat.dev, stat.ino, options.requireSingleLink === true);
    const portable = toPortablePath(relativePath);
    state.entries.set(portable, `file:${stat.size}:${sha256}`);
    state.identities.set(portable, fileIdentity(stat));
  }
  const after = await lstat(directoryPath, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new PackageEditTransactionError("source_changed", `Package directory changed during snapshot: ${relativeDir || "."}`);
  }
}

async function hashRegularFile(path: string, expectedDev: bigint, expectedIno: bigint, requireSingleLink: boolean): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Node's O_NOFOLLOW flag is meaningful for this path only on Linux.  On Windows/macOS the
    // surrounding lstat/open/fstat/lstat sequence is an observable recheck, not a claim of
    // descriptor-relative closure; `closedInventory` remains explicitly unavailable there.
    handle = await open(path, fsConstants.O_RDONLY | (process.platform === "linux" ? fsConstants.O_NOFOLLOW : 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== expectedDev || before.ino !== expectedIno || (requireSingleLink && before.nlink !== 1n)) {
      throw new PackageEditTransactionError("source_changed", `Package file changed before hashing: ${path}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || (requireSingleLink && (after.nlink !== 1n || pathAfter.nlink !== 1n))) {
      throw new PackageEditTransactionError("source_changed", `Package file changed while hashing: ${path}`);
    }
    return hash.digest("hex");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function directoryIdentity(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `dir:${stat.dev}:${stat.ino}`;
}

function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `file:${stat.dev}:${stat.ino}:${stat.nlink}`;
}

function toPortablePath(path: string): string {
  return path.split("\\").join("/");
}
