import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonSha256, createGpuHybridTextureSourceSnapshot, deriveGpuHybridTextureStaticDescriptor, hashFile, LocalMotionJobGovernor, rememberLoadedPackageHashes, type LocalMotionJobPolicy, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { gpuSegmentedHybridAdmissionIdentityProblem, type GpuSegmentedHybridAdmissionIdentity } from "@shellx-motion/renderer-browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gpuRangeFramePlanSequenceSha256, gpuRangeFrameSequenceSha256 } from "./segmented-final-internal/render-segment-store-identity.js";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { deriveSegmentedFinalPaths } from "./segmented-final-internal/segmented-final-adapter-store.js";
import { renderSegmentedFinal } from "./segmented-final-internal/segmented-final-adapter.js";
import { renderSegmentedFinal as renderPublicSegmentedFinal } from "./segmented-final.js";
import type { RenderSegmentGpuHybridIdentity, RenderSegmentGpuHybridRangeProducerEvidence, RenderSegmentGpuStandardIdentity, RenderSegmentGpuRangeProducerEvidence } from "./segmented-final-internal/render-segment-store-types.js";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ packageContentSha256: string; firstStoreWasAbsent: boolean }>,
  rendered: [] as number[],
  releases: 0,
  failRange: 1 as number | undefined,
  expectedStoreRoot: "",
  hostCleanupComplete: false,
  failHostAfterCleanup: false,
  identitySalt: "stable",
  hybrid: false
}));

vi.mock("./segmented-final-internal/segmented-final-adapter-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./segmented-final-internal/segmented-final-adapter-store.js")>();
  return {
    ...actual,
    acquireSegmentedFinalLock: async () => async () => undefined
  };
});

vi.mock("./segmented-final-internal/segmented-final-store-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./segmented-final-internal/segmented-final-store-authority.js")>();
  return {
    ...actual,
    SegmentedFinalStoreAuthority: class {
    static async acquire(paths: { storeRoot: string }) {
      state.expectedStoreRoot = paths.storeRoot;
      return new this();
    }
    async assertCurrent() {}
    async assertStoreCurrent() {}
    async discardEmptyStore() {}
    async resumeGpuMaxProcessTreeRssBytes() { return 512 * 1024 * 1024; }
    }
  };
});

vi.mock("./segmented-final-gpu-host.js", () => ({
  prepareAdmittedSegmentedGpuHost: async (input: {
    packageContentSha256: string;
    timeline: { frameCount: number; durationMs: number; fps: number; width: number; height: number };
  }) => {
    const firstStoreWasAbsent = await lstat(state.expectedStoreRoot).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    state.calls.push({ packageContentSha256: input.packageContentSha256, firstStoreWasAbsent });
    if (state.failHostAfterCleanup) {
      state.hostCleanupComplete = true;
      throw new Error("controlled closed host verdict cleanup failure");
    }
    const identity = state.hybrid
      ? gpuHybridIdentity(input.packageContentSha256, input.timeline)
      : gpuIdentity(input.packageContentSha256, input.timeline.frameCount);
    return {
      producer: { frameLane: "gpu" as const, identity },
      createRangeProducer: ({ range, timeline }: {
        range: { index: number; startFrameIndex: number; endFrameIndexExclusive: number };
        timeline: { durationMs: number; fps: number; width: number; height: number };
      }) => {
        let evidence: RenderSegmentGpuRangeProducerEvidence | undefined;
        return {
          get evidence() { return evidence; },
          async produce(sink: { write(frame: { index: number; atMs: number; format: "rgba"; width: number; height: number; strideBytes: number; colorSpace: "srgb"; alphaMode: "straight"; rgba: Buffer }): Promise<void> }) {
            state.rendered.push(range.index);
            if (state.failRange !== undefined && state.rendered.length === 2) throw new Error("controlled GPU range interruption");
            const frameHashes: string[] = [];
            const framePlanFingerprints: string[] = [];
            for (let index = range.startFrameIndex; index < range.endFrameIndexExclusive; index += 1) {
              const rgba = Buffer.alloc(timeline.width * timeline.height * 4);
              for (let offset = 0; offset < rgba.length; offset += 4) {
                rgba[offset] = 32 + index * 64;
                rgba[offset + 1] = 64 + index * 32;
                rgba[offset + 2] = 128;
                rgba[offset + 3] = 255;
              }
              frameHashes.push(createHash("sha256").update(rgba).digest("hex"));
              framePlanFingerprints.push(hash(`gpu-plan:${index}`));
              await sink.write({ index, atMs: Math.max(0, Math.min(Math.round((index * 1_000) / timeline.fps), timeline.durationMs - 1)), format: "rgba", width: timeline.width, height: timeline.height, strideBytes: timeline.width * 4, colorSpace: "srgb", alphaMode: "straight", rgba });
            }
            const storeRange = {
              index: range.index,
              startFrame: range.startFrameIndex,
              endFrameExclusive: range.endFrameIndexExclusive,
              frameCount: range.endFrameIndexExclusive - range.startFrameIndex
            };
            const frameSequenceSha256 = gpuRangeFrameSequenceSha256({ range: storeRange, timeline, frameHashes });
            const framePlanSequenceSha256 = gpuRangeFramePlanSequenceSha256({ range: storeRange, timeline, framePlanFingerprints });
            evidence = state.hybrid
              ? hybridRangeEvidence(identity as RenderSegmentGpuHybridIdentity, storeRange, timeline, framePlanFingerprints, frameSequenceSha256, framePlanSequenceSha256)
              : standardRangeEvidence(identity as RenderSegmentGpuStandardIdentity, range.index, framePlanFingerprints, frameSequenceSha256, framePlanSequenceSha256);
          }
        };
      },
      audio: {},
      async release() { state.releases += 1; }
    };
  }
}));

