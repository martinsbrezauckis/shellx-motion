import { canonicalJsonSha256, type GpuFrameBudget, type GpuSceneStaticMaxima } from "@shellx-motion/core";
import type { GpuStreamingFrameProducerEvidence } from "@shellx-motion/renderer-browser";
import { describe, expect, it } from "vitest";
import { gpuFinalReceiptInputHashes } from "./gpu-final-receipt-provenance.js";

const HASH = "a".repeat(64);
type DirectHtmlHybrid = Extract<NonNullable<GpuStreamingFrameProducerEvidence["hybrid"]>, { schema: "shellx-motion/gpu-hybrid-capture@1" }>;
type RestrictedHybrid = Extract<NonNullable<GpuStreamingFrameProducerEvidence["hybrid"]>, { schema: "shellx-motion/gpu-restricted-shader-hybrid@1" }>;

describe("GPU final receipt provenance", () => {
  it("binds every mandatory GPU provenance digest into the final receipt", () => {
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: evidence() })).toEqual({
      "gpu-pipeline-catalog": HASH,
      "gpu-static-plan": HASH,
      "gpu-static-plan-document": HASH,
      "gpu-static-plan-resources": HASH,
      "gpu-static-scene": HASH,
      "gpu-static-inputs": HASH,
      "gpu-resource-budget": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-adapter": HASH,
      "gpu-runtime": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-session-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-readback-transport": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-containment": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-frame-sequence": HASH,
      "gpu-frame-plan-sequence": HASH
    });
  });

  it("refuses receipt success when canonical resource evidence is incomplete", () => {
    const base = evidence();
    const incomplete: GpuStreamingFrameProducerEvidence = {
      ...base,
      provenance: { ...base.provenance, resourceBudget: null }
    };
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: incomplete })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, provenance: { ...base.provenance, resourceBudget: { ...base.provenance.resourceBudget!, sha256: HASH } } }
    })).toBeUndefined();
  });

  it("fails closed on partial producer records and throwing evidence accessors", () => {
    for (const producer of [
      undefined,
      null,
      {},
      { frameLane: "gpu" },
      { frameLane: "gpu", evidence: {} },
      { frameLane: "gpu", evidence: { provenance: null } },
      { frameLane: "gpu-pbr", evidence: {} }
    ]) {
      expect(gpuFinalReceiptInputHashes(producer)).toBeUndefined();
    }
    let producerEvidenceReads = 0;
    const accessorBackedProducer = { frameLane: "gpu" };
    Object.defineProperty(accessorBackedProducer, "evidence", {
      enumerable: true,
      get() {
        producerEvidenceReads += 1;
        throw new Error("hostile evidence accessor");
      }
    });
    expect(gpuFinalReceiptInputHashes(accessorBackedProducer)).toBeUndefined();
    expect(producerEvidenceReads).toBe(0);

    let provenanceReads = 0;
    const accessorBackedEvidence = evidence();
    Object.defineProperty(accessorBackedEvidence, "provenance", {
      enumerable: true,
      get() {
        provenanceReads += 1;
        throw new Error("hostile provenance accessor");
      }
    });
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: accessorBackedEvidence })).toBeUndefined();
    expect(provenanceReads).toBe(0);

    let canonicalFrameCountReads = 0;
    const nestedEvidenceAccessor = evidence();
    const staticPlan = nestedEvidenceAccessor.provenance.staticPlan! as unknown as Record<string, unknown>;
    Object.defineProperty(staticPlan, "canonicalFrameCount", {
      enumerable: true,
      get() {
        canonicalFrameCountReads += 1;
        throw new Error("hostile nested static-plan accessor");
      }
    });
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: nestedEvidenceAccessor })).toBeUndefined();
    expect(canonicalFrameCountReads).toBe(0);
  });

  it("preserves non-GPU empty bindings for valid browser and native producer records", () => {
    expect(gpuFinalReceiptInputHashes({ frameLane: "browser", evidence: {} })).toEqual({});
    expect(gpuFinalReceiptInputHashes({ frameLane: "native", evidence: {} })).toEqual({});
  });

  it("refuses absent, malformed, or frame-mismatched persistent session metrics", () => {
    const base = evidence();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, sessionResources: null } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, sessionResources: { ...base.sessionResources!, framesRendered: 2 } }
    })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, sessionResources: { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1 } as GpuStreamingFrameProducerEvidence["sessionResources"] }
    })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, sessionResources: { ...base.sessionResources!, pointPositionEvaluation: "gpu-estimated" } as unknown as GpuStreamingFrameProducerEvidence["sessionResources"] }
    })).toBeUndefined();
  });

  it("binds exact v2 compute ABI metrics and refuses forged growth or pass counters", () => {
    const base = evidence();
    const sessionResources = {
      ...base.sessionResources!,
      pointPositionEvaluation: "gpu-fixed-analytic-time" as const,
      pointComputeField: "fixed-analytic-v2" as const,
      computeParticleBufferSlots: 2,
      computeParticleBufferBytes: 12_800_000,
      computeParticleBufferHighWaterSlots: 2,
      computeParticleBufferHighWaterBytes: 12_800_000,
      adapterComputeParticleInstanceLimit: 131_072,
      computeParticleDispatches: 1,
      computeParticleAbi: "shellx-motion/gpu-compute-particle-field@2" as const,
      computeParticleInstanceBytes: 64,
      computeParticleRetainedBufferCount: 2,
      computeParticleUniformBytes: 432,
      computeParticleRasterCalls: 2,
      computeParticleHeadRasterCalls: 1,
      computeParticleTrailRasterCalls: 1,
      computeParticleCapacityReconfigurations: 0,
      computeParticleLateAllocationRefusals: 0
    };
    const admitted = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, sessionResources } });
    expect(admitted?.["gpu-session-resources"]).toMatch(/^[a-f0-9]{64}$/);
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...base, sessionResources: { ...sessionResources, computeParticleCapacityReconfigurations: 1 }
    } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...base, sessionResources: { ...sessionResources, computeParticleTrailRasterCalls: 0, computeParticleRasterCalls: 2 }
    } })).toBeUndefined();
  });

  it("binds V25-A environment arena reservations and refuses missing, malformed, or contradictory metrics", () => {
    const base = evidence();
    const staticPlan = base.provenance.staticPlan!;
    const resourceBudget = base.provenance.resourceBudget!;
    const environment: GpuStreamingFrameProducerEvidence = {
      ...base,
      provenance: {
        ...base.provenance,
        staticPlan: {
          ...staticPlan,
          maxima: { ...staticPlan.maxima, maxEnvironmentCount: 1 }
        } as never,
        resourceBudget: {
          ...gpuResourceBudget({ ...resourceBudget.maxima, environmentCount: 8, environmentUniformBytes: 1_664 } as GpuFrameBudget)
        }
      },
      sessionResources: {
        ...base.sessionResources!,
        environmentUniformCapacitySlots: 36,
        environmentUniformBytes: 9_216,
        environmentUniformHighWaterSlots: 36,
        environmentUniformHighWaterBytes: 9_216,
        environmentDrawsRendered: 8,
        environmentEnvelopeReservations: 1
      } as never
    };
    const admitted = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: environment });
    expect(admitted?.["gpu-environment-arena"]).toMatch(/^[a-f0-9]{64}$/);
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...environment,
      sessionResources: { ...environment.sessionResources, environmentUniformCapacitySlots: 35 } as never
    } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...environment,
      sessionResources: {
        ...environment.sessionResources,
        environmentUniformCapacitySlots: 0,
        environmentUniformBytes: 0,
        environmentUniformHighWaterSlots: 0,
        environmentUniformHighWaterBytes: 0,
        environmentDrawsRendered: 0
      } as never
    } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...environment,
      sessionResources: { ...environment.sessionResources, environmentDrawsRendered: 1 } as never
    } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...environment,
      sessionResources: { ...environment.sessionResources, frameArenaReconfigurations: 2 } as never
    } })).toBeUndefined();
    const environmentStaticPlan = environment.provenance.staticPlan!;
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: {
      ...environment,
      provenance: {
        ...environment.provenance,
        staticPlan: { ...environmentStaticPlan, maxima: { ...environmentStaticPlan.maxima, maxEnvironmentCount: 0 } } as never
      }
    } })).toBeUndefined();
  });

  it("requires exact readback transport facts but excludes observational timing from identity", () => {
    const base = evidence();
    const original = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: base });
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, readback: null } })).toBeUndefined();
    expect(gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, readback: { ...base.readback!, transport: { ...base.readback!.transport, allocations: { ...base.readback!.transport.allocations, rowCompaction: 1 } } } }
    })).toBeUndefined();
    const withDifferentTiming = gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: { ...base, readback: { ...base.readback!, timing: { ...base.readback!.timing, totalNanoseconds: 9, minNanoseconds: 9, maxNanoseconds: 9 } } }
    });
    expect(withDifferentTiming).toEqual(original);
  });

  it("binds the admitted video aggregate ledger and full-source PCM digest when video is present", () => {
    const base = evidence();
    const hashes = gpuFinalReceiptInputHashes({
      frameLane: "gpu",
      evidence: {
        ...base,
        video: { schema: "shellx-motion/gpu-video-frame-provider@1", mode: "immutable-ffmpeg-rgba-stream", sourceCount: 1, decodedFrameCount: 1, peakInMemoryFrames: 1, stagedDecodedBytes: 8, stagedFrameCount: 1, sources: [] },
        videoStaging: { ledger: { maxBytes: 100, immutableSourceBytes: 10, plannedRgbaBytes: 8, plannedPcmBytes: 12, totalBytes: 30 }, pcmSha256: HASH }
      }
    });
    expect(hashes).toMatchObject({
      "gpu-video-staging-ledger": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-video-pcm": HASH
    });
  });

  it("binds the additive direct B2 hybrid ledger without changing the legacy capture sequence", () => {
    const base = evidence();
    const hybrid = directHybrid();
    const hashes = gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, hybrid } });
    expect(hashes).toMatchObject({
      "gpu-hybrid-source-binding": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-hybrid-capture-sequence": HASH,
      "gpu-hybrid-exact-capture-ledger": "b".repeat(64)
    });
    for (const malformed of [
      { ...hybrid, capturedFrames: 0 },
      { ...hybrid, capturedFrames: 2 },
      { ...hybrid, captureFrameSequenceSha256: null },
      { ...hybrid, exactCaptureLedgerSequenceSha256: "not-a-hash" },
      { ...hybrid, inputHashes: { "surface.html": "not-a-hash" } }
    ]) {
      expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, hybrid: malformed as never } })).toBeUndefined();
    }
  });

  it("refuses malformed direct HTML and restricted-GLSL binding structures before projecting a final receipt", () => {
    const base = evidence();
    const html = directHybrid();
    const htmlFailures = [
      { ...html, sourceDocument: { ...html.sourceDocument, policy: undefined } },
      { ...html, sourceDocument: { ...html.sourceDocument, unexpected: true } },
      { ...html, scriptExecution: { ...html.scriptExecution, sources: [{ layerId: "x", layerType: "html", path: "x", sha256: HASH, bytes: 1 }] } },
      { ...html, scriptExecution: { ...html.scriptExecution, entry: {} } },
      { ...html, network: { ...html.network, allowPrivateNetwork: true } },
      { ...html, network: { ...html.network, approvedOrigins: ["https://example.invalid"] } },
      { ...html, network: { ...html.network, pins: [{ hostname: "example.invalid", address: "127.0.0.1", family: 4 }] } },
      { ...html, network: { ...html.network!, responsePolicy: { ...html.network!.responsePolicy, unexpected: true } } },
      { ...html, inputHashes: { ...html.inputHashes, motion: undefined } },
      { ...html, inputHashes: { ...html.inputHashes, "browser-package/surface.html": "b".repeat(64) } },
      { ...html, unexpected: true }
    ];
    for (const hybrid of htmlFailures) {
      expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, hybrid: hybrid as never } })).toBeUndefined();
    }

    const shader = restrictedHybrid();
    expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, hybrid: shader } })).toMatchObject({
      "gpu-hybrid-source-binding": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-hybrid-exact-capture-ledger": "b".repeat(64)
    });
    const shaderFailures = [
      { ...shader, shader: { ...shader.shader, language: "wgsl" } },
      { ...shader, shader: { ...shader.shader, uniformNames: ["b", "a"] } },
      { ...shader, shader: { ...shader.shader, uniformNames: ["not an identifier"] } },
      { ...shader, shader: { ...shader.shader, uniformNames: Array.from({ length: 17 }, (_, index) => `uniform${String(index).padStart(2, "0")}`) } },
      { ...shader, shader: { ...shader.shader, unexpected: true } },
      { ...shader, texture: { ...shader.texture, width: 0 } },
      { ...shader, texture: { ...shader.texture, encoding: "jpeg" } },
      { ...shader, texture: { ...shader.texture, unexpected: true } },
      { ...shader, inputHashes: { ...shader.inputHashes, "shaders/legacy.frag": "b".repeat(64) } }
    ];
    for (const hybrid of shaderFailures) {
      expect(gpuFinalReceiptInputHashes({ frameLane: "gpu", evidence: { ...base, hybrid: hybrid as never } })).toBeUndefined();
    }
  });

});

