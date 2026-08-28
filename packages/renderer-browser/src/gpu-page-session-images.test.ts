import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { uploadWebGpuPageSessionImages } from "./gpu-page-session-images";

describe("GPU page immutable image admission", () => {
  it("rasterizes bounded JPEG, WebP, and already-static SVG only inside the retained page and binds both hashes", async () => {
    const destroyTexture = vi.fn();
    const createTexture = vi.fn(() => ({ createView: () => ({}), destroy: destroyTexture }));
    const createImageBitmap = vi.fn(async () => ({ width: 3, height: 2, close: vi.fn() }));
    const rgba = new Uint8ClampedArray(3 * 2 * 4).fill(0x7f);
    class PageBlob { constructor(readonly parts: unknown[], readonly options: { type: string }) {} }
    class PageCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data: rgba }) }; }
    }
    const digest = async (_algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> => {
      const hash = createHash("sha256").update(bytes).digest();
      return Uint8Array.from(hash).buffer;
    };
    const pageImages = new Map();
    const context = createContext({
      Array, ArrayBuffer, Map, Math, Number, Object, Promise, Uint8Array, Uint8ClampedArray,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      crypto: { subtle: { digest } }, Blob: PageBlob, OffscreenCanvas: PageCanvas, createImageBitmap,
      GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 },
      __shellxMotionGpuSessionV1: {
        device: { createTexture, createBindGroup: vi.fn(() => ({})), queue: { writeTexture: vi.fn() } },
        imagePipeline: { getBindGroupLayout: vi.fn(() => ({})) }, imageSampler: {}, images: pageImages,
        limits: { maxTextureDimension2D: 3840 }
      }
    });
    const upload = runInContext(`(${uploadWebGpuPageSessionImages.toString()})`, context) as typeof uploadWebGpuPageSessionImages;
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    for (const [id, mimeType, staticSvg] of [
      ["jpeg", "image/jpeg", false], ["webp", "image/webp", false], ["svg", "image/svg+xml", true]
    ] as const) {
      const bytes = Buffer.from(`exact-${id}`);
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      await expect(upload([{ id, width: 3, height: 2, bytesBase64: bytes.toString("base64"), mimeType, sourceSha256, ...(staticSvg ? { staticSvg: true as const } : {}) }])).resolves.toEqual({
        ok: true, uploaded: 1, decoded: [{ id, sourceSha256, decodedSha256, width: 3, height: 2 }]
      });
    }
    expect(createImageBitmap).toHaveBeenCalledTimes(3);
    expect(createTexture).toHaveBeenCalledTimes(3);
    for (const [blob] of createImageBitmap.mock.calls as unknown as [unknown][]) {
      expect(blob).toBeInstanceOf(PageBlob);
      expect((blob as PageBlob).parts).toHaveLength(1);
      expect((blob as PageBlob).parts[0]).toBeInstanceOf(ArrayBuffer);
    }
    const originalTextureCount = createTexture.mock.calls.length;
    const jpegBytes = Buffer.from("exact-jpeg");
    const jpegSha256 = createHash("sha256").update(jpegBytes).digest("hex");
    await expect(upload([{ id: "jpeg", width: 3, height: 2, bytesBase64: jpegBytes.toString("base64"), mimeType: "image/jpeg", sourceSha256: jpegSha256 }])).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/duplicated/) } });
    await expect(upload([{ id: "tampered", width: 3, height: 2, bytesBase64: Buffer.from("changed").toString("base64"), mimeType: "image/jpeg", sourceSha256: "0".repeat(64) }])).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/exact package hash/) } });
    await expect(upload([{ id: "unadmitted-svg", width: 3, height: 2, bytesBase64: Buffer.from("svg").toString("base64"), mimeType: "image/svg+xml", sourceSha256: createHash("sha256").update("svg").digest("hex") }])).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/static SVG admission/) } });
    expect(createTexture).toHaveBeenCalledTimes(originalTextureCount);
    const stagedBytes = Buffer.from("staged");
    const stagedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
    await expect(upload([
      { id: "staged", width: 3, height: 2, bytesBase64: stagedBytes.toString("base64"), mimeType: "image/jpeg", sourceSha256: stagedSha256 },
      { id: "not-static", width: 3, height: 2, bytesBase64: Buffer.from("svg").toString("base64"), mimeType: "image/svg+xml", sourceSha256: createHash("sha256").update("svg").digest("hex") }
    ])).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/static SVG admission/) } });
    expect(pageImages.has("staged")).toBe(false);
    expect(destroyTexture).toHaveBeenCalledTimes(1);

    pageImages.clear();
    for (let index = 0; index < 16; index += 1) pageImages.set(`full-${index}`, { texture: {}, bindGroup: {}, sourceSha256: "a".repeat(64), decodedSha256: "b".repeat(64), width: 2048, height: 2048 });
    const beforeBudgetRefusal = createTexture.mock.calls.length;
    await expect(upload([{ id: "over-budget", width: 1, height: 1, bytesBase64: Buffer.from("x").toString("base64"), mimeType: "image/jpeg", sourceSha256: createHash("sha256").update("x").digest("hex") }])).resolves.toMatchObject({ ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/256 MiB/) } });
    expect(createTexture).toHaveBeenCalledTimes(beforeBudgetRefusal);
  });

  it("requires the supplied decoded hash to bind exact raw RGBA bytes instead of substituting source identity", async () => {
    const rgba = Buffer.from([1, 2, 3, 255]);
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");
    const createTexture = vi.fn(() => ({ createView: () => ({}) }));
    const digest = async (_algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> => Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
    const pageImages = new Map();
    const context = createContext({
      Array, ArrayBuffer, Map, Math, Number, Object, Promise, Uint8Array,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      crypto: { subtle: { digest } }, GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 },
      __shellxMotionGpuSessionV1: {
        device: { createTexture, createBindGroup: vi.fn(() => ({})), queue: { writeTexture: vi.fn() } },
        imagePipeline: { getBindGroupLayout: vi.fn(() => ({})) }, imageSampler: {}, images: pageImages,
        limits: { maxTextureDimension2D: 3840 }
      }
    });
    const upload = runInContext(`(${uploadWebGpuPageSessionImages.toString()})`, context) as typeof uploadWebGpuPageSessionImages;
    const raw = { width: 1, height: 1, rgbaBase64: rgba.toString("base64"), sourceSha256: "a".repeat(64) };

    await expect(upload([{ id: "match", ...raw, decodedSha256 }])).resolves.toEqual({
      ok: true, uploaded: 1, decoded: [{ id: "match", sourceSha256: raw.sourceSha256, decodedSha256, width: 1, height: 1 }]
    });
    await expect(upload([{ id: "absent", ...raw } as never])).resolves.toMatchObject({
      ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/decoded pixel hash is invalid/) }
    });
    await expect(upload([{ id: "malformed", ...raw, decodedSha256: "not-a-sha256" }])).resolves.toMatchObject({
      ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/decoded pixel hash is invalid/) }
    });
    await expect(upload([{ id: "tampered", ...raw, decodedSha256: "0".repeat(64) }])).resolves.toMatchObject({
      ok: false, failure: { code: "gpu_render_failed", message: expect.stringMatching(/exact decoded pixel hash/) }
    });
    expect(pageImages.has("absent")).toBe(false);
    expect(pageImages.has("malformed")).toBe(false);
    expect(pageImages.has("tampered")).toBe(false);
  });

  it("uses a revoked page-local Blob URL image decode only when Chrome rejects an admitted static SVG bitmap", async () => {
    const createTexture = vi.fn(() => ({ createView: () => ({}) }));
    const createImageBitmap = vi.fn(async () => { throw new Error("The source image could not be decoded."); });
    const rgba = new Uint8ClampedArray(3 * 2 * 4).fill(0x2a);
    class PageBlob { constructor(readonly parts: unknown[], readonly options: { type: string }) {} }
    class PageImage {
      static readonly created: PageImage[] = [];
      private currentSrc = "";
      readonly sourceAssignments: string[] = [];
      get src(): string { return this.currentSrc; }
      set src(value: string) { this.sourceAssignments.push(value); this.currentSrc = value; }
      naturalWidth = 3;
      naturalHeight = 2;
      constructor() { PageImage.created.push(this); }
      async decode(): Promise<void> {}
    }
    class PageCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data: rgba }) }; }
    }
    const createObjectURL = vi.fn((blob: unknown) => {
      expect(blob).toBeInstanceOf(PageBlob);
      return "blob:motion-static-svg";
    });
    const revokeObjectURL = vi.fn();
    const digest = async (_algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> => Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
    const context = createContext({
      Array, ArrayBuffer, Map, Math, Number, Object, Promise, Uint8Array, Uint8ClampedArray,
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
      crypto: { subtle: { digest } }, Blob: PageBlob, Image: PageImage, URL: { createObjectURL, revokeObjectURL }, OffscreenCanvas: PageCanvas, createImageBitmap,
      GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2 },
      __shellxMotionGpuSessionV1: {
        device: { createTexture, createBindGroup: vi.fn(() => ({})), queue: { writeTexture: vi.fn() } },
        imagePipeline: { getBindGroupLayout: vi.fn(() => ({})) }, imageSampler: {}, images: new Map(),
        limits: { maxTextureDimension2D: 3840 }
      }
    });
    const upload = runInContext(`(${uploadWebGpuPageSessionImages.toString()})`, context) as typeof uploadWebGpuPageSessionImages;
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2"/></svg>');
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const decodedSha256 = createHash("sha256").update(rgba).digest("hex");

    await expect(upload([{ id: "static-svg", width: 3, height: 2, bytesBase64: bytes.toString("base64"), mimeType: "image/svg+xml", staticSvg: true, sourceSha256 }])).resolves.toEqual({
      ok: true, uploaded: 1, decoded: [{ id: "static-svg", sourceSha256, decodedSha256, width: 3, height: 2 }]
    });
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(PageImage.created).toHaveLength(1);
    expect(PageImage.created[0]?.sourceAssignments).toEqual(["blob:motion-static-svg", ""]);
    expect(PageImage.created[0]?.src).toBe("");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:motion-static-svg");
    expect(createTexture).toHaveBeenCalledTimes(1);
  });
});
