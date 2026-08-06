import { createHash } from "node:crypto";
import {
  compareCodeUnits,
  compileMotionDocumentCompositing,
  hashBuffer,
  hashPackageFile,
  loadMotionPackage,
  resolvePackageAsset,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import { constants as fsConstants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_PACKAGE_EDIT_FILES = 20_000;
const MAX_PACKAGE_EDIT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PACKAGE_EDIT_DEPTH = 32;
const MAX_PACKAGE_EDIT_PATH_BYTES = 4_096;

export type PackageEditTransactionErrorCode =
  | "unsafe_output"
  | "output_not_empty"
  | "source_changed"
  | "copy_mismatch"
  | "unsupported_source_entry"
  | "package_limit_exceeded"
  | "output_changed";

export class PackageEditTransactionError extends Error {
  constructor(readonly code: PackageEditTransactionErrorCode, message: string) {
    super(message);
    this.name = "PackageEditTransactionError";
  }
}

export interface PackageEditTransactionOptions<T, U = undefined> {
  sourceRoot: string;
  outputRoot: string;
  edit: (stagedRoot: string) => Promise<T>;
  validate?: (stagedRoot: string, editResult: T) => Promise<void>;
  afterCommit?: (outputRoot: string, editResult: T) => Promise<U>;
}

export interface PackageEditTransactionResult<T, U> {
  outputRoot: string;
  editResult: T;
  afterCommitResult: U;
}

export interface NewPackageTransactionOptions<T, U = undefined> {
  outputRoot: string;
  build: (stagedRoot: string) => Promise<T>;
  validate?: (stagedRoot: string, buildResult: T) => Promise<void>;
  beforeCommit?: (stagedRoot: string, buildResult: T) => Promise<void>;
  afterCommit?: (outputRoot: string, buildResult: T) => Promise<U>;
}

export async function commitNewPackage<T, U = undefined>(
  options: NewPackageTransactionOptions<T, U>
): Promise<PackageEditTransactionResult<T, U>> {
  const outputRoot = resolve(options.outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  await canonicalPathForSafety(outputRoot);
  const initialOutput = await inspectOutputClaim(outputRoot);
  const stageRoot = await mkdtemp(join(dirname(outputRoot), `.${safeToken(basename(outputRoot))}.shellx-new-`));
  const stagedPackageRoot = join(stageRoot, "package");
  const backupRoot = join(stageRoot, "previous-output");
  let backupClaimed = false;
  let outputInstalled = false;
  let cleanupStage = true;
  try {
    await mkdir(stagedPackageRoot, { mode: 0o700 });
    const buildResult = await options.build(stagedPackageRoot);
    const stagedBuild = await snapshotTree(stagedPackageRoot);
    if (options.validate) await options.validate(stagedPackageRoot, buildResult);
    const stagedValidated = await snapshotTree(stagedPackageRoot);
    if (!sameSnapshot(stagedBuild, stagedValidated)) {
      throw new PackageEditTransactionError("source_changed", "New package validation changed staged package bytes.");
    }
    if (options.beforeCommit) await options.beforeCommit(stagedPackageRoot, buildResult);
    const stagedBeforeCommit = await snapshotTree(stagedPackageRoot);
    if (!sameSnapshot(stagedBuild, stagedBeforeCommit)) {
      throw new PackageEditTransactionError("source_changed", "New package staging changed before output claim.");
    }

    if (initialOutput.exists) {
      await rename(outputRoot, backupRoot);
      backupClaimed = true;
      const claimed = await inspectClaimedBackup(backupRoot);
      if (claimed.dev !== initialOutput.dev || claimed.ino !== initialOutput.ino) {
        throw new PackageEditTransactionError("output_changed", "New package output changed before it could be claimed.");
      }
    } else {
      try {
        await mkdir(outputRoot);
      } catch (error) {
        if (isExistingPathError(error)) {
          throw new PackageEditTransactionError("output_changed", "New package output appeared before commit.");
        }
        throw error;
      }
      const claim = await inspectOutputClaim(outputRoot);
      await rename(outputRoot, backupRoot);
      backupClaimed = true;
      const claimed = await inspectClaimedBackup(backupRoot);
      if (!claim.exists || claimed.dev !== claim.dev || claimed.ino !== claim.ino) {
        throw new PackageEditTransactionError("output_changed", "Exclusive new package output claim changed before commit.");
      }
    }

    const stagedAtInstall = await snapshotTree(stagedPackageRoot);
    if (!sameSnapshot(stagedBuild, stagedAtInstall)) {
      throw new PackageEditTransactionError("source_changed", "New package staging changed during output claim.");
    }
    await rename(stagedPackageRoot, outputRoot);
    outputInstalled = true;
    let afterCommitResult: U = undefined as U;
    if (options.afterCommit) afterCommitResult = await options.afterCommit(outputRoot, buildResult);
    return { outputRoot, editResult: buildResult, afterCommitResult };
  } catch (error) {
    if (outputInstalled) {
      await rm(outputRoot, { recursive: true, force: true });
      outputInstalled = false;
    }
    if (backupClaimed && initialOutput.exists) {
      try {
        await rename(backupRoot, outputRoot);
        backupClaimed = false;
      } catch {
        cleanupStage = false;
        throw new PackageEditTransactionError(
          "output_changed",
          `New package rollback was obstructed; the previous empty destination is preserved at ${backupRoot}.`
        );
      }
    }
    throw error;
  } finally {
    if (cleanupStage) await rm(stageRoot, { recursive: true, force: true });
  }
}

export interface MotionDocumentEditOptions {
  sourcePackage: MotionPackage;
  outputRoot: string;
  patchedMotion: MotionDocument;
  patchedManifest?: MotionPackage["manifest"];
  stagedFiles?: Array<{ sourcePath: string; targetAssetRef: string; expectedSha256: string }>;
  receipt: OperationReceipt;
  receiptFileName: string;
  receiptsRoot?: string;
  writeHostReceipt?: (receiptsRoot: string, receipt: OperationReceipt) => Promise<string>;
}

export interface MotionDocumentEditResult {
  packageRoot: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  hostReceiptPath?: string;
}

export async function commitMotionDocumentEdit(options: MotionDocumentEditOptions): Promise<MotionDocumentEditResult> {
  const packageRoot = resolve(options.outputRoot);
  const manifestPath = join(packageRoot, "manifest.json");
  const motionPath = join(packageRoot, options.sourcePackage.manifest.motion);
  const receiptPath = join(packageRoot, "receipts", options.receiptFileName);
  // Every authoring family edits the preserved source layers. Recompile an attached graph at the
  // transaction boundary so timeline/keying/tracking/procedural edits cannot leave renderer-visible
  // generated layers stale while retaining apparently current compile metadata.
  const persistedMotion = compileMotionDocumentCompositing(options.patchedMotion);
  const transaction = await commitPackageEdit({
    sourceRoot: options.sourcePackage.root,
    outputRoot: packageRoot,
    edit: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      assertParsedPackageIdentity(options.sourcePackage, stagedPkg);
      await assertReceiptInputHashes(options.receipt, stagedPkg);
      for (const file of options.stagedFiles ?? []) await copyVerifiedAsset(stagedRoot, file);
      if (options.patchedManifest) await writeJson(join(stagedRoot, "manifest.json"), options.patchedManifest);
      await writeJson(join(stagedRoot, stagedPkg.manifest.motion), persistedMotion);
      await writeJson(join(stagedRoot, "receipts", options.receiptFileName), options.receipt);
    },
    validate: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      if (jsonHash(stagedPkg.motion) !== jsonHash(persistedMotion)) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged package edit did not preserve the validated Motion document.");
      }
      if (options.patchedManifest && jsonHash(stagedPkg.manifest) !== jsonHash(options.patchedManifest)) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged package edit did not preserve the validated package manifest.");
      }
    },
    afterCommit: async () => options.receiptsRoot && options.writeHostReceipt
      ? options.writeHostReceipt(options.receiptsRoot, options.receipt)
      : undefined
  });
  return {
    packageRoot,
    manifestPath,
    motionPath,
    receiptPath,
    ...(transaction.afterCommitResult ? { hostReceiptPath: transaction.afterCommitResult } : {})
  };
}