function evidence(): GpuStreamingFrameProducerEvidence {
  return {
    schema: "shellx-motion/gpu-streaming-producer@1",
    inputHashes: { "motion.json": HASH },
    immutableImageResources: [],
    frameSequenceSha256: HASH,
    framePlanSequenceSha256: HASH,
    provenance: {
      pipelineCatalog: { schema: "shellx-motion/gpu-pipeline-catalog@1", entries: [], sha256: HASH },
      staticPlan: { schema: "shellx-motion/gpu-scene-static-plan@1", fingerprint: HASH, documentFingerprint: HASH, canonicalFrameCount: 1, resourceReferencesSha256: HASH, resourceReferenceCount: 0, maxima: { canonicalFrameCount: 1, maxEnvironmentCount: 0 } as GpuSceneStaticMaxima, geometryReuse: "not-claimed" },
      staticScene: { schema: "shellx-motion/gpu-static-scene-fingerprint@1", pipelineCatalogSha256: HASH, inputHashesSha256: HASH, sha256: HASH },
      resourceBudget: gpuResourceBudget({ environmentCount: 0, environmentUniformBytes: 0 } as GpuFrameBudget)
    },
    browserVersion: "test-browser/1",
    gpu: {
      schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: HASH,
      adapter: { cdpVendorId: 1, cdpDeviceId: 1, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
      limits: { maxTextureDimension2D: 1, maxBufferSize: 1, maxStorageBufferBindingSize: 1 }
    },
    video: null,
    hybrid: null,
    typography: { authority: "manifest-font-face-browser-shaped", shaping: "canvas-2d", fallbackPolicy: "manifest-bound-required", fontProbe: "font-face-load-and-font-set-check", fontAssets: [] },
    runtimeLifecycle: { browserSession: "single-per-render", device: "persistent-per-render", pipelines: "fixed-reused" },
    readback: {
      schema: "shellx-motion/gpu-readback-transport@1",
      transport: {
        path: "webgpu-texture-map-read-cdp-base64-owned-rgba", framesObserved: 1, width: 1920, height: 1, tightBytesPerRow: 7680, mappedBytesPerRow: 7680,
        bytes: { gpuTextureToMappedReadback: 7680, cdpBase64Payload: 10_240, hostBase64Decoded: 7680 },
        allocations: { hostBase64Decode: 1, rowCompaction: 0, straightAlpha: 0 },
        rowCompaction: { tightRowFrames: 1, paddedRowFrames: 0, copiedBytes: 0, allocationCount: 0 },
        straightAlpha: { inPlaceOwnedBufferFrames: 1, copiedBytes: 0, allocationCount: 0 },
        output: { format: "rgba", colorSpace: "srgb", alphaMode: "straight", strideBytes: 7680, hashing: "sha256-tight-straight-rgba" }
      },
      timing: { observational: true, clock: "node-process-hrtime", scope: "admitted-frame-render-and-readback", framesObserved: 1, totalNanoseconds: 0, minNanoseconds: 0, maxNanoseconds: 0 }
    },
    sessionResources: {
      schema: "shellx-motion/gpu-page-session-resources@1",
      framesRendered: 1,
      frameArenaReconfigurations: 1,
      frameTextureSlots: 1,
      frameTextureBytes: 4,
      depthTextureBytes: 0,
      readbackBytes: 4,
      frameArenaBytes: 8,
      frameTextureHighWaterSlots: 1,
      frameTextureHighWaterBytes: 4,
      frameArenaHighWaterBytes: 8,
      frameArenaReservations: 1,
      frameArenaLateAllocationRefusals: 0,
      dynamicBufferSlots: 1,
      dynamicBufferBytes: 4,
      dynamicBufferHighWaterSlots: 1,
      dynamicBufferHighWaterBytes: 4,
      environmentUniformCapacitySlots: 0,
      environmentUniformBytes: 0,
      environmentUniformHighWaterSlots: 0,
      environmentUniformHighWaterBytes: 0,
      environmentUniformLateAllocationRefusals: 0,
      environmentDrawsRendered: 0,
      environmentEnvelopeReservations: 0,
      immutableImageTextures: 0,
      retainedTextSurfaces: 0,
      pointRaster: "gpu-native-instanced",
      pointPositionEvaluation: "core-cpu-exact-time",
      pointComputeField: "not-used",
      immutablePointBufferSlots: 0,
      immutablePointBufferBytes: 0,
      immutablePointMirrorBytes: 0,
      immutablePointBufferHighWaterSlots: 0,
      immutablePointBufferHighWaterBytes: 0,
      adapterPointInstanceLimit: 0,
      computeParticleBufferSlots: 0,
      computeParticleBufferBytes: 0,
      computeParticleBufferHighWaterSlots: 0,
      computeParticleBufferHighWaterBytes: 0,
      adapterComputeParticleInstanceLimit: 0,
      computeParticleDispatches: 0,
      computeParticleAbi: "not-used",
      computeParticleInstanceBytes: 0,
      computeParticleRetainedBufferCount: 0,
      computeParticleUniformBytes: 0,
      computeParticleRasterCalls: 0,
      computeParticleHeadRasterCalls: 0,
      computeParticleTrailRasterCalls: 0,
      computeParticleCapacityReconfigurations: 0,
      computeParticleLateAllocationRefusals: 0
    },
    processMonitoring: { mode: "precontained-direct-chromium", chromiumRootPid: 42, watchedRoot: "precontained-chromium-root", rssScope: "precontained-chromium-tree", measurement: "exact-precontained-chromium-root-pid", watchRegistered: true, containment: null, encoderContainmentCoversChromium: false },
    session: { state: "closed", cleanup: "complete" }
  };
}

function gpuResourceBudget(maxima: GpuFrameBudget) {
  const budget = {
    schema: "shellx-motion/gpu-resource-budget-evidence@1" as const,
    expectedFrames: 1,
    observedFrames: 1,
    maxima
  };
  return { ...budget, sha256: canonicalJsonSha256(budget) };
}

function directHybrid(): DirectHtmlHybrid {
  return {
    schema: "shellx-motion/gpu-hybrid-capture@1",
    classification: "gpu-hybrid", producer: "governed-browser-surface", browserOwnership: "borrowed-gpu-runtime",
    captureScope: "declared-browser-source-document", layerId: "surface", source: "surface.html",
    sourceDocument: { schema: "shellx-motion/gpu-hybrid-html-policy@1", policy: "strict-data-only-html", source: "surface.html", sourceSha256: HASH, byteLength: 12 } as never,
    browser: { name: "chromium", version: "test-browser/1" },
    scriptExecution: { schema: "shellx-motion/script-execution@1", detectedClass: "data-only", requestedMode: "none", activeMode: "data-only", resolverVersion: 1, sources: [] } as never,
    network: { policy: "host-approved-origins", allowPrivateNetwork: false, resolutionTimeoutMs: 1, approvedOrigins: [], pins: [], responsePolicy: { maxResponseBytes: 1, maxAggregateBytes: 1, maxConcurrentResponses: 1, contentTypes: "bounded-render-media" } } as never,
    inputHashes: { motion: HASH, html: HASH, "browser-package/surface.html": HASH }, typography: "browser-html-canvas-unverified",
    capturedFrames: 1, captureFrameSequenceSha256: HASH, exactCaptureLedgerSequenceSha256: "b".repeat(64)
  };
}

function restrictedHybrid(): RestrictedHybrid {
  return {
    schema: "shellx-motion/gpu-restricted-shader-hybrid@1",
    classification: "gpu-restricted-shader-hybrid", producer: "governed-restricted-glsl-webgl", browserOwnership: "borrowed-gpu-runtime",
    captureScope: "isolated-shader-layer-texture", layerId: "shader", source: "shaders/legacy.frag",
    shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", assetRef: "shaders/legacy.frag", sourceSha256: HASH, byteLength: 12, seed: 1, uniformNames: [], validation: "restricted-expression-only" },
    texture: { width: 16, height: 16, encoding: "png", alpha: "straight-rgba" }, browser: { name: "chromium", version: "test-browser/1" },
    scriptExecution: { schema: "shellx-motion/script-execution@1", detectedClass: "data-only", requestedMode: "none", activeMode: "data-only", resolverVersion: 1, sources: [] } as never,
    network: { policy: "host-approved-origins", allowPrivateNetwork: false, resolutionTimeoutMs: 1, approvedOrigins: [], pins: [], responsePolicy: { maxResponseBytes: 1, maxAggregateBytes: 1, maxConcurrentResponses: 1, contentTypes: "bounded-render-media" } } as never,
    inputHashes: { motion: HASH, "shaders/legacy.frag": HASH }, typography: "not-applicable-isolated-webgl",
    capturedFrames: 1, captureFrameSequenceSha256: HASH, exactCaptureLedgerSequenceSha256: "b".repeat(64)
  } as RestrictedHybrid;
}
