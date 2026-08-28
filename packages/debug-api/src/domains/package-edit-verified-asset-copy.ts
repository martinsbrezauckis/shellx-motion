import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  OutputPathTopology,
  readBoundedStableFile,
  resolvePackageAsset,
  writeVerifiedBoundedFile,
  type StableFileIdentity,
} from "@shellx-motion/core";
import { PackageEditTransactionError } from "./package-edit-transaction-error.js";

/**
 * The retained staged-target route is acquired under the package-output authority before a
 * provider-root scope is entered. The copy then uses that retained route rather than attempting
 * to acquire a fresh target topology while the provider authority is active.
 */
export interface PreparedAbsentAssetDestination {
  readonly targetAssetRef: string;
  readonly targetPath: string;
  readonly topology: OutputPathTopology;
}

export interface AdmittedProviderAssetSource {
  readonly sourcePath: string;
  readonly sourceRoot: string;
  readonly identity: StableFileIdentity;
  readonly sha256: string;
  readonly byteLength: number;
}

interface AdmittedPackageEditAsset extends AdmittedProviderAssetSource {
  readonly targetAssetRef: string;
}

/** A held O_NOFOLLOW/O_EXCL target descriptor, created only under package-output authority. */
export interface OpenedAbsentAssetDestination {
  readonly destination: PreparedAbsentAssetDestination;
  readonly handle: FileHandle;
}

/** Capture an absent package-local asset destination before entering a provider-source scope. */
export async function prepareAbsentVerifiedAssetDestination(
  stagedRoot: string,
  targetAssetRef: string,
): Promise<PreparedAbsentAssetDestination> {
  const portableRef = portableAssetRef(targetAssetRef);
  const targetPath = resolvePackageAsset({ root: stagedRoot }, portableRef);
  const topology = await OutputPathTopology.acquire(targetPath);
  await topology.assertCurrent();
  if (await existingLeaf(targetPath)) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider delivery asset destination must be absent in the source package.");
  }
  return { targetAssetRef: portableRef, targetPath, topology };
}

