import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { completedFrameHashSummary, fullStreamedFrameSequenceSha256, segmentFrameSequenceSha256 } from "./segmented-final-internal/render-segment-store-identity.js";
import { MAX_RENDER_SEGMENT_STORE_MANIFEST_BYTES, createRenderSegmentStore, resumeRenderSegmentStore, type RenderSegmentStore } from "./segmented-final-internal/render-segment-store.js";
import type { CreateRenderSegmentStoreInput } from "./segmented-final-internal/render-segment-store-types.js";

const roots: string[] = [];
const hashes = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(64));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable render segment store", () => {
  it("plans only deterministic, ordered, nonempty full-coverage ranges", () => {
    expect(planRenderSegments({ frameCount: 7, segmentFrames: 3 })).toMatchObject({
      frameCount: 7,
      segmentFrames: 3,
      segmentCount: 3,
      ranges: [
        { index: 0, startFrame: 0, endFrameExclusive: 3, frameCount: 3 },
        { index: 1, startFrame: 3, endFrameExclusive: 6, frameCount: 3 },
        { index: 2, startFrame: 6, endFrameExclusive: 7, frameCount: 1 }
      ]
    });
    expectCodeSync(() => planRenderSegments({ frameCount: 0, segmentFrames: 1 }), "segment_plan_invalid");
    expectCodeSync(() => planRenderSegments({ frameCount: 513, segmentFrames: 1 }), "segment_count_exceeded");
    expectCodeSync(() => planRenderSegments({ frameCount: 36_001, segmentFrames: 100 }), "segment_frame_budget_exceeded");
  });

  it("reopens exactly the verified prefix after interruption and appends without rerendering it", async () => {
    const input = await newInput({ frameCount: 5, segmentFrames: 2 });
    const readbackCalls: number[] = [];
    input.verifyReadback = ({ range }) => {
      readbackCalls.push(range.index);
      return verifiedReadback(range.frameCount);
    };
    const first = await createRenderSegmentStore(input);
    await stageAndCommit(first, 0);
    expectCodeSync(() => fullStreamedFrameSequenceSha256(first.manifest), "segment_entry_invalid");
    await stageAndCommit(first, 1);
    const before = await readFile(join(input.rootPath, "segments", "segment-000001.mkv"), "utf8");

    const resumed = await resumeRenderSegmentStore(input);
    expect(resumed.verifiedPrefix.map((entry) => entry.index)).toEqual([0, 1]);
    expect(resumed.nextIndex).toBe(2);
    expect(await readFile(join(input.rootPath, "segments", "segment-000001.mkv"), "utf8")).toBe(before);
    readbackCalls.splice(0);
    await stageAndCommit(resumed, 2);
    expect(readbackCalls).toEqual([2]);
    expect(resumed.verifiedPrefix).toHaveLength(3);
    expect(fullStreamedFrameSequenceSha256(resumed.manifest)).toMatch(/^[a-f0-9]{64}$/);
    expect(completedFrameHashSummary(resumed.manifest)).toEqual({ frameCount: 5, uniqueFrameHashes: 5 });
  });

  it("binds a segmented delivery request before resume and never persists its raw paths", async () => {
    const input = await newInput({ frameCount: 4, segmentFrames: 2 });
    input.delivery = deliveryFacts();
    const store = await createRenderSegmentStore(input);
    await stageAndCommit(store, 0);
    expect(store.manifest.delivery).toEqual(deliveryFacts());
    expect(JSON.stringify(store.manifest)).not.toContain("/output/");

    await expectCode(
      resumeRenderSegmentStore({
        ...input,
        delivery: { ...deliveryFacts(), quality: { minDurationMs: 0, minUniqueFrameHashes: 1 } }
      }),
      "segment_plan_mismatch"
    );
    await expectCode(
      createRenderSegmentStore({
        ...await newInput({ frameCount: 4, segmentFrames: 2 }),
        delivery: { ...deliveryFacts(), quality: { minDurationMs: 0, minUniqueFrameHashes: 36_001 } }
      }),
      "segment_plan_invalid"
    );
  });

  it("refuses artifact tampering, symlinks, forged gaps, plan changes, and failed re-readback", async () => {
    const input = await newInput({ frameCount: 4, segmentFrames: 2 });
    const store = await createRenderSegmentStore(input);
    await stageAndCommit(store, 0);
    const artifact = join(input.rootPath, "segments", "segment-000001.mkv");
    await writeFile(artifact, "tampered");
    await expectCode(resumeRenderSegmentStore(input), "segment_integrity_failed");

    const symlinkInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const symlinkStore = await createRenderSegmentStore(symlinkInput);
    await stageAndCommit(symlinkStore, 0);
    const symlinkArtifact = join(symlinkInput.rootPath, "segments", "segment-000001.mkv");
    await unlink(symlinkArtifact);
    const outside = join(await newRoot(), "outside.mkv");
    await writeFile(outside, "outside");
    let fileSymlinksAvailable = true;
    try {
      await symlink(outside, symlinkArtifact);
    } catch (error) {
      if (!isWindowsSymlinkUnavailable(error)) throw error;
      // Standard Windows accounts cannot create file symlinks; Linux/macOS retain this refusal proof.
      fileSymlinksAvailable = false;
    }
    if (fileSymlinksAvailable) {
      await expectCode(resumeRenderSegmentStore(symlinkInput), "segment_integrity_failed");

      const manifestSymlinkInput = await newInput({ frameCount: 2, segmentFrames: 2 });
      await createRenderSegmentStore(manifestSymlinkInput);
      const manifestPath = join(manifestSymlinkInput.rootPath, "manifest.json");
      await unlink(manifestPath);
      await symlink(outside, manifestPath);
      await expectCode(resumeRenderSegmentStore(manifestSymlinkInput), "segment_integrity_failed");
    }

    const forgedInput = await newInput({ frameCount: 4, segmentFrames: 2 });
    const forgedStore = await createRenderSegmentStore(forgedInput);
    await stageAndCommit(forgedStore, 0);
    const forged = forgedStore.manifest;
    forged.completed[0].index = 1;
    await writeManifest(forgedInput.rootPath, forged);
    await expectCode(resumeRenderSegmentStore(forgedInput), "segment_entry_invalid");

    const changedInput = { ...input, plan: planRenderSegments({ frameCount: 4, segmentFrames: 1 }) };
    await expectCode(resumeRenderSegmentStore(changedInput), "segment_plan_mismatch");
    const readbackInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const readbackStore = await createRenderSegmentStore(readbackInput);
    await stageAndCommit(readbackStore, 0);
    const verifierFailure = { ...readbackInput, verifyReadback: () => ({ ok: false as const, message: "injected readback failure" }) };
    await expectCode(resumeRenderSegmentStore(verifierFailure), "segment_readback_verification_failed");
    const changedContentInput = { ...readbackInput, package: { ...readbackInput.package, contentSha256: hashes[5] } };
    await expectCode(resumeRenderSegmentStore(changedContentInput), "segment_plan_mismatch");
  });

  it("rejects malformed, reordered, wrong-length, or over-sized frame-hash checkpoints", async () => {
    const input = await newInput({ frameCount: 4, segmentFrames: 2 });
    const store = await createRenderSegmentStore(input);
    await stageAndCommit(store, 0);
    const malformed = store.manifest;
    malformed.completed[0].frameHashes = [hashes[0]];
    await writeManifest(input.rootPath, malformed);
    await expectCode(resumeRenderSegmentStore(input), "segment_entry_invalid");

    const blankInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const blankStore = await createRenderSegmentStore(blankInput);
    await stageAndCommit(blankStore, 0);
    const blankManifest = blankStore.manifest;
    blankManifest.completed[0].blankFrameCount = 3;
    await writeManifest(blankInput.rootPath, blankManifest);
    await expectCode(resumeRenderSegmentStore(blankInput), "segment_entry_invalid");

    const invalidHashInput = await newInput({ frameCount: 4, segmentFrames: 2 });
    const invalidHashStore = await createRenderSegmentStore(invalidHashInput);
    await stageAndCommit(invalidHashStore, 0);
    const invalidHashManifest = invalidHashStore.manifest;
    invalidHashManifest.completed[0].frameHashes[1] = "G".repeat(64);
    await writeManifest(invalidHashInput.rootPath, invalidHashManifest);
    await expectCode(resumeRenderSegmentStore(invalidHashInput), "segment_entry_invalid");

    const reorderedInput = await newInput({ frameCount: 4, segmentFrames: 2 });
    const reordered = await createRenderSegmentStore(reorderedInput);
    await stageAndCommit(reordered, 0);
    const reorderedManifest = reordered.manifest;
    reorderedManifest.completed[0].frameHashes.reverse();
    await writeManifest(reorderedInput.rootPath, reorderedManifest);
    await expectCode(resumeRenderSegmentStore(reorderedInput), "segment_entry_invalid");

    const escapedInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const escapedStore = await createRenderSegmentStore(escapedInput);
    await stageAndCommit(escapedStore, 0);
    const escapedManifest = escapedStore.manifest;
    escapedManifest.completed[0].artifact.path = "../outside.mkv";
    await writeManifest(escapedInput.rootPath, escapedManifest);
    await expectCode(resumeRenderSegmentStore(escapedInput), "segment_entry_invalid");

    const hugeInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    await createRenderSegmentStore(hugeInput);
    await writeFile(join(hugeInput.rootPath, "manifest.json"), "x".repeat(MAX_RENDER_SEGMENT_STORE_MANIFEST_BYTES + 1));
    await expectCode(resumeRenderSegmentStore(hugeInput), "segment_manifest_invalid");
  });

  it("cleans only the exact owned partial after a failed commit and preserves unrelated files", async () => {
    const input = await newInput({ frameCount: 2, segmentFrames: 2 });
    const store = await createRenderSegmentStore(input);
    const temp = store.temporaryArtifactPath(0);
    await writeFile(temp, "partial");
    const unrelated = join(input.rootPath, "segments", "do-not-touch.txt");
    await writeFile(unrelated, "preserve me");
    await expectCode(store.commit(checkpointInput(store, 0)), "segment_store_unrecognized");
    await expect(readFile(temp, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("preserve me");
  });

  it("refuses fresh unrecognized roots without deleting their contents and rolls back failed atomic manifest publication", async () => {
    const rootPath = await newRoot();
    const sentinel = join(rootPath, "keep.txt");
    await writeFile(sentinel, "keep");
    await expectCode(createRenderSegmentStore(await inputAt(rootPath, 2, 2)), "segment_store_unrecognized");
    expect(await readFile(sentinel, "utf8")).toBe("keep");

    const input = await newInput({ frameCount: 2, segmentFrames: 2 });
    const store = await createRenderSegmentStore(input);
    const before = await readFile(join(input.rootPath, "manifest.json"), "utf8");
    await writeFile(join(input.rootPath, ".manifest.json.partial"), "not our temp");
    await writeFile(store.temporaryArtifactPath(0), "segment");
    await expectCode(store.commit(checkpointInput(store, 0)), "segment_atomic_write_failed");
    expect(await readFile(join(input.rootPath, "manifest.json"), "utf8")).toBe(before);
    await expect(readFile(join(input.rootPath, "segments", "segment-000001.mkv"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(input.rootPath, ".manifest.json.partial"), "utf8")).toBe("not our temp");
  });

  it("separates create from resume and recovers only exact regular crash leftovers", async () => {
    const retryInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const initialPartial = join(retryInput.rootPath, ".manifest.json.partial");
    await mkdir(join(retryInput.rootPath, "segments"));
    await writeFile(initialPartial, "interrupted-initial-create");
    const retriedCreate = await createRenderSegmentStore(retryInput);
    expect(retriedCreate.verifiedPrefix).toEqual([]);
    await expect(readFile(initialPartial, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const input = await newInput({ frameCount: 4, segmentFrames: 2 });
    await expectCode(resumeRenderSegmentStore(input), "segment_store_unrecognized");
    const store = await createRenderSegmentStore(input);
    const partial = store.temporaryArtifactPath(0);
    expect(partial).toMatch(/\.segment-000001\.mkv\.partial$/);
    await writeFile(partial, "interrupted-before-rename");
    const afterPartial = await resumeRenderSegmentStore(input);
    expect(afterPartial.nextIndex).toBe(0);
    await expect(readFile(partial, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const orphanPartial = afterPartial.temporaryArtifactPath(0);
    const orphanFinal = join(input.rootPath, "segments", "segment-000001.mkv");
    await writeFile(orphanPartial, "interrupted-after-rename");
    await rename(orphanPartial, orphanFinal);
    await writeFile(join(input.rootPath, ".manifest.json.partial"), "interrupted-manifest");
    const afterOrphan = await resumeRenderSegmentStore(input);
    expect(afterOrphan.verifiedPrefix).toEqual([]);
    await expect(readFile(orphanFinal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(input.rootPath, ".manifest.json.partial"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a readback verifier instead of trusting caller-declared verification", async () => {
    const input = await newInput({ frameCount: 2, segmentFrames: 2 });
    await expectCode(createRenderSegmentStore({ ...input, verifyReadback: undefined as any }), "segment_plan_invalid");
  });

  it("refuses bytes changed during commit or resume readback and retains observed fractional FPS", async () => {
    const commitInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    commitInput.verifyReadback = async ({ artifactPath, range }) => {
      await writeFile(artifactPath, "changed-during-readback");
      return verifiedReadback(range.frameCount);
    };
    const commitStore = await createRenderSegmentStore(commitInput);
    await writeFile(commitStore.temporaryArtifactPath(0), "before-readback");
    await expectCode(commitStore.commit(checkpointInput(commitStore, 0)), "segment_integrity_failed");

    const resumeInput = await newInput({ frameCount: 2, segmentFrames: 2 });
    const resumeStore = await createRenderSegmentStore(resumeInput);
    await stageAndCommit(resumeStore, 0);
    resumeInput.verifyReadback = async ({ artifactPath, range }) => {
      await writeFile(artifactPath, "changed-during-resume-readback");
      return verifiedReadback(range.frameCount);
    };
    await expectCode(resumeRenderSegmentStore(resumeInput), "segment_integrity_failed");

    const fractional = await newInput({ frameCount: 2, segmentFrames: 2 });
    fractional.timeline.fps = 29.97;
    fractional.verifyReadback = ({ range }) => verifiedReadback(range.frameCount, 30_000 / 1_001);
    const fractionalStore = await createRenderSegmentStore(fractional);
    await stageAndCommit(fractionalStore, 0);
    expect(fractionalStore.manifest.completed[0].readback.fps).toBe(30_000 / 1_001);
    await expect(resumeRenderSegmentStore(fractional)).resolves.toBeDefined();
  });

  it("creates and resumes an approved-active prefix only under the same host verdict", async () => {
    const input = await newInput({ frameCount: 2, segmentFrames: 2 });
    input.producer = { frameLane: "browser", scriptExecution: activeScriptEvidence("attestation-stable") };
    const store = await createRenderSegmentStore(input);
    await stageAndCommit(store, 0);
    await expect(resumeRenderSegmentStore(input)).resolves.toMatchObject({ completedCount: 1 });
  });
});

async function newInput(options: { frameCount: number; segmentFrames: number }): Promise<CreateRenderSegmentStoreInput> {
  return inputAt(await newRoot(), options.frameCount, options.segmentFrames);
}

function isWindowsSymlinkUnavailable(error: unknown): boolean {
  return process.platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EPERM";
}

async function inputAt(rootPath: string, frameCount: number, segmentFrames: number): Promise<CreateRenderSegmentStoreInput> {
  return {
    rootPath,
    plan: planRenderSegments({ frameCount, segmentFrames }),
    package: { id: "segment-test", manifestSha256: hashes[0], contentSha256: hashes[2] },
    frameLane: "browser",
    producer: { frameLane: "browser", scriptExecution: dataOnlyScriptEvidence() },
    timeline: { motionSha256: hashes[1], durationMs: 1000, fps: 30, width: 640, height: 360 },
    intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" },
    verifyReadback: ({ range }) => verifiedReadback(range.frameCount)
  };
}

function deliveryFacts() {
  return {
    schema: "shellx-motion/segmented-final-delivery@1" as const,
    outputPathSha256: hashes[3],
    preset: "mp4-h264" as const,
    audio: [{ contentSha256: hashes[4], controlsSha256: hashes[5] }],
    quality: { minDurationMs: 0, minUniqueFrameHashes: 0 },
    forceSoftwareEncode: true,
    verifyDeliveredColor: true
  };
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-segment-store-"));
  roots.push(root);
  return root;
}

async function stageAndCommit(store: RenderSegmentStore, index: number): Promise<void> {
  await writeFile(store.temporaryArtifactPath(index), `segment-${index}`);
  await store.commit(checkpointInput(store, index));
}

function checkpointInput(store: RenderSegmentStore, index: number) {
  const range = store.manifest.plan.ranges[index];
  const frameHashes = hashes.slice(range.startFrame, range.endFrameExclusive);
  return {
    index,
    temporaryArtifactPath: store.temporaryArtifactPath(index),
    frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
    frameHashes,
    blankFrameCount: 0,
    producer: { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "browser" as const, scriptExecution: store.manifest.producer.frameLane === "browser" ? store.manifest.producer.scriptExecution : undefined, warningUnion: [], warningsOmitted: 0 }
  };
}

function dataOnlyScriptEvidence() {
  return { schema: "shellx-motion/script-execution@1" as const, detectedClass: "data-only" as const, requestedMode: "none" as const, activeMode: "data-only" as const, resolverVersion: 1 as const, sources: [] };
}

function activeScriptEvidence(attestationId: string) {
  const entry = { layerId: "agent-entry", layerType: "html" as const, path: "agent-entry.html", sha256: "f".repeat(64), bytes: 128 };
  return { schema: "shellx-motion/script-execution@1" as const, detectedClass: "active-content" as const, requestedMode: "trusted-local-agent-authored" as const, activeMode: "trusted-local-agent-authored" as const, resolverVersion: 1, packageSnapshotSha256: "e".repeat(64), attestationId, sources: [entry], entry };
}

function verifiedReadback(frameCount: number, fps = 30) {
  return {
    ok: true as const,
    readback: { verified: true as const, frameCount, width: 640, height: 360, fps, durationMs: frameCount * (1000 / fps) }
  };
}

async function writeManifest(rootPath: string, manifest: unknown): Promise<void> {
  await writeFile(join(rootPath, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code} refusal.`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function expectCodeSync(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code} refusal.`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}
