import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createGpuStreamingFrameProducer } from "./gpu-streaming-producer";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";
import { containedGpuJob, fakeGpuRuntime, fakeGpuSessionResources } from "./gpu-streaming-producer.test-support";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "./effect-module-registry";
import { resolveGpuEffectModuleStaticPlanForUse } from "./gpu-effect-module-use-authority";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/gpu-points-preview", import.meta.url));

describe("GPU streamed frame producer effect modules", () => {
  it("binds one current lease through every module-bearing final frame and emits its sparse canonical ledger", async () => {
    const pkg = effectModuleStreamingPackage();
    const admitted = await admittedEffectModuleStreamingPlan(pkg);
    const observedLeases: unknown[] = [];
    let closed = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: admitted.staticPlan,
      effectModuleLease: admitted.lease,
      openRuntime: async () => moduleAwareFakeGpuRuntime(() => { closed += 1; }, observedLeases)
    });
    try {
      await producer.produce({ async write() {} }, containedGpuJob());
      expect(observedLeases).toHaveLength(4);
      expect(observedLeases.every((lease) => lease === admitted.lease)).toBe(true);
      expect(closed).toBe(1);
      expect(producer.evidence.effectModules).toMatchObject({
        schema: "shellx-motion/gpu-effect-module-streaming-use@1",
        ledger: {
          beginUse: { canonicalFrameCount: 4, modules: expect.arrayContaining([expect.objectContaining({ moduleId: "motion.afterimage-stack", registryGeneration: 1, revocation: "not-revoked-at-begin-use" })]) },
          applications: [expect.objectContaining({ index: 0, atUs: 0, layerId: "afterimage-a" }), expect.objectContaining({ index: 3, atUs: 750_000, layerId: "afterimage-b" })],
          applicationSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          release: "pending"
        },
        resources: {
          live: { uniformBufferSlots: 1, uniformBytes: 160, bindGroupSlots: 1, passes: 2, frames: 2, lateAllocationRefusals: 0, persistentTextureCount: 0 },
          terminal: { uniformBufferSlots: 0, uniformBytes: 0, bindGroupSlots: 0, pipelineReleases: 1, preparedBindGroupReleases: 1, arenaUniformBufferDestructions: 1 }
        },
        runtimeCleanup: "complete",
        leaseRelease: "outer-host-owned-pending"
      });
      expect(producer.evidence.provenance.staticPlan).toHaveProperty("effectModules");
      expect(await admitted.lease.release()).toEqual({ released: true });
    } finally {
      await admitted.release();
    }
  });

  it("refuses missing, forged, and released module leases before Chromium opens", async () => {
    const pkg = effectModuleStreamingPackage();
    const admitted = await admittedEffectModuleStreamingPlan(pkg);
    let opens = 0;
    const openRuntime = async () => { opens += 1; return fakeGpuRuntime(() => {}); };
    try {
      const descriptor = admitted.staticPlan.effectModules![0]!;
      const forgedStaticPlan = Object.freeze({
        ...admitted.staticPlan,
        effectModules: Object.freeze([Object.freeze({ ...descriptor, amountQ16: descriptor.amountQ16 + 1 }), ...admitted.staticPlan.effectModules!.slice(1)])
      });
      const forgedPlan = createGpuStreamingFrameProducer({ pkg, staticPlan: forgedStaticPlan, effectModuleLease: admitted.lease, openRuntime });
      await expect(forgedPlan.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_static_plan_invalid" });
      const missing = createGpuStreamingFrameProducer({ pkg, staticPlan: admitted.staticPlan, openRuntime });
      await expect(missing.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_resource_refused" });
      const forged = createGpuStreamingFrameProducer({ pkg, staticPlan: admitted.staticPlan, effectModuleLease: { async release() { return { released: true }; } } as never, openRuntime });
      await expect(forged.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_resource_refused" });
      await admitted.lease.release();
      const released = createGpuStreamingFrameProducer({ pkg, staticPlan: admitted.staticPlan, effectModuleLease: admitted.lease, openRuntime });
      await expect(released.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_resource_refused" });
      expect(opens).toBe(0);
    } finally {
      await admitted.release();
    }
  });

  it("refuses a governed module plus either B2 hybrid entry point before Browser resources open", async () => {
    const pkg = effectModuleStreamingPackage();
    const admitted = await admittedEffectModuleStreamingPlan(pkg);
    let opens = 0;
    const hybrid = Object.freeze({
      ...admitted.staticPlan,
      hybridTextures: Object.freeze([{}])
    }) as unknown as GpuStreamingFrameProducerInput["staticPlan"];
    const producer = createGpuStreamingFrameProducer({ pkg, staticPlan: hybrid, effectModuleLease: admitted.lease, openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); } });
    try {
      await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_unsupported_feature" });
      const segmented = createGpuStreamingFrameProducer({
        pkg,
        staticPlan: admitted.staticPlan,
        effectModuleLease: admitted.lease,
        segmentedHybrid: {} as never,
        openRuntime: async () => { opens += 1; return fakeGpuRuntime(() => {}); }
      });
      await expect(segmented.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_unsupported_feature" });
      expect(opens).toBe(0);
    } finally {
      await admitted.lease.release().catch(() => undefined);
      await admitted.release();
    }
  });

  it("closes module resources and retains only a pending outer lease on cancellation", async () => {
    const pkg = effectModuleStreamingPackage();
    const admitted = await admittedEffectModuleStreamingPlan(pkg);
    const controller = new AbortController();
    let closed = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: admitted.staticPlan,
      effectModuleLease: admitted.lease,
      openRuntime: async () => moduleAwareFakeGpuRuntime(() => { closed += 1; }, [])
    });
    try {
      await expect(producer.produce({ async write() { controller.abort(new Error("operator cancelled")); } }, containedGpuJob(controller.signal))).rejects.toThrow("operator cancelled");
      expect(closed).toBe(1);
      expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
      expect(producer.evidence.effectModules).toMatchObject({
        ledger: { applications: [expect.objectContaining({ index: 0, layerId: "afterimage-a" })], release: "pending" },
        resources: { live: null, terminal: { pipelineReleases: 1, preparedBindGroupReleases: 1, arenaUniformBufferDestructions: 1 } },
        runtimeCleanup: "complete",
        leaseRelease: "outer-host-owned-pending"
      });
      expect(await admitted.lease.release()).toEqual({ released: true });
    } finally {
      await admitted.release();
    }
  });

  it("records no failed render application and still proves runtime cleanup", async () => {
    const pkg = effectModuleStreamingPackage();
    const admitted = await admittedEffectModuleStreamingPlan(pkg);
    let closed = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      staticPlan: admitted.staticPlan,
      effectModuleLease: admitted.lease,
      openRuntime: async () => {
        const opened = await moduleAwareFakeGpuRuntime(() => { closed += 1; }, []);
        if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        let calls = 0;
        opened.session.render = async (plan, options) => {
          calls += 1;
          if (calls === 2) return { ok: false, failure: { code: "gpu_device_lost", message: "simulated frame failure" } } as never;
          return await render(plan, options);
        };
        return opened;
      }
    });
    try {
      await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_device_lost" });
      expect(closed).toBe(1);
      expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
      expect(producer.evidence.effectModules).toMatchObject({
        ledger: { applications: [expect.objectContaining({ index: 0, layerId: "afterimage-a" })], release: "pending" },
        resources: { live: null, terminal: { pipelineReleases: 1, preparedBindGroupReleases: 1, arenaUniformBufferDestructions: 1 } },
        runtimeCleanup: "complete",
        leaseRelease: "outer-host-owned-pending"
      });
    } finally {
      await admitted.lease.release().catch(() => undefined);
      await admitted.release();
    }
  });
});