/** Open the already-admitted absent destination before the provider source scope is entered. */
export async function openPreparedAbsentAssetDestination(
  destination: PreparedAbsentAssetDestination,
): Promise<OpenedAbsentAssetDestination> {
  await destination.topology.assertCurrent();
  if (await existingLeaf(destination.targetPath)) {
    throw new PackageEditTransactionError("output_changed", "Provider delivery asset destination appeared before exclusive creation.");
  }
  try {
    const handle = await open(
      destination.targetPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    return { destination, handle };
  } catch (error) {
    if (isExistingPathError(error)) {
      throw new PackageEditTransactionError("output_changed", "Provider delivery asset destination appeared before exclusive creation.");
    }
    throw error;
  }
}

/**
 * Copy one admitted provider source through its exact retained source identity into a destination
 * that was proven absent under the separate package-output authority. The source path remains in
 * this stack frame only; all errors emitted here are deliberately path-free.
 */
export async function copyAdmittedProviderAsset(
  openedDestination: OpenedAbsentAssetDestination,
  source: AdmittedProviderAssetSource,
): Promise<void> {
  let verified: Awaited<ReturnType<typeof readBoundedStableFile>>;
  try {
    verified = await readBoundedStableFile(source.sourcePath, {
      label: "Admitted provider delivery source",
      maxBytes: source.byteLength,
      withinRoot: source.sourceRoot,
      requireSingleLink: true,
      captureIdentity: true,
      expectedIdentity: source.identity,
    });
  } catch {
    throw new PackageEditTransactionError("source_changed", "Admitted provider delivery source changed before package copy.");
  }
  if (!verified.identity || verified.byteLength !== source.byteLength || verified.sha256 !== source.sha256) {
    throw new PackageEditTransactionError("source_changed", "Admitted provider delivery source no longer matches its verified facts.");
  }

  // The descriptor was opened under package authority before this provider-root scope. Retained
  // topology checks still protect its parent route without acquiring a target route in this scope.
  await openedDestination.destination.topology.assertCurrent();
  let offset = 0;
  while (offset < verified.bytes.byteLength) {
    const { bytesWritten } = await openedDestination.handle.write(verified.bytes, offset, verified.bytes.byteLength - offset, offset);
    if (bytesWritten <= 0) throw new PackageEditTransactionError("copy_mismatch", "Provider delivery asset write made no progress.");
    offset += bytesWritten;
  }
  await openedDestination.handle.sync();
  await openedDestination.destination.topology.assertCurrent();
}

/** Close a held descriptor after provider scope exits, then reopen/re-hash under package authority. */
export async function closeAndVerifyAdmittedProviderAsset(
  openedDestination: OpenedAbsentAssetDestination,
  source: Pick<AdmittedProviderAssetSource, "sha256" | "byteLength">,
): Promise<void> {
  await openedDestination.handle.close();
  await openedDestination.destination.topology.assertCurrent();
  const output = await reopenPreparedDestination(openedDestination.destination, source.byteLength);
  if (output.sha256 !== source.sha256 || output.byteLength !== source.byteLength) {
    throw new PackageEditTransactionError("copy_mismatch", "Copied provider delivery asset failed its staged package verification.");
  }
}

/** Close a held target when source copy failed; the private COW workspace removes only its stage. */
export async function abandonOpenedProviderAsset(openedDestination: OpenedAbsentAssetDestination): Promise<void> {
  await openedDestination.handle.close().catch(() => {});
}

/** Existing package-edit caller behavior, extracted so provider imports share the verified copy seam. */
export async function copyVerifiedAsset(
  stagedRoot: string,
  file: {
    sourcePath: string;
    targetAssetRef: string;
    expectedSha256: string;
    sourceRoot?: string;
    expectedByteLength?: number;
    expectedIdentity?: StableFileIdentity;
  },
): Promise<void> {
  const hasAdmittedIdentity = file.sourceRoot !== undefined || file.expectedByteLength !== undefined || file.expectedIdentity !== undefined;
  if (hasAdmittedIdentity) {
    if (!file.sourceRoot || file.expectedByteLength === undefined || !file.expectedIdentity) {
      throw new PackageEditTransactionError("source_changed", "Imported package-edit asset admission facts are incomplete.");
    }
    await copyAdmittedBoundedAsset(stagedRoot, {
      sourcePath: file.sourcePath,
      sourceRoot: file.sourceRoot,
      targetAssetRef: file.targetAssetRef,
      sha256: file.expectedSha256,
      byteLength: file.expectedByteLength,
      identity: file.expectedIdentity,
    });
    return;
  }
  const portableRef = portableAssetRef(file.targetAssetRef);
  const sourcePath = resolve(file.sourcePath);
  const targetPath = resolvePackageAsset({ root: stagedRoot }, portableRef);
  const sourcePathBefore = await lstat(sourcePath);
  if (!sourcePathBefore.isFile() || sourcePathBefore.isSymbolicLink()) {
    throw new PackageEditTransactionError("unsupported_source_entry", "Imported package-edit asset must be a regular non-symlink file.");
  }
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const sourceBefore = await source.stat();
    if (!sourceBefore.isFile() || sourceBefore.dev !== sourcePathBefore.dev || sourceBefore.ino !== sourcePathBefore.ino) {
      throw new PackageEditTransactionError("source_changed", "Imported package-edit asset changed before staging.");
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await rm(targetPath, { force: true });
    target = await open(targetPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    for await (const chunkValue of source.createReadStream({ autoClose: false })) {
      const chunk = chunkValue as Buffer;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) throw new Error("Imported package-edit asset write made no progress.");
        offset += bytesWritten;
      }
    }
    await target.sync();
    const [sourceAfter, sourcePathAfter] = await Promise.all([source.stat(), lstat(sourcePath)]);
    if (sourceAfter.size !== sourceBefore.size
      || sourceAfter.mtimeMs !== sourceBefore.mtimeMs
      || sourceAfter.ctimeMs !== sourceBefore.ctimeMs
      || sourcePathAfter.isSymbolicLink()
      || sourcePathAfter.dev !== sourceAfter.dev
      || sourcePathAfter.ino !== sourceAfter.ino) {
      throw new PackageEditTransactionError("source_changed", "Imported package-edit asset changed during staging.");
    }
    if (hash.digest("hex") !== file.expectedSha256) {
      throw new PackageEditTransactionError("source_changed", "Imported package-edit asset bytes differ from the receipt input hash.");
    }
  } finally {
    await target?.close().catch(() => {});
    await source?.close().catch(() => {});
  }
  const targetStat = await lstat(targetPath);
  const targetHash = await hashOpenedRegularFile(targetPath, targetStat.dev, targetStat.ino, targetStat.size, false);
  if (targetHash !== file.expectedSha256) {
    throw new PackageEditTransactionError("copy_mismatch", "Staged package-edit asset failed post-copy verification.");
  }
}

