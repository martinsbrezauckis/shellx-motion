/** Stable private-file reopening for B7 preview evidence; receipt bytes remain opaque. */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { crc32, hashBuffer, MOTION_DOCUMENT_LIMITS } from "@shellx-motion/core";
import type { AuthorityFacts } from "./checkpoint-storyboard-record-store-types.js";

export const MAX_RETAINED_TRACE_PREVIEW_RECEIPT_BYTES = 256 * 1024;
export const MAX_RETAINED_TRACE_PREVIEW_PNG_BYTES = 64 * 1024 * 1024;
export const MAX_RETAINED_TRACE_PREVIEW_DIMENSION = MOTION_DOCUMENT_LIMITS.maxDimension;
export const MAX_RETAINED_TRACE_PREVIEW_PIXELS = MOTION_DOCUMENT_LIMITS.maxFramePixels;

export async function readPrivateRetainedTracePreviewEvidence(path: string, facts: AuthorityFacts, maxBytes: number, label: string): Promise<Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>> {
  const privateFile = (stat: Awaited<ReturnType<typeof lstat>>) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === facts.ownerUid && (Number(stat.mode) & 0o077) === 0 && stat.size >= 0 && stat.size <= maxBytes;
  const before = await lstat(path); if (!privateFile(before)) throw new Error(`${label} is not a bounded private file.`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); if (!privateFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before opening.`);
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.byteLength) { const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (read.bytesRead === 0) throw new Error(`${label} ended before its stable size.`); offset += read.bytesRead; }
    const after = await handle.stat(), pathAfter = await lstat(path);
    if (!privateFile(after) || !privateFile(pathAfter) || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) throw new Error(`${label} changed while reading.`);
    return Object.freeze({ bytes, byteLength: bytes.byteLength, sha256: hashBuffer(bytes) });
  } finally { await handle.close(); }
}

/** Reopens the renderer-owned exact RGBA PNG envelope without trusting its filename or metadata. */
export function retainedTracePreviewPngDimensions(bytes: Buffer): Readonly<{ width: number; height: number }> {
  if (bytes.byteLength < 57 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG signature is invalid");
  const chunks: ReadonlyArray<Readonly<{ type: string; data: Buffer }>> = readExactPngChunks(bytes);
  if (chunks.length !== 3 || chunks[0]?.type !== "IHDR" || chunks[1]?.type !== "IDAT" || chunks[2]?.type !== "IEND" || chunks[0].data.byteLength !== 13 || chunks[1].data.byteLength < 1 || chunks[2].data.byteLength !== 0) throw new Error("PNG chunk sequence is not the exact renderer-owned RGBA envelope");
  const header = chunks[0].data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  if (width < 1 || height < 1 || width > MAX_RETAINED_TRACE_PREVIEW_DIMENSION || height > MAX_RETAINED_TRACE_PREVIEW_DIMENSION || width * height > MAX_RETAINED_TRACE_PREVIEW_PIXELS) throw new Error("PNG dimensions are invalid");
  if (header[8] !== 8 || header[9] !== 6 || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) throw new Error("PNG must use the renderer-owned 8-bit non-interlaced RGBA encoding");
  const rowBytes = width * 4 + 1, expectedInflatedBytes = rowBytes * height;
  let scanlines: Buffer;
  try { scanlines = inflateSync(chunks[1].data, { maxOutputLength: expectedInflatedBytes }); }
  catch { throw new Error("PNG IDAT stream is not a bounded renderer-owned RGBA payload"); }
  if (scanlines.byteLength !== expectedInflatedBytes) throw new Error("PNG IDAT stream does not match its exact RGBA dimensions");
  for (let offset = 0; offset < scanlines.byteLength; offset += rowBytes) if (scanlines[offset] !== 0) throw new Error("PNG scanlines do not use the renderer-owned filter policy");
  return Object.freeze({ width, height });
}

function readExactPngChunks(bytes: Buffer): ReadonlyArray<Readonly<{ type: string; data: Buffer }>> {
  const chunks: Array<Readonly<{ type: string; data: Buffer }>> = [];
  let offset = 8;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("PNG chunk header is truncated");
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) throw new Error("PNG chunk is truncated");
    const typeBytes = bytes.subarray(offset + 4, offset + 8), type = typeBytes.toString("ascii"), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error(`PNG ${type} chunk CRC is invalid`);
    chunks.push(Object.freeze({ type, data: Buffer.from(data) }));
    offset = end;
  }
  return Object.freeze(chunks);
}
