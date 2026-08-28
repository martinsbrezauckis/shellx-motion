import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { segmentArtifactRelativePath, segmentFrameSequenceSha256, temporarySegmentBasename } from "./render-segment-store-identity.js";
import { MAX_RENDER_SEGMENT_STORE_FRAMES } from "./render-segment-plan.js";
import { MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES, RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA } from "./render-segment-gpu-behavior-types.js";
import { assertCompletedPrefix, assertManifestMatchesResumeInput, assertReadback, createRenderSegmentStoreManifest } from "./render-segment-store-validation.js";
import { expectedReadbackFacts, observeRegularSegmentArtifact, verifyCompletedRenderSegmentPrefix, verifyRenderSegmentReadback } from "./render-segment-store-readback.js";
import {
  MAX_RENDER_SEGMENTS,
  RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA,
  RenderSegmentStoreError,
  type CommitRenderSegmentInput,
  type CreateRenderSegmentStoreInput,
  type RenderSegmentCheckpoint,
  type RenderSegmentReadbackVerifier,
  type RenderSegmentStoreInput,
  type RenderSegmentStoreManifest,
  type ResumeRenderSegmentStoreInput
} from "./render-segment-store-types.js";

const MANIFEST_NAME = "manifest.json";
const SEGMENTS_DIRECTORY = "segments";
const MANIFEST_TEMP_NAME = ".manifest.json.partial";
/** Bounded from the existing 36,000-frame render ceiling; never read an attacker-sized manifest. */
export const MAX_RENDER_SEGMENT_STORE_MANIFEST_BYTES = (MAX_RENDER_SEGMENT_STORE_FRAMES * 80) + (MAX_RENDER_SEGMENTS * 1024);
/** GPU checkpoints persist both raw-frame and Core frame-plan fingerprints. */
export const MAX_GPU_RENDER_SEGMENT_STORE_MANIFEST_BYTES = (MAX_RENDER_SEGMENT_STORE_FRAMES * 160) + (MAX_RENDER_SEGMENTS * 2_048);
/**
 * One hybrid capture record is retained per canonical frame: exact time,
 * Core request identity, encoded and decoded pixel hashes, and fixed texture
 * dimensions.  This remains bounded by the existing 36,000-frame ceiling.
 */
export const MAX_GPU_HYBRID_RENDER_SEGMENT_STORE_MANIFEST_BYTES = (MAX_RENDER_SEGMENT_STORE_FRAMES * 512) + (MAX_RENDER_SEGMENTS * 4_096);
/** Full Core schedule once, exact range slices once; all behavior values are fixed-width hashes. */
export const MAX_GPU_BEHAVIOR_RENDER_SEGMENT_STORE_MANIFEST_BYTES = (MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES * 768) + (MAX_RENDER_SEGMENTS * 4_096);

/** Create a new empty store only. Existing nonempty roots are never merged, cleaned, or reused. */
export async function createRenderSegmentStore(input: CreateRenderSegmentStoreInput): Promise<RenderSegmentStore> {
  const rootPath = resolve(input.rootPath);
  await mkdir(rootPath, { recursive: true });
  await assertDirectory(rootPath, "Segment store root");
  const existingNames = await readdir(rootPath);
  const reuseInterruptedInitialLayout = await recoverInterruptedInitialLayout(rootPath, existingNames);
  if (!reuseInterruptedInitialLayout && existingNames.length > 0) {
    throw new RenderSegmentStoreError("segment_store_unrecognized", "New segment store root must be empty; existing contents were preserved.");
  }
  const manifest = createRenderSegmentStoreManifest(input);
  if (!reuseInterruptedInitialLayout) await mkdir(join(rootPath, SEGMENTS_DIRECTORY));
  await writeManifestAtomically(rootPath, manifest);
  return new RenderSegmentStore(rootPath, input, manifest);
}

/** Resume a recognized existing store only. It never creates an empty store by accident. */
export async function resumeRenderSegmentStore(input: ResumeRenderSegmentStoreInput): Promise<RenderSegmentStore> {
  const rootPath = resolve(input.rootPath);
  await assertExistingDirectory(rootPath, "Segment store root");
  assertResumeRootEntries(await readdir(rootPath), input.recovery);
  await assertRegularManifest(rootPath, input);
  await assertDirectory(join(rootPath, SEGMENTS_DIRECTORY), "Segment store segments directory");
  const manifest = await readManifest(rootPath);
  assertManifestMatchesResumeInput(manifest, input);
  assertCompletedPrefix(manifest);
  // A final staging/list is removable only after this exact manifest was recognized and matched
  // to the caller's immutable input facts. Never delete a similarly named file from a forged root.
  await recoverSegmentedFinalLeftovers(rootPath, input.recovery);
  await recoverOwnedRegularFileIfPresent(join(rootPath, MANIFEST_TEMP_NAME), "Segment manifest temporary file");
  await recoverOwnedSegmentLeftovers(rootPath, manifest);
  await assertCompletedSegmentNames(rootPath, manifest);
  await verifyCompletedRenderSegmentPrefix(rootPath, manifest, input.verifyReadback);
  return new RenderSegmentStore(rootPath, input, manifest);
}

