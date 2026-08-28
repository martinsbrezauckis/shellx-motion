import { compileGpuFramePlan } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { closeWebGpuPageSession, openWebGpuPageSession, renderWebGpuPageSessionFrame, uploadWebGpuPageSessionImages } from "./gpu-page-session";
import { installWebGpuPageSessionResources, readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { installWebGpuPageSessionInstanceBuffers } from "./gpu-page-instance-buffers";
import { installWebGpuPageSessionParticleComputeV2 } from "./gpu-page-particle-compute-v2";
import { prepareWebGpuPageSessionTextSurfaces, uploadWebGpuPageSessionFonts } from "./gpu-page-text-session";
import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";
import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";
import { reserveWebGpuPageSessionFrameResources } from "./gpu-page-frame-reservation";
import {
  closeWebGpuPageSessionAfterimageStackPipeline,
  installWebGpuPageSessionAfterimageStackPipeline,
  prepareWebGpuPageSessionAfterimageStackPass,
  readWebGpuPageSessionAfterimageStackMetrics
} from "./gpu-page-afterimage-stack";
import { renderWebGpuPageSessionAfterimageStackFrame } from "./gpu-page-afterimage-stack-frame";
import { createGpuPageAfterimageStackFixture } from "./unadopted/gpu-page-afterimage-stack.test-support";
import type { GpuEffectModuleBeginUseLease } from "./gpu-effect-module-use-authority";

const openGpuRuntime = vi.hoisted(() => vi.fn());
const verifyGpuEffectModuleBeginUseLease = vi.hoisted(() => vi.fn());
vi.mock("./gpu-browser-runtime", () => ({
  GPU_ADAPTER_REQUEST_OPTIONS: { powerPreference: "high-performance" },
  openGpuRuntime
}));
vi.mock("./gpu-effect-module-use-authority", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gpu-effect-module-use-authority")>(),
  verifyGpuEffectModuleBeginUseLease
}));

import { createGpuFrameRenderSession, renderInternalGpuFrame } from "./gpu-frame-renderer";

function runtimeFixture() {
  return {
    secureContext: true,
    gpuApi: true,
    adapter: true,
    adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null },
    device: true,
    limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
  };
}

function compileAfterimagePlan() {
  const descriptor = createGpuPageAfterimageStackFixture({ drawId: "effect-module-draw", width: 1, height: 1 });
  const { schema: _schema, width: _width, height: _height, ...binding } = descriptor;
  return compileGpuFramePlan({
    schema: "shellx-motion/gpu-frame-intent@1",
    width: 1,
    height: 1,
    clear: { r: 0, g: 0, b: 0, a: 0 },
    draws: [
      { kind: "groupStart", id: binding.scopeGroupDrawId, drawCount: 2, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 0, pivotY: 0, opacity: 1, blendMode: "normal", effects: null },
      { kind: "rect", id: "subject", x: 0, y: 0, width: 1, height: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      { kind: "effectModule", id: binding.drawId, blendMode: "normal", effects: null, ...binding },
      { kind: "groupEnd", id: `${binding.scopeGroupDrawId}.end`, groupId: binding.scopeGroupDrawId }
    ]
  });
}

async function compileCoreV1GeometryPlan() {
  const path = new URL("../../core/src/gpu-scene-2d-plan.ts", import.meta.url).href;
  const core = await import(path) as unknown as { compileGpuScene2dPlan(motion: unknown, atMs: number): { ok: boolean; plan?: { frame: ReturnType<typeof compileGpuFramePlan> } } };
  const result = core.compileGpuScene2dPlan({ schema: "shellx-motion/motion@1", id: "v1-session", name: "v1 session", durationMs: 1_000, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "v1-path", type: "shape", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 64 }, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 100, height: 100 }, data: "M 0 0 L 100 0 L 100 100 L 0 100 Z" }, style: { fill: "#ff00ff", stroke: "#00ff00", strokeWidth: 2, strokeLinecap: "butt", strokeLinejoin: "miter", strokeDasharray: [8, 4], strokeDashoffset: 2 } }] }, 0);
  if (!result.ok || !result.plan) throw new Error("Core v1 session fixture did not compile.");
  return result.plan.frame;
}

