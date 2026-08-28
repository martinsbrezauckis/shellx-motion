import { createHash, webcrypto } from "node:crypto";
import { runInContext, createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { closeWebGpuPageSession } from "./gpu-page-session-close";
import { reserveWebGpuPageSessionDynamicImages, replaceWebGpuPageSessionDynamicImages } from "./gpu-page-session-dynamic-images";
import { readWebGpuPageSessionResourceMetrics } from "./gpu-page-session-resource-metrics";

const sourceSha256 = "a".repeat(64);

describe("GPU page dynamic image reservations", () => {
  it("keeps one reserved texture through exact writes, refuses bad replacements before writing, and destroys it on close", async () => {
    const writeTexture = vi.fn();
    const destroy = vi.fn();
    const createTexture = vi.fn(() => ({ createView: () => ({}), destroy }));
    const context = dynamicContext({ createTexture, writeTexture, popErrorScope: async () => null, includeStatic: false });
    const reserve = runInContext(`(${reserveWebGpuPageSessionDynamicImages.toString()})`, context) as typeof reserveWebGpuPageSessionDynamicImages;
    const replace = runInContext(`(${replaceWebGpuPageSessionDynamicImages.toString()})`, context) as typeof replaceWebGpuPageSessionDynamicImages;
    const read = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    const close = runInContext(`(${closeWebGpuPageSession.toString()})`, context) as typeof closeWebGpuPageSession;
    const first = rgba(7);

    await expect(reserve([{ id: "video-clip", width: 2, height: 2, sourceSha256 }])).resolves.toEqual({ ok: true, reserved: 1 });
    const texture = runInContext("globalThis.__shellxMotionGpuSessionV1.images.get('video-clip').texture", context);
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.images.get('video-clip').dynamic", context)).toBe(true);
    await expect(replace([replacement(first)])).resolves.toMatchObject({ ok: true, replaced: 1 });
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({ immutableImageTextures: 0, dynamicImageTextureSlots: 1, dynamicImageTextureBytes: 16, dynamicImageTextureWrites: 1, dynamicImageTextureReplacements: 1, dynamicImageTextureLateRefusals: 0 });

    await expect(replace([{ ...replacement(rgba(8)), sourceSha256: "b".repeat(64) }])).resolves.toMatchObject({ ok: false });
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.images.get('video-clip').texture", context)).toBe(texture);
    expect(createTexture).toHaveBeenCalledTimes(1);

    await expect(close()).resolves.toEqual({ dynamicImageTextureDestructions: 1 });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("returns a failure when WebGPU validation reports a post-write error", async () => {
    const writeTexture = vi.fn();
    const context = dynamicContext({ createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })), writeTexture, popErrorScope: async () => ({ message: "validation" }) });
    const reserve = runInContext(`(${reserveWebGpuPageSessionDynamicImages.toString()})`, context) as typeof reserveWebGpuPageSessionDynamicImages;
    const replace = runInContext(`(${replaceWebGpuPageSessionDynamicImages.toString()})`, context) as typeof replaceWebGpuPageSessionDynamicImages;
    await reserve([{ id: "video-clip", width: 2, height: 2, sourceSha256 }]);

    await expect(replace([replacement(rgba(9))])).resolves.toMatchObject({ ok: false });
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(runInContext("globalThis.__shellxMotionGpuSessionV1.dynamicImages.metrics", context)).toMatchObject({ writes: 0, replacements: 0, lateRefusals: 1 });
  });

  it("keeps legacy metrics unchanged when no dynamic reservation exists", async () => {
    const context = createContext({
      Map, Math, Number, Object,
      __shellxMotionGpuSessionV1: {
        images: new Map([["static", { texture: { destroy() {} } }]]), textSurfaces: new Map(),
        resources: { snapshot: (images: number) => ({ schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 0, immutableImageTextures: images }) }
      }
    });
    const read = runInContext(`(${readWebGpuPageSessionResourceMetrics.toString()})`, context) as typeof readWebGpuPageSessionResourceMetrics;
    const metrics = await read();
    expect(metrics).toMatchObject({ immutableImageTextures: 1 });
    expect(metrics).not.toHaveProperty("dynamicImageTextureSlots");
  });
});

function dynamicContext(input: { createTexture: ReturnType<typeof vi.fn>; writeTexture: ReturnType<typeof vi.fn>; popErrorScope: () => Promise<unknown>; includeStatic?: boolean }) {
  const staticTexture = { createView: () => ({}), destroy: vi.fn() };
  return createContext({
    Array, ArrayBuffer, Map, Set, Uint8Array, Math, Number, Object, Promise, Error,
    atob: (value: string) => Buffer.from(value, "base64").toString("latin1"), crypto: webcrypto,
    GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 },
    __shellxMotionGpuSessionV1: {
      device: { createTexture: input.createTexture, createBindGroup: vi.fn(() => ({})), queue: { writeTexture: input.writeTexture }, pushErrorScope: vi.fn(), popErrorScope: input.popErrorScope },
      imagePipeline: { getBindGroupLayout: vi.fn(() => ({})) }, imageSampler: {},
      images: new Map(input.includeStatic === false ? [] : [["static", { texture: staticTexture, bindGroup: {}, sourceSha256, decodedSha256: sourceSha256, width: 1, height: 1 }]]), textSurfaces: new Map(),
      resources: { snapshot: (images: number) => ({ schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 0, immutableImageTextures: images }) }
    }
  });
}

function rgba(seed: number): Uint8Array { return Uint8Array.from([seed, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]); }
function replacement(bytes: Uint8Array) {
  return { id: "video-clip", width: 2, height: 2, rgbaBase64: Buffer.from(bytes).toString("base64"), sourceSha256, decodedSha256: createHash("sha256").update(bytes).digest("hex") };
}