/** Serialized engine-owned append-only checkpoint store; deliberately absent from the package root. */
export class RenderSegmentStore {
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly rootPath: string,
    private readonly input: RenderSegmentStoreInput,
    private manifestValue: RenderSegmentStoreManifest
  ) {}

  get manifest(): RenderSegmentStoreManifest {
    return clone(this.manifestValue);
  }

  /** Exactly the prefix whose artifact bytes and readback were verified during this store lifecycle. */
  get verifiedPrefix(): RenderSegmentCheckpoint[] {
    return clone(this.manifestValue.completed);
  }

  /** Cheap count for sequential executors; use `verifiedPrefix` only when checkpoint data is needed. */
  get completedCount(): number {
    return this.manifestValue.completed.length;
  }

  get nextIndex(): number | null {
    return this.manifestValue.completed.length < this.manifestValue.plan.ranges.length ? this.manifestValue.completed.length : null;
  }

  /** The future segment encoder must write only this exact same-directory incomplete artifact. */
  temporaryArtifactPath(index: number): string {
    this.assertNextIndex(index);
    return join(this.rootPath, SEGMENTS_DIRECTORY, temporarySegmentBasename(index, this.manifestValue.intermediate.extension));
  }

  commit(input: CommitRenderSegmentInput): Promise<RenderSegmentCheckpoint> {
    const task = this.#writeQueue.then(() => this.commitOne(input));
    this.#writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async commitOne(input: CommitRenderSegmentInput): Promise<RenderSegmentCheckpoint> {
    this.assertNextIndex(input.index);
    const temporaryPath = this.temporaryArtifactPath(input.index);
    if (resolve(input.temporaryArtifactPath) !== temporaryPath) {
      throw new RenderSegmentStoreError("segment_commit_invalid", "Segment commit must use the exact store-owned temporary artifact path.");
    }
    const finalPath = join(this.rootPath, segmentArtifactRelativePath(input.index, this.manifestValue.intermediate.extension));
    try {
      await assertCommitSegmentNames(this.rootPath, this.manifestValue, basename(temporaryPath));
      const beforeReadback = await observeRegularSegmentArtifact(temporaryPath, "Segment temporary artifact");
      const range = this.manifestValue.plan.ranges[input.index];
      const readback = await verifyRenderSegmentReadback(this.input.verifyReadback, {
        range,
        artifactPath: temporaryPath,
        expected: expectedReadbackFacts(this.manifestValue)
      });
      const afterReadback = await observeRegularSegmentArtifact(temporaryPath, "Segment temporary artifact");
      if (beforeReadback.byteLength !== afterReadback.byteLength || beforeReadback.sha256 !== afterReadback.sha256) {
        throw new RenderSegmentStoreError("segment_integrity_failed", "Segment artifact changed during readback verification.");
      }
      const candidate: RenderSegmentCheckpoint = {
        index: input.index,
        range: { ...range },
        frameSequence: { schema: "shellx-motion/render-segment-frame-sequence@1", sha256: input.frameSequenceSha256 },
        frameHashes: [...input.frameHashes],
        blankFrameCount: input.blankFrameCount,
        producer: clone(input.producer),
        artifact: {
          path: segmentArtifactRelativePath(input.index, this.manifestValue.intermediate.extension),
          sha256: afterReadback.sha256,
          byteLength: afterReadback.byteLength
        },
        readback
      };
      assertReadback(candidate.readback, this.manifestValue.timeline, range.frameCount);
      if (candidate.frameSequence.sha256 !== segmentFrameSequenceSha256(candidate)) {
        throw new RenderSegmentStoreError("segment_commit_invalid", "Segment frame hashes do not match the caller-supplied frame-sequence SHA-256.");
      }
      const updated: RenderSegmentStoreManifest = { ...this.manifestValue, completed: [...this.manifestValue.completed, candidate] };
      assertCompletedPrefix(updated);
      await rename(temporaryPath, finalPath);
      try {
        await writeManifestAtomically(this.rootPath, updated);
      } catch (error) {
        await removeOwnedRegularFile(finalPath);
        throw error;
      }
      this.manifestValue = updated;
      return clone(candidate);
    } catch (error) {
      await removeOwnedRegularFile(temporaryPath);
      if (error instanceof RenderSegmentStoreError) throw error;
      throw new RenderSegmentStoreError("segment_atomic_write_failed", `Segment checkpoint commit failed: ${safeMessage(error)}`);
    }
  }

  private assertNextIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index !== this.manifestValue.completed.length || index >= this.manifestValue.plan.ranges.length) {
      throw new RenderSegmentStoreError("segment_commit_invalid", "Segment commits must append exactly the next incomplete canonical range.");
    }
  }
}