function effectModuleStreamingPackage(): MotionPackage {
  return {
    root: fixtureRoot,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_effect_streaming", name: "GPU effect streaming", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_gpu_effect_streaming", name: "GPU effect streaming", durationMs: 1_000, fps: 4, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [
        { id: "subject-a", type: "group", startMs: 0, durationMs: 250, childLayerIds: ["plate-a", "afterimage-a"] },
        { id: "plate-a", type: "shape", shape: "rect", fill: "#ff8040", startMs: 0, durationMs: 250, transform: { width: 16, height: 16 } },
        { id: "afterimage-a", type: "adjustment", startMs: 0, durationMs: 250, effectModule: afterimageReference(32_768, -3) },
        { id: "subject-b", type: "group", startMs: 750, durationMs: 250, childLayerIds: ["plate-b", "afterimage-b"] },
        { id: "plate-b", type: "shape", shape: "rect", fill: "#4080ff", startMs: 0, durationMs: 250, transform: { width: 16, height: 16 } },
        { id: "afterimage-b", type: "adjustment", startMs: 0, durationMs: 250, effectModule: afterimageReference(12_000, 4) }
      ]
    }
  };
}

function afterimageReference(amountQ16: number, dxPx: number) {
  return { schema: "shellx-motion/effect-module-ref@1" as const, moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { echoes: [{ dxPx, dyPx: 2, color: "#FF80C0C0", opacityQ16: 48_000 }], amountQ16 } };
}