const roots: string[] = [];
const HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  state.calls = [];
  state.rendered = [];
  state.releases = 0;
  state.failRange = 1;
  state.expectedStoreRoot = "";
  state.hostCleanupComplete = false;
  state.failHostAfterCleanup = false;
  state.identitySalt = "stable";
  state.hybrid = false;
});

describe("GPU segmented admitted host", () => {
  it("creates its identity before a new store, resumes only the verified prefix, and requires the exact host identity", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-gpu-segmented-admission-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    await mkdir(packageRoot, { mode: 0o700 });
    await writeFile(join(packageRoot, "manifest.json"), "{\"id\":\"gpu-segmented-admission\"}\n", { mode: 0o600 });
    await writeFile(join(packageRoot, "motion.json"), "{\"fps\":2}\n", { mode: 0o600 });
    const outputPath = join(root, "result.mp4");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    state.expectedStoreRoot = paths.storeRoot;

    const initial = await run({ packageRoot, outputPath, intent: "create" });
    if (initial.ok) throw new Error("Expected controlled GPU range interruption.");
    if (initial.error.code !== "segment_producer_failed") throw initial.error;
    expect(initial).toMatchObject({ ok: false, error: { code: "segment_producer_failed", evidence: { phase: "spool" } } });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.firstStoreWasAbsent).toBe(true);
    expect(state.rendered).toEqual([0, 1]);
    expect(state.releases).toBe(1);

    state.failRange = undefined;
    const resumed = await run({ packageRoot, outputPath, intent: "resume" });
    if (!resumed.ok) throw resumed.error;
    expect(state.calls).toHaveLength(2);
    expect(state.calls.map((call) => call.packageContentSha256)).toEqual([state.calls[0]?.packageContentSha256, state.calls[0]?.packageContentSha256]);
    expect(state.rendered).toEqual([0, 1, 1]);
    expect(resumed.transport).toMatchObject({
      resume: { verifiedPrefixSegments: 1, newlyCompletedSegments: 1 },
      producer: { frameLane: "gpu", identity: { hostVerdict: { session: { purpose: "pre-store-identity", emittedFrames: 0, cleanup: "complete" } } } }
    });
    expect(state.releases).toBe(2);
  }, 60_000);

  it("keeps the durable store absent when host cleanup fails before the host can return an identity", async () => {
    const root = await fixtureRoot("cleanup-before-store");
    const packageRoot = join(root, "package");
    const outputPath = join(root, "result.mp4");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    state.expectedStoreRoot = paths.storeRoot;
    state.failHostAfterCleanup = true;

    const result = await run({ packageRoot, outputPath, intent: "create" });
    expect(result).toMatchObject({ ok: false, error: { code: "segmented_final_failed", evidence: { phase: "preflight" } } });
    expect(state.calls[0]?.firstStoreWasAbsent).toBe(true);
    expect(state.hostCleanupComplete).toBe(true);
    await expect(lstat(paths.storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a resumed GPU prefix when the newly admitted host runtime verdict differs", async () => {
    const root = await fixtureRoot("resume-runtime-mismatch");
    const packageRoot = join(root, "package");
    const outputPath = join(root, "result.mp4");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    state.expectedStoreRoot = paths.storeRoot;

    const initial = await run({ packageRoot, outputPath, intent: "create" });
    expect(initial).toMatchObject({ ok: false, error: { code: "segment_producer_failed" } });
    state.identitySalt = "changed-runtime";
    state.failRange = undefined;
    const resumed = await run({ packageRoot, outputPath, intent: "resume" });

    expect(resumed).toMatchObject({ ok: false, error: { code: "segment_store_failed", evidence: { phase: "spool" } } });
    expect(state.rendered).toEqual([0, 1]);
    await expect(lstat(paths.storeRoot)).resolves.toBeDefined();
  });

  it("carries an injected admitted GPU host through the public wrapper, outer governor, create/resume, and receipt transport", async () => {
    const root = await fixtureRoot("public-create-resume");
    const packageRoot = join(root, "package");
    const outputPath = join(root, "public.mp4");
    const pkg = await loadedPublicPackage(packageRoot, "public-create-resume");
    const paths = deriveSegmentedFinalPaths(outputPath, packageRoot);
    state.expectedStoreRoot = paths.storeRoot;

    const initial = await renderPublicSegmentedFinal({
      pkg, frameLane: "gpu", outputPath, segmented: { segmentFrames: 1 }, preset: "mp4-h264",
      inputRoots: [packageRoot], outputRoots: [root], quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      governor: governor(), scratchRoot: root, toolPolicy: { forceSoftwareEncode: true, verifyDeliveredColor: false }
    });
    expect(initial).toMatchObject({ ok: false, error: { code: "segmented_final_failed", evidence: { phase: "spool" } } });
    expect(state.calls[0]?.firstStoreWasAbsent).toBe(true);

    state.failRange = undefined;
    const resumed = await renderPublicSegmentedFinal({
      pkg, frameLane: "gpu", outputPath, segmented: { segmentFrames: 1, resume: true }, preset: "mp4-h264",
      inputRoots: [packageRoot], outputRoots: [root], quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      governor: governor(), scratchRoot: root, toolPolicy: { forceSoftwareEncode: true, verifyDeliveredColor: false }
    });
    if (!resumed.ok) throw new Error(resumed.error.message);
    expect(resumed).toMatchObject({
      transport: {
        frameLane: "gpu",
        store: { location: "derived-from-output", intent: "resume" },
        resume: { verifiedPrefixSegments: 1, newlyCompletedSegments: 1 },
        producer: { frameLane: "gpu", identity: { hostVerdict: { runtimeEvidenceSha256: hash("runtime:stable") } } }
      },
      receipt: {
        inputHashes: {
          "gpu-runtime": hash("runtime:stable"),
          "gpu-readback-transport": expect.stringMatching(/^[a-f0-9]{64}$/),
          "gpu-frame-sequence": expect.stringMatching(/^[a-f0-9]{64}$/),
          "gpu-frame-plan-sequence": expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        output: { frameTransport: { frameLane: "gpu", store: { intent: "resume" } } }
      }
    });
    expect(state.rendered).toEqual([0, 1, 1]);
    expect(state.releases).toBe(2);
  }, 60_000);

  it("projects every B2 range ledger into one public receipt aggregate without leaking range-local cleanup", async () => {
    const root = await fixtureRoot("public-hybrid-aggregate");
    const packageRoot = join(root, "package");
    const outputPath = join(root, "public-hybrid.mp4");
    const pkg = await loadedPublicPackage(packageRoot, "public-hybrid-aggregate");
    state.expectedStoreRoot = deriveSegmentedFinalPaths(outputPath, packageRoot).storeRoot;
    state.hybrid = true;
    state.failRange = undefined;
    expect(gpuSegmentedHybridAdmissionIdentityProblem(gpuHybridIdentity(hash("package"), { frameCount: 2, durationMs: 1_000, fps: 2, width: 4, height: 2 }).hybrid.admission)).toBeNull();

    const result = await renderPublicSegmentedFinal({
      pkg, frameLane: "gpu", outputPath, segmented: { segmentFrames: 1 }, preset: "mp4-h264",
      inputRoots: [packageRoot], outputRoots: [root], quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
      governor: governor(), scratchRoot: root, toolPolicy: { forceSoftwareEncode: true, verifyDeliveredColor: false }
    });
    if (!result.ok) throw new Error(result.error.message);
    const producer = result.transport.producer;
    if (producer.schema !== "shellx-motion/gpu-hybrid-segment-aggregate-producer@1") {
      throw new Error("B2 public receipt must expose the final aggregate producer schema.");
    }
    expect(producer.hybrid).toMatchObject({
      rangeCount: 2, captureCount: 2,
      captureSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      rangeLedgerSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect("ledger" in producer.hybrid).toBe(false);
    expect("cleanup" in producer.hybrid).toBe(false);
    expect(producer.finalReceiptInputHashes).toMatchObject({
      "gpu-hybrid-range-ledger": producer.hybrid.captureSequenceSha256,
      "gpu-hybrid-range-ledger-sequence": producer.hybrid.rangeLedgerSequenceSha256
    });
    expect(producer.finalReceiptInputHashes).not.toHaveProperty("gpu-hybrid-range-cleanup");
    expect(result.receipt.inputHashes).toMatchObject({
      "gpu-hybrid-range-ledger": producer.hybrid.captureSequenceSha256,
      "gpu-hybrid-range-ledger-sequence": producer.hybrid.rangeLedgerSequenceSha256
    });
    const receiptProducer = ((result.receipt.output as { frameTransport: { producer: typeof producer } }).frameTransport).producer;
    expect(receiptProducer).toMatchObject({ schema: producer.schema, hybrid: producer.hybrid });
  }, 60_000);
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), `.tmp-gpu-segmented-${name}-`));
  roots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: `gpu-segmented-${name}`, name,
    motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] }
  })}\n`, { mode: 0o600 });
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: `gpu-segmented-${name}-motion`, name,
    durationMs: 1_000, fps: 2, width: 4, height: 2, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" }
  })}\n`, { mode: 0o600 });
  return root;
}