interface DirectoryClaim {
  exists: boolean;
  dev?: number;
  ino?: number;
}

interface SnapshotState {
  files: number;
  bytes: number;
  entries: Map<string, string>;
}

export async function commitPackageEdit<T, U = undefined>(
  options: PackageEditTransactionOptions<T, U>
): Promise<PackageEditTransactionResult<T, U>> {
  const sourceRoot = resolve(options.sourceRoot);
  const outputRoot = resolve(options.outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  const [canonicalSource, canonicalOutput] = await Promise.all([
    realpath(sourceRoot),
    canonicalPathForSafety(outputRoot)
  ]);
  if (isPathInsideOrEqual(canonicalSource, canonicalOutput) || isPathInsideOrEqual(canonicalOutput, canonicalSource)) {
    throw new PackageEditTransactionError("unsafe_output", "Package edit output must be outside the source package.");
  }

  const initialOutput = await inspectOutputClaim(outputRoot);
  const sourceBefore = await snapshotTree(sourceRoot);
  const stageRoot = await mkdtemp(join(dirname(outputRoot), `.${safeToken(basename(outputRoot))}.shellx-edit-`));
  const stagedPackageRoot = join(stageRoot, "package");
  const backupRoot = join(stageRoot, "previous-output");
  let backupClaimed = false;
  let outputInstalled = false;
  let cleanupStage = true;
  try {
    await cp(sourceRoot, stagedPackageRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
    const stagedBefore = await snapshotTree(stagedPackageRoot);
    if (!sameSnapshot(sourceBefore, stagedBefore)) {
      throw new PackageEditTransactionError("copy_mismatch", "Staged package bytes do not match the source package snapshot.");
    }

    const editResult = await options.edit(stagedPackageRoot);
    if (options.validate) await options.validate(stagedPackageRoot, editResult);
    const sourceAfter = await snapshotTree(sourceRoot);
    if (!sameSnapshot(sourceBefore, sourceAfter)) {
      throw new PackageEditTransactionError("source_changed", "Source package changed while the edit transaction was running.");
    }

    if (initialOutput.exists) {
      await rename(outputRoot, backupRoot);
      backupClaimed = true;
      const claimed = await inspectClaimedBackup(backupRoot);
      if (claimed.dev !== initialOutput.dev || claimed.ino !== initialOutput.ino) {
        throw new PackageEditTransactionError("output_changed", "Package edit output changed before it could be claimed.");
      }
    } else {
      try {
        await mkdir(outputRoot);
      } catch (error) {
        if (isExistingPathError(error)) {
          throw new PackageEditTransactionError("output_changed", "Package edit output appeared before commit.");
        }
        throw error;
      }
      const claim = await inspectOutputClaim(outputRoot);
      await rename(outputRoot, backupRoot);
      backupClaimed = true;
      const claimed = await inspectClaimedBackup(backupRoot);
      if (!claim.exists || claimed.dev !== claim.dev || claimed.ino !== claim.ino) {
        throw new PackageEditTransactionError("output_changed", "Exclusive package edit output claim changed before commit.");
      }
    }

    await rename(stagedPackageRoot, outputRoot);
    outputInstalled = true;
    let afterCommitResult: U = undefined as U;
    if (options.afterCommit) afterCommitResult = await options.afterCommit(outputRoot, editResult);
    return { outputRoot, editResult, afterCommitResult };
  } catch (error) {
    if (outputInstalled) {
      await rm(outputRoot, { recursive: true, force: true });
      outputInstalled = false;
    }
    if (backupClaimed && initialOutput.exists) {
      try {
        await rename(backupRoot, outputRoot);
        backupClaimed = false;
      } catch {
        cleanupStage = false;
        throw new PackageEditTransactionError(
          "output_changed",
          `Package edit rollback was obstructed; the previous empty destination is preserved at ${backupRoot}.`
        );
      }
    }
    throw error;
  } finally {
    if (cleanupStage) await rm(stageRoot, { recursive: true, force: true });
  }
}

async function inspectOutputClaim(path: string): Promise<DirectoryClaim> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PackageEditTransactionError("output_not_empty", "Package edit output must be an empty directory or absent.");
    }
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new PackageEditTransactionError("output_not_empty", "Package edit output must be an empty directory or absent.");
    }
    return { exists: true, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (isMissingPathError(error)) return { exists: false };
    throw error;
  }
}

