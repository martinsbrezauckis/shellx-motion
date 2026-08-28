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
}

export interface PackageEditTreeSnapshotOptions {
  /** Refuse every file whose link count is not exactly one. */
  readonly requireSingleLink?: boolean;
}

/** Bounded no-follow source/stage snapshot for legacy package COW checks. */
export async function snapshotPackageEditTree(root: string, options: PackageEditTreeSnapshotOptions = {}): Promise<SnapshotState> {
  const state: SnapshotState = { files: 0, bytes: 0, entries: new Map() };
  await snapshotDirectory(root, "", 0, state, options);
  return state;
}

export function samePackageEditTreeSnapshot(left: SnapshotState, right: SnapshotState): boolean {
  if (left.files !== right.files || left.bytes !== right.bytes || left.entries.size !== right.entries.size) return false;
  for (const [path, value] of left.entries) if (right.entries.get(path) !== value) return false;
  return true;
}

async function snapshotDirectory(root: string, relativeDir: string, depth: number, state: SnapshotState, options: PackageEditTreeSnapshotOptions): Promise<void> {
  if (depth > MAX_PACKAGE_EDIT_DEPTH) {
    throw new PackageEditTransactionError("package_limit_exceeded", `Package tree exceeds ${MAX_PACKAGE_EDIT_DEPTH} directory levels.`);
  }
  const directoryPath = relativeDir ? join(root, relativeDir) : root;
  const before = await lstat(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new PackageEditTransactionError("unsupported_source_entry", `Package directory is not a regular directory: ${relativeDir || "."}`);
  }
  if (relativeDir) state.entries.set(toPortablePath(relativeDir), "dir");
  const entries = (await readdir(directoryPath, { withFileTypes: true, encoding: "utf8" }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    if (Buffer.byteLength(relativePath, "utf8") > MAX_PACKAGE_EDIT_PATH_BYTES) {
      throw new PackageEditTransactionError("package_limit_exceeded", `Package path exceeds ${MAX_PACKAGE_EDIT_PATH_BYTES} bytes.`);
    }
    const absolutePath = join(root, relativePath);
    const stat = await lstat(absolutePath);
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
    state.bytes += stat.size;
    if (state.files > MAX_PACKAGE_EDIT_FILES || state.bytes > MAX_PACKAGE_EDIT_BYTES) {
      throw new PackageEditTransactionError("package_limit_exceeded", "Package edit source exceeds the bounded file or byte limit.");
    }
    if (options.requireSingleLink && stat.nlink !== 1) {
      throw new PackageEditTransactionError("unsupported_source_entry", `Package edit source contains a non-single-link file: ${toPortablePath(relativePath)}`);
    }
    const sha256 = await hashRegularFile(absolutePath, stat.dev, stat.ino, options.requireSingleLink === true);
    state.entries.set(toPortablePath(relativePath), `file:${stat.size}:${sha256}`);
  }
  const after = await lstat(directoryPath);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new PackageEditTransactionError("source_changed", `Package directory changed during snapshot: ${relativeDir || "."}`);
  }
}

async function hashRegularFile(path: string, expectedDev: number, expectedIno: number, requireSingleLink: boolean): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expectedDev || before.ino !== expectedIno || (requireSingleLink && before.nlink !== 1)) {
      throw new PackageEditTransactionError("source_changed", `Package file changed before hashing: ${path}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || (requireSingleLink && (after.nlink !== 1 || pathAfter.nlink !== 1))) {
      throw new PackageEditTransactionError("source_changed", `Package file changed while hashing: ${path}`);
    }
    return hash.digest("hex");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function toPortablePath(path: string): string {
  return path.split("\\").join("/");
}