async function loadedPublicPackage(packageRoot: string, name: string): Promise<MotionPackage> {
  const pkg: MotionPackage = {
    root: packageRoot,
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: `gpu-segmented-${name}`, name,
      motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1", id: `gpu-segmented-${name}-motion`, name,
      durationMs: 1_000, fps: 2, width: 4, height: 2, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" }
    }
  };
  rememberLoadedPackageHashes(pkg, {
    "manifest.json": await hashFile(join(packageRoot, "manifest.json")),
    "motion.json": await hashFile(join(packageRoot, "motion.json"))
  });
  return pkg;
}

async function run(input: { packageRoot: string; outputPath: string; intent: "create" | "resume" }) {
  return await renderSegmentedFinal({
    package: { rootPath: input.packageRoot, id: "gpu-segmented-admission", manifestSha256: HASH },
    timeline: { motionSha256: HASH, frameCount: 2, durationMs: 1_000, fps: 2, width: 4, height: 2 },
    frameLane: "gpu",
    plan: planRenderSegments({ frameCount: 2, segmentFrames: 1 }),
    outputPath: input.outputPath,
    store: { intent: input.intent },
    preset: "mp4-h264",
    inputRoots: [input.packageRoot],
    outputRoots: [join(input.packageRoot, "..")],
    quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
    forceSoftwareEncode: true,
    verifyDeliveredColor: false,
    gpuHost: { pkg: {} as MotionPackage },
    governor: governor(),
    scratchRoot: join(input.packageRoot, "..")
  });
}

