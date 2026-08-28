import { MAX_MOTION_PNG_FRAME_DIMENSION, MAX_MOTION_PNG_FRAME_PIXELS } from "./png-rgba-decode";

/** The closed image MIME set admitted by the GPU still-image resource path. */
export type GpuImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
export type GpuImageDecodeAuthority = "safe-host-png-rgba" | "precontained-browser-static-raster";

export interface GpuImageResourceClassification {
  readonly mimeType: GpuImageMimeType;
  readonly width: number;
  readonly height: number;
  /** Conservative straight RGBA storage needed after decode. */
  readonly decodedBytes: number;
  /** PNG stays on the existing bounded parser; other types never invoke a host browser. */
  readonly decodeAuthority: GpuImageDecodeAuthority;
  /** SVG bytes passed this exact static subset gate before Chromium receives them. */
  readonly staticSvg: boolean;
}

export class GpuImageResourceClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuImageResourceClassificationError";
    Object.setPrototypeOf(this, GpuImageResourceClassificationError.prototype);
  }
}

/** Infer only the fixed public image MIME set. Unknown extensions need manifest metadata. */
export function gpuImageMimeTypeForAssetRef(assetRef: string): GpuImageMimeType | null {
  const lower = assetRef.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return null;
}

/**
 * Verify image magic, declared MIME and dimensions before any browser decode.
 * SVG is accepted only as a static no-script/no-network/no-font subset. The returned bytes are
 * intentionally not rewritten: the exact one-read package snapshot stays the identity passed to
 * the contained page decoder.
 */
export function classifyGpuImageResource(bytes: Buffer, declaredMimeType: string): GpuImageResourceClassification {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) throw new GpuImageResourceClassificationError("GPU image resource is empty.");
  if (!isGpuImageMimeType(declaredMimeType)) throw new GpuImageResourceClassificationError(`GPU image MIME '${declaredMimeType}' is unsupported.`);
  const detected = detect(bytes);
  if (detected.mimeType !== declaredMimeType) {
    throw new GpuImageResourceClassificationError(`GPU image MIME '${declaredMimeType}' does not match ${detected.mimeType} magic/content.`);
  }
  assertDimensions(detected.width, detected.height);
  return Object.freeze({
    mimeType: detected.mimeType,
    width: detected.width,
    height: detected.height,
    decodedBytes: detected.width * detected.height * 4,
    decodeAuthority: detected.mimeType === "image/png" ? "safe-host-png-rgba" : "precontained-browser-static-raster",
    staticSvg: detected.mimeType === "image/svg+xml"
  });
}

export function isGpuImageMimeType(value: string): value is GpuImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/svg+xml";
}

function detect(bytes: Buffer): { mimeType: GpuImageMimeType; width: number; height: number } {
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return pngDimensions(bytes);
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegDimensions(bytes);
  if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return webpDimensions(bytes);
  return svgDimensions(bytes);
}

function pngDimensions(bytes: Buffer): { mimeType: "image/png"; width: number; height: number } {
  if (bytes.byteLength < 33 || bytes.subarray(12, 16).toString("ascii") !== "IHDR" || bytes.readUInt32BE(8) !== 13) {
    throw new GpuImageResourceClassificationError("PNG image has no valid IHDR header.");
  }
  return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { mimeType: "image/jpeg"; width: number; height: number } {
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    // Standalone markers carry no length. Everything else must be a complete segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) break;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return { mimeType: "image/jpeg", width, height };
    }
    offset += segmentLength;
  }
  throw new GpuImageResourceClassificationError("JPEG image has no supported complete frame header.");
}

function isJpegStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function webpDimensions(bytes: Buffer): { mimeType: "image/webp"; width: number; height: number } {
  if (bytes.readUInt32LE(4) + 8 !== bytes.byteLength) throw new GpuImageResourceClassificationError("WebP RIFF size does not match the exact package bytes.");
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const kind = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new GpuImageResourceClassificationError("WebP contains a truncated chunk.");
    }
    // Animated WebP is an extended VP8X stream with the animation bit set and ANIM/ANMF
    // chunks. This still-image path does not select a frame, so it must reject both signals.
    if (kind === "ANIM" || kind === "ANMF") throw new GpuImageResourceClassificationError("Animated WebP is not admitted as an immutable still image.");
    if (kind === "VP8X") {
      if (length !== 10) throw new GpuImageResourceClassificationError("WebP VP8X header is malformed.");
      const flags = bytes[data]!;
      // VP8X bit 1 is animation; bits 7, 6, and 0 are reserved and reject rather than
      // accepting a profile whose semantics this static decoder does not model.
      if ((flags & 0x02) !== 0) throw new GpuImageResourceClassificationError("Animated WebP is not admitted as an immutable still image.");
      if ((flags & 0xc1) !== 0) throw new GpuImageResourceClassificationError("WebP VP8X contains unsupported reserved flags.");
      if (dimensions) throw new GpuImageResourceClassificationError("WebP contains more than one VP8X header.");
      dimensions = { width: readUint24Le(bytes, data + 4) + 1, height: readUint24Le(bytes, data + 7) + 1 };
    }
    if (kind === "VP8 " && !dimensions) {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) throw new GpuImageResourceClassificationError("WebP VP8 frame header is malformed.");
      dimensions = { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
    }
    if (kind === "VP8L" && !dimensions) {
      if (length < 5 || bytes[data] !== 0x2f) throw new GpuImageResourceClassificationError("WebP VP8L frame header is malformed.");
      const first = bytes[data + 1]! | (bytes[data + 2]! << 8) | (bytes[data + 3]! << 16) | (bytes[data + 4]! << 24);
      dimensions = { width: (first & 0x3fff) + 1, height: ((first >>> 14) & 0x3fff) + 1 };
    }
    offset = end + (length & 1);
  }
  if (offset !== bytes.byteLength) throw new GpuImageResourceClassificationError("WebP contains trailing incomplete chunk framing.");
  if (!dimensions) throw new GpuImageResourceClassificationError("WebP image has no supported complete frame header.");
  return { mimeType: "image/webp", ...dimensions };
}

function readUint24Le(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function svgDimensions(bytes: Buffer): { mimeType: "image/svg+xml"; width: number; height: number } {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new GpuImageResourceClassificationError("SVG image is not valid UTF-8."); }
  // This is deliberately a gate, not a best-effort cleaner. Mutating author input would make the
  // bytes being rasterized differ from the retained package hash.
  const xmlNamePrefix = "(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";
  if (/<!doctype\b|<!entity\b|<\?(?!xml\b)/i.test(source)
    || new RegExp(`<${xmlNamePrefix}(?:script|foreignObject|iframe|object|embed|audio|video|canvas|text|font|animate[A-Za-z]*|set)\\b`, "i").test(source)
    || new RegExp(`\\s${xmlNamePrefix}on[a-z0-9_-]+\\s*=`, "i").test(source)
    || new RegExp(`(?:${xmlNamePrefix})?href\\s*=`, "i").test(source)
    || /@(?:import|font-face)\b/i.test(source)
    || /\b(?:font-family|font-size|font-weight|font-style)\s*[:=]/i.test(source)
    || /@keyframes\b|\b(?:animation|transition)(?:-[a-z]+)?\s*:/i.test(source)) {
    throw new GpuImageResourceClassificationError("SVG image contains scripts, animation, external references, executable content, or fonts.");
  }
  // Paint-server fragment references are static; every other url() form can resolve externally.
  const urlsRemoved = source.replace(/url\(\s*(["']?)#[A-Za-z_][A-Za-z0-9_.:-]*\1\s*\)/gi, "");
  if (/url\s*\(/i.test(urlsRemoved)) throw new GpuImageResourceClassificationError("SVG image contains a non-fragment external resource reference.");
  const root = source.match(/^\s*(?:<\?xml\s+[^>]*\?>\s*)?<svg\b([^>]*)>/i);
  if (!root) throw new GpuImageResourceClassificationError("SVG image has no root svg element.");
  const attributes = root[1]!;
  const width = svgLength(attributes, "width");
  const height = svgLength(attributes, "height");
  const viewBox = attributes.match(/\bviewBox\s*=\s*(["'])([^"']+)\1/i)?.[2]?.trim().split(/[\s,]+/).map(Number);
  const viewBoxWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[3] : undefined;
  const resolvedWidth = width ?? viewBoxWidth;
  const resolvedHeight = height ?? viewBoxHeight;
  if (resolvedWidth === undefined || resolvedHeight === undefined || !Number.isInteger(resolvedWidth) || !Number.isInteger(resolvedHeight)) {
    throw new GpuImageResourceClassificationError("SVG image must declare finite integer width and height or a finite integer viewBox.");
  }
  return { mimeType: "image/svg+xml", width: resolvedWidth, height: resolvedHeight };
}

function svgLength(attributes: string, name: "width" | "height"): number | undefined {
  const raw = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`, "i"))?.[2]?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^([0-9]+)(?:px)?$/i);
  return match ? Number(match[1]) : undefined;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_MOTION_PNG_FRAME_DIMENSION || height > MAX_MOTION_PNG_FRAME_DIMENSION || width * height > MAX_MOTION_PNG_FRAME_PIXELS) {
    throw new GpuImageResourceClassificationError(`GPU image dimensions ${width}x${height} exceed the ${MAX_MOTION_PNG_FRAME_PIXELS}-pixel resource budget (3840x2160).`);
  }
}
