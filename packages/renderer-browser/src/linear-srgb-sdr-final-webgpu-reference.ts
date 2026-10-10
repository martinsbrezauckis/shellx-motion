import { createHash } from "node:crypto";
import {
  composeLinearSrgbLayers,
  sampleLinearSrgbGradient,
  type LinearSrgbSdrCompositingLayer,
  type LinearSrgbSdrFinalRoute,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS,
  linearSrgbSdrPublicationDitherOffset,
} from "./linear-srgb-sdr-final-webgpu-contract";

const F2A_MASK_WIDTH = 1280;
const F2A_MASK_HEIGHT = 720;
const F2A_MASK_PIXEL_COUNT = F2A_MASK_WIDTH * F2A_MASK_HEIGHT;
export const LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES = F2A_MASK_PIXEL_COUNT / 8;

/**
 * Slot-local strict-SDR eligibility facts. The packed bitmap is an internal plan input:
 * only its SHA-256 belongs in the bounded M1 record. Source colours remain the
 * descriptor-sealed GPU RGBA8 bytes, never this analytic reference working frame.
 */
export interface LinearSrgbSdrFinalReferenceDitherMask {
  /** One bit per 1280x720 pixel, row-major and least-significant-bit first. */
  readonly packedRowMajorBits: Buffer;
  readonly sha256: string;
  readonly eligibleCount: number;
}

/** CPU-only expected pixels for conformance vectors; this does not replace the isolated WebGPU producer. */
export function renderLinearSrgbSdrFinalReferenceFrame(route: LinearSrgbSdrFinalRoute): Buffer {
  const bytes = Buffer.alloc(route.canvas.width * route.canvas.height * 4);
  return withReferenceWorkingPixels(route, (pixels) => {
    for (let y = 0; y < route.canvas.height; y += 1) for (let x = 0; x < route.canvas.width; x += 1) {
      const offset = (y * route.canvas.width + x) * 4, dithered = referenceDitherEligible(route, pixels, x, y) ? linearSrgbSdrPublicationDitherOffset(x, y) : 0;
      bytes[offset] = quantize(pixels[offset]! + dithered); bytes[offset + 1] = quantize(pixels[offset + 1]! + dithered); bytes[offset + 2] = quantize(pixels[offset + 2]! + dithered); bytes[offset + 3] = quantize(pixels[offset + 3]!);
    }
    return bytes;
  });
}

/**
 * Builds the completed CPU-reference counterpart of the final encode eligibility
 * gate. This is deliberately distinct from the GPU coverage attachment, which
 * records only visible gradient coverage before endpoint and smoothness refusal.
 */
export function buildLinearSrgbSdrFinalReferenceDitherMask(route: LinearSrgbSdrFinalRoute): LinearSrgbSdrFinalReferenceDitherMask {
  if (route.canvas.width !== F2A_MASK_WIDTH || route.canvas.height !== F2A_MASK_HEIGHT) {
    throw new Error("The strict F2a reference dither mask requires the literal 1280x720 route.");
  }
  const packedRowMajorBits = Buffer.alloc(LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES);
  let eligibleCount = 0;
  try {
    withReferenceWorkingPixels(route, (pixels) => {
      for (let y = 0; y < F2A_MASK_HEIGHT; y += 1) for (let x = 0; x < F2A_MASK_WIDTH; x += 1) {
        if (!referenceDitherEligible(route, pixels, x, y)) continue;
        const pixelIndex = y * F2A_MASK_WIDTH + x;
        packedRowMajorBits[pixelIndex >>> 3] |= 1 << (pixelIndex & 7);
        eligibleCount += 1;
      }
    });
    if (eligibleCount > F2A_MASK_PIXEL_COUNT) throw new Error("The strict F2a reference dither mask exceeded its literal pixel count.");
    return Object.freeze({
      packedRowMajorBits,
      sha256: createHash("sha256").update(packedRowMajorBits).digest("hex"),
      eligibleCount,
    });
  } catch (error) {
    packedRowMajorBits.fill(0);
    throw error;
  }
}

/** The plan reads membership without reimplementing the row-major bit packing. */
export function linearSrgbSdrFinalReferenceDitherMaskBit(mask: LinearSrgbSdrFinalReferenceDitherMask, x: number, y: number): boolean {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= F2A_MASK_WIDTH || y >= F2A_MASK_HEIGHT
    || mask.packedRowMajorBits.byteLength !== LINEAR_SRGB_SDR_FINAL_F2A_REFERENCE_DITHER_MASK_BYTES) {
    throw new Error("The strict F2a reference dither mask lookup is outside its literal packed bitmap.");
  }
  const pixelIndex = y * F2A_MASK_WIDTH + x;
  return (mask.packedRowMajorBits[pixelIndex >>> 3]! & (1 << (pixelIndex & 7))) !== 0;
}

/** Mirrors the r8 coverage attachment: only a still-visible gradient contribution opts into dithering. */
export function linearSrgbSdrPublicationGradientCoverage(route: LinearSrgbSdrFinalRoute, x: number, y: number): number {
  let coverage = 0;
  for (const rect of route.rects) {
    if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue;
    const sourceCoverage = "gradient" in rect ? (rect.blendMode === "screen" ? screenMaximumPremultipliedLinear(rect, x, y) : rect.opacity) : 0;
    if (rect.blendMode === "screen") coverage = Math.min(1, sourceCoverage + coverage * (1 - screenMinimumPremultipliedLinear(rect, x, y)));
    else coverage = sourceCoverage + coverage * (1 - rect.opacity);
  }
  return coverage;
}

