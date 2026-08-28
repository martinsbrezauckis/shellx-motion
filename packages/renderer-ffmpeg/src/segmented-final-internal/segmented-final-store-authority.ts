/** Retained private-store and staging-file authority for one segmented final delivery. */
import { lstat, readFile, readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  OutputDirectoryReservation,
  OutputPathTopology,
  assertOutputLeafIdentity,
  captureOutputLeaf,
  hashFile,
  type OutputPathLeafIdentity
} from "@shellx-motion/core";
import type { SegmentedFinalPaths } from "./segmented-final-adapter-store.js";
import { MAX_GPU_HYBRID_RENDER_SEGMENT_STORE_MANIFEST_BYTES } from "./render-segment-store.js";
import { gpuResumeContainmentCeiling } from "./render-segment-gpu-resume-ceiling.js";

export class SegmentedFinalStoreAuthority {
  private constructor(
    private readonly outputPath: string,
    private readonly outputTopology: OutputPathTopology,
    private readonly store: OutputDirectoryReservation,
    private readonly outputIdentity: OutputPathLeafIdentity,
    private readonly created: boolean
  ) {}

  static async acquire(paths: SegmentedFinalPaths, intent: "create" | "resume"): Promise<SegmentedFinalStoreAuthority> {
    const outputTopology = await OutputPathTopology.acquire(paths.outputPath);
    const outputIdentity = await captureOutputLeaf(paths.outputPath);
    if (outputIdentity.kind !== "missing") {
      throw new Error("Segmented final output already exists; publication never overwrites it.");
    }
    const store = await OutputDirectoryReservation.acquire(paths.storeRoot, {
      allowExistingContents: true,
      requirePrivate: true,
      requireAbsent: intent === "create"
    });
    const authority = new SegmentedFinalStoreAuthority(paths.outputPath, outputTopology, store, outputIdentity, intent === "create");
    await authority.assertCurrent();
    return authority;
  }

  /** The output must remain absent through every external tool and before publication. */
  async assertCurrent(): Promise<void> {
    await this.outputTopology.assertCurrent();
    await this.store.assertCurrent();
    await assertOutputLeafIdentity(this.outputPath, this.outputIdentity, "Segmented final output destination");
  }

  /** After publication, the destination is no longer missing but the route/store stay pinned. */
  async assertStoreCurrent(): Promise<void> {
    await this.outputTopology.assertCurrent();
    await this.store.assertCurrent();
  }

  /** Reads one bounded private manifest field that may only reduce the current governor grant. */
  async resumeGpuMaxProcessTreeRssBytes(currentCeiling: number): Promise<number> {
    if (this.created) throw new Error("A newly created segment store cannot supply resume containment evidence.");
    await this.assertCurrent();
    const path = join(this.store.path, "manifest.json");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_GPU_HYBRID_RENDER_SEGMENT_STORE_MANIFEST_BYTES) {
      throw new Error("Segmented GPU resume manifest is not a bounded regular file.");
    }
    const manifest = JSON.parse(await readFile(path, "utf8")) as unknown;
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("Segmented GPU resume manifest changed while its containment ceiling was read.");
    }
    await this.assertCurrent();
    return gpuResumeContainmentCeiling(manifest, currentCeiling);
  }

  /** A failed preflight may leave only this new, empty private root; never remove a checkpoint. */
  async discardEmptyStore(): Promise<void> {
    if (!this.created) return;
    await this.assertCurrent();
    if ((await readdir(this.store.path)).length === 0) await rmdir(this.store.path);
  }
}

export type StableStagingFile = { dev: number; ino: number; size: number; sha256: string };

/** Re-hash exactly one stable regular inode before no-clobber publication. */
export async function stableStagingFile(path: string, expectedSha256: string): Promise<StableStagingFile> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Segmented final verified staging output must be an owned regular file.");
  }
  const sha256 = await hashFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
  ) {
    throw new Error("Segmented final staging output changed while its final hash was revalidated.");
  }
  if (sha256 !== expectedSha256) {
    throw new Error("Segmented final staging output changed after final FFprobe validation.");
  }
  return { dev: Number(after.dev), ino: Number(after.ino), size: after.size, sha256 };
}

export async function assertStagingIdentity(path: string, expected: StableStagingFile): Promise<void> {
  const actual = await lstat(path);
  if (
    !actual.isFile() || actual.isSymbolicLink()
    || Number(actual.dev) !== expected.dev || Number(actual.ino) !== expected.ino || actual.size !== expected.size
  ) {
    throw new Error("Segmented final staging output changed after immediate revalidation.");
  }
}
