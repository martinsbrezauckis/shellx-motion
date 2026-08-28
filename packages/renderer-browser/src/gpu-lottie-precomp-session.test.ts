import { compileGpuScene2dPlan, lowerStaticLottieToMotion } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";
import { closeWebGpuPageSession, openWebGpuPageSession, renderWebGpuPageSessionFrame } from "./gpu-page-session";
import { reserveWebGpuPageSessionFrameResources } from "./gpu-page-frame-reservation";
import { installWebGpuPageSessionResources, readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { installWebGpuPageSessionInstanceBuffers } from "./gpu-page-instance-buffers";
import { installWebGpuPageSessionParticleCompute } from "./gpu-page-particle-compute";
import { installWebGpuPageSessionGradientPipeline } from "./gpu-page-gradient";
import { installWebGpuPageSessionStyledRectanglePipeline } from "./gpu-page-styled-rectangle";
import { installWebGpuPageSessionBlendPipeline } from "./gpu-page-blend";
import { installWebGpuPageSessionBlurPipeline } from "./gpu-page-blur";
import { installWebGpuPageSessionGlowPipeline } from "./gpu-page-glow";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";
import { installWebGpuPageSessionAdjustmentPipeline } from "./gpu-page-adjustment";
import { installWebGpuPageSessionScene3dPipeline } from "./gpu-page-scene3d";
import { installWebGpuPageSessionEnvironmentPipeline } from "./gpu-page-environment";
import { installWebGpuPageSessionMaterialPipeline } from "./gpu-page-material";
import { installWebGpuPageSessionChromaKeyPipeline } from "./gpu-page-chroma-key";
import { installWebGpuPageSessionChromaMatteCleanupPipeline } from "./gpu-page-chroma-matte-cleanup";

const openGpuRuntime = vi.hoisted(() => vi.fn());
vi.mock("./gpu-browser-runtime", () => ({ GPU_ADAPTER_REQUEST_OPTIONS: { powerPreference: "high-performance" }, openGpuRuntime }));

import { createGpuFrameRenderSession } from "./gpu-frame-renderer";

describe("persistent GPU session for Lottie precomposition groups", () => {
  it("renders two hold samples through one masked group-compositor session without claiming a direct Browser or Native route", async () => {
    const lowered = lowerStaticLottieToMotion({ adapterId: "adapter.lottie", sourcePath: "scene.json", sourceText: source(), normalizedPackagePath: "packages/precomp" });
    const first = compile(lowered.motion, 0), held = compile(lowered.motion, 500);
    expect(first.draws[0]).toMatchObject({ kind: "groupStart", mask: expect.objectContaining({ x: 0, y: 0, width: 40, height: 20 }), x: 40 });
    expect(held.draws[0]).toMatchObject({ kind: "groupStart", mask: expect.objectContaining({ x: 0, y: 0, width: 40, height: 20 }), x: 60 });
    const rendered: unknown[] = [];
    const page = { evaluate: vi.fn(async (callback: unknown, input?: unknown) => {
      if (callback === GPU_PAGE_SERIALIZATION_RUNTIME) return true;
      if (callback === openWebGpuPageSession) return { ok: true, runtime: runtime() };
      if ([installWebGpuPageSessionResources, installWebGpuPageSessionInstanceBuffers, installWebGpuPageSessionParticleCompute, installWebGpuPageSessionGradientPipeline, installWebGpuPageSessionStyledRectanglePipeline, installWebGpuPageSessionBlendPipeline, installWebGpuPageSessionBlurPipeline, installWebGpuPageSessionGlowPipeline, installWebGpuPageSessionMaskPipeline, installWebGpuPageSessionAdjustmentPipeline, installWebGpuPageSessionScene3dPipeline, installWebGpuPageSessionEnvironmentPipeline, installWebGpuPageSessionMaterialPipeline, installWebGpuPageSessionChromaKeyPipeline, installWebGpuPageSessionChromaMatteCleanupPipeline].includes(callback as never)) return { ok: true };
      if (callback === reserveWebGpuPageSessionFrameResources) return { ok: true };
      if (callback === renderWebGpuPageSessionFrame) { rendered.push(input); return { ok: true, bytesPerRow: 512, paddedBase64: Buffer.alloc(40_960).toString("base64") }; }
      if (callback === readWebGpuPageSessionResourceMetrics) return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: rendered.length };
      if (callback === closeWebGpuPageSession) return undefined;
      return { ok: true };
    }) };
    const close = vi.fn();
    openGpuRuntime.mockResolvedValue({ ok: true, session: { page, browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null }, assessRender: async () => ({ ok: true, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } }), close } });
    const opened = await createGpuFrameRenderSession();
    expect(opened.ok).toBe(true); if (!opened.ok) return;
    await expect(opened.session.render(first)).resolves.toMatchObject({ ok: true });
    await expect(opened.session.render(held)).resolves.toMatchObject({ ok: true });
    expect(openGpuRuntime).toHaveBeenCalledTimes(1);
    expect(page.evaluate.mock.calls.filter(([callback]) => callback === installWebGpuPageSessionMaskPipeline)).toHaveLength(1);
    expect(rendered).toHaveLength(2);
    await opened.session.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

function compile(motion: Parameters<typeof compileGpuScene2dPlan>[0], atMs: number) { const result = compileGpuScene2dPlan(motion, atMs); if (!result.ok) throw new Error(result.failure.message); return result.plan.frame; }
function runtime() { return { secureContext: true, gpuApi: true, adapter: true, adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null }, device: true, limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 } }; }
function source(): string { return JSON.stringify({ v: "5.12.2", fr: 10, ip: 0, op: 10, w: 100, h: 80, layers: [{ ind: 1, ty: 0, nm: "scene", refId: "scene", ip: 0, op: 10, st: 0, sr: 1, bm: 0, ks: { a: { a: 0, k: [10, 0] }, p: { a: 1, k: [{ t: 0, s: [50, 0], h: 1 }, { t: 5, s: [70, 0] }] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } }], assets: [{ id: "scene", w: 40, h: 20, layers: [{ ind: 2, ty: 1, nm: "solid", ip: 0, op: 10, sw: 4, sh: 3, sc: "#ff0000" }] }] }); }
