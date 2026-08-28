import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attestArtifactReceipt,
  canonicalJsonSha256,
  createAttestedArtifactHandle,
  deriveGpuPostRenderReuseIdentity,
  hashBuffer,
  validateGpuPostRenderReuseIdentity,
  verifyGpuPostRenderReuseIdentity,
  type ArtifactReceiptAttestation,
  type AttestedArtifactHandle,
  type OperationReceipt,
} from "./index";

const roots: string[] = [];
const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32617663316d703431", "hex");

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("GPU post-render reuse identity", () => {
  it("binds loaded inputs, static plan, resources, transport, runtime, video absence, quality, and retained media", async () => {
    const fixture = await gpuArtifact();
    const verified = await verifyGpuPostRenderReuseIdentity({ root: fixture.root, artifact: fixture.artifact });

    expect(verified.identity).toMatchObject({
      schema: "shellx-motion/gpu-post-render-reuse-identity@1",
      mode: "post-render-only",
      source: { receiptId: fixture.receipt.id, receiptSha256: fixture.sourceReceipt.sha256 },
      artifact: { sha256: fixture.artifact.sha256, byteLength: MP4.byteLength },
      staticScene: { pipelineCatalogSha256: fixture.receipt.inputHashes["gpu-pipeline-catalog"] },
      frameTransport: { frameSequenceSha256: fixture.receipt.inputHashes["gpu-frame-sequence"] },
      runtime: { adapterFingerprint: fixture.receipt.inputHashes["gpu-adapter"] },
      video: null,
      quality: { exactSourceInputsSha256: null },
      identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(verifyGpuPostRenderReuseIdentity({ root: fixture.root, artifact: fixture.artifact, expected: verified.identity })).resolves.toMatchObject({ identity: verified.identity });
  });

  it("refuses a warning receipt, missing containment, malformed adapter, or an unbound quality closure", async () => {
    const fixture = await gpuArtifact();
    const base = fixture.receipt;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: { ...base, status: "warning" } })).toThrow(/passed host render.final/);

    const missingContainment = cloneReceipt(base);
    const monitoring = outputEvidence(missingContainment).processMonitoring as Record<string, unknown>;
    monitoring.containment = null;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: missingContainment })).toThrow(/containment/);

    const malformedAdapter = cloneReceipt(base);
    (outputEvidence(malformedAdapter).gpu as Record<string, unknown>).adapterFingerprint = "not-a-hash";
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: malformedAdapter })).toThrow(/adapter fingerprint/);

    const malformedAdapterProfile = cloneReceipt(base);
    (outputEvidence(malformedAdapterProfile).gpu as Record<string, unknown>).adapter = {};
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: malformedAdapterProfile })).toThrow(/adapter profile/);

    const missingQuality = cloneReceipt(base);
    delete (outputTransport(missingQuality).encoderHandoff as Record<string, unknown>).quality;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: missingQuality })).toThrow(/quality closure/);
  });

  it("refuses a mismatched frame sequence, then refuses a changed serialized identity", async () => {
    const fixture = await gpuArtifact();
    const mismatched = cloneReceipt(fixture.receipt);
    ((outputTransport(mismatched).encoderHandoff as Record<string, unknown>).frameSequence as Record<string, unknown>).sha256 = hash("other-frame-sequence");
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: mismatched })).toThrow(/frame transport/);

    const mismatchedCount = cloneReceipt(fixture.receipt);
    outputTransport(mismatchedCount).frameCount = 2;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: mismatchedCount })).toThrow(/static scene or resource budget/);

    const identity = deriveGpuPostRenderReuseIdentity(fixture);
    expect(() => validateGpuPostRenderReuseIdentity({ ...identity, runtime: { ...identity.runtime, adapterFingerprint: hash("other-adapter") } })).toThrow(/does not bind/);
  });

  it("binds immutable video ledger and PCM evidence, and refuses an invalid ledger", async () => {
    const fixture = await gpuArtifact();
    const receipt = cloneReceipt(fixture.receipt);
    const evidence = outputEvidence(receipt);
    const ledger = { maxBytes: 64, immutableSourceBytes: 16, plannedRgbaBytes: 20, plannedPcmBytes: 12, totalBytes: 48 };
    const pcmSha256 = hash("full-source-pcm");
    evidence.video = { schema: "shellx-motion/gpu-video-frame-provider@1", sourceCount: 1 };
    evidence.videoStaging = { ledger, pcmSha256 };
    receipt.inputHashes["gpu-video-staging-ledger"] = canonicalJsonSha256(ledger);
    receipt.inputHashes["gpu-video-pcm"] = pcmSha256;

    expect(deriveGpuPostRenderReuseIdentity({ ...fixture, receipt }).video).toEqual({ stagingLedgerSha256: canonicalJsonSha256(ledger), pcmSha256 });
    (evidence.videoStaging as { ledger: { totalBytes: number } }).ledger.totalBytes = 63;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt })).toThrow(/ledger/);
  });

  it("binds the V25-A environment reservation arena and refuses missing, malformed, or contradictory shutter evidence", async () => {
    const fixture = await gpuArtifact(true);
    expect(deriveGpuPostRenderReuseIdentity(fixture).runtime.sessionResourcesSha256).toBe(fixture.receipt.inputHashes["gpu-session-resources"]);

    const missing = cloneReceipt(fixture.receipt);
    delete missing.inputHashes["gpu-environment-arena"];
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: missing })).toThrow(/gpu-environment-arena/);

    const malformed = cloneReceipt(fixture.receipt);
    const malformedMetrics = outputEvidence(malformed).sessionResources as Record<string, unknown>;
    malformedMetrics.environmentUniformCapacitySlots = 35;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: malformed })).toThrow(/environment reservation or arena/);

    const contradictory = cloneReceipt(fixture.receipt);
    const contradictoryMetrics = outputEvidence(contradictory).sessionResources as Record<string, unknown>;
    contradictoryMetrics.environmentDrawsRendered = 1;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: contradictory })).toThrow(/environment reservation or arena/);

    const grownArena = cloneReceipt(fixture.receipt);
    const grownArenaMetrics = outputEvidence(grownArena).sessionResources as Record<string, unknown>;
    grownArenaMetrics.frameArenaReconfigurations = 2;
    expect(() => deriveGpuPostRenderReuseIdentity({ ...fixture, receipt: grownArena })).toThrow(/environment reservation or arena/);
  });
});

