import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonSha256,
  type MotionDocument,
  type MotionPackage
} from "@shellx-motion/core";
import {
  createGpuStreamingFrameProducer,
  prepareGpuSceneResources,
  resolveGpuEffectModuleStaticPlanForUse,
  type GpuEffectModuleBeginUseLease,
  type GpuStreamingFrameProducerInput,
  type GpuEffectModuleUseAuthority
} from "@shellx-motion/renderer-browser";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "@shellx-motion/renderer-browser/internal/effect-modules";
import { afterEach, describe, expect, it } from "vitest";
import { beginGpuEffectModuleRangeLease, produceReleasedGpuEffectModuleRange } from "./segmented-final-gpu-effect-module-range.js";
import { assertSegmentProducerConsistency } from "./segmented-final-internal/render-segment-producer-evidence.js";
import { planFingerprint, renderSegmentStoreSchema } from "./segmented-final-internal/render-segment-store-identity.js";

const roots: string[] = [];
const HASH = "a".repeat(64);
const frameSink = { async write() {} } as never;
type GpuOpenRuntime = NonNullable<GpuStreamingFrameProducerInput["openRuntime"]>;

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("segmented GPU effect-module lease boundary", () => {
  it("rechecks a queued resolution at fresh range admission, rejects foreign authority, and never reuses a replay lease", async () => {
    const installed = await installedAuthority();
    const resolved = await resolution(installed.authority, singleModuleDocument());
    const first = await beginGpuEffectModuleRangeLease(true, { authority: installed.authority, resolution: resolved });
    const replay = await beginGpuEffectModuleRangeLease(true, { authority: installed.authority, resolution: resolved });
    expect(first).toBeDefined();
    expect(replay).toBeDefined();
    expect(first).not.toBe(replay);
    await first!.release();
    await replay!.release();

    const foreign = await installedAuthority();
    await expect(beginGpuEffectModuleRangeLease(true, { authority: foreign.authority, resolution: resolved })).rejects.toThrow("not trusted");
    await installed.registry.revoke("motion.afterimage-stack", "1.0.0");
    await expect(beginGpuEffectModuleRangeLease(true, { authority: installed.authority, resolution: resolved })).rejects.toThrow(/revoked|unavailable/i);
  });

  it("releases a range lease only after producer cleanup and refuses durable evidence when cleanup or release fails", async () => {
    const installed = await installedAuthority();
    const active = await activeProducer(installed, singleModuleDocument(), 0);
    const events: string[] = [];
    const complete = await produceReleasedGpuEffectModuleRange({
      producer: observedProducer(active.producer, events), sink: frameSink, job: admittedJob(installed.root), lease: active.lease
    });
    expect(events).toEqual(["produce"]);
    expect(complete.released).toMatchObject({ release: "released", applications: [expect.objectContaining({ release: "released" })] });
    await expect(active.lease.release()).resolves.toEqual({ released: false });

    const failed = await freshLease(installed.authority, singleModuleDocument());
    await expect(produceReleasedGpuEffectModuleRange({
      producer: { async produce() { throw new Error("producer cleanup failure"); } } as never, sink: frameSink, job: admittedJob(installed.root), lease: failed
    })).rejects.toThrow("producer cleanup failure");
    await expect(failed.release()).resolves.toEqual({ released: false });

    const released = await activeProducer(installed, singleModuleDocument(), 0);
    await released.lease.release();
    await expect(produceReleasedGpuEffectModuleRange({
      producer: released.producer, sink: frameSink, job: admittedJob(installed.root), lease: released.lease
    })).rejects.toThrow(/lease cleanup|effect-module lease/i);
  });

  it("keeps non-overlapping A-to-B applications on separate fresh range leases", async () => {
    const installed = await installedAuthority();
    const motion = sequentialModuleDocument();
    const a = await activeProducer(installed, motion, 0);
    const b = await activeProducer(installed, motion, 1);
    const aUse = await produceReleasedGpuEffectModuleRange({ producer: a.producer, sink: frameSink, job: admittedJob(installed.root), lease: a.lease });
    const bUse = await produceReleasedGpuEffectModuleRange({ producer: b.producer, sink: frameSink, job: admittedJob(installed.root), lease: b.lease });
    expect(aUse.released.applications.map((entry) => entry.layerId)).toEqual(["afterimage-a"]);
    expect(bUse.released.applications.map((entry) => entry.layerId)).toEqual(["afterimage-b"]);
    expect(aUse.released.beginUse.modules.map((entry) => entry.registryGeneration)).toEqual(bUse.released.beginUse.modules.map((entry) => entry.registryGeneration));
  });

  it("releases a module-bearing zero-active range without manufacturing a pass or ledger application", async () => {
    const installed = await installedAuthority();
    const inactive = await activeProducer(installed, lateModuleDocument(), 0);
    const use = await produceReleasedGpuEffectModuleRange({ producer: inactive.producer, sink: frameSink, job: admittedJob(installed.root), lease: inactive.lease });
    expect(inactive.staticPlan.effectModules).toHaveLength(1);
    expect(use.pending.resources).toEqual({ live: null, terminal: null });
    expect(use.released.applications).toEqual([]);
  });

  it("refuses a substituted but valid descriptor sequence against the immutable admitted identity", async () => {
    const installed = await installedAuthority();
    const expected = await activeProducer(installed, singleModuleDocument(), 0);
    const changed = await activeProducer(installed, singleModuleDocument(12_000), 0);
    const expectedProducer = { frameLane: "gpu", identity: effectIdentity(expected.staticPlan.effectModules!) } as never;
    const substituted = { frameLane: "gpu", identity: effectIdentity(changed.staticPlan.effectModules!) } as never;
    expect(() => assertSegmentProducerConsistency(expectedProducer, substituted)).toThrow("immutable GPU identity");
    await expected.lease.release();
    await changed.lease.release();
  });

  it("retains the exact legacy no-module store schema and plan fingerprint wire", () => {
    const producer = { frameLane: "gpu" as const, identity: { schema: "shellx-motion/gpu-segmented-identity@1", marker: "legacy" } } as never;
    const input = {
      plan: { schema: "shellx-motion/render-segment-plan@1" as const, frameCount: 1, segmentFrames: 1, segmentCount: 1, ranges: [{ index: 0, startFrame: 0, endFrameExclusive: 1, frameCount: 1 }] },
      package: { id: "legacy", manifestSha256: HASH, contentSha256: HASH }, frameLane: "gpu" as const, producer,
      timeline: { motionSha256: HASH, durationMs: 1_000, fps: 1, width: 1, height: 1 }, intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" }
    };
    expect(renderSegmentStoreSchema(input.frameLane, producer)).toBe("shellx-motion/gpu-render-segment-store@1");
    expect(planFingerprint(input)).toBe(canonicalJsonSha256({ schema: "shellx-motion/gpu-render-segment-store@1", ...input }));
  });
});

