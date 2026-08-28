import type { GpuPageSessionImageInput, GpuPageSessionImageOutput } from "./gpu-page-session-types";

/**
 * Page-evaluated immutable-image admission. This is intentionally a closed function: Playwright
 * serializes it into the already-contained GPU page without a Node/browser launch seam.
 */
export async function uploadWebGpuPageSessionImages(inputs: GpuPageSessionImageInput[]): Promise<GpuPageSessionImageOutput> {
  type Texture = { createView(): unknown; destroy?(): void };
  type Device = { createBindGroup(value: unknown): unknown; createTexture(value: unknown): Texture; queue: { writeTexture(a: unknown,b: Uint8Array,c: unknown,d: unknown): void } };
  const fail = (message: string): GpuPageSessionImageOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as { atob?(value: string): string; crypto?: { subtle?: { digest(name: string, bytes: Uint8Array): Promise<ArrayBuffer> } }; createImageBitmap?: (source: Blob) => Promise<{ width: number; height: number; close?(): void }>; OffscreenCanvas?: new(width: number, height: number) => { getContext(kind: "2d", options?: unknown): { drawImage(image: unknown, x: number, y: number): void; getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } } | null }; Blob?: new(parts: BlobPart[], options?: BlobPropertyBag) => Blob; Image?: new() => { src: string; naturalWidth: number; naturalHeight: number; decode?(): Promise<void> }; URL?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }; GPUTextureUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; imagePipeline: { getBindGroupLayout(index: number): unknown }; imageSampler: unknown; images: Map<string, { texture: Texture; bindGroup: unknown; sourceSha256: string; decodedSha256: string; width: number; height: number }>; limits: { maxTextureDimension2D: number } } | undefined;
  const textureUsage = browserGlobal.GPUTextureUsage;
  if (!state || !textureUsage || typeof browserGlobal.atob !== "function") return fail("The persistent GPU page session cannot upload image resources.");
  const OffscreenCanvasCtor = browserGlobal.OffscreenCanvas;
  if (!Array.isArray(inputs) || inputs.length > 64) return fail("GPU image resource count exceeds its 64-image session budget.");
  const maxEncodedBytes = 64 * 1024 * 1024;
  const maxDecodedBytes = 256 * 1024 * 1024;
  const maxImageDimension = 4_096;
  const staged: Array<{ id: string; texture: Texture; bindGroup: unknown; sourceSha256: string; decodedSha256: string; width: number; height: number }> = [];
  const newImageIds = new Set<string>();
  const replacedImageIds = new Set<string>();
  let decodedSessionBytes = Array.from(state.images.values()).reduce((sum, image) => sum + image.width * image.height * 4, 0);
  if (decodedSessionBytes > maxDecodedBytes) return fail("GPU persistent image resources exceed the 256 MiB decoded session budget.");
  const sha256 = async (bytes: Uint8Array): Promise<string> => {
    const digest = await browserGlobal.crypto?.subtle?.digest("SHA-256", bytes);
    if (!digest) throw new Error("The persistent GPU page session cannot bind decoded image bytes to SHA-256.");
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const binary = (base64: unknown, maxBytes: number): Uint8Array => {
    if (typeof base64 !== "string" || base64.length > Math.ceil(maxBytes / 3) * 4) throw new Error("GPU image resource base64 payload exceeds its bounded decode input.");
    const bytes = Uint8Array.from(browserGlobal.atob!(base64), (character) => character.charCodeAt(0));
    if (bytes.byteLength > maxBytes) throw new Error("GPU image resource bytes exceed their bounded decode input.");
    return bytes;
  };
  const decode = async (input: Extract<GpuPageSessionImageInput, { bytesBase64: string }>): Promise<{ rgba: Uint8Array; decodedSha256: string }> => {
    if (!browserGlobal.createImageBitmap || !OffscreenCanvasCtor || !browserGlobal.Blob) throw new Error("The persistent GPU page session cannot safely rasterize this static image.");
    const source = binary(input.bytesBase64, maxEncodedBytes);
    if (await sha256(source) !== input.sourceSha256) throw new Error("GPU encoded image bytes changed after their exact package hash was bound.");
    if (input.mimeType === "image/svg+xml" && input.staticSvg !== true) throw new Error("GPU SVG rasterization requires a prior static SVG admission.");
    // Base64 produces page-owned bytes. Copy to a concrete ArrayBuffer before Blob so a
    // SharedArrayBuffer cannot enter this rasterization boundary through an ArrayBufferLike view.
    const blob = () => new browserGlobal.Blob!([Uint8Array.from(source).buffer as ArrayBuffer], { type: input.mimeType });
    const rasterize = async (image: unknown, width: number, height: number): Promise<{ rgba: Uint8Array; decodedSha256: string }> => {
      if (width !== input.width || height !== input.height) throw new Error("GPU browser image decode dimensions do not match the admitted resource dimensions.");
      const canvas = new OffscreenCanvasCtor(input.width, input.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("GPU browser image decode could not allocate its contained raster surface.");
      context.drawImage(image, 0, 0);
      const rgba = new Uint8Array(context.getImageData(0, 0, input.width, input.height).data);
      return { rgba, decodedSha256: await sha256(rgba) };
    };
    const decodeStaticSvgBlobUrl = async (): Promise<{ rgba: Uint8Array; decodedSha256: string }> => {
      // Chromium's createImageBitmap can reject an otherwise admitted SVG Blob (including on
      // native Windows Chrome). The static Core gate has already excluded active content and
      // external references, so a page-local Blob URL image decode is a bounded equivalent
      // rasterization route. It retains the source hash above and hashes the exact canvas RGBA.
      if (!browserGlobal.Image || !browserGlobal.URL) throw new Error("The persistent GPU page session cannot use its static SVG fallback decoder.");
      const objectUrl = browserGlobal.URL.createObjectURL(blob());
      const image = new browserGlobal.Image();
      try {
        if (typeof image.decode !== "function") throw new Error("The persistent GPU page session cannot decode a static SVG Blob URL.");
        image.src = objectUrl;
        await image.decode();
        return await rasterize(image, image.naturalWidth, image.naturalHeight);
      } finally {
        image.src = "";
        browserGlobal.URL.revokeObjectURL(objectUrl);
      }
    };
    let bitmap: { width: number; height: number; close?(): void };
    try {
      bitmap = await browserGlobal.createImageBitmap(blob());
    } catch (error) {
      if (input.mimeType !== "image/svg+xml" || input.staticSvg !== true) throw error;
      return await decodeStaticSvgBlobUrl();
    }
    try { return await rasterize(bitmap, bitmap.width, bitmap.height); }
    finally { bitmap.close?.(); }
  };
  try {
    for (const input of inputs) {
      if (!input || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id) || (state.images.has(input.id) && input.replace !== true) || staged.some((entry) => entry.id === input.id)) throw new Error("GPU image resource id is invalid, duplicated, or replaced without authority.");
      if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > maxImageDimension || input.height > maxImageDimension || input.width > state.limits.maxTextureDimension2D || input.height > state.limits.maxTextureDimension2D) throw new Error("GPU image resource dimensions exceed device limits.");
      const decodedByteLength = input.width * input.height * 4;
      if (decodedByteLength > maxDecodedBytes) throw new Error("GPU image resource exceeds the 256 MiB decoded session budget.");
      if (!state.images.has(input.id)) newImageIds.add(input.id);
      if (state.images.size + newImageIds.size > 64) throw new Error("GPU persistent image resources exceed the 64-image session budget.");
      const prior = state.images.get(input.id);
      if (prior && !replacedImageIds.has(input.id)) { decodedSessionBytes -= prior.width * prior.height * 4; replacedImageIds.add(input.id); }
      if (decodedSessionBytes + decodedByteLength > maxDecodedBytes) throw new Error("GPU image resources exceed the 256 MiB decoded session budget.");
      decodedSessionBytes += decodedByteLength;
      if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) throw new Error("GPU image resource source hash is invalid.");
      const decoded = "rgbaBase64" in input
        ? await (async () => {
            const rgba = binary(input.rgbaBase64, decodedByteLength);
            if (rgba.byteLength !== decodedByteLength) throw new Error("GPU image resource byte length does not match its dimensions.");
            if (!/^[a-f0-9]{64}$/.test(input.decodedSha256)) throw new Error("GPU RGBA resource decoded pixel hash is invalid.");
            if (await sha256(rgba) !== input.decodedSha256) throw new Error("GPU RGBA bytes changed after their exact decoded pixel hash was bound.");
            return { rgba, decodedSha256: input.decodedSha256 };
          })()
        : await decode(input);
      if (!/^[a-f0-9]{64}$/.test(decoded.decodedSha256)) throw new Error("GPU image resource decoded hash is invalid.");
      const bytesPerRow = Math.ceil((input.width * 4) / 256) * 256; const padded = new Uint8Array(bytesPerRow * input.height);
      for (let row = 0; row < input.height; row += 1) padded.set(decoded.rgba.subarray(row * input.width * 4, (row + 1) * input.width * 4), row * bytesPerRow);
      const texture = state.device.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
      state.device.queue.writeTexture({ texture }, padded, { bytesPerRow, rowsPerImage: input.height }, { width: input.width, height: input.height, depthOrArrayLayers: 1 });
      const bindGroup = state.device.createBindGroup({ layout: state.imagePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: state.imageSampler }, { binding: 1, resource: texture.createView() }] });
      staged.push({ id: input.id, texture, bindGroup, sourceSha256: input.sourceSha256, decodedSha256: decoded.decodedSha256, width: input.width, height: input.height });
    }
    for (const entry of staged) { const prior=state.images.get(entry.id);state.images.set(entry.id, entry);prior?.texture.destroy?.(); }
    return { ok: true, uploaded: staged.length, decoded: staged.map(({ id, sourceSha256, decodedSha256, width, height }) => ({ id, sourceSha256, decodedSha256, width, height })) };
  } catch (error) {
    for (const entry of staged) entry.texture.destroy?.();
    return fail(error instanceof Error ? error.message : "GPU image resource upload failed.");
  }
}
