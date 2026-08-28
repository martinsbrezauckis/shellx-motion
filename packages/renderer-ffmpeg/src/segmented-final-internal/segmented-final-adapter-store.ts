/** Filesystem ownership helpers for the internal segmented-final adapter. */
import { createHash } from "node:crypto";
import { copyFile, lstat, link, mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OutputPathTopology,
  assertOutputDirectoryIdentity,
  assertOutputLeafIdentity,
  captureOutputDirectoryIdentity,
  captureOutputLeaf,
  hashFile
} from "@shellx-motion/core";
import type { PublicationCommitUncertainEvidence } from "@shellx-motion/core";
import { completedFrameHashSummary, fullStreamedFrameSequenceSha256 } from "./render-segment-store-identity.js";
import { observeRegularSegmentArtifact } from "./render-segment-store-readback.js";
import {
  SegmentedFinalStoreAuthority,
  assertStagingIdentity,
  stableStagingFile
} from "./segmented-final-store-authority.js";
import type { RenderSegmentStoreManifest } from "./render-segment-store-types.js";
import type { SegmentedFinalPartialOutputEvidence, SegmentedFinalSegmentEvidence } from "./segmented-final-adapter-types.js";

const STORE_SUFFIX = ".shellx-motion-segments";
const FINAL_STAGE_PREFIX = "final-staging";
const CONCAT_LIST = "segments.ffconcat";
const CONCAT_TEMP = ".segments.ffconcat.partial";

export interface SegmentedFinalPaths {
  outputPath: string;
  storeRoot: string;
  /** An exclusive sibling reservation; the durable store itself remains exactly deterministic. */
  lockPath: string;
  segmentsDirectory: string;
  stagingPath: string;
  concatListPath: string;
  concatTempPath: string;
}

export class SegmentedFinalStoreBusyError extends Error {
  readonly code = "segment_store_busy";

  constructor() {
    super("Segmented final store is already reserved by another render; wait for it to finish or inspect the retained checkpoint before retrying.");
    this.name = "SegmentedFinalStoreBusyError";
    Object.setPrototypeOf(this, SegmentedFinalStoreBusyError.prototype);
  }
}

export class SegmentedPublicationIdentityError extends Error {
  readonly destinationCreated = true;
  constructor(
    /** Exact link target and stage identity admitted immediately before the no-clobber link. */
    readonly expectedPublication: PublicationCommitUncertainEvidence,
    readonly primaryCause: unknown
  ) {
    super("Segmented final destination was created but could not be proven identical to verified staging.", { cause: primaryCause });
    this.name = "SegmentedPublicationIdentityError";
    Object.setPrototypeOf(this, SegmentedPublicationIdentityError.prototype);
  }
}

export function deriveSegmentedFinalPaths(outputPath: string, packageRoot: string): SegmentedFinalPaths {
  const resolvedOutput = resolve(outputPath);
  const resolvedPackage = resolve(packageRoot);
  if (!isAbsolute(outputPath) || resolvedOutput !== outputPath || !isAbsolute(packageRoot) || resolvedPackage !== packageRoot) {
    throw new Error("Segmented final package and output paths must be resolved absolute paths.");
  }
  const extension = extname(resolvedOutput).toLowerCase();
  if (!extension || !/^\.[a-z0-9]{1,16}$/.test(extension)) {
    throw new Error("Segmented final output requires a real safe extension for its staging artifact.");
  }
  // The final basename is caller controlled and can approach filesystem component limits. The
  // store address stays deterministic, while SegmentedFinalStoreAuthority binds its private inode.
  const storeRoot = join(dirname(resolvedOutput), `.${STORE_SUFFIX.slice(1)}-${pathFingerprint(resolvedOutput)}`);
  if (overlaps(resolvedPackage, storeRoot)) {
    throw new Error("Package and deterministic segmented-final store roots must not overlap.");
  }
  return {
    outputPath: resolvedOutput,
    storeRoot,
    lockPath: `${storeRoot}.lock`,
    segmentsDirectory: `${storeRoot}${sep}segments`,
    stagingPath: `${storeRoot}${sep}${FINAL_STAGE_PREFIX}${extension}`,
    concatListPath: `${storeRoot}${sep}segments${sep}${CONCAT_LIST}`,
    concatTempPath: `${storeRoot}${sep}segments${sep}${CONCAT_TEMP}`
  };
}

/**
 * Reserve this output's derived durable store before inspecting or mutating it. A directory
 * creation is atomic and never follows a caller-provided path. We deliberately do not break
 * stale locks: an operator must first inspect the retained checkpoint before resuming it.
 */