async function freshLease(authority: GpuEffectModuleUseAuthority, motion: MotionDocument): Promise<GpuEffectModuleBeginUseLease> {
  return await authority.beginUse(await resolution(authority, motion));
}

async function activeProducer(installed: Awaited<ReturnType<typeof installedAuthority>>, motion: MotionDocument, rangeIndex: number) {
  const pkg: MotionPackage = { root: installed.root, manifest: { schema: "shellx-motion/package-manifest@1", id: "segmented-effect", name: "Segmented effect", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion };
  const resolved = await resolveGpuEffectModuleStaticPlanForUse(motion, installed.authority);
  if (!resolved.ok || !resolved.resolution) throw new Error("Expected module static resolution.");
  const lease = await installed.authority.beginUse(resolved.resolution);
  const resources = await prepareGpuSceneResources(pkg, resolved.plan.resources);
  const producer = createGpuStreamingFrameProducer({
    pkg, staticPlan: resolved.plan, resources, effectModuleLease: lease, openRuntime: effectRuntime(),
    range: { index: rangeIndex, startFrameIndex: rangeIndex, endFrameIndexExclusive: rangeIndex + 1 }
  });
  return { lease, producer, staticPlan: resolved.plan };
}

function observedProducer(producer: ReturnType<typeof createGpuStreamingFrameProducer>, events: string[]) {
  return { get evidence() { return producer.evidence; }, async produce(sink: typeof frameSink, job: ReturnType<typeof admittedJob>) { events.push("produce"); await producer.produce(sink, job); } } as never;
}

function admittedJob(root: string) {
  return { admission: "pre-acquired" as const, signal: new AbortController().signal, scratchRoot: root, maxProcessTreeRssBytes: 512 * 1024 * 1024, watchProcess() {} };
}

function effectRuntime(): GpuOpenRuntime {
  return async (_images, _fonts, options) => {
    let applications = 0, closed = false;
    return { ok: true as const, session: {
      browserProcess: { pid: 9_003, launcher: "precontained-direct-chromium" as const, containment: { rootPid: 9_003, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes } },
      async uploadImages(images: readonly unknown[]) { return { ok: true as const, uploaded: images.length }; },
      async render(plan: { width: number; height: number; draws: readonly { kind: string }[] }) { if (plan.draws.some((draw) => draw.kind === "effectModule")) applications += 1; const rgba = Buffer.alloc(plan.width * plan.height * 4, 255); return { ok: true as const, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: plan.width, height: plan.height, evidence: runtimeEvidence(), readback: readback(plan.width, plan.height) } }; },
      async resourceMetrics() { return metrics(applications, closed); },
      async close() { closed = true; }
    } };
  };
}

