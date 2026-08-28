import { createHash } from "node:crypto";
import { canonicalJson, gpuSceneBehaviorFrameEvidenceSequences } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { rangeEvidence } from "./segmented-final-gpu-host-range.js";
import { assertGpuBehaviorSegmentIdentity, assertGpuBehaviorSegmentRangeProducerEvidence } from "./segmented-final-internal/render-segment-gpu-behavior-evidence.js";
import { MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES, type RenderSegmentGpuBehaviorRangeProducerEvidence } from "./segmented-final-internal/render-segment-gpu-behavior-types.js";
import type { RenderSegmentGpuIdentity } from "./segmented-final-internal/render-segment-store-types.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

describe("segmented GPU readback transport range evidence", () => {
  it("binds validated readback identity and refuses missing or forged transport evidence", () => {
    const fixture = rangeFixture();
    const admitted = rangeEvidence(fixture);
    expect(admitted.finalReceiptInputHashes["gpu-readback-transport"]).toBe(canonicalHash(fixture.producer.evidence.readback!.transport));

    expect(() => rangeEvidence({
      ...fixture,
      producer: { ...fixture.producer, evidence: { ...fixture.producer.evidence, readback: null } }
    })).toThrow("complete range evidence closure");
    expect(() => rangeEvidence({
      ...fixture,
      producer: {
        ...fixture.producer,
        evidence: {
          ...fixture.producer.evidence,
          readback: {
            ...fixture.producer.evidence.readback!,
            transport: {
              ...fixture.producer.evidence.readback!.transport,
              allocations: { ...fixture.producer.evidence.readback!.transport.allocations, hostBase64Decode: 1 }
            }
          }
        }
      }
    })).toThrow("complete range evidence closure");
  });

  it("binds one fixed environment arena for both pre-environment and active local ranges", () => {
    const preEnvironment = rangeFixture("pre-environment");
    const activeEnvironment = rangeFixture("active-environment");
    const preEvidence = rangeEvidence(preEnvironment);
    const activeEvidence = rangeEvidence(activeEnvironment);
    expect(preEvidence.environmentArena).toMatchObject({ environmentDrawsRendered: 0, resourceBudget: { maxEnvironmentDrawsPerFrame: 0 } });
    expect(preEvidence.finalReceiptInputHashes["gpu-environment-arena"]).toBe(canonicalHash(preEvidence.environmentArena));
    expect(activeEvidence.environmentArena).toMatchObject({ environmentDrawsRendered: 16, resourceBudget: { maxEnvironmentDrawsPerFrame: 8 } });
    expect(activeEvidence.finalReceiptInputHashes["gpu-environment-arena"]).toBe(canonicalHash(activeEvidence.environmentArena));

    expect(() => rangeEvidence({
      ...activeEnvironment,
      producer: {
        ...activeEnvironment.producer,
        evidence: {
          ...activeEnvironment.producer.evidence,
          sessionResources: { ...activeEnvironment.producer.evidence.sessionResources, environmentDrawsRendered: 1 }
        }
      } as unknown as import("@shellx-motion/renderer-browser").GpuStreamingFrameProducer
    })).toThrow("complete range evidence closure");
  });

  it("refuses dynamic texture counters on a range without an immutable hybrid identity", () => {
    const fixture = rangeFixture();
    expect(() => rangeEvidence({
      ...fixture,
      producer: {
        ...fixture.producer,
        evidence: {
          ...fixture.producer.evidence,
          sessionResources: {
            ...fixture.producer.evidence.sessionResources,
            dynamicImageTextureSlots: 1,
            dynamicImageTextureBytes: 16,
            dynamicImageTextureHighWaterSlots: 1,
            dynamicImageTextureHighWaterBytes: 16,
            dynamicImageTextureWrites: 2,
            dynamicImageTextureReplacements: 2,
            dynamicImageTextureLateRefusals: 0,
            dynamicImageTextureDestructions: 0
          }
        }
      } as unknown as import("@shellx-motion/renderer-browser").GpuStreamingFrameProducer
    })).toThrow("unclaimed dynamic texture reservation");
  });

  it("uses a distinct behavior range identity and binds ordered Core frame and budget sequences", () => {
    const fixture = rangeFixture();
    const frames = [
      { index: 0, atMs: 0, atUs: 0, fingerprint: hash("behavior-frame-0"), budgetSha256: hash("behavior-budget-0") },
      { index: 1, atMs: 500, atUs: 500_000, fingerprint: hash("behavior-frame-1"), budgetSha256: hash("behavior-budget-1") }
    ];
    const sequences = gpuSceneBehaviorFrameEvidenceSequences(frames);
    const behaviors = {
      staticFingerprint: hash("behavior-static"), baseStaticFingerprint: fixture.identity.staticPlan.fingerprint,
      behaviorStaticFingerprint: hash("behavior-plan"), behaviorSourceSha256: hash("behavior-source"), targetLayerIds: ["shape"],
      staticBudget: { baseResourceReferenceCount: 0, behaviorInputBytes: 80, bindingCount: 1, enabledBindingCount: 1, behaviorFrameWorkUnits: 8 },
      frames, ...sequences
    };
    const identity: RenderSegmentGpuIdentity = { ...fixture.identity, schema: "shellx-motion/gpu-behavior-segmented-identity@1", behaviors };
    const producer = {
      ...fixture.producer,
      evidence: {
        ...fixture.producer.evidence,
        behaviors: { schema: "shellx-motion/gpu-scene-behavior-streaming@1", ...behaviors }
      }
    } as unknown as import("@shellx-motion/renderer-browser").GpuStreamingFrameProducer;
    const admitted = rangeEvidence({ ...fixture, producer, identity });
    const behaviorAdmitted = admitted as RenderSegmentGpuBehaviorRangeProducerEvidence;
    expect(admitted).toMatchObject({
      schema: "shellx-motion/gpu-behavior-segment-range-producer@1",
      behaviors: { framePlanSequenceSha256: sequences.framePlanSequenceSha256, frameBudgetSequenceSha256: sequences.frameBudgetSequenceSha256 },
      finalReceiptInputHashes: { "gpu-behavior-static-plan": hash("behavior-static"), "gpu-behavior-frame-budget-sequence": sequences.frameBudgetSequenceSha256 }
    });
    expect(behaviorAdmitted.identity.behaviors).not.toHaveProperty("frames");
    const resume = (value: unknown) => assertGpuBehaviorSegmentRangeProducerEvidence({
      value, identity: identity as Extract<RenderSegmentGpuIdentity, { schema: "shellx-motion/gpu-behavior-segmented-identity@1" }>,
      packageFacts: { id: "behavior", manifestSha256: hash("manifest"), contentSha256: identity.packageContentSha256 },
      range: { index: 0, startFrame: 0, endFrameExclusive: 2, frameCount: 2 },
      timeline: { motionSha256: hash("motion"), durationMs: 1_000, fps: 2, width: 4, height: 2 }, frameHashes: fixture.producer.rangeEvidence!.frameHashes
    });
    expect(() => resume(behaviorAdmitted)).not.toThrow();
    expect(() => rangeEvidence({
      ...fixture,
      producer: { ...producer, evidence: { ...producer.evidence, behaviors: { ...producer.evidence.behaviors!, behaviorSourceSha256: hash("substituted") } } },
      identity
    })).toThrow("immutable Core behavior schedule");
    const substitutedFrames = [{ ...frames[0]!, fingerprint: hash("substituted-frame") }, frames[1]!];
    const substitutedSequences = gpuSceneBehaviorFrameEvidenceSequences(substitutedFrames);
    expect(() => rangeEvidence({
      ...fixture,
      producer: { ...producer, evidence: { ...producer.evidence, behaviors: { ...producer.evidence.behaviors!, frames: substitutedFrames, ...substitutedSequences } } },
      identity
    })).toThrow("immutable Core behavior schedule");
    expect(() => resume({ ...behaviorAdmitted, behaviors: { ...behaviorAdmitted.behaviors, frames: substitutedFrames, ...substitutedSequences }, finalReceiptInputHashes: { ...behaviorAdmitted.finalReceiptInputHashes, "gpu-behavior-frame-plan-sequence": substitutedSequences.framePlanSequenceSha256, "gpu-behavior-frame-budget-sequence": substitutedSequences.frameBudgetSequenceSha256 } })).toThrow("schedule slice");
    expect(() => resume({ ...behaviorAdmitted, behaviors: { ...behaviorAdmitted.behaviors, framePlanSequenceSha256: hash("forged-digest") }, finalReceiptInputHashes: { ...behaviorAdmitted.finalReceiptInputHashes, "gpu-behavior-frame-plan-sequence": hash("forged-digest") } })).toThrow("ordered plan or budget digest");
    expect(() => resume({ ...behaviorAdmitted, finalReceiptInputHashes: { ...behaviorAdmitted.finalReceiptInputHashes, "gpu-behavior-source": hash("forged-receipt") } })).toThrow("receipt hashes");
  });

  it("refuses a standalone behavior identity above its 16,000-frame durable schedule ceiling", () => {
    const fixture = rangeFixture();
    const frameCount = MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES + 1;
    const frames = Array.from({ length: frameCount }, (_, index) => ({
      index, atMs: index, atUs: index * 1_000, fingerprint: hash(`behavior-frame-${index}`), budgetSha256: hash(`behavior-budget-${index}`)
    }));
    const sequences = gpuSceneBehaviorFrameEvidenceSequences(frames);
    const identity = {
      ...fixture.identity,
      schema: "shellx-motion/gpu-behavior-segmented-identity@1" as const,
      staticPlan: { ...fixture.identity.staticPlan, canonicalFrameCount: frameCount },
      behaviors: {
        staticFingerprint: hash("behavior-static"), baseStaticFingerprint: fixture.identity.staticPlan.fingerprint,
        behaviorStaticFingerprint: hash("behavior-plan"), behaviorSourceSha256: hash("behavior-source"), targetLayerIds: ["shape"],
        staticBudget: { baseResourceReferenceCount: 0, behaviorInputBytes: 80, bindingCount: 1, enabledBindingCount: 1, behaviorFrameWorkUnits: 8 },
        frames, ...sequences
      }
    };
    expect(() => assertGpuBehaviorSegmentIdentity(identity, {
      id: "behavior", manifestSha256: hash("manifest"), contentSha256: identity.packageContentSha256
    }, frameCount)).toThrow(`more than ${MAX_GPU_BEHAVIOR_SEGMENTED_FRAMES}`);
  });
});