function gpuIdentity(packageContentSha256: string, canonicalFrameCount: number): RenderSegmentGpuStandardIdentity {
  return {
    schema: "shellx-motion/gpu-segmented-identity@1",
    packageContentSha256,
    pipelineCatalogSha256: hash("catalog"),
    staticPlan: { fingerprint: hash("plan"), documentFingerprint: hash("document"), resourceReferencesSha256: hash("resources"), canonicalFrameCount, maxEnvironmentCount: 0 },
    staticScene: { sha256: hash("scene"), inputHashesSha256: hash("scene-inputs") },
    hostVerdict: {
      schema: "shellx-motion/gpu-segmented-host-verdict@1",
      platform: "linux",
      browser: { source: "path", executableSha256: hash("chromium"), version: "test-chromium/1" },
      launchProfileSha256: hash("launch"),
      runtimeEvidenceSha256: hash(`runtime:${state.identitySalt}`),
      adapterFingerprint: hash("adapter"),
      containment: { mode: "unix-process-group", memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 },
      session: { purpose: "pre-store-identity", emittedFrames: 0, cleanup: "complete" }
    }
  };
}

function gpuHybridIdentity(
  packageContentSha256: string,
  timeline: { frameCount: number; durationMs: number; fps: number; width: number; height: number }
): RenderSegmentGpuHybridIdentity {
  const standard = gpuIdentity(packageContentSha256, timeline.frameCount);
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "public-hybrid-motion", name: "public hybrid",
    durationMs: timeline.durationMs, fps: timeline.fps, width: timeline.width, height: timeline.height,
    layers: [{ id: "surface", type: "html", source: "surface.html", startMs: 0, durationMs: timeline.durationMs }],
    assets: [], provenance: { sourceApp: "test", createdBy: "test" }
  };
  const descriptor = deriveGpuHybridTextureStaticDescriptor(motion, motion.layers[0]!);
  if (!descriptor) throw new Error("Hybrid transport fixture requires a Core static descriptor.");
  const browser = { name: "chromium" as const, executableSha256: standard.hostVerdict.browser.executableSha256, runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" as const };
  const policy = { scripts: "data-only-none" as const, network: "no-egress" as const, htmlClosure: "primary-self-contained" as const, capture: "one-borrowed-browser-context-per-bootstrap-or-range" as const };
  const sourceSnapshotSha256 = hash("public-hybrid-source");
  const captureContractSha256 = canonicalJsonSha256({ schema: "shellx-motion/gpu-segmented-hybrid-capture-contract@1", staticPlanFingerprint: standard.staticPlan.fingerprint, descriptorFingerprint: descriptor.descriptorFingerprint, sourceSnapshotSha256, sourceByteLength: 12, browser, policy });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({ descriptor, sourceSnapshotSha256, sourceByteLength: 12, captureContractSha256 });
  const id = `hybrid-${createHash("sha256").update(descriptor.descriptorFingerprint).digest("hex").slice(0, 24)}`;
  const entries = Array.from({ length: timeline.frameCount }, (_, index) => ({ index, atMs: Math.round((index * 1_000) / timeline.fps), atUs: Math.round((index * 1_000_000) / timeline.fps), requestFingerprint: hash(`hybrid-request:${index}`) }));
  const dynamicTexture = { id, width: timeline.width, height: timeline.height, sourceSha256: captureContractSha256, bytes: timeline.width * timeline.height * 4 };
  const admission: GpuSegmentedHybridAdmissionIdentity = {
    schema: "shellx-motion/gpu-segmented-hybrid-admission@1", staticPlanFingerprint: standard.staticPlan.fingerprint,
    descriptor, sourceSnapshot, captureContractSha256, browser: { ...browser, version: standard.hostVerdict.browser.version }, dynamicTexture, policy,
    bootstrap: { ...entries[0]!, resourceId: id, width: timeline.width, height: timeline.height, pngSha256: hash("hybrid-bootstrap-png"), decodedRgbaSha256: hash("hybrid-bootstrap-rgba"), cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: dynamicReservation(dynamicTexture) } }
  };
  return {
    ...standard,
    schema: "shellx-motion/gpu-hybrid-segmented-identity@1",
    hybrid: { admission, capturePlan: { schema: "shellx-motion/gpu-hybrid-capture-plan@1", entries, sha256: canonicalJsonSha256({ schema: "shellx-motion/gpu-hybrid-capture-plan@1", entries }) } }
  };
}

