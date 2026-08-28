import { createHash } from "node:crypto";
import type { GpuRuntimeFailure, GpuSessionDynamicImageReservation, GpuSessionFontResource, GpuSessionImageResource } from "./gpu-runtime-types";

export function admitSessionFonts(fonts: readonly GpuSessionFontResource[]): { ok: true; fonts: Array<{ resourceId: string; family: string; weight: number; style: "normal" | "italic" | "oblique"; bytesBase64: string }> } | { ok: false; failure: GpuRuntimeFailure } {
  if (!Array.isArray(fonts) || fonts.length > 32) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU font resources exceed the 32-face session budget." } };
  const ids = new Set<string>(); let totalBytes = 0; const admitted: Array<{ resourceId: string; family: string; weight: number; style: "normal" | "italic" | "oblique"; bytesBase64: string }> = [];
  for (const font of fonts) {
    if (!font || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(font.resourceId) || ids.has(font.resourceId) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(font.family) || !Number.isInteger(font.weight) || font.weight < 1 || font.weight > 1_000 || !["normal", "italic", "oblique"].includes(font.style) || font.bytes.byteLength < 1 || font.bytes.byteLength > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(font.sha256) || createHash("sha256").update(font.bytes).digest("hex") !== font.sha256) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU font resource is malformed or has an invalid byte identity." } };
    ids.add(font.resourceId); totalBytes += font.bytes.byteLength; if (totalBytes > 64 * 1024 * 1024) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU font resources exceed the 64 MiB session budget." } };
    admitted.push({ resourceId: font.resourceId, family: font.family, weight: font.weight, style: font.style, bytesBase64: font.bytes.toString("base64") });
  }
  return { ok: true, fonts: admitted };
}

export function admitSessionImages(images: readonly GpuSessionImageResource[]): { ok: true; images: Array<{ id: string; width: number; height: number; rgbaBase64: string; sourceSha256: string; decodedSha256: string } | { id: string; width: number; height: number; bytesBase64: string; mimeType: "image/jpeg" | "image/webp" | "image/svg+xml"; sourceSha256: string; staticSvg?: true }> } | { ok: false; failure: GpuRuntimeFailure } {
  if (!Array.isArray(images) || images.length > 64) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU image resources exceed the 64-image session budget." } };
  const ids = new Set<string>(); let totalBytes = 0;
  const admitted: Array<{ id: string; width: number; height: number; rgbaBase64: string; sourceSha256: string; decodedSha256: string } | { id: string; width: number; height: number; bytesBase64: string; mimeType: "image/jpeg" | "image/webp" | "image/svg+xml"; sourceSha256: string; staticSvg?: true }> = [];
  for (const image of images) {
    if (!image || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(image.id) || ids.has(image.id) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4_096 || image.height > 4_096 || !/^[a-f0-9]{64}$/.test(image.sha256)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU image resource is malformed or outside fixed dimensions." } };
    const hasRgba = Buffer.isBuffer(image.rgba);
    const hasEncoded = Buffer.isBuffer(image.bytes) && (image.mimeType === "image/jpeg" || image.mimeType === "image/webp" || image.mimeType === "image/svg+xml");
    if (hasRgba === hasEncoded) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU image resource must be exactly one verified RGBA or static encoded image." } };
    ids.add(image.id);
    const payload = hasRgba ? image.rgba! : image.bytes!;
    totalBytes += hasRgba ? payload.byteLength : image.width * image.height * 4;
    if (totalBytes > 256 * 1024 * 1024) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU image resources exceed the 256 MiB decoded session budget." } };
    if (hasRgba) {
      if (payload.byteLength !== image.width * image.height * 4 || typeof image.decodedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.decodedSha256) || createHash("sha256").update(payload).digest("hex") !== image.decodedSha256) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU RGBA resource does not bind its exact decoded pixel hash." } };
      admitted.push({ id: image.id, width: image.width, height: image.height, rgbaBase64: payload.toString("base64"), sourceSha256: image.sha256, decodedSha256: image.decodedSha256 });
    } else {
      if (payload.byteLength < 1 || payload.byteLength > 64 * 1024 * 1024 || createHash("sha256").update(payload).digest("hex") !== image.sha256 || (image.mimeType === "image/svg+xml" && image.staticSvg !== true)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU encoded image does not bind exact bytes, MIME, or static SVG admission." } };
      admitted.push({ id: image.id, width: image.width, height: image.height, bytesBase64: payload.toString("base64"), mimeType: image.mimeType!, sourceSha256: image.sha256, ...(image.staticSvg ? { staticSvg: true as const } : {}) });
    }
  }
  return { ok: true, images: admitted };
}

/** Scalar-only admission for textures that must be allocated once before any preview scrub. */
export function admitSessionDynamicImages(images: readonly GpuSessionDynamicImageReservation[]): { ok: true; images: GpuSessionDynamicImageReservation[] } | { ok: false; failure: GpuRuntimeFailure } {
  if (!Array.isArray(images) || images.length > 64) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU dynamic image reservations exceed the 64-image session budget." } };
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const image of images) {
    if (!image || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(image.id) || ids.has(image.id) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4_096 || image.height > 4_096 || !/^[a-f0-9]{64}$/.test(image.sourceSha256)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "A GPU dynamic image reservation is malformed or outside fixed dimensions." } };
    const bytes = image.width * image.height * 4;
    if (!Number.isSafeInteger(bytes)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU dynamic image reservation byte accounting overflowed." } };
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 256 * 1024 * 1024) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU dynamic image reservations exceed the 256 MiB decoded session budget." } };
    ids.add(image.id);
  }
  return { ok: true, images: images.map((image) => ({ ...image })) };
}

export function admitCombinedSessionImages(staticImages: readonly GpuSessionImageResource[], dynamicImages: readonly GpuSessionDynamicImageReservation[]): { ok: true } | { ok: false; failure: GpuRuntimeFailure } {
  if (staticImages.length + dynamicImages.length > 64) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU static and dynamic images exceed the 64-image session budget." } };
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const image of staticImages) {
    if (ids.has(image.id)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU static and dynamic images have duplicate texture ids." } };
    ids.add(image.id); totalBytes += image.width * image.height * 4;
  }
  for (const image of dynamicImages) {
    if (ids.has(image.id)) return { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU static and dynamic images have duplicate texture ids." } };
    ids.add(image.id); totalBytes += image.width * image.height * 4;
  }
  return Number.isSafeInteger(totalBytes) && totalBytes <= 256 * 1024 * 1024
    ? { ok: true }
    : { ok: false, failure: { code: "gpu_limits_exceeded", message: "GPU static and dynamic images exceed the 256 MiB decoded session budget." } };
}

export class GpuFrameTimeoutError extends Error {
  constructor(timeoutMs: number) { super(`GPU frame operation exceeded its ${timeoutMs}ms budget.`); }
}

export class GpuFrameAbortError extends Error {
  constructor() { super("GPU frame rendering was cancelled."); }
}

export async function raceGpuFrameOperation<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new GpuFrameTimeoutError(timeoutMs)), timeoutMs); }),
      new Promise<T>((_, reject) => {
        if (!signal) return;
        abort = () => reject(new GpuFrameAbortError());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