async function gpuArtifact(environment = false): Promise<{
  root: string;
  receipt: OperationReceipt;
  sourceReceipt: ArtifactReceiptAttestation;
  artifact: AttestedArtifactHandle;
}> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-post-render-reuse-"));
  roots.push(root);
  const outputPath = join(root, "final.mp4");
  await writeFile(outputPath, MP4);
  const receipt = receiptFor(outputPath, environment);
  const receiptPath = join(root, "gpu-final.receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const sourceReceipt = await attestArtifactReceipt(root, receiptPath, "render");
  const artifact = await createAttestedArtifactHandle({
    root,
    artifactPath: outputPath,
    packageId: receipt.packageId,
    motionId: "motion_gpu_post_render",
    operationHash: receipt.inputHashes.operationHash,
    preset: "mp4-h264",
    mediaType: "video/mp4",
    receipts: [sourceReceipt],
    createdAt: receipt.createdAt,
    probe: false,
  });
  return { root, receipt, sourceReceipt, artifact };
}

function receiptFor(outputPath: string, environment = false): OperationReceipt {
  const loadedInputs = { "motion.json": hash("motion"), "assets/hero.png": hash("hero") };
  const pipelineCatalog = { schema: "shellx-motion/gpu-pipeline-catalog@1", entries: [] as unknown[] };
  const pipelineCatalogSha256 = canonicalJsonSha256(pipelineCatalog);
  const staticPlan = {
    schema: "shellx-motion/gpu-scene-static-plan@1",
    fingerprint: hash("static-plan"), documentFingerprint: hash("static-document"), canonicalFrameCount: 1,
    resourceReferencesSha256: hash("static-resources"), resourceReferenceCount: 2, maxima: { canonicalFrameCount: 1, maxEnvironmentCount: environment ? 1 : 0 }, geometryReuse: "not-claimed",
  };
  const staticScene = {
    schema: "shellx-motion/gpu-static-scene-fingerprint@1", pipelineCatalogSha256,
    inputHashesSha256: canonicalJsonSha256(loadedInputs), sha256: hash("static-scene"),
  };
  const resourceBudget = { schema: "shellx-motion/gpu-resource-budget-evidence@1", expectedFrames: 1, observedFrames: 1, maxima: { rectangleCount: 1, environmentCount: environment ? 8 : 0, environmentUniformBytes: environment ? 1_664 : 0 } };
  const resourceBudgetEvidence = { ...resourceBudget, sha256: canonicalJsonSha256(resourceBudget) };
  const runtime = {
    schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "trusted-chromium", webgpuFeatureStatus: "enabled",
    adapterFingerprint: hash("adapter"), adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "vendor", cdpDevice: "device", vendor: "vendor", device: "device", architecture: null, description: null },
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 1024, maxStorageBufferBindingSize: 1024 },
  };
  runtime.adapterFingerprint = adapterFingerprint(runtime.adapter);
  const sessionResources = {
    schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1,
    frameArenaReconfigurations: 1, frameArenaReservations: 1, frameArenaLateAllocationRefusals: 0, frameArenaBytes: 8, frameArenaHighWaterBytes: 8,
    environmentUniformCapacitySlots: environment ? 36 : 0, environmentUniformBytes: environment ? 9_216 : 0, environmentUniformHighWaterSlots: environment ? 36 : 0, environmentUniformHighWaterBytes: environment ? 9_216 : 0,
    environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: environment ? 8 : 0, environmentEnvelopeReservations: environment ? 1 : 0
  };
  const containment = { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 1024 };
  const monitoring = {
    mode: "precontained-direct-chromium", chromiumRootPid: 42, watchedRoot: "precontained-chromium-root", rssScope: "precontained-chromium-tree",
    measurement: "exact-precontained-chromium-root-pid", watchRegistered: true, containment, encoderContainmentCoversChromium: true,
  };
  const frameSequenceSha256 = hash("frames"), framePlanSequenceSha256 = hash("frame-plans");
  const inputHashes = {
    operationHash: hash("sdk-operation"),
    "gpu-pipeline-catalog": pipelineCatalogSha256,
    "gpu-static-plan": staticPlan.fingerprint,
    "gpu-static-plan-document": staticPlan.documentFingerprint,
    "gpu-static-plan-resources": staticPlan.resourceReferencesSha256,
    "gpu-static-scene": staticScene.sha256,
    "gpu-static-inputs": staticScene.inputHashesSha256,
    "gpu-resource-budget": resourceBudgetEvidence.sha256,
    "gpu-adapter": runtime.adapterFingerprint,
    "gpu-runtime": canonicalJsonSha256(runtime),
    "gpu-session-resources": canonicalJsonSha256(sessionResources),
    "gpu-containment": canonicalJsonSha256(monitoring),
    "gpu-frame-sequence": frameSequenceSha256,
    "gpu-frame-plan-sequence": framePlanSequenceSha256,
    ...(environment ? { "gpu-environment-arena": canonicalJsonSha256({
      schema: "shellx-motion/gpu-environment-arena-evidence@1",
      staticPlanFingerprint: staticPlan.fingerprint,
      canonicalFrameCount: 1,
      maxEnvironmentCount: 1,
      resourceBudget: { maxEnvironmentDrawsPerFrame: 8, maxEnvironmentUniformBytesPerFrame: 1_664 },
      frameArena: { reservations: 1, lateAllocationRefusals: 0, reconfigurations: 1, bytes: 8, highWaterBytes: 8 },
      uniforms: { capacitySlots: 36, bytes: 9_216, highWaterSlots: 36, highWaterBytes: 9_216, lateAllocationRefusals: 0 },
      environmentDrawsRendered: 8,
      environmentEnvelopeReservations: 1
    }) } : {}),
  };
  return {
    schema: "shellx-motion/receipt@1", id: "gpu-final-source", operation: "render.final", status: "passed", packageId: "pkg_gpu_post_render",
    inputHashes, createdAt: "2026-08-14T00:00:00.000Z", lane: "ffmpeg",
    output: {
      path: outputPath, sha256: hashBuffer(MP4), preset: "mp4-h264",
      frameTransport: {
        delivery: "streamed", frameLane: "gpu", frameCount: 1, retainedFrameCount: 0,
        producer: {
          frameLane: "gpu",
          evidence: {
            schema: "shellx-motion/gpu-streaming-producer@1", inputHashes: loadedInputs,
            frameSequenceSha256, framePlanSequenceSha256,
            provenance: { pipelineCatalog: { ...pipelineCatalog, sha256: pipelineCatalogSha256 }, staticPlan, staticScene, resourceBudget: resourceBudgetEvidence },
            gpu: runtime, video: null, typography: {}, runtimeLifecycle: {}, sessionResources, processMonitoring: monitoring, session: {},
          },
        },
        encoderHandoff: {
          delivery: "streamed", frameFormat: "rgba", frameSequence: { schema: "shellx-motion/streamed-frame-sequence@1", sha256: frameSequenceSha256 },
          quality: { frameCount: 1, blankFrames: 0, uniqueFrameHashes: 1, uniqueFrameHashesExact: true },
        },
      },
    },
    warnings: [],
  };
}

function outputTransport(receipt: OperationReceipt): Record<string, unknown> {
  return (receipt.output as { frameTransport: Record<string, unknown> }).frameTransport;
}

function outputEvidence(receipt: OperationReceipt): Record<string, unknown> {
  return ((outputTransport(receipt).producer as { evidence: Record<string, unknown> }).evidence);
}

function cloneReceipt(receipt: OperationReceipt): OperationReceipt { return JSON.parse(JSON.stringify(receipt)) as OperationReceipt; }
function hash(value: string): string { return canonicalJsonSha256(value); }
function adapterFingerprint(adapter: { cdpVendorId: number; cdpDeviceId: number; cdpVendor: string; cdpDevice: string; vendor: string; device: string; architecture: string | null; description: string | null }): string {
  return createHash("sha256").update(JSON.stringify({ page: { vendor: adapter.vendor, device: adapter.device, architecture: adapter.architecture, description: adapter.description }, cdp: { vendorId: adapter.cdpVendorId, deviceId: adapter.cdpDeviceId, vendor: adapter.cdpVendor, device: adapter.cdpDevice } })).digest("hex");
}