async function admittedEffectModuleStreamingPlan(pkg: MotionPackage) {
  const root = await mkdtemp(join(tmpdir(), "motion-gpu-effect-streaming-"));
  const stateRoot = join(root, "effect-modules");
  await mkdir(stateRoot, { mode: 0o700 });
  const manifest = join(root, "afterimage.json");
  await writeFile(manifest, `${JSON.stringify({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack", intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1" })}\n`, { mode: 0o600 });
  const registry = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async (path) => {
    const bytes = await readFile(path);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } });
  const pending = await registry.prepareInstallFromManifestFile(manifest);
  await registry.confirmInstall(pending.confirmationId);
  const authority = createEffectModuleRegistryUseAuthority(registry);
  const resolved = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, authority);
  if (!resolved.ok || !resolved.resolution) throw new Error(resolved.ok ? "effect module resolution did not return an opaque use resolution" : resolved.failure.message);
  return {
    staticPlan: resolved.plan,
    lease: await authority.beginUse(resolved.resolution),
    release: async () => {
      await registry.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function moduleAwareFakeGpuRuntime(onClose: () => void, observedLeases: unknown[]) {
  let closed = false;
  let applications = 0;
  const opened = fakeGpuRuntime(() => { closed = true; onClose(); });
  if (!opened.ok) return opened;
  const render = opened.session.render.bind(opened.session);
  opened.session.render = async (plan, options) => {
    observedLeases.push(options?.effectModuleLease);
    const result = await render(plan, options);
    if (result.ok && (plan as { draws: readonly { kind: string }[] }).draws.some((draw) => draw.kind === "effectModule")) applications += 1;
    return result;
  };
  opened.session.resourceMetrics = async () => {
    const base = fakeGpuSessionResources((opened.session as unknown as { framesRendered?: number }).framesRendered ?? 4);
    const current = base as Record<string, unknown>;
    return Object.freeze({
      ...current,
      ...(applications > 0 ? closed
        ? { afterimageStackUniformBufferSlots: 0, afterimageStackUniformBytes: 0, afterimageStackBindGroupSlots: 0, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0, afterimageStackPipelineReleases: 1, afterimageStackPreparedBindGroupReleases: 1, afterimageStackArenaUniformBufferDestructions: 1 }
        : { afterimageStackUniformBufferSlots: 1, afterimageStackUniformBytes: 160, afterimageStackBindGroupSlots: 1, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0 }
        : {})
    }) as never;
  };
  return opened;
}