async function inspectClaimedBackup(path: string): Promise<{ dev: number; ino: number }> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(path)).length > 0) {
    throw new PackageEditTransactionError("output_changed", "Claimed package edit output was not the original empty directory.");
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function snapshotTree(root: string): Promise<SnapshotState> {
  const state: SnapshotState = { files: 0, bytes: 0, entries: new Map() };
  await snapshotDirectory(root, "", 0, state);
  return state;
}

async function snapshotDirectory(root: string, relativeDir: string, depth: number, state: SnapshotState): Promise<void> {
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
      await snapshotDirectory(root, relativePath, depth + 1, state);
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
    const sha256 = await hashRegularFile(absolutePath, stat.dev, stat.ino);
    state.entries.set(toPortablePath(relativePath), `file:${stat.size}:${sha256}`);
  }
  const after = await lstat(directoryPath);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new PackageEditTransactionError("source_changed", `Package directory changed during snapshot: ${relativeDir || "."}`);
  }
}

async function hashRegularFile(path: string, expectedDev: number, expectedIno: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expectedDev || before.ino !== expectedIno) {
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
      || pathAfter.ino !== after.ino) {
      throw new PackageEditTransactionError("source_changed", `Package file changed while hashing: ${path}`);
    }
    return hash.digest("hex");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function sameSnapshot(left: SnapshotState, right: SnapshotState): boolean {
  if (left.files !== right.files || left.bytes !== right.bytes || left.entries.size !== right.entries.size) return false;
  for (const [path, value] of left.entries) if (right.entries.get(path) !== value) return false;
  return true;
}