function standardRangeEvidence(identity: RenderSegmentGpuStandardIdentity, rangeIndex: number, framePlanFingerprints: string[], frameSequenceSha256: string, framePlanSequenceSha256: string): RenderSegmentGpuRangeProducerEvidence {
  return {
    schema: "shellx-motion/gpu-segment-range-producer@1", frameLane: "gpu", identity, frameSequenceSha256, framePlanSequenceSha256, framePlanFingerprints,
    finalReceiptInputHashes: gpuRangeReceiptHashes(identity, rangeIndex, frameSequenceSha256, framePlanSequenceSha256), warningUnion: [], warningsOmitted: 0
  };
}

function hybridRangeEvidence(identity: RenderSegmentGpuHybridIdentity, range: { index: number; startFrame: number; endFrameExclusive: number }, timeline: { width: number; height: number }, framePlanFingerprints: string[], frameSequenceSha256: string, framePlanSequenceSha256: string): RenderSegmentGpuHybridRangeProducerEvidence {
  const entries = identity.hybrid.capturePlan.entries
    .filter((entry) => entry.index >= range.startFrame && entry.index < range.endFrameExclusive)
    .map((entry) => ({
      ...entry, resourceId: identity.hybrid.admission.dynamicTexture.id, width: timeline.width, height: timeline.height,
      pngSha256: entry.index === identity.hybrid.admission.bootstrap.index ? identity.hybrid.admission.bootstrap.pngSha256 : hash(`hybrid-png:${entry.index}`),
      decodedRgbaSha256: entry.index === identity.hybrid.admission.bootstrap.index ? identity.hybrid.admission.bootstrap.decodedRgbaSha256 : hash(`hybrid-rgba:${entry.index}`)
    }));
  const ledger = { schema: "shellx-motion/gpu-segmented-hybrid-range-ledger@1" as const, rangeIndex: range.index, startFrameIndex: range.startFrame, endFrameIndexExclusive: range.endFrameExclusive, expectedCaptureCount: entries.length, captureCount: entries.length, entries, sequenceSha256: canonicalJsonSha256(entries) };
  return {
    schema: "shellx-motion/gpu-hybrid-segment-range-producer@1", frameLane: "gpu", identity, frameSequenceSha256, framePlanSequenceSha256, framePlanFingerprints,
    hybrid: { ledger, cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: dynamicReservation(identity.hybrid.admission.dynamicTexture) } },
    finalReceiptInputHashes: { ...gpuRangeReceiptHashes(identity, range.index, frameSequenceSha256, framePlanSequenceSha256), "gpu-hybrid-admission": canonicalJsonSha256(identity.hybrid.admission), "gpu-hybrid-capture-plan": identity.hybrid.capturePlan.sha256, "gpu-hybrid-range-ledger": ledger.sequenceSha256 },
    warningUnion: [], warningsOmitted: 0
  };
}