function screenMinimumPremultipliedLinear(rect: LinearSrgbSdrFinalRoute["rects"][number], x: number, y: number): number {
  const encoded = "fill" in rect ? rect.fill : sampleLinearSrgbGradient(rect.gradient, (x - rect.x + 0.5) / rect.width, (y - rect.y + 0.5) / rect.height);
  return Math.min(srgbDecode(encoded.r), srgbDecode(encoded.g), srgbDecode(encoded.b)) * rect.opacity;
}

function screenMaximumPremultipliedLinear(rect: Extract<LinearSrgbSdrFinalRoute["rects"][number], { readonly gradient: unknown }>, x: number, y: number): number {
  const encoded = sampleLinearSrgbGradient(rect.gradient, (x - rect.x + 0.5) / rect.width, (y - rect.y + 0.5) / rect.height);
  return Math.max(srgbDecode(encoded.r), srgbDecode(encoded.g), srgbDecode(encoded.b)) * rect.opacity;
}

function srgbDecode(value: number): number { return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4); }

function withReferenceWorkingPixels<T>(route: LinearSrgbSdrFinalRoute, operation: (pixels: Float32Array) => T): T {
  const pixelCount = route.canvas.width * route.canvas.height;
  const referenceWorkingBytes = pixelCount * LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS.referenceWorkingBytesPerPixel;
  if (!Number.isSafeInteger(referenceWorkingBytes) || referenceWorkingBytes > LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS.maxReferenceWorkingBytes) throw new Error("The linear-sRGB SDR reference exceeded its fixed working-pixel budget.");
  // One explicit, bounded four-channel Float32 working frame; do not retain one JavaScript object per pixel.
  const pixels = new Float32Array(pixelCount * 4);
  try {
    for (let y = 0; y < route.canvas.height; y += 1) for (let x = 0; x < route.canvas.width; x += 1) {
      const layers: LinearSrgbSdrCompositingLayer[] = [{ ...route.canvas.background, a: 1 }];
      for (const rect of route.rects) if (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height) {
        const blend = rect.blendMode === "screen" ? { blendMode: "screen" as const } : {};
        if ("fill" in rect) layers.push({ ...rect.fill, a: rect.opacity, ...blend });
        else layers.push({ ...sampleLinearSrgbGradient(rect.gradient, (x - rect.x + 0.5) / rect.width, (y - rect.y + 0.5) / rect.height), a: rect.opacity, ...blend });
      }
      const pixel = composeLinearSrgbLayers(layers), offset = (y * route.canvas.width + x) * 4;
      pixels[offset] = pixel.r; pixels[offset + 1] = pixel.g; pixels[offset + 2] = pixel.b; pixels[offset + 3] = pixel.a;
    }
    return operation(pixels);
  } finally {
    pixels.fill(0);
  }
}

function referenceDitherEligible(route: LinearSrgbSdrFinalRoute, pixels: Float32Array, x: number, y: number): boolean {
  const width = route.canvas.width, height = route.canvas.height, offset = (y * width + x) * 4;
  const coverage = linearSrgbSdrPublicationGradientCoverage(route, x, y), alpha = pixels[offset + 3]!, r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!;
  const endpointMargin = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.endpointMarginLsb / 255;
  if (!Number.isFinite(coverage) || coverage <= 0 || coverage > 1 || !Number.isFinite(alpha) || alpha <= 0 || alpha > 1 || !Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || r <= endpointMargin || g <= endpointMargin || b <= endpointMargin || r >= 1 - endpointMargin || g >= 1 - endpointMargin || b >= 1 - endpointMargin) return false;
  const left = (y * width + Math.max(0, x - 1)) * 4, right = (y * width + Math.min(width - 1, x + 1)) * 4;
  const up = (Math.max(0, y - 1) * width + x) * 4, down = (Math.min(height - 1, y + 1) * width + x) * 4;
  const minimum = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.minimum, maximum = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.maximum;
  const leftDelta = Math.max(Math.abs(r - pixels[left]!), Math.abs(g - pixels[left + 1]!), Math.abs(b - pixels[left + 2]!));
  const rightDelta = Math.max(Math.abs(r - pixels[right]!), Math.abs(g - pixels[right + 1]!), Math.abs(b - pixels[right + 2]!));
  const upDelta = Math.max(Math.abs(r - pixels[up]!), Math.abs(g - pixels[up + 1]!), Math.abs(b - pixels[up + 2]!));
  const downDelta = Math.max(Math.abs(r - pixels[down]!), Math.abs(g - pixels[down + 1]!), Math.abs(b - pixels[down + 2]!));
  const maximumDelta = Math.max(leftDelta, rightDelta, upDelta, downDelta);
  return maximumDelta >= minimum && maximumDelta <= maximum;
}

function quantize(value: number): number { return Math.round(Math.min(1, Math.max(0, value)) * 255); }
