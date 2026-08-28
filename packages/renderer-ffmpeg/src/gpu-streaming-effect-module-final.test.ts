import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MotionPackage } from "@shellx-motion/core";
import {
  gpuEffectModuleFinalReceiptEvidence,
  prepareGpuSceneResources,
  resolveGpuEffectModuleStaticPlanForUse,
  type GpuStreamingFrameProducerInput
} from "@shellx-motion/renderer-browser";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "@shellx-motion/renderer-browser/internal/effect-modules";
import { afterEach, describe, expect, it } from "vitest";
import { gpuFinalEffectModuleReceiptInputHashes } from "./gpu-final-effect-module-evidence.js";
import { admittedGpuPreflight, type GpuEffectModuleReleaseState } from "./streaming-final-adapter-execution.js";
import { gpuStreamingProducer } from "./streaming-final-gpu.js";
import type { RenderStreamingFinalInput, StreamingFinalProducerEvidence } from "./streaming-final-adapter-types.js";

const roots: string[] = [];
type GpuOpenRuntime = NonNullable<GpuStreamingFrameProducerInput["openRuntime"]>;

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("direct GPU effect-module streaming boundary", () => {
  it("passes an opaque installed lease to Browser, then projects only released receipt evidence", async () => {
    const installed = await installedAuthority();
    const pkg = effectPackage(installed.root);
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, installed.authority);
    expect(resolved).toMatchObject({ ok: true, plan: { effectModules: [expect.any(Object)] } });
    if (!resolved.ok || !resolved.resolution) return;
    const effectModuleRelease: GpuEffectModuleReleaseState = { complete: false, failed: false };
    let observed: StreamingFinalProducerEvidence | undefined;
    const input: RenderStreamingFinalInput = {
      pkg, frameLane: "gpu", outputPath: join(installed.root, "unpublished.mp4"),
      toolPolicy: { gpu: { openRuntime: async (...args) => {
        expect(effectModuleRelease.lease).toBeDefined();
        return await effectRuntime()(...args);
      } } }
    };
    const admitted = admittedGpuPreflight(
      input, resolved.plan, undefined, input.toolPolicy,
      { authority: installed.authority, resolution: resolved.resolution }, effectModuleRelease,
      () => {}, (evidence) => { observed = evidence; }, () => {}
    );
    const prepared = await admitted(admittedContext(installed.root));
    const frames: number[] = [];
    await prepared.produce({ write: async (frame) => { frames.push(frame.index); } }, admittedContext(installed.root));
    expect(frames).toEqual([0]);
    expect(effectModuleRelease.lease).toBeDefined();
    const evidence = observed?.frameLane === "gpu" ? observed.evidence : undefined;
    if (!evidence?.effectModules) throw new Error("Expected Browser GPU effect-module producer evidence.");
    expect(evidence.effectModules).toMatchObject({ runtimeCleanup: "complete", resources: { live: { uniformBytes: 160 }, terminal: { uniformBytes: 0 } } });
    await prepared.release();
    expect(effectModuleRelease).toMatchObject({ complete: true, failed: false });
    const released = gpuEffectModuleFinalReceiptEvidence(effectModuleRelease.lease!, evidence.effectModules!.ledger);
    expect(released).toMatchObject({ schema: "shellx-motion/gpu-effect-module-final-use@1", release: "released", applications: [expect.objectContaining({ release: "released" })] });
    expect(gpuFinalEffectModuleReceiptInputHashes(observed!, released)).toMatchObject({
      "gpu-effect-module-catalog": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-begin-use": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-applications": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-cleanup": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    await installed.registry.close();
  });

  it("refuses fake and released leases before a Browser runtime opens", async () => {
    const installed = await installedAuthority();
    const pkg = effectPackage(installed.root);
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, installed.authority);
    if (!resolved.ok || !resolved.resolution) return;
    const resources = await prepareGpuSceneResources(pkg, resolved.plan.resources);
    const fakeLease = { async release() { return { released: true }; } } as never;
    const releasedLease = await installed.authority.beginUse(resolved.resolution);
    await releasedLease.release();
    for (const lease of [fakeLease, releasedLease]) {
      let opens = 0;
      const producer = gpuStreamingProducer({
        pkg, frameLane: "gpu", outputPath: join(installed.root, "unpublished.mp4"),
        toolPolicy: { gpu: { openRuntime: async (...args) => { opens += 1; return await effectRuntime()(...args); } } }
      }, () => {}, () => {}, resolved.plan, resources, undefined, lease);
      await expect(producer({ write: async () => {} }, admittedContext(installed.root))).rejects.toThrow("effect-module lease");
      expect(opens).toBe(0);
    }
    await installed.registry.close();
  });

  it("refuses a revoke that occurred while the outer admission was queued, before runtime open", async () => {
    const installed = await installedAuthority();
    const pkg = effectPackage(installed.root);
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, installed.authority);
    if (!resolved.ok || !resolved.resolution) return;
    let opens = 0;
    const effectModuleRelease: GpuEffectModuleReleaseState = { complete: false, failed: false };
    const queuedAdmission = admittedGpuPreflight(
      { pkg, frameLane: "gpu", outputPath: join(installed.root, "unpublished.mp4"), toolPolicy: { gpu: { openRuntime: async (...args) => { opens += 1; return await effectRuntime()(...args); } } } },
      resolved.plan, undefined, undefined,
      { authority: installed.authority, resolution: resolved.resolution }, effectModuleRelease,
      () => {}, () => {}, () => {}
    );
    await installed.registry.revoke("motion.afterimage-stack", "1.0.0");
    await expect(queuedAdmission(admittedContext(installed.root))).rejects.toThrow(/revoked|unavailable/i);
    expect(opens).toBe(0);
    expect(effectModuleRelease).toMatchObject({ complete: true, failed: false });
    await installed.registry.close();
  });

  it("retains a governed descriptor with zero canonical applications as explicit null resource evidence", async () => {
    const installed = await installedAuthority();
    const pkg = effectPackage(installed.root, false, true);
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, installed.authority);
    if (!resolved.ok) throw new Error(resolved.failure.message);
    expect(resolved).toMatchObject({ plan: { effectModules: [expect.any(Object)], canonicalFrameCount: 1 } });
    if (!resolved.resolution) return;
    const lease = await installed.authority.beginUse(resolved.resolution);
    const resources = await prepareGpuSceneResources(pkg, resolved.plan.resources);
    let observed: StreamingFinalProducerEvidence | undefined;
    const producer = gpuStreamingProducer(
      { pkg, frameLane: "gpu", outputPath: join(installed.root, "zero-application.mp4"), toolPolicy: { gpu: { openRuntime: effectRuntime() } } },
      (evidence) => { observed = { frameLane: "gpu", evidence }; }, () => {}, resolved.plan, resources, undefined, lease
    );
    await producer({ write: async () => {} }, admittedContext(installed.root));
    const evidence = observed?.frameLane === "gpu" ? observed.evidence : undefined;
    if (!evidence?.effectModules) throw new Error("Expected zero-application module evidence.");
    expect(evidence.effectModules).toMatchObject({ resources: { live: null, terminal: null }, ledger: { applications: [] } });
    await lease.release();
    const released = gpuEffectModuleFinalReceiptEvidence(lease, evidence.effectModules.ledger);
    expect(released.applications).toEqual([]);
    expect(gpuFinalEffectModuleReceiptInputHashes(observed!, released)).toMatchObject({
      "gpu-effect-module-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-cleanup": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    await installed.registry.close();
  });

  it("releases its installed lease when post-admission resource setup fails", async () => {
    const installed = await installedAuthority();
    const pkg = effectPackage(installed.root, true);
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, installed.authority);
    if (!resolved.ok || !resolved.resolution) return;
    const effectModuleRelease: GpuEffectModuleReleaseState = { complete: false, failed: false };
    const admitted = admittedGpuPreflight(
      { pkg, frameLane: "gpu", outputPath: join(installed.root, "unpublished.mp4") },
      resolved.plan, undefined, undefined,
      { authority: installed.authority, resolution: resolved.resolution }, effectModuleRelease,
      () => {}, () => {}, () => {}
    );
    await expect(admitted(admittedContext(installed.root))).rejects.toThrow(/GPU image asset/i);
    expect(effectModuleRelease).toMatchObject({ complete: true, failed: false, lease: expect.any(Object) });
    await expect(effectModuleRelease.lease!.release()).resolves.toEqual({ released: false });
    await installed.registry.close();
  });
});

