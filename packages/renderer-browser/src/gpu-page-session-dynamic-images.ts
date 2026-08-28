import type {
  GpuPageSessionDynamicImageReplacementOutput,
  GpuPageSessionDynamicImageReservation,
  GpuPageSessionDynamicImageReservationOutput,
  GpuPageSessionImageInput
} from "./gpu-page-session-types";

/**
 * Allocate stable dynamic texture slots once. No media bytes cross this seam;
 * a later exact-RGBA replacement is the only way to populate a reserved slot.
 */
export async function reserveWebGpuPageSessionDynamicImages(inputs: GpuPageSessionDynamicImageReservation[]): Promise<GpuPageSessionDynamicImageReservationOutput> {
  type Texture = { createView(): unknown; destroy?(): void };
  type ImageEntry = { texture: Texture; bindGroup: unknown; sourceSha256: string; decodedSha256: string; width: number; height: number; dynamic?: boolean };
  type DynamicState = { reservations: Map<string, { width: number; height: number; sourceSha256: string }>; metrics: { reservedSlots: number; reservedBytes: number; highWaterSlots: number; highWaterBytes: number; writes: number; replacements: number; lateRefusals: number; destructions: number } };
  const fail = (message: string): GpuPageSessionDynamicImageReservationOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as {
    GPUTextureUsage?: Record<string, number>;
    __shellxMotionGpuSessionV1?: {
      device?: { createTexture(value: unknown): Texture; createBindGroup(value: unknown): unknown };
      imagePipeline?: { getBindGroupLayout(index: number): unknown };
      imageSampler?: unknown;
      images?: Map<string, ImageEntry>;
      dynamicImages?: DynamicState;
    };
  };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  const textureUsage = browserGlobal.GPUTextureUsage;
  if (!state?.device || !state.imagePipeline || !state.images || !textureUsage) return fail("The persistent GPU page session cannot reserve dynamic image textures.");
  const dynamic = state.dynamicImages ?? (state.dynamicImages = {
    reservations: new Map(),
    metrics: { reservedSlots: 0, reservedBytes: 0, highWaterSlots: 0, highWaterBytes: 0, writes: 0, replacements: 0, lateRefusals: 0, destructions: 0 }
  });
  const refuse = (message: string): GpuPageSessionDynamicImageReservationOutput => { dynamic.metrics.lateRefusals += 1; return fail(message); };
  if (!Array.isArray(inputs) || inputs.length > 64) return refuse("GPU dynamic image reservations exceed the 64-image session budget.");
  const ids = new Set<string>();
  let requestedBytes = 0;
  try {
    for (const input of inputs) {
      if (!input || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id) || ids.has(input.id) || state.images.has(input.id) || dynamic.reservations.has(input.id)) return refuse("GPU dynamic image reservation has a duplicate or invalid texture id.");
      if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 4_096 || input.height > 4_096 || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) return refuse("GPU dynamic image reservation is outside fixed dimensions or identity bounds.");
      const bytes = input.width * input.height * 4;
      if (!Number.isSafeInteger(bytes) || bytes < 1) return refuse("GPU dynamic image reservation byte accounting overflowed.");
      requestedBytes += bytes;
      if (!Number.isSafeInteger(requestedBytes)) return refuse("GPU dynamic image reservation byte accounting overflowed.");
      ids.add(input.id);
    }
    if (state.images.size + inputs.length > 64) return refuse("GPU dynamic image reservations exceed the 64-image session budget.");
    const currentBytes = Array.from(state.images.values()).reduce((total, image) => total + image.width * image.height * 4, 0);
    if (!Number.isSafeInteger(currentBytes) || currentBytes + requestedBytes > 256 * 1024 * 1024) return refuse("GPU dynamic image reservations exceed the 256 MiB decoded session budget.");
    const staged: Array<{ id: string; entry: ImageEntry; reservation: { width: number; height: number; sourceSha256: string } }> = [];
    try {
      for (const input of inputs) {
        const texture = state.device.createTexture({ size: { width: input.width, height: input.height, depthOrArrayLayers: 1 }, format: "rgba8unorm", usage: textureUsage.TEXTURE_BINDING | textureUsage.COPY_DST });
        const bindGroup = state.device.createBindGroup({ layout: state.imagePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: state.imageSampler }, { binding: 1, resource: texture.createView() }] });
        staged.push({ id: input.id, entry: { texture, bindGroup, sourceSha256: input.sourceSha256, decodedSha256: "0".repeat(64), width: input.width, height: input.height, dynamic: true }, reservation: { width: input.width, height: input.height, sourceSha256: input.sourceSha256 } });
      }
    } catch (error) {
      for (const stagedEntry of staged) stagedEntry.entry.texture.destroy?.();
      return refuse(error instanceof Error ? error.message : "GPU dynamic image texture allocation failed.");
    }
    for (const stagedEntry of staged) { state.images.set(stagedEntry.id, stagedEntry.entry); dynamic.reservations.set(stagedEntry.id, stagedEntry.reservation); }
    dynamic.metrics.reservedSlots += staged.length;
    dynamic.metrics.reservedBytes += requestedBytes;
    dynamic.metrics.highWaterSlots = Math.max(dynamic.metrics.highWaterSlots, dynamic.metrics.reservedSlots);
    dynamic.metrics.highWaterBytes = Math.max(dynamic.metrics.highWaterBytes, dynamic.metrics.reservedBytes);
    return { ok: true, reserved: staged.length };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "GPU dynamic image reservation failed.");
  }
}