function gpuRangeReceiptHashes(identity: RenderSegmentGpuStandardIdentity | RenderSegmentGpuHybridIdentity, rangeIndex: number, frameSequenceSha256: string, framePlanSequenceSha256: string): Record<string, string> {
  return {
    "gpu-pipeline-catalog": identity.pipelineCatalogSha256, "gpu-static-plan": identity.staticPlan.fingerprint,
    "gpu-static-plan-document": identity.staticPlan.documentFingerprint, "gpu-static-plan-resources": identity.staticPlan.resourceReferencesSha256,
    "gpu-static-scene": identity.staticScene.sha256, "gpu-static-inputs": identity.staticScene.inputHashesSha256,
    "gpu-adapter": identity.hostVerdict.adapterFingerprint, "gpu-runtime": identity.hostVerdict.runtimeEvidenceSha256,
    "gpu-containment": hash(`containment:${rangeIndex}`), "gpu-resource-budget": hash(`budget:${rangeIndex}`),
    "gpu-session-resources": hash(`session:${rangeIndex}`), "gpu-readback-transport": hash(`readback:${rangeIndex}`),
    "gpu-frame-sequence": frameSequenceSha256, "gpu-frame-plan-sequence": framePlanSequenceSha256
  };
}

function dynamicReservation(value: { id: string; width: number; height: number; sourceSha256: string }) {
  return { id: value.id, width: value.width, height: value.height, sourceSha256: value.sourceSha256 };
}

function governor(): LocalMotionJobGovernor {
  const policy: LocalMotionJobPolicy = {
    maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 5_000, maxWallClockMs: 30_000,
    minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000
  };
  return new LocalMotionJobGovernor(policy, {
    leases: null,
    prepareScratchRoot: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); return path; },
    freeScratchBytes: async () => Number.MAX_SAFE_INTEGER
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