function admittedContext(root: string) {
  const signal = new AbortController().signal;
  const job = { admission: "pre-acquired" as const, jobId: "effect-module-test", scratchRoot: root, maxProcessTreeRssBytes: 512 * 1024 * 1024, signal, watchProcess() {}, reportSandbox() {} };
  return { signal, attempt: {}, job, runAdmitted: async <T>(work: (current: typeof job) => Promise<T>) => await work(job) } as never;
}

async function installedAuthority() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-direct-effect-")); roots.push(root);
  const stateRoot = join(root, "effect-modules"); const source = join(root, "afterimage.json");
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(source, `${JSON.stringify({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack", intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1" })}\n`);
  const registry = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async (path) => {
    const bytes = await readFile(path); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } });
  const pending = await registry.prepareInstallFromManifestFile(source); await registry.confirmInstall(pending.confirmationId);
  return { root, registry, authority: createEffectModuleRegistryUseAuthority(registry) };
}

function effectPackage(root: string, missingImage = false, inactiveModule = false): MotionPackage {
  const missingLayer = missingImage ? [{ id: "missing", type: "image" as const, assetRef: "assets/missing.png", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }] : [];
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "direct-effect", name: "direct", motion: "motion.json", assets: missingImage ? ["assets/missing.png"] : [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: {
    schema: "shellx-motion/motion@1", id: "direct-effect", name: "direct", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
      { id: "scope", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["plate", "afterimage", ...(missingImage ? ["missing"] : [])] },
      { id: "plate", type: "shape", shape: "rect", fill: "#4080ffff", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } },
      { id: "afterimage", type: "adjustment", startMs: inactiveModule ? 1 : 0, durationMs: inactiveModule ? 999 : 1_000, effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { amountQ16: 32_768, echoes: [{ dxPx: -2, dyPx: 3, color: "#FF80C0C0", opacityQ16: 48_000 }] } } },
      ...missingLayer
    ]
  } };
}

