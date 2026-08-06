/**
 * Native renderer PNG codec and frame-hash helpers.
 *
 * Role: self-contained, dependency-light PNG decode/encode plus the deflate-level constants and the
 * decoded-image value type used by the native renderer. Extracted verbatim from `index.ts` so the large
 * render orchestrator no longer carries the byte-level codec, satisfying the module-size architecture gate.
 *
 * Behavior is byte-identical to the previous in-`index.ts` implementation: same PNG signature, same CRC
 * table, same truecolour-with-alpha (colour type 6, bit depth 8) encode path, and the same decode path
 * (colour types 2/6, non-interlaced, 8-bit). Receipt hashes are therefore unchanged.
 *
 * Dependencies: `node:zlib` (deflate/inflate), `node:crypto` (sha256), and
 * `@shellx-motion/core.assertLocalMotionFrameBudget` (decode dimension guard).
 *
 * Primary callers: `packages/renderer-native/src/index.ts` (session/preview render loop) which decodes
 * package PNG assets, encodes rendered frames, and hashes the encoded bytes.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { assertLocalMotionFrameBudget } from "@shellx-motion/core";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Maximum zlib deflate level (smallest PNG). Used for user-facing frames the caller keeps — single
 * preview / still-frame / one-off render exports and image-sequence deliverables — so their bytes (and
 * therefore their receipt hashes) are unchanged from the historical renderer.
 */
export const MAX_PNG_COMPRESSION_LEVEL = 9;

/**
 * Fast zlib deflate level for transient intermediate frame PNGs — the native final-render loop's frames
 * that exist only as FFmpeg encoder input and are re-decoded away. PNG is
 * lossless at every level, so the decoded pixels (and thus the final video) are identical to level 9.
 *
 * Level 1 vs 3 tradeoff (measured on a 1920x1080 mixed-content frame, node zlib): level 1 encodes in
 * ~21.5 ms producing 1.47 MiB; level 3 in ~28.3 ms producing 1.37 MiB; level 9 in ~93.2 ms producing
 * 1.28 MiB. Encode CPU is the flagged cost, and these frames are written then immediately consumed by
 * FFmpeg, so file size barely matters. Level 1 gives the fastest encode (~4.3x faster than level 9,
 * ~1.3x faster than level 3) for only ~7% larger transient files — the right pick for encoder-input
 * frames. The separate sequence-hash re-read pass is addressed by sampling rather than by
 * trading encode speed for a marginally smaller file here.)
 */
export const INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL = 1;

/** Decoded truecolour(-with-alpha) PNG pixels, always expanded to tightly packed RGBA. */
export interface NativeImage {
  width: number;
  height: number;
  rgba: Buffer;
}

export function decodeNativePngRgba(png: Buffer): NativeImage {
  assertNativePngSignature(png);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("PNG has truncated chunk header.");
    const length = png.readUInt32BE(offset);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > png.length) throw new Error(`PNG chunk ${type} is truncated.`);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} has invalid CRC.`);
    offset = chunkEnd;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has invalid dimensions.");
  assertLocalMotionFrameBudget({ width, height });
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}.`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}.`);
  if (interlaceMethod !== 0) throw new Error(`Unsupported PNG interlace method: ${interlaceMethod}.`);
  if (idatChunks.length === 0) throw new Error("PNG is missing IDAT data.");

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expectedScanlineLength = (stride + 1) * height;
  const inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedScanlineLength });
  if (inflated.length !== expectedScanlineLength) throw new Error("PNG image data length does not match its dimensions.");
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const raw = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;
    const row = unfilterNativePngScanline(raw, previous, filter, channels);
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = channels === 4 ? row[source + 3] : 255;
    }
    previous = row;
  }

  return { width, height, rgba };
}

function unfilterNativePngScanline(raw: Buffer, previous: Buffer, filter: number, bytesPerPixel: number): Buffer {
  const row = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    if (filter === 0) row[index] = raw[index];
    else if (filter === 1) row[index] = (raw[index] + left) & 0xff;
    else if (filter === 2) row[index] = (raw[index] + up) & 0xff;
    else if (filter === 3) row[index] = (raw[index] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[index] = (raw[index] + paethNativePng(left, up, upLeft)) & 0xff;
    else throw new Error(`Unsupported PNG filter: ${filter}.`);
  }
  return row;
}

function paethNativePng(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function assertNativePngSignature(png: Buffer): void {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("File is not a PNG image.");
  }
}

/**
 * Encode an RGBA buffer as a truecolour-with-alpha PNG. `level` is the zlib deflate level (0-9);
 * defaults to {@link MAX_PNG_COMPRESSION_LEVEL}. PNG is lossless at every level, so the level only
 * affects the compressed byte stream (and thus the PNG sha256), never the decoded pixels.
 */
export function encodePng(width: number, height: number, rgba: Buffer, level: number = MAX_PNG_COMPRESSION_LEVEL): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * width * 4;
    const targetStart = y * (width * 4 + 1);
    scanlines[targetStart] = 0;
    rgba.copy(scanlines, targetStart + 1, sourceStart, sourceStart + width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

const CRC_TABLE = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