function assertResumeRootEntries(names: string[], recovery?: ResumeRenderSegmentStoreInput["recovery"]): void {
  const allowed = new Set([MANIFEST_NAME, SEGMENTS_DIRECTORY, MANIFEST_TEMP_NAME, ...(recovery ? [recovery.stagingBasename] : [])]);
  if (!names.includes(MANIFEST_NAME) || !names.includes(SEGMENTS_DIRECTORY) || names.some((name) => !allowed.has(name))) {
    throw new RenderSegmentStoreError("segment_store_unrecognized", "Existing segment store root is not a recognized resumable layout.");
  }
}

async function recoverSegmentedFinalLeftovers(rootPath: string, recovery: ResumeRenderSegmentStoreInput["recovery"]): Promise<void> {
  if (!recovery) return;
  assertRecoveryBasename(recovery.stagingBasename, /^final-staging\.[a-z0-9]{1,16}$/);
  if (recovery.concatListBasename !== "segments.ffconcat" || recovery.concatTempBasename !== ".segments.ffconcat.partial") {
    throw new RenderSegmentStoreError("segment_store_path_invalid", "Segmented final recovery names are not recognized owned concat names.");
  }
  await recoverOwnedRegularFileIfPresent(join(rootPath, recovery.stagingBasename), "Segmented final staging leftover");
  const segmentRoot = join(rootPath, SEGMENTS_DIRECTORY);
  await recoverOwnedRegularFileIfPresent(join(segmentRoot, recovery.concatListBasename), "Segmented final concat-list leftover");
  await recoverOwnedRegularFileIfPresent(join(segmentRoot, recovery.concatTempBasename), "Segmented final concat-list temporary leftover");
}

function assertRecoveryBasename(value: string, expression: RegExp): void {
  if (!expression.test(value)) throw new RenderSegmentStoreError("segment_store_path_invalid", "Segmented final recovery name is not a recognized owned basename.");
}

/** Only the exact empty layout an interrupted initial create owns is safe to retry. */
async function recoverInterruptedInitialLayout(rootPath: string, names: string[]): Promise<boolean> {
  if (names.length === 0) return false;
  if (names.length !== 2 || !names.includes(SEGMENTS_DIRECTORY) || !names.includes(MANIFEST_TEMP_NAME)) return false;
  const segmentsPath = join(rootPath, SEGMENTS_DIRECTORY);
  await assertDirectory(segmentsPath, "Initial segment store segments directory");
  if ((await readdir(segmentsPath)).length !== 0) return false;
  await recoverOwnedRegularFileIfPresent(join(rootPath, MANIFEST_TEMP_NAME), "Initial segment store manifest temporary file");
  return true;
}

async function assertCommitSegmentNames(rootPath: string, manifest: RenderSegmentStoreManifest, temporaryName: string): Promise<void> {
  const allowed = new Set([...manifest.completed.map((entry) => basename(entry.artifact.path)), temporaryName]);
  const names = await readdir(join(rootPath, SEGMENTS_DIRECTORY));
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) {
    throw new RenderSegmentStoreError("segment_store_unrecognized", "Segment commit found an unrelated, missing, or orphaned segment artifact.");
  }
}

async function recoverOwnedSegmentLeftovers(rootPath: string, manifest: RenderSegmentStoreManifest): Promise<void> {
  const directory = join(rootPath, SEGMENTS_DIRECTORY);
  const completedNames = new Set(manifest.completed.map((entry) => basename(entry.artifact.path)));
  const nextIndex = manifest.completed.length;
  const recoverableNames = new Set<string>();
  if (nextIndex < manifest.plan.ranges.length) {
    recoverableNames.add(temporarySegmentBasename(nextIndex, manifest.intermediate.extension));
    recoverableNames.add(basename(segmentArtifactRelativePath(nextIndex, manifest.intermediate.extension)));
  }
  for (const name of await readdir(directory)) {
    if (completedNames.has(name)) continue;
    if (!recoverableNames.has(name)) {
      throw new RenderSegmentStoreError("segment_store_unrecognized", "Segment store contains an unrelated or non-next incomplete artifact.");
    }
    await recoverOwnedRegularFileIfPresent(join(directory, name), "Owned interrupted segment artifact");
  }
}