function assertParsedPackageIdentity(expected: MotionPackage, staged: MotionPackage): void {
  if (jsonHash({ manifest: expected.manifest, motion: expected.motion }) !== jsonHash({ manifest: staged.manifest, motion: staged.motion })) {
    throw new PackageEditTransactionError("source_changed", "Source package changed after the Motion edit was prepared.");
  }
}

async function assertReceiptInputHashes(receipt: OperationReceipt, staged: MotionPackage): Promise<void> {
  const expectedManifestHash = receipt.inputHashes["manifest.json"];
  const expectedMotionHash = receipt.inputHashes[staged.manifest.motion];
  if (!expectedManifestHash || !expectedMotionHash) {
    throw new PackageEditTransactionError("copy_mismatch", "Motion edit receipt is missing manifest or motion input hashes.");
  }
  const [manifestHash, motionHash] = await Promise.all([
    hashPackageFile(resolvePackageAsset(staged, "manifest.json")),
    hashPackageFile(resolvePackageAsset(staged, staged.manifest.motion))
  ]);
  if (manifestHash !== expectedManifestHash || motionHash !== expectedMotionHash) {
    throw new PackageEditTransactionError("source_changed", "Source package bytes changed after Motion edit receipt hashing.");
  }
}

async function copyVerifiedAsset(
  stagedRoot: string,
  file: { sourcePath: string; targetAssetRef: string; expectedSha256: string }
): Promise<void> {
  const portableRef = toPortablePath(file.targetAssetRef).replace(/^\.\//, "");
  if (!portableRef.startsWith("assets/") || portableRef === "assets/") {
    throw new PackageEditTransactionError("unsupported_source_entry", "Imported package-edit files must target the assets directory.");
  }
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
    const copiedHash = hash.digest("hex");
    if (copiedHash !== file.expectedSha256) {
      throw new PackageEditTransactionError("source_changed", "Imported package-edit asset bytes differ from the receipt input hash.");
    }
  } finally {
    if (target) await target.close().catch(() => {});
    if (source) await source.close().catch(() => {});
  }
  const targetStat = await lstat(targetPath);
  const targetHash = await hashRegularFile(targetPath, targetStat.dev, targetStat.ino);
  if (targetHash !== file.expectedSha256) {
    throw new PackageEditTransactionError("copy_mismatch", "Staged package-edit asset failed post-copy verification.");
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function jsonHash(value: unknown): string {
  return hashBuffer(Buffer.from(JSON.stringify(value), "utf8"));
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(await canonicalPathForSafety(parent), basename(resolved));
  }
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function safeToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "package";
}

function toPortablePath(path: string): string {
  return path.split("\\").join("/");
}