export async function acquireSegmentedFinalLock(paths: SegmentedFinalPaths): Promise<() => Promise<void>> {
  const topology = await OutputPathTopology.acquire(paths.lockPath);
  const original = await captureOutputLeaf(paths.lockPath);
  if (original.kind !== "missing") throw new SegmentedFinalStoreBusyError();
  try {
    await topology.assertCurrent();
    await assertOutputLeafIdentity(paths.lockPath, original, "Segmented final store reservation");
    await mkdir(paths.lockPath, { recursive: false, mode: 0o700 });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new SegmentedFinalStoreBusyError();
    }
    throw error;
  }
  const identity = await captureOutputDirectoryIdentity(paths.lockPath, "Segmented final store reservation", { private: true });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await topology.assertCurrent();
    await assertOutputDirectoryIdentity(paths.lockPath, identity, "Segmented final store reservation", { private: true });
    await rmdir(paths.lockPath);
  };
}

export async function writeConcatListAtomically(paths: SegmentedFinalPaths, contents: string): Promise<string> {
  await assertAbsent(paths.concatListPath, "Segmented final concat list already exists unexpectedly.");
  await assertAbsent(paths.concatTempPath, "Segmented final concat-list temporary artifact already exists unexpectedly.");
  await writeFile(paths.concatTempPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    // Hard-link creation is no-clobber and atomic on this one owned directory/filesystem.
    await link(paths.concatTempPath, paths.concatListPath);
    await unlink(paths.concatTempPath);
  } catch (error) {
    await removeExactRegularIfPresent(paths.concatTempPath, "Segmented final concat-list temporary artifact");
    throw error;
  }
  const actual = await hashFile(paths.concatListPath);
  return actual;
}

export async function assertConcatListHash(path: string, expected: string): Promise<void> {
  await assertRegular(path, "Segmented final concat list");
  if (await hashFile(path) !== expected) throw new Error("Segmented final concat list changed after canonical creation.");
}

export async function verifySegmentArtifacts(
  manifest: RenderSegmentStoreManifest,
  rootPath: string
): Promise<SegmentedFinalSegmentEvidence[]> {
  const root = resolve(rootPath);
  const directory = `${root}${sep}segments`;
  const expected = manifest.completed.map((entry) => basename(entry.artifact.path));
  const names = await readdir(directory);
  if (names.length !== expected.length || names.some((name) => !expected.includes(name))) {
    throw new Error("Segmented final store contains a forged, missing, or unknown segment artifact.");
  }
  const segments: SegmentedFinalSegmentEvidence[] = [];
  for (const entry of manifest.completed) {
    const path = resolve(root, entry.artifact.path);
    if (!within(root, path)) throw new Error("Segmented final segment artifact path escapes its owned store.");
    const actual = await observeRegularSegmentArtifact(path, "Segmented final segment artifact");
    if (actual.sha256 !== entry.artifact.sha256 || actual.byteLength !== entry.artifact.byteLength) {
      throw new Error("Segmented final segment artifact does not match its verified checkpoint.");
    }
    segments.push({
      index: entry.index,
      range: { ...entry.range },
      artifactSha256: entry.artifact.sha256,
      frameSequenceSha256: entry.frameSequence.sha256,
      readback: { ...entry.readback }
    });
  }
  return segments;
}

export function segmentIdentity(manifest: RenderSegmentStoreManifest) {
  const summary = completedFrameHashSummary(manifest);
  return {
    frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1" as const, sha256: fullStreamedFrameSequenceSha256(manifest) },
    frameCount: summary.frameCount,
    uniqueFrameHashes: summary.uniqueFrameHashes,
    blankFrames: manifest.completed.reduce((total, entry) => total + entry.blankFrameCount, 0)
  };
}