async function assertCompletedSegmentNames(rootPath: string, manifest: RenderSegmentStoreManifest): Promise<void> {
  const expectedNames = manifest.completed.map((entry) => basename(entry.artifact.path));
  const names = await readdir(join(rootPath, SEGMENTS_DIRECTORY));
  if (names.length !== expectedNames.length || names.some((name) => !expectedNames.includes(name))) {
    throw new RenderSegmentStoreError("segment_store_unrecognized", "Segment store contains an unrecognized, missing, or incomplete segment artifact.");
  }
}

async function assertRegularManifest(rootPath: string, input: RenderSegmentStoreInput): Promise<void> {
  const stat = await assertRegularFile(join(rootPath, MANIFEST_NAME), "Segment store manifest");
  // The resume request's immutable producer identifies its expected schema
  // without reading the untrusted manifest. This picks the narrower behavior
  // ceiling before JSON parse; a later exact schema match still remains mandatory.
  const maximum = input.frameLane === "gpu"
    ? input.producer.frameLane === "gpu" && input.producer.identity.schema === RENDER_GPU_BEHAVIOR_SEGMENTED_IDENTITY_SCHEMA
      ? MAX_GPU_BEHAVIOR_RENDER_SEGMENT_STORE_MANIFEST_BYTES
      : MAX_GPU_HYBRID_RENDER_SEGMENT_STORE_MANIFEST_BYTES
    : MAX_RENDER_SEGMENT_STORE_MANIFEST_BYTES;
  if (stat.size > maximum) {
    throw new RenderSegmentStoreError("segment_manifest_invalid", "Segment store manifest exceeds the bounded frame-hash checkpoint size.");
  }
}

async function readManifest(rootPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(rootPath, MANIFEST_NAME), "utf8")) as unknown;
  } catch (error) {
    throw new RenderSegmentStoreError("segment_manifest_invalid", `Segment store manifest is not valid JSON: ${safeMessage(error)}`);
  }
}

async function writeManifestAtomically(rootPath: string, manifest: RenderSegmentStoreManifest): Promise<void> {
  const temporaryPath = join(rootPath, MANIFEST_TEMP_NAME);
  let created = false;
  try {
    const contents = `${canonicalJson(manifest)}\n`;
    if (Buffer.byteLength(contents, "utf8") > manifestByteCeiling(manifest)) {
      throw new RenderSegmentStoreError("segment_manifest_invalid", "Segment store manifest exceeds its immutable behavior/frame evidence ceiling.");
    }
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    created = true;
    await rename(temporaryPath, join(rootPath, MANIFEST_NAME));
  } catch (error) {
    if (created) await removeOwnedRegularFile(temporaryPath);
    if (error instanceof RenderSegmentStoreError) throw error;
    throw new RenderSegmentStoreError("segment_atomic_write_failed", `Atomic segment manifest write failed: ${safeMessage(error)}`);
  }
}

function manifestByteCeiling(manifest: RenderSegmentStoreManifest): number {
  return manifest.schema === RENDER_GPU_BEHAVIOR_SEGMENT_STORE_SCHEMA
    ? MAX_GPU_BEHAVIOR_RENDER_SEGMENT_STORE_MANIFEST_BYTES
    : manifest.frameLane === "gpu" ? MAX_GPU_HYBRID_RENDER_SEGMENT_STORE_MANIFEST_BYTES : MAX_RENDER_SEGMENT_STORE_MANIFEST_BYTES;
}

async function assertExistingDirectory(path: string, label: string): Promise<void> {
  try {
    await assertDirectory(path, label);
  } catch (error) {
    if (error instanceof RenderSegmentStoreError) throw new RenderSegmentStoreError("segment_store_unrecognized", `${label} does not exist as a resumable store root.`);
    throw error;
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
  } catch (error) {
    throw new RenderSegmentStoreError("segment_store_path_invalid", `${label} must be a real directory: ${safeMessage(error)}`);
  }
}

async function assertRegularFile(path: string, label: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    return stat;
  } catch (error) {
    throw new RenderSegmentStoreError("segment_integrity_failed", `${label} must be an existing regular file: ${safeMessage(error)}`);
  }
}

async function recoverOwnedRegularFileIfPresent(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RenderSegmentStoreError("segment_store_path_invalid", `${label} must be a regular file before recovery.`);
    }
    await unlink(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function removeOwnedRegularFile(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink()) await unlink(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