function effectRuntime(): GpuOpenRuntime {
  return async (_images, _fonts, options) => {
    let applications = 0, closed = false;
    return { ok: true as const, session: {
      browserProcess: { pid: 9_003, launcher: "precontained-direct-chromium" as const, containment: { rootPid: 9_003, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes } },
      async uploadImages(images: readonly unknown[]) { return { ok: true as const, uploaded: images.length }; },
      async render(plan: { width: number; height: number; draws: readonly { kind: string }[] }) { if (plan.draws.some((draw) => draw.kind === "effectModule")) applications += 1; const rgba = Buffer.alloc(plan.width * plan.height * 4, 255); return { ok: true as const, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: plan.width, height: plan.height, evidence: runtimeEvidence(), readback: readback(plan.width, plan.height) } }; },
      async resourceMetrics() { return applications === 0 ? withoutModuleMetrics(metrics(applications, closed)) : metrics(applications, closed); },
      async close() { closed = true; }
    } };
  };
}

function runtimeEvidence() { return { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 1, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } } as const; }
function readback(width: number, height: number) { const row = Math.ceil((width * 4) / 256) * 256, bytes = row * height; return { schema: "shellx-motion/gpu-readback-frame@1", width, height, tightBytesPerRow: width * 4, mappedBytesPerRow: row, gpuTextureToMappedReadbackBytes: bytes, cdpBase64PayloadBytes: Math.ceil(bytes / 3) * 4, hostBase64DecodedBytes: bytes, allocations: { hostBase64Decode: 1, rowCompaction: row === width * 4 ? 0 : 1, straightAlpha: 0 }, copiedBytes: { rowCompaction: row === width * 4 ? 0 : width * height * 4, straightAlpha: 0 }, rowCompaction: row === width * 4 ? "bypassed-tight-stride" : "copied-padded-rows", straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0, hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback" } as const; }
function withoutModuleMetrics(metrics: object) { const value = { ...(metrics as Record<string, unknown>) }; for (const key of ["afterimageStackUniformBufferSlots", "afterimageStackUniformBytes", "afterimageStackBindGroupSlots", "afterimageStackPasses", "afterimageStackFrames", "afterimageStackLateAllocationRefusals", "afterimageStackPersistentTextureCount", "afterimageStackPipelineReleases", "afterimageStackPreparedBindGroupReleases", "afterimageStackArenaUniformBufferDestructions"]) delete value[key]; return value as never; }
function metrics(applications: number, closed: boolean) { return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8, frameArenaReservations: 1, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0, immutableImageTextures: 0, retainedTextSurfaces: 0, pointRaster: "gpu-native-instanced", pointPositionEvaluation: "core-cpu-exact-time", pointComputeField: "not-used", immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0, computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0, computeParticleDispatches: 0, computeParticleAbi: "not-used", computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0, computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0, ...(closed ? { afterimageStackUniformBufferSlots: 0, afterimageStackUniformBytes: 0, afterimageStackBindGroupSlots: 0, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0, afterimageStackPipelineReleases: 1, afterimageStackPreparedBindGroupReleases: 1, afterimageStackArenaUniformBufferDestructions: 1 } : { afterimageStackUniformBufferSlots: 1, afterimageStackUniformBytes: 160, afterimageStackBindGroupSlots: 1, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0 }) } as never; }