/** Write exact verified RGBA pixels into a prior stable reservation without reallocating its texture. */
export async function replaceWebGpuPageSessionDynamicImages(inputs: GpuPageSessionImageInput[]): Promise<GpuPageSessionDynamicImageReplacementOutput> {
  type Texture = { createView(): unknown; destroy?(): void };
  type ImageEntry = { texture: Texture; bindGroup: unknown; sourceSha256: string; decodedSha256: string; width: number; height: number; dynamic?: boolean };
  type DynamicState = { reservations: Map<string, { width: number; height: number; sourceSha256: string }>; metrics: { reservedSlots: number; reservedBytes: number; highWaterSlots: number; highWaterBytes: number; writes: number; replacements: number; lateRefusals: number; destructions: number } };
  const fail = (message: string): GpuPageSessionDynamicImageReplacementOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as {
    atob?(value: string): string;
    crypto?: { subtle?: { digest(name: string, bytes: Uint8Array): Promise<ArrayBuffer> } };
    GPUTextureUsage?: Record<string, number>;
    __shellxMotionGpuSessionV1?: { device?: { queue: { writeTexture(a: unknown, b: Uint8Array, c: unknown, d: unknown): void }; pushErrorScope?(filter: "validation"): void; popErrorScope?(): Promise<unknown | null>; lost?: Promise<unknown> }; images?: Map<string, ImageEntry>; dynamicImages?: DynamicState };
  };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  const dynamic = state?.dynamicImages;
  if (!state?.device || !state.images || !dynamic || typeof browserGlobal.atob !== "function" || typeof state.device.pushErrorScope !== "function" || typeof state.device.popErrorScope !== "function") return fail("The persistent GPU page session cannot replace dynamic image textures with validation containment.");
  const refuse = (message: string): GpuPageSessionDynamicImageReplacementOutput => { dynamic.metrics.lateRefusals += 1; return fail(message); };
  if (!Array.isArray(inputs) || inputs.length > 64) return refuse("GPU dynamic image replacement exceeds the 64-image session budget.");
  const digest = async (bytes: Uint8Array): Promise<string> => {
    const result = await browserGlobal.crypto?.subtle?.digest("SHA-256", bytes);
    if (!result) throw new Error("The persistent GPU page session cannot bind dynamic pixels to SHA-256.");
    return Array.from(new Uint8Array(result)).map((entry) => entry.toString(16).padStart(2, "0")).join("");
  };
  const staged: Array<{ input: Extract<GpuPageSessionImageInput, { rgbaBase64: string }>; rgba: Uint8Array; decodedSha256: string }> = [];
  const ids = new Set<string>();
  try {
    for (const input of inputs) {
      if (!input || !("rgbaBase64" in input) || ids.has(input.id)) return refuse("GPU dynamic image replacement must contain one exact RGBA payload per reserved id.");
      const reservation = dynamic.reservations.get(input.id);
      const image = state.images.get(input.id);
      if (!reservation || !image?.dynamic) return refuse("GPU dynamic image replacement refers to an unreserved texture slot.");
      if (input.width !== reservation.width || input.height !== reservation.height || input.sourceSha256 !== reservation.sourceSha256 || !/^[a-f0-9]{64}$/.test(input.decodedSha256)) return refuse("GPU dynamic image replacement changed its reserved identity or dimensions.");
      const expectedBytes = input.width * input.height * 4;
      if (!Number.isSafeInteger(expectedBytes) || input.rgbaBase64.length > Math.ceil(expectedBytes / 3) * 4) return refuse("GPU dynamic image replacement bytes exceed the reserved texture.");
      const rgba = Uint8Array.from(browserGlobal.atob(input.rgbaBase64), (character) => character.charCodeAt(0));
      if (rgba.byteLength !== expectedBytes || await digest(rgba) !== input.decodedSha256) return refuse("GPU dynamic image replacement does not bind exact decoded RGBA pixels.");
      staged.push({ input, rgba, decodedSha256: input.decodedSha256 });
      ids.add(input.id);
    }
    const write = (image: ImageEntry, input: Extract<GpuPageSessionImageInput, { rgbaBase64: string }>, rgba: Uint8Array): void => {
      const bytesPerRow = Math.ceil((input.width * 4) / 256) * 256;
      const padded = new Uint8Array(bytesPerRow * input.height);
      for (let row = 0; row < input.height; row += 1) padded.set(rgba.subarray(row * input.width * 4, (row + 1) * input.width * 4), row * bytesPerRow);
      state.device!.queue.writeTexture({ texture: image.texture }, padded, { bytesPerRow, rowsPerImage: input.height }, { width: input.width, height: input.height, depthOrArrayLayers: 1 });
    };
    let scoped = false;
    try {
      state.device.pushErrorScope("validation");
      scoped = true;
      for (const entry of staged) {
        const image = state.images.get(entry.input.id)!;
        write(image, entry.input, entry.rgba);
      }
      const validation = state.device.lost
        ? await Promise.race([state.device.popErrorScope(), state.device.lost.then(() => { throw new Error("GPU device was lost while replacing a dynamic image texture."); })])
        : await state.device.popErrorScope();
      scoped = false;
      if (validation) throw new Error("GPU rejected a dynamic image replacement validation scope.");
    } catch (error) {
      if (scoped) await state.device.popErrorScope!().catch(() => undefined);
      return refuse(error instanceof Error ? error.message : "GPU dynamic image replacement failed.");
    }
    for (const entry of staged) {
      const image = state.images.get(entry.input.id)!;
      image.decodedSha256 = entry.decodedSha256;
      dynamic.metrics.writes += 1;
      dynamic.metrics.replacements += 1;
    }
    return { ok: true, replaced: staged.length, decoded: staged.map((entry) => ({ id: entry.input.id, sourceSha256: entry.input.sourceSha256, decodedSha256: entry.decodedSha256, width: entry.input.width, height: entry.input.height })) };
  } catch (error) { return refuse(error instanceof Error ? error.message : "GPU dynamic image replacement failed."); }
}
