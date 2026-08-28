import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { prepareWebGpuPageSessionTextSurfaces, uploadWebGpuPageSessionFonts } from "./gpu-page-text-session";

describe("persistent GPU typography session", () => {
  it("loads exact font bytes and shapes a cached multilingual text surface", async () => {
    const textureDestroy = vi.fn(); const createTexture = vi.fn(); const copyExternalImageToTexture = vi.fn(); const onSubmittedWorkDone = vi.fn(async () => undefined); const pushErrorScope = vi.fn(); const popErrorScope = vi.fn<() => Promise<{ message: string } | null>>(async () => null); const addFont = vi.fn(); const loaded = vi.fn(); const fillText = vi.fn();
    class TestFontFace { constructor(readonly family: string, readonly source: ArrayBuffer) {} async load() { loaded(); return this; } }
    const context2d = { direction: "ltr", fillStyle: "", font: "", fontKerning: "", letterSpacing: "", textAlign: "", textBaseline: "", shadowOffsetX: 0, shadowOffsetY: 0, shadowBlur: 0, shadowColor: "", fillText, measureText: (value: string) => { const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(context2d.font)?.[1] ?? 0); return { width: value.length * fontSize * 0.6, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 }; } };
    const texture = { createView: () => ({}), destroy: textureDestroy }; createTexture.mockReturnValue(texture);
    const context = createContext({
      Uint8Array, ArrayBuffer, Map, Math, JSON, Error, Number, String,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"), FontFace: TestFontFace,
        document: { fonts: { add: addFont, check: () => true }, createElement: () => ({ width: 0, height: 0, getContext: () => context2d }) },
      GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 },
      __shellxMotionGpuSessionV1: {
        device: { createTexture, createBindGroup: () => ({ bound: true }), pushErrorScope, popErrorScope, queue: { copyExternalImageToTexture, onSubmittedWorkDone } },
        imagePipeline: { getBindGroupLayout: () => ({}) }, imageSampler: {}, fonts: new Map(), textSurfaces: new Map(), textSurfaceBytes: 0
      }
    });
    const upload = runInContext(`(${uploadWebGpuPageSessionFonts.toString()})`, context) as typeof uploadWebGpuPageSessionFonts;
    const prepare = runInContext(`(${prepareWebGpuPageSessionTextSurfaces.toString()})`, context) as typeof prepareWebGpuPageSessionTextSurfaces;
    const fontBytes = Buffer.from("font-fixture");
    await expect(upload([{ resourceId: "font-brand", family: "Brand Sans", weight: 700, style: "normal", bytesBase64: fontBytes.toString("base64") }])).resolves.toEqual({ ok: true, count: 1, textFit: [] });
    const draw = { kind: "text" as const, id: "title", blendMode: "normal" as const, effects: null, surfaceId: "text-surface", fontResourceIds: ["font-brand"], fontFamily: "Brand Sans", text: "Hello world مرحبا", x: 0, y: 0, width: 128, height: 64, rotationDeg: 0, pivotX: 64, pivotY: 32, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 }, fontSize: 24, fontWeight: 700, fontStyle: "normal" as const, letterSpacing: 0, lineHeight: 1.1, textAlign: "center" as const, verticalAlign: "middle" as const, direction: "rtl" as const, textShadow: { offsetX: 2, offsetY: 3, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } }, textFit: { policy: "auto-fit" as const, safeArea: { top: 0, right: 128, bottom: 64, left: 0 }, minFontSize: 16 } };
    const plan = { schema: "shellx-motion/gpu-frame-intent@1" as const, width: 128, height: 64, clear: { r: 0, g: 0, b: 0, a: 1 }, draws: [draw], fingerprint: "0".repeat(64), budget: { rectangleCount: 0, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 1, textUtf8Bytes: Buffer.byteLength(draw.text), textSurfacePixels: 8192, scene3dCount:0,scene3dObjectCount:0,scene3dVertexCount:0,scene3dIndexCount:0,environmentCount:0,materialCount:0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 120, scene3dVertexBufferBytes:0,scene3dIndexBufferBytes:0,scene3dUniformBytes:0,environmentUniformBytes:0,materialUniformBytes:0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0, compositeCount: 0, compositeUniformBytes: 0, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 0, estimatedPlanBytes: 160 + Buffer.byteLength(draw.text) } };
    await expect(prepare(plan)).resolves.toMatchObject({ ok: true, count: 1, textFit: [{ layerId: "title", policy: "auto-fit", status: "auto-fitted", requestedFontSize: 24, appliedFontSize: expect.any(Number), minFontSize: 16 }] });
    await expect(prepare(plan)).resolves.toMatchObject({ ok: true, count: 1, textFit: [{ layerId: "title", status: "auto-fitted" }] });
    const unsafe = { ...draw, surfaceId: "text-surface-safe-refusal", textFit: { policy: "safe" as const, safeArea: { top: 32, right: 96, bottom: 33, left: 32 }, minFontSize: null } };
    await expect(prepare({ ...plan, draws: [unsafe] })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringContaining("glyph-layout contract") } });
    popErrorScope.mockResolvedValueOnce({ message: "external-image destination usage" });
    await expect(prepare({ ...plan, draws: [{ ...draw, surfaceId: "text-surface-validation-refusal" }] })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringContaining("external-image destination usage") } });
    expect(loaded).toHaveBeenCalledOnce(); expect(addFont).toHaveBeenCalledOnce(); expect(createTexture).toHaveBeenCalledWith(expect.objectContaining({ usage: 7 })); expect(copyExternalImageToTexture).toHaveBeenCalledTimes(2); expect(onSubmittedWorkDone).toHaveBeenCalledTimes(3); expect(pushErrorScope).toHaveBeenCalledTimes(4); expect(popErrorScope).toHaveBeenCalledTimes(4); expect(textureDestroy).toHaveBeenCalledOnce(); expect(fillText).toHaveBeenCalled(); expect(context2d.shadowOffsetX).toBe(2); expect(context2d.shadowBlur).toBe(4);
  });
});