function rangeFixture(environment: "none" | "pre-environment" | "active-environment" = "none") {
  const environmentPlan = environment !== "none";
  const environmentWork = environment === "active-environment";
  const range = { index: 0, startFrameIndex: 0, endFrameIndexExclusive: 2 };
  const timeline = { motionSha256: hash("motion"), frameCount: 2, durationMs: 1_000, fps: 2, width: 4, height: 2 };
  const containment = { mode: "unix-process-group" as const, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: 512 * 1024 * 1024 };
  const gpu = { schema: "shellx-motion/gpu-runtime-evidence@1", adapterFingerprint: hash("adapter"), browserSource: "path" };
  const identity: RenderSegmentGpuIdentity = {
    schema: "shellx-motion/gpu-segmented-identity@1",
    packageContentSha256: hash("package"),
    pipelineCatalogSha256: hash("catalog"),
    staticPlan: { fingerprint: hash("plan"), documentFingerprint: hash("document"), resourceReferencesSha256: hash("resources"), canonicalFrameCount: 2, maxEnvironmentCount: environmentPlan ? 1 : 0 },
    staticScene: { sha256: hash("scene"), inputHashesSha256: hash("scene-inputs") },
    hostVerdict: {
      schema: "shellx-motion/gpu-segmented-host-verdict@1",
      platform: "linux",
      browser: { source: "path", executableSha256: hash("browser"), version: "test-browser/1" },
      launchProfileSha256: hash("launch"),
      runtimeEvidenceSha256: canonicalHash(gpu),
      adapterFingerprint: gpu.adapterFingerprint,
      containment,
      session: { purpose: "pre-store-identity", emittedFrames: 0, cleanup: "complete" }
    }
  };
  const readback = {
    schema: "shellx-motion/gpu-readback-transport@1" as const,
    transport: {
      path: "webgpu-texture-map-read-cdp-base64-owned-rgba" as const,
      framesObserved: 2,
      width: 4,
      height: 2,
      tightBytesPerRow: 16,
      mappedBytesPerRow: 256,
      bytes: { gpuTextureToMappedReadback: 1_024, cdpBase64Payload: 1_368, hostBase64Decoded: 1_024 },
      allocations: { hostBase64Decode: 2, rowCompaction: 2, straightAlpha: 0 as const },
      rowCompaction: { tightRowFrames: 0, paddedRowFrames: 2, copiedBytes: 64, allocationCount: 2 },
      straightAlpha: { inPlaceOwnedBufferFrames: 2, copiedBytes: 0 as const, allocationCount: 0 as const },
      output: { format: "rgba" as const, colorSpace: "srgb" as const, alphaMode: "straight" as const, strideBytes: 16, hashing: "sha256-tight-straight-rgba" as const }
    },
    timing: { observational: true as const, clock: "node-process-hrtime" as const, scope: "admitted-frame-render-and-readback" as const, framesObserved: 2, totalNanoseconds: 0, minNanoseconds: 0, maxNanoseconds: 0 }
  };
  const frameHashes = [hash("frame-0"), hash("frame-1")];
  const framePlanFingerprints = [hash("plan-0"), hash("plan-1")];
  return {
    producer: {
      rangeEvidence: { frameHashes, framePlanFingerprints },
      evidence: {
        session: { state: "closed" as const, cleanup: "complete" as const },
        gpu,
        browserVersion: "test-browser/1",
        provenance: {
          staticPlan: { schema: "shellx-motion/gpu-scene-static-plan@1", fingerprint: identity.staticPlan.fingerprint, documentFingerprint: identity.staticPlan.documentFingerprint, canonicalFrameCount: 2, resourceReferencesSha256: identity.staticPlan.resourceReferencesSha256, resourceReferenceCount: 0, maxima: { canonicalFrameCount: 2, maxEnvironmentCount: environmentPlan ? 1 : 0 }, geometryReuse: "not-claimed" },
          staticScene: { sha256: identity.staticScene.sha256, inputHashesSha256: identity.staticScene.inputHashesSha256 },
          resourceBudget: gpuResourceBudget(2, environmentWork ? 8 : 0)
        },
        sessionResources: {
          schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 2,
          frameArenaReconfigurations: 1, frameArenaReservations: 2, frameArenaLateAllocationRefusals: 0, frameArenaBytes: 8, frameArenaHighWaterBytes: 8,
          environmentUniformCapacitySlots: environmentPlan ? 36 : 0, environmentUniformBytes: environmentPlan ? 9_216 : 0, environmentUniformHighWaterSlots: environmentPlan ? 36 : 0, environmentUniformHighWaterBytes: environmentPlan ? 9_216 : 0,
          environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: environmentWork ? 16 : 0, environmentEnvelopeReservations: environmentPlan ? 1 : 0
        },
        processMonitoring: { containment },
        readback
      }
    } as unknown as import("@shellx-motion/renderer-browser").GpuStreamingFrameProducer,
    range,
    timeline,
    identity
  };
}

function gpuResourceBudget(frameCount: number, environmentCount: number) {
  const budget = {
    schema: "shellx-motion/gpu-resource-budget-evidence@1" as const,
    expectedFrames: frameCount,
    observedFrames: frameCount,
    maxima: { environmentCount, environmentUniformBytes: environmentCount * 208 }
  };
  return { ...budget, sha256: canonicalHash(budget) };
}