export async function publishStagedFile(
  paths: SegmentedFinalPaths,
  authority: SegmentedFinalStoreAuthority,
  expectedSha256: string
): Promise<{ staging: "removed" | "retained" }> {
  // Finalization has already hashed/read back the stage. Re-hash the exact regular inode again
  // immediately before link(2), so a post-FFprobe replacement cannot become the public output.
  const staging = await stableStagingFile(paths.stagingPath, expectedSha256);
  await authority.assertCurrent();
  await assertStagingIdentity(paths.stagingPath, staging);
  await link(paths.stagingPath, paths.outputPath);
  try {
    const [stage, output] = await Promise.all([lstat(paths.stagingPath), lstat(paths.outputPath)]);
    if (
      !stage.isFile() || stage.isSymbolicLink() || !output.isFile() || output.isSymbolicLink()
      || stage.size !== output.size || stage.dev !== output.dev || stage.ino !== output.ino
    ) {
      throw new Error("No-follow hard-link identity proof did not match staging and final output.");
    }
    await authority.assertStoreCurrent();
    if (await hashFile(paths.outputPath) !== expectedSha256) {
      throw new Error("No-clobber publication bytes did not match the final verified staging hash.");
    }
  } catch (error) {
    throw new SegmentedPublicationIdentityError({
      publicPath: paths.outputPath,
      kind: "file",
      expectedIdentity: { dev: staging.dev, ino: staging.ino },
      expected: { sha256: expectedSha256, byteLength: staging.size }
    }, error);
  }
  try {
    await unlink(paths.stagingPath);
    return { staging: "removed" };
  } catch {
    // The hard-link identity was already proven, so the output is valid even if retaining the
    // second link needs later owned-store cleanup. Never present this as an unpublished failure.
    return { staging: "retained" };
  }
}

/** Copy a finalized durable segment stage into the CLI's private paired-output stage without publishing its public name. */
export async function stageStagedFileForPairedPublication(
  paths: SegmentedFinalPaths,
  authority: SegmentedFinalStoreAuthority,
  publication: import("@shellx-motion/core").DerivedOutputPublication,
  expectedSha256: string
): Promise<void> {
  if (resolve(publication.outputPath) !== paths.outputPath) {
    throw new Error("Segmented private output publication does not bind the requested final destination.");
  }
  const staging = await stableStagingFile(paths.stagingPath, expectedSha256);
  await authority.assertCurrent();
  await assertStagingIdentity(paths.stagingPath, staging);
  await copyFile(paths.stagingPath, publication.stagingPath);
  const copied = await publication.verifyFile();
  if (copied.sha256 !== expectedSha256 || copied.byteLength !== staging.size) {
    throw new Error("Segmented private output stage did not match finalized delivery bytes.");
  }
}

export async function partialOutput(path: string): Promise<SegmentedFinalPartialOutputEvidence> {
  try {
    await assertRegular(path, "Segmented final staging output");
    return { status: "unverified", sha256: await hashFile(path) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unverified" };
  }
}

/** Failure cleanup never follows links or removes a surprising object. */
export async function removeUnpublishedStage(path: string): Promise<{
  outcome: "missing" | "removed" | "retained";
  cause?: unknown;
}> {
  try {
    const outcome = await removeExactRegularIfPresent(path, "Segmented final staging output");
    return { outcome };
  } catch (error) {
    return { outcome: "retained" as const, cause: error };
  }
}

/** Published output remains valid if this best-effort exact cleanup cannot empty the owned store. */
export async function cleanupPublishedStore(paths: SegmentedFinalPaths, manifest: RenderSegmentStoreManifest): Promise<{
  outcome: "complete" | "retained";
  removedSegmentCount: number;
  missingSegmentCount: number;
  retainedSegmentCount: number;
}> {
  let removedSegmentCount = 0;
  let missingSegmentCount = 0;
  let retainedSegmentCount = 0;
  let retained = false;
  for (const entry of manifest.completed) {
    try {
      const result = await removeExactRegularIfPresent(
        resolve(paths.storeRoot, entry.artifact.path),
        "Segmented final segment artifact"
      );
      if (result === "removed") removedSegmentCount += 1;
      else missingSegmentCount += 1;
    } catch {
      retained = true;
      retainedSegmentCount += 1;
    }
  }
  for (const [path, label] of [
    [paths.concatListPath, "Segmented final concat list"], [paths.concatTempPath, "Segmented final concat-list temporary artifact"],
    [paths.stagingPath, "Segmented final published staging link"], [`${paths.storeRoot}${sep}manifest.json`, "Segmented final manifest"],
    [`${paths.storeRoot}${sep}.manifest.json.partial`, "Segmented final manifest temporary artifact"]
  ] as const) {
    try { await removeExactRegularIfPresent(path, label); } catch { retained = true; }
  }
  try { await rmdir(paths.segmentsDirectory); await rmdir(paths.storeRoot); } catch { retained = true; }
  return {
    outcome: retained ? "retained" : "complete",
    removedSegmentCount,
    missingSegmentCount,
    retainedSegmentCount
  };
}

async function assertAbsent(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function assertRegular(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be an owned regular file.`);
}

async function removeExactRegularIfPresent(path: string, label: string): Promise<"removed" | "missing"> {
  try {
    await assertRegular(path, label);
    await unlink(path);
    return "removed";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function pathFingerprint(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}