describe("GPU frame render session serial ownership", () => {
  it("refuses module raw plans before browser work and terminal-closes a prepared module failure", async () => {
    const plan = compileAfterimagePlan();
    const allowedLease = {} as GpuEffectModuleBeginUseLease;
    const releasedLease = {} as GpuEffectModuleBeginUseLease;
    verifyGpuEffectModuleBeginUseLease.mockImplementation((lease: unknown) => lease === allowedLease ? null : lease === releasedLease ? "The GPU effect-module begin-use lease was released." : "GPU effect-module frames require a current opaque begin-use lease.");
    openGpuRuntime.mockClear();
    await expect(renderInternalGpuFrame(plan)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(openGpuRuntime).not.toHaveBeenCalled();

    const browserClose = vi.fn();
    const page = {
      evaluate: vi.fn(async (callback: unknown) => {
        if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
        if (callback === openWebGpuPageSession) return { ok: true, runtime: runtimeFixture() };
        if ([installWebGpuPageSessionResources, installWebGpuPageSessionInstanceBuffers, installWebGpuPageSessionGradientPipeline, installWebGpuPageSessionStyledRectanglePipeline, installWebGpuPageSessionBlendPipeline, installWebGpuPageSessionBlurPipeline, installWebGpuPageSessionGlowPipeline, installWebGpuPageSessionMaskPipeline, installWebGpuPageSessionAdjustmentPipeline, installWebGpuPageSessionScene3dPipeline, installWebGpuPageSessionEnvironmentPipeline, installWebGpuPageSessionMaterialPipeline, installWebGpuPageSessionChromaKeyPipeline].includes(callback as never)) return { ok: true };
        if (callback === reserveWebGpuPageSessionFrameResources) return { ok: true };
        if (callback === installWebGpuPageSessionAfterimageStackPipeline || callback === prepareWebGpuPageSessionAfterimageStackPass) return { ok: true };
        if (callback === renderWebGpuPageSessionAfterimageStackFrame) return { ok: false, failure: { code: "gpu_render_failed", message: "forced page refusal" } };
        if (callback === readWebGpuPageSessionResourceMetrics) return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 0 };
        if (callback === readWebGpuPageSessionAfterimageStackMetrics) return { uniformBufferSlots: 1, uniformBytes: 160, bindGroupSlots: 1, passes: 0, frames: 0, lateAllocationRefusals: 0, persistentTextureCount: 0 };
        if (callback === closeWebGpuPageSessionAfterimageStackPipeline) return { releasedPipeline: true, releasedPreparedPasses: 1, releasedArenaUniformReferences: 1, releasedUniformBuffers: 1 };
        if (callback === closeWebGpuPageSession) return undefined;
        return { ok: true };
      })
    };
    openGpuRuntime.mockResolvedValue({ ok: true, session: { page, browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null }, assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }), close: browserClose } });
    const opened = await createGpuFrameRenderSession();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const noLease = await opened.session.render(plan);
    const forgedLease = await opened.session.render(plan, { effectModuleLease: {} as GpuEffectModuleBeginUseLease });
    const released = await opened.session.render(plan, { effectModuleLease: releasedLease });
    for (const result of [noLease, forgedLease, released]) expect(result).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(page.evaluate).not.toHaveBeenCalledWith(reserveWebGpuPageSessionFrameResources, expect.anything());

    await expect(opened.session.render(plan, { effectModuleLease: allowedLease })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: "forced page refusal" } });
    expect(page.evaluate).toHaveBeenCalledWith(reserveWebGpuPageSessionFrameResources, expect.anything());
    expect(page.evaluate).toHaveBeenCalledWith(closeWebGpuPageSessionAfterimageStackPipeline);
    expect(page.evaluate).toHaveBeenCalledWith(closeWebGpuPageSession);
    expect(browserClose).toHaveBeenCalledOnce();
    await expect(opened.session.resourceMetrics?.()).resolves.toMatchObject({ afterimageStackUniformBufferSlots: 0, afterimageStackBindGroupSlots: 0, afterimageStackPipelineReleases: 1, afterimageStackPreparedBindGroupReleases: 1, afterimageStackArenaUniformBufferDestructions: 1 });
    await expect(opened.session.render(plan, { effectModuleLease: allowedLease })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_cancelled" } });
  });

  it("refuses raw RGBA without an exact decoded-pixel identity before opening Chromium", async () => {
    const rgba = Buffer.from([1, 2, 3, 255]);
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    const sourceSha256 = "a".repeat(64);
    openGpuRuntime.mockClear();

    for (const image of [
      { id: "absent", width: 1, height: 1, rgba, sha256: sourceSha256 },
      { id: "malformed", width: 1, height: 1, rgba, sha256: sourceSha256, decodedSha256: "not-a-sha256" },
      { id: "tampered", width: 1, height: 1, rgba, sha256: sourceSha256, decodedSha256: "0".repeat(64) }
    ]) {
      await expect(createGpuFrameRenderSession([image as never])).resolves.toMatchObject({
        ok: false, failure: { code: "gpu_limits_exceeded", message: expect.stringMatching(/exact decoded pixel hash/) }
      });
    }
    expect(openGpuRuntime).not.toHaveBeenCalled();

    const page = {
      evaluate: vi.fn(async (callback: unknown) => {
        if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
        if (callback === openWebGpuPageSession) return { ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }, device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } } };
        if (callback === uploadWebGpuPageSessionImages) return { ok: true, uploaded: 1, decoded: [{ id: "match", sourceSha256, decodedSha256, width: 1, height: 1 }] };
        if (callback === closeWebGpuPageSession) return undefined;
        return { ok: true };
      })
    };
    openGpuRuntime.mockResolvedValue({
      ok: true,
      session: {
        page,
        browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null },
        assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }),
        close: async () => undefined
      }
    });
    const matched = await createGpuFrameRenderSession([{ id: "match", width: 1, height: 1, rgba, sha256: sourceSha256, decodedSha256 }]);
    expect(matched).toMatchObject({ ok: true, session: { immutableImageResources: [{ id: "match", sourceSha256, decodedSha256, width: 1, height: 1 }] } });
    if (matched.ok) await matched.session.close();
  });

  it("refuses a concurrent frame while the ordered arena is active and leaves metrics readable", async () => {
    let releaseRender: ((value: unknown) => void) | undefined;
    let renderedInput: unknown;
    const finishRender = (value: unknown) => { if (!releaseRender) throw new Error("The render completion hook was not installed."); releaseRender(value); };
    const page = {
      evaluate: vi.fn(async (callback: unknown, input?: unknown) => {
        if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
        if (callback === openWebGpuPageSession) return { ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }, device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } } };
        if ([installWebGpuPageSessionResources, installWebGpuPageSessionInstanceBuffers, installWebGpuPageSessionGradientPipeline, installWebGpuPageSessionStyledRectanglePipeline, installWebGpuPageSessionBlendPipeline, installWebGpuPageSessionBlurPipeline, installWebGpuPageSessionGlowPipeline, installWebGpuPageSessionMaskPipeline, installWebGpuPageSessionAdjustmentPipeline, installWebGpuPageSessionScene3dPipeline, installWebGpuPageSessionEnvironmentPipeline, installWebGpuPageSessionMaterialPipeline, installWebGpuPageSessionChromaKeyPipeline].includes(callback as never)) return { ok: true };
        if (callback === prepareWebGpuPageSessionTextSurfaces) return { ok: true, count: 1, textFit: [] };
        if (callback === renderWebGpuPageSessionFrame) return await new Promise((resolve) => { renderedInput = input; releaseRender = resolve; });
        if (callback === readWebGpuPageSessionResourceMetrics) return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 0 };
        if (callback === closeWebGpuPageSession) return undefined;
        if (callback === uploadWebGpuPageSessionFonts) return { ok: true, count: 0, textFit: [] };
        return { ok: true, uploaded: 0 };
      })
    };
    openGpuRuntime.mockResolvedValue({
      ok: true,
      session: {
        page,
        browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null },
        assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }),
        close: async () => undefined
      }
    });
    const opened = await createGpuFrameRenderSession();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const plan = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 1, height: 1, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [{ kind: "rect", id: "pixel", x: 0, y: 0, width: 1, height: 1, color: { r: 1, g: 0, b: 0, a: 1 } }] });
    const first = opened.session.render(plan);
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));
    await expect(opened.session.render(plan)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: "GPU frame session accepts exactly one ordered frame operation at a time." } });
    await expect(opened.session.resourceMetrics?.()).resolves.toMatchObject({ schema: "shellx-motion/gpu-page-session-resources@1" });
    finishRender({ ok: true, bytesPerRow: 256, paddedBase64: Buffer.alloc(256).toString("base64") });
    await expect(first).resolves.toMatchObject({ ok: true, frame: { rgba: expect.any(Buffer) } });
    expect(page.evaluate).not.toHaveBeenCalledWith(installWebGpuPageSessionParticleComputeV2);
    expect(page.evaluate).not.toHaveBeenCalledWith(prepareWebGpuPageSessionTextSurfaces, expect.anything());
    expect(renderedInput).toMatchObject({ schema: "shellx-motion/gpu-page-frame-transport@1", codec: "gzip-json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    page.evaluate.mockClear(); renderedInput = undefined; releaseRender = undefined;
    const textPlan = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 64, height: 64, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [{ kind: "text", id: "title", blendMode: "normal", effects: null, surfaceId: "text-a", fontResourceIds: ["font-brand"], fontFamily: "Brand", text: "GPU", x: 0, y: 0, width: 64, height: 64, rotationDeg: 0, pivotX: 32, pivotY: 32, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 }, fontSize: 24, fontWeight: 700, fontStyle: "normal", letterSpacing: 0, lineHeight: 1, textAlign: "center", verticalAlign: "middle", direction: "ltr", textShadow: null, textFit: null }] });
    const textFrame = opened.session.render(textPlan);
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));
    expect(page.evaluate).toHaveBeenCalledWith(prepareWebGpuPageSessionTextSurfaces, textPlan);
    expect(renderedInput).toMatchObject({ schema: "shellx-motion/gpu-page-frame-transport@1", codec: "gzip-json" });
    finishRender({ ok: true, bytesPerRow: 256, paddedBase64: Buffer.alloc(16_384).toString("base64") });
    await expect(textFrame).resolves.toMatchObject({ ok: true, frame: { rgba: expect.any(Buffer), textFit: [] } });
    page.evaluate.mockClear(); renderedInput = undefined; releaseRender = undefined;
    const particlePlan = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 64, height: 64, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [{ kind: "particleCompute", id: "field", blendMode: "normal", effects: null, schema: "shellx-motion/gpu-compute-particle-field@2", seed: 1, count: 100_000, atMs: 400, startMs: 0, lifetimeMs: 1_000, width: 64, height: 64, x: 0, y: 0, scale: 1, originX: 32, originY: 32, rotationDeg: 0, opacity: 1, color: {r:1,g:1,b:1,a:1}, secondaryColor: {r:1,g:1,b:1,a:1}, minSize: 1, maxSize: 1, minSpeed: 0, maxSpeed: 0, direction: 0, spread: 0, gravity: 0, fadeOut: false, sources: [{kind:"impact",centerX:.5,centerY:.5,radius:.2,strength:.5,startProgress:.2,durationProgress:.5}], origins: [{x:.5,y:.5,weight:1,directionOffsetDeg:0,speedScale:1}], trail: null, shading: {mode:"flat",sizeJitter:0,opacityJitter:0,glow:0}, computeDispatchCount: 1, rasterPassCount: 1, instanceBytes: 64, retainedBufferCount: 2, retainedInstanceBytes: 12_800_000 }] });
    const particleFrame = opened.session.render(particlePlan);
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));
    expect(page.evaluate).toHaveBeenCalledWith(installWebGpuPageSessionParticleComputeV2);
    finishRender({ ok: true, bytesPerRow: 256, paddedBase64: Buffer.alloc(16_384).toString("base64") });
    await expect(particleFrame).resolves.toMatchObject({ ok: true, frame: { rgba: expect.any(Buffer) } });
    page.evaluate.mockClear(); renderedInput = undefined; releaseRender = undefined;
    const geometryFrame = opened.session.render(await compileCoreV1GeometryPlan());
    await vi.waitFor(() => expect(releaseRender).toBeTypeOf("function"));
    expect(renderedInput).toMatchObject({ schema: "shellx-motion/gpu-page-frame-transport@1", codec: "gzip-json" });
    finishRender({ ok: true, bytesPerRow: 256, paddedBase64: Buffer.alloc(16_384).toString("base64") });
    await expect(geometryFrame).resolves.toMatchObject({ ok: true, frame: { rgba: expect.any(Buffer) } });
    await opened.session.close();
  });

  it("closes the page and browser when additive environment setup fails", async () => {
    const browserClose = vi.fn();
    const page = {
      evaluate: vi.fn(async (callback: unknown) => {
        if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
        if (callback === openWebGpuPageSession) return { ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }, device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } } };
        if (callback === installWebGpuPageSessionEnvironmentPipeline) return { ok: false, failure: { code: "gpu_render_failed", message: "additive environment validation failed" } };
        if (callback === closeWebGpuPageSession) return undefined;
        return { ok: true };
      })
    };
    openGpuRuntime.mockResolvedValue({ ok: true, session: { page, browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null }, assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }), close: browserClose } });

    await expect(createGpuFrameRenderSession()).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: "additive environment validation failed" } });
    expect(page.evaluate).toHaveBeenCalledWith(closeWebGpuPageSession);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("cancels a pre-delivery reservation by closing the owned page and browser", async () => {
    const browserClose = vi.fn();
    const page = {
      evaluate: vi.fn(async (callback: unknown) => {
        if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
        if (callback === openWebGpuPageSession) return { ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }, device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } } };
        if (callback === reserveWebGpuPageSessionFrameResources) return await new Promise(() => undefined);
        if (callback === closeWebGpuPageSession) return undefined;
        return { ok: true };
      })
    };
    openGpuRuntime.mockResolvedValue({ ok: true, session: { page, browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null }, assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }), close: browserClose } });
    const opened = await createGpuFrameRenderSession();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const plan = compileGpuFramePlan({ schema: "shellx-motion/gpu-frame-intent@1", width: 1, height: 1, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [{ kind: "rect", id: "pixel", x: 0, y: 0, width: 1, height: 1, color: { r: 1, g: 0, b: 0, a: 1 } }] });
    const controller = new AbortController();
    const pending = opened.session.render(plan, { signal: controller.signal });
    await vi.waitFor(() => expect(page.evaluate).toHaveBeenCalledWith(reserveWebGpuPageSessionFrameResources, expect.anything()));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, failure: { code: "gpu_cancelled" } });
    expect(page.evaluate).toHaveBeenCalledWith(closeWebGpuPageSession);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});
