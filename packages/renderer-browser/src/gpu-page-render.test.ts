import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderWebGpuPlan } from "./gpu-page-render.test-support";

describe("renderWebGpuPlan", () => {
  it("refuses non-normal blend modes instead of silently rendering them as normal", async () => {
    const serializedRenderer = runInNewContext(`(${renderWebGpuPlan.toString()})`, {}) as typeof renderWebGpuPlan;
    const result = await serializedRenderer({
      adapterOptions: { powerPreference: "high-performance" },
      plan: {
        schema: "shellx-motion/gpu-frame-intent@1", width: 1, height: 1,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        draws: [{ kind: "rect", id: "pixel", blendMode: "multiply", effects: null, x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } }],
        fingerprint: "test",
        budget: { rectangleCount: 1, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount:0,scene3dObjectCount:0,scene3dVertexCount:0,scene3dIndexCount:0,environmentCount:0,materialCount:0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes:0,scene3dIndexBufferBytes:0,scene3dUniformBytes:0,environmentUniformBytes:0,materialUniformBytes:0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 1, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0, compositeCount: 1, compositeUniformBytes: 64, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 8, estimatedPlanBytes: 80 }
      }
    });
    expect(result).toEqual({ ok: false, failure: { code: "gpu_render_failed", message: "One-shot GPU frames cannot apply composite effects; use a persistent render session." } });
  });

  it("runs as an isolated serialized renderer with privacy-reduced adapter evidence", async () => {
    const textureDestroy = vi.fn();
    const bufferDestroy = vi.fn();
    const deviceDestroy = vi.fn();
    const unmap = vi.fn();
    const writeBuffer = vi.fn();
    const pass = { draw: vi.fn(), end: vi.fn(), setPipeline: vi.fn(), setVertexBuffer: vi.fn() };
    const readback = new ArrayBuffer(256);
    const device = {
      createBuffer: vi.fn(() => ({ destroy: bufferDestroy, getMappedRange: () => readback, mapAsync: async () => undefined, unmap })),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: vi.fn(() => pass),
        copyTextureToBuffer: vi.fn(),
        finish: vi.fn(() => ({}))
      })),
      createRenderPipeline: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      createTexture: vi.fn(() => ({ createView: () => ({}), destroy: textureDestroy })),
      destroy: deviceDestroy,
      limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 },
      queue: { onSubmittedWorkDone: async () => undefined, submit: vi.fn(), writeBuffer }
    };
    const serializedRenderer = runInNewContext(`(${renderWebGpuPlan.toString()})`, {
      GPUBufferUsage: { COPY_DST: 1, MAP_READ: 2, VERTEX: 4 },
      GPUMapMode: { READ: 1 },
      GPUTextureUsage: { COPY_SRC: 1, RENDER_ATTACHMENT: 2 },
      isSecureContext: true,
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: "nvidia", device: "", architecture: "blackwell", description: "" },
            requestDevice: async () => device
          })
        }
      }
    }) as typeof renderWebGpuPlan;
    const result = await serializedRenderer({
      adapterOptions: { powerPreference: "high-performance" },
      plan: {
        schema: "shellx-motion/gpu-frame-intent@1",
        width: 1,
        height: 1,
        clear: { r: 0, g: 0, b: 0, a: 1 },
        draws: [
          { kind: "rect", id: "pixel", blendMode: "normal", effects: null, x: 0, y: 0, width: 1, height: 1, rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } },
          { kind: "ellipse", id: "orb", blendMode: "normal", effects: null, x: 0, y: 0, width: 1, height: 1, rotationDeg: 45, pivotX: 0.5, pivotY: 0.5, color: { r: 0, g: 1, b: 1, a: 0.5 }, strokeWidth: 0.1, stroke: { r: 1, g: 0.5, b: 0, a: 0.25 } },
          { kind: "triangles", id: "triangle", blendMode: "normal", effects: null, vertices: [{ x: 0.5, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], rotationDeg: 0, pivotX: 0.5, pivotY: 0.5, color: { r: 1, g: 1, b: 0, a: 1 } },
          // A Core-ear-clipped concave path reaches this fixed browser ABI as
          // three resolved triangles; the page never parses SVG.
          { kind: "coloredTriangles", id: "path", blendMode: "normal", effects: null, vertices: [
            { x: 0, y: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { x: 1, y: 0, color: { r: 0, g: 1, b: 0, a: 0.5 } }, { x: 0, y: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
            { x: 1, y: 0, color: { r: 0, g: 1, b: 0, a: 0.5 } }, { x: 1, y: 1, color: { r: 1, g: 1, b: 0, a: 0.5 } }, { x: 0.5, y: 0.5, color: { r: 1, g: 0, b: 1, a: 0.5 } },
            { x: 0.5, y: 0.5, color: { r: 1, g: 0, b: 1, a: 0.5 } }, { x: 1, y: 1, color: { r: 1, g: 1, b: 0, a: 0.5 } }, { x: 0, y: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }
          ], rotationDeg: 0, pivotX: 0.5, pivotY: 0.5 }
        ],
        fingerprint: "test",
        budget: { rectangleCount: 2, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 9, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0, textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount:0,scene3dObjectCount:0,scene3dVertexCount:0,scene3dIndexCount:0,environmentCount:0,materialCount:0, gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, triangleBufferBytes: 216, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0, textVertexBufferBytes: 0, scene3dVertexBufferBytes:0,scene3dIndexBufferBytes:0,scene3dUniformBytes:0,environmentUniformBytes:0,materialUniformBytes:0, gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0, blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0, motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0, compositeCount: 0, compositeUniformBytes: 0, blurUniformBytes: 0, glowUniformBytes: 0, maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 0, estimatedPlanBytes: 218 }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      bytesPerRow: 256,
      runtime: {
        secureContext: true,
        gpuApi: true,
        adapter: true,
        adapterInfo: { vendor: "nvidia", device: "", architecture: "blackwell", description: null },
        device: true,
        limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576, maxStorageBufferBindingSize: 1_048_576 }
      }
    });
    if (!result.ok) return;
    expect(result.padded).toHaveLength(256);
    expect(pass.draw).toHaveBeenCalledWith(6);
    expect(pass.draw).toHaveBeenCalledTimes(4);
    const ellipseVertices = writeBuffer.mock.calls[1]?.[2] as Float32Array;
    expect(ellipseVertices).toHaveLength(90);
    expect(ellipseVertices[0]).toBeCloseTo(0, 6);
    expect(ellipseVertices[1]).toBeCloseTo(Math.SQRT2, 6);
    expect(Array.from(ellipseVertices.slice(8, 15))).toEqual([0.25, 0.125, 0, 0.25, 0.5, 0.5, expect.closeTo(0.1, 6)]);
    const triangleVertices = writeBuffer.mock.calls[2]?.[2] as Float32Array;
    expect(triangleVertices).toHaveLength(18);
    const coloredTriangleVertices = writeBuffer.mock.calls[3]?.[2] as Float32Array;
    expect(coloredTriangleVertices).toHaveLength(54);
    expect(Array.from(coloredTriangleVertices.slice(0, 18))).toEqual([-1, 1, 0.5, 0, 0, 0.5, 1, 1, 0, 0.5, 0, 0.5, -1, -1, 0, 0, 0.5, 0.5]);
    expect(pass.draw).toHaveBeenCalledWith(3);
    expect(pass.draw).toHaveBeenCalledWith(9);
    expect(unmap).toHaveBeenCalledTimes(1);
    expect(textureDestroy).toHaveBeenCalledTimes(1);
    expect(bufferDestroy).toHaveBeenCalledTimes(5);
    expect(deviceDestroy).toHaveBeenCalledTimes(1);
  });
});