function runtimeEvidence() { return { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 1, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } } as const; }
function readback(width: number, height: number) { const row = Math.ceil((width * 4) / 256) * 256, bytes = row * height; return { schema: "shellx-motion/gpu-readback-frame@1", width, height, tightBytesPerRow: width * 4, mappedBytesPerRow: row, gpuTextureToMappedReadbackBytes: bytes, cdpBase64PayloadBytes: Math.ceil(bytes / 3) * 4, hostBase64DecodedBytes: bytes, allocations: { hostBase64Decode: 1, rowCompaction: row === width * 4 ? 0 : 1, straightAlpha: 0 }, copiedBytes: { rowCompaction: row === width * 4 ? 0 : width * height * 4, straightAlpha: 0 }, rowCompaction: row === width * 4 ? "bypassed-tight-stride" : "copied-padded-rows", straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0, hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback" } as const; }
function metrics(applications: number, closed: boolean) { return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8, frameArenaReservations: 1, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0, immutableImageTextures: 0, retainedTextSurfaces: 0, pointRaster: "gpu-native-instanced", pointPositionEvaluation: "core-cpu-exact-time", pointComputeField: "not-used", immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0, computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0, computeParticleDispatches: 0, computeParticleAbi: "not-used", computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0, computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0, ...(applications === 0 ? {} : closed ? { afterimageStackUniformBufferSlots: 0, afterimageStackUniformBytes: 0, afterimageStackBindGroupSlots: 0, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0, afterimageStackPipelineReleases: 1, afterimageStackPreparedBindGroupReleases: 1, afterimageStackArenaUniformBufferDestructions: 1 } : { afterimageStackUniformBufferSlots: 1, afterimageStackUniformBytes: 160, afterimageStackBindGroupSlots: 1, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0 }) } as never; }

async function resolution(authority: GpuEffectModuleUseAuthority, motion: MotionDocument) {
  const resolved = await resolveGpuEffectModuleStaticPlanForUse(motion, authority);
  if (!resolved.ok || !resolved.resolution) throw new Error("Expected module static resolution.");
  return resolved.resolution;
}

async function installedAuthority() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-segment-effect-")); roots.push(root);
  const stateRoot = join(root, "effect-modules"), source = join(root, "afterimage.json");
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(source, `${JSON.stringify({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack", intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1" })}\n`);
  const registry = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async (path) => { const bytes = await readFile(path); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; } });
  const pending = await registry.prepareInstallFromManifestFile(source); await registry.confirmInstall(pending.confirmationId);
  return { root, registry, authority: createEffectModuleRegistryUseAuthority(registry) };
}

function singleModuleDocument(amountQ16 = 32_768): MotionDocument {
  return moduleDocument([{ id: "scope", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["plate", "afterimage"] }, { id: "plate", type: "shape", startMs: 0, durationMs: 1_000, shape: "rect", fill: "#ffffffff", width: 16, height: 16 }, moduleLayer("afterimage", 0, 1_000, amountQ16)]);
}

function sequentialModuleDocument(): MotionDocument {
  return moduleDocument([
    { id: "scope-a", type: "group", startMs: 0, durationMs: 500, childLayerIds: ["plate-a", "afterimage-a"] }, { id: "plate-a", type: "shape", startMs: 0, durationMs: 500, shape: "rect", fill: "#ffffffff", width: 16, height: 16 }, moduleLayer("afterimage-a", 0, 500),
    { id: "scope-b", type: "group", startMs: 500, durationMs: 500, childLayerIds: ["plate-b", "afterimage-b"] }, { id: "plate-b", type: "shape", startMs: 0, durationMs: 500, shape: "rect", fill: "#ffffffff", width: 16, height: 16 }, moduleLayer("afterimage-b", 0, 500)
  ]);
}

function lateModuleDocument(): MotionDocument {
  return moduleDocument([
    { id: "scope", type: "group", startMs: 500, durationMs: 500, childLayerIds: ["plate", "afterimage"] },
    { id: "plate", type: "shape", startMs: 0, durationMs: 500, shape: "rect", fill: "#ffffffff", width: 16, height: 16 }, moduleLayer("afterimage", 0, 500)
  ]);
}

function moduleDocument(layers: MotionDocument["layers"]): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "segmented-effect", name: "Segmented effect", durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers };
}

function moduleLayer(id: string, startMs: number, durationMs: number, amountQ16 = 32_768): MotionDocument["layers"][number] {
  return { id, type: "adjustment", startMs, durationMs, effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { amountQ16, echoes: [{ dxPx: -2, dyPx: 3, color: "#FF80C0C0", opacityQ16: 48_000 }] } } };
}

function effectIdentity(descriptors: readonly unknown[]) {
  return { schema: "shellx-motion/gpu-effect-module-segmented-identity@1", effectModules: { descriptors } };
}