/** Re-read an already-admitted source under its exact identity, then exclusively publish its bytes. */
async function copyAdmittedBoundedAsset(
  stagedRoot: string,
  source: AdmittedPackageEditAsset,
): Promise<void> {
  const portableRef = portableAssetRef(source.targetAssetRef);
  const targetPath = resolvePackageAsset({ root: stagedRoot }, portableRef);
  let admitted: Awaited<ReturnType<typeof readBoundedStableFile>>;
  try {
    admitted = await readBoundedStableFile(source.sourcePath, {
      label: "Admitted package asset import source",
      maxBytes: source.byteLength,
      withinRoot: source.sourceRoot,
      requireSingleLink: true,
      captureIdentity: true,
      expectedIdentity: source.identity,
    });
  } catch {
    throw new PackageEditTransactionError("source_changed", "Admitted package asset import source changed before package copy.");
  }
  if (!admitted.identity || admitted.byteLength !== source.byteLength || admitted.sha256 !== source.sha256) {
    throw new PackageEditTransactionError("source_changed", "Admitted package asset import source no longer matches its verified facts.");
  }
  try {
    const copied = await writeVerifiedBoundedFile(targetPath, admitted.bytes, {
      label: "Imported package asset",
      maxBytes: source.byteLength,
      withinRoot: stagedRoot,
      expectedSha256: source.sha256,
    });
    if (copied.byteLength !== source.byteLength || copied.sha256 !== source.sha256) {
      throw new PackageEditTransactionError("copy_mismatch", "Copied package asset failed its staged identity verification.");
    }
  } catch (error) {
    if (error instanceof PackageEditTransactionError) throw error;
    throw new PackageEditTransactionError("copy_mismatch", "Admitted package asset could not be exclusively copied into the staged package.");
  }
}

async function reopenPreparedDestination(
  destination: PreparedAbsentAssetDestination,
  expectedByteLength: number,
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  await destination.topology.assertCurrent();
  const before = await lstat(destination.targetPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expectedByteLength) {
    throw new PackageEditTransactionError("copy_mismatch", "Copied provider delivery asset is not a single-link regular file.");
  }
  const sha256 = await hashOpenedRegularFile(destination.targetPath, before.dev, before.ino, expectedByteLength, true);
  await destination.topology.assertCurrent();
  return { sha256, byteLength: expectedByteLength };
}

async function hashOpenedRegularFile(
  path: string,
  expectedDev: number,
  expectedIno: number,
  expectedByteLength: number,
  requireSingleLink: boolean,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== expectedDev || before.ino !== expectedIno
      || before.size !== expectedByteLength || (requireSingleLink && before.nlink !== 1)) {
      throw new PackageEditTransactionError("copy_mismatch", "Copied provider delivery asset changed before reopening.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino || pathAfter.size !== after.size
      || (requireSingleLink && (after.nlink !== 1 || pathAfter.nlink !== 1))) {
      throw new PackageEditTransactionError("copy_mismatch", "Copied provider delivery asset changed while reopening.");
    }
    return hash.digest("hex");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function existingLeaf(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function portableAssetRef(assetRef: string): string {
  const portable = assetRef.split("\\").join("/").replace(/^\.\//, "");
  if (!portable.startsWith("assets/") || portable === "assets/") {
    throw new PackageEditTransactionError("unsupported_source_entry", "Imported package-edit files must target the assets directory.");
  }
  return portable;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}
