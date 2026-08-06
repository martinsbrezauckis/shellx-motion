import { inflateRawSync } from "node:zlib";
import { decodeDotLottieUtf8 } from "./dotlottie-json";
import type { DotLottieLimits } from "./dotlottie-types";

export interface DotLottieZipEntry {
  path: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  directory: boolean;
}

export function readDotLottieZipDirectory(archive: Buffer, limits: DotLottieLimits): DotLottieZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  const commentLength = archive.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== archive.length) throw new Error("dotLottie ZIP end record is not terminal.");
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("dotLottie multi-disk ZIP archives are unsupported.");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("dotLottie ZIP64 archives are unsupported.");
  if (totalEntries === 0 || totalEntries > limits.maxEntries) throw new Error(`dotLottie ZIP entry count must be between 1 and ${limits.maxEntries}.`);
  if (centralOffset + centralSize !== eocdOffset) throw new Error("dotLottie central directory bounds do not converge.");

  const entries: DotLottieZipEntry[] = [];
  const seen = new Set<string>();
  let expandedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    assertRange(archive, offset, 46, "central directory header");
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("dotLottie central directory signature is invalid.");
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc32 = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const entryCommentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    assertRange(archive, offset, recordLength, "central directory entry");
    if ((flags & 0x0001) !== 0) throw new Error("dotLottie encrypted ZIP entries are unsupported.");
    if ((flags & 0x0008) !== 0) throw new Error("dotLottie ZIP data descriptors are unsupported.");
    if ((flags & ~0x0806) !== 0) throw new Error(`dotLottie ZIP entry ${pathForFlags(archive, offset, nameLength)} uses unsupported flags.`);
    if (method !== 0 && method !== 8) throw new Error(`dotLottie ZIP compression method ${method} is unsupported.`);
    if (diskStart !== 0) throw new Error("dotLottie multi-disk entries are unsupported.");
    assertNoZip64Extra(archive.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    const path = decodeDotLottieUtf8(archive.subarray(offset + 46, offset + 46 + nameLength), "dotLottie ZIP entry name");
    validateEntryPath(path, limits);
    const duplicate = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(duplicate)) throw new Error(`dotLottie ZIP contains a duplicate entry: ${path}.`);
    seen.add(duplicate);
    const directory = path.endsWith("/");
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) throw new Error(`dotLottie directory entry ${path} must be empty.`);
    const host = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (host === 3 && unixMode !== 0) {
      const kind = unixMode & 0o170000;
      if (kind !== 0 && kind !== 0o100000 && !(directory && kind === 0o040000)) throw new Error(`dotLottie ZIP entry ${path} is not a regular file or directory.`);
    }
    if (uncompressedSize > limits.maxFileBytes) throw new Error(`dotLottie ZIP entry ${path} exceeds the per-file limit.`);
    if (compressedSize === 0 && uncompressedSize > 0) throw new Error(`dotLottie ZIP entry ${path} has an invalid compressed size.`);
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) throw new Error(`dotLottie ZIP entry ${path} exceeds the compression-ratio limit.`);
    expandedBytes += uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) throw new Error("dotLottie ZIP exceeds the expanded-byte limit.");
    entries.push({ path, flags, method, crc32, compressedSize, uncompressedSize, localOffset, dataOffset: -1, directory });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error("dotLottie central directory entry count does not match its size.");
  validateLocalLayout(archive, entries, centralOffset);
  return entries;
}

export function readDotLottieZipEntry(archive: Buffer, entry: DotLottieZipEntry, limits: DotLottieLimits): Buffer {
  const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let output: Buffer;
  try {
    output = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: Math.min(entry.uncompressedSize + 1, limits.maxFileBytes + 1) });
  } catch {
    throw new Error(`dotLottie ZIP entry ${entry.path} could not be decompressed within limits.`);
  }
  if (output.length !== entry.uncompressedSize) throw new Error(`dotLottie ZIP entry ${entry.path} expanded size does not match metadata.`);
  if (crc32(output) !== entry.crc32) throw new Error(`dotLottie ZIP entry ${entry.path} failed CRC-32 verification.`);
  return output;
}

export function findDotLottieFile(entries: DotLottieZipEntry[], path: string): DotLottieZipEntry | undefined {
  return entries.find((entry) => entry.path === path && !entry.directory);
}

function validateLocalLayout(archive: Buffer, entries: DotLottieZipEntry[], centralOffset: number): void {
  const ranges = entries.map((entry) => validateLocalEntryMetadata(archive, entry, centralOffset)).sort((left, right) => left.start - right.start);
  if (ranges[0].start !== 0) throw new Error("dotLottie ZIP contains an unsupported preamble.");
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw new Error("dotLottie ZIP local entries overlap.");
    if (ranges[index].start !== ranges[index - 1].end) throw new Error("dotLottie ZIP contains unclaimed bytes between local entries.");
  }
  if (ranges[ranges.length - 1].end !== centralOffset) throw new Error("dotLottie ZIP contains unclaimed bytes before the central directory.");
}

function validateLocalEntryMetadata(archive: Buffer, entry: DotLottieZipEntry, centralOffset: number): { start: number; end: number } {
  assertRange(archive, entry.localOffset, 30, `local header for ${entry.path}`);
  if (archive.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`dotLottie local header for ${entry.path} is invalid.`);
  const flags = archive.readUInt16LE(entry.localOffset + 6);
  const method = archive.readUInt16LE(entry.localOffset + 8);
  const crc = archive.readUInt32LE(entry.localOffset + 14);
  const compressedSize = archive.readUInt32LE(entry.localOffset + 18);
  const uncompressedSize = archive.readUInt32LE(entry.localOffset + 22);
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  assertRange(archive, entry.localOffset, 30 + nameLength + extraLength + entry.compressedSize, `local entry ${entry.path}`);
  if (dataOffset + entry.compressedSize > centralOffset) throw new Error(`dotLottie local entry ${entry.path} overlaps the central directory.`);
  const localPath = decodeDotLottieUtf8(archive.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength), "dotLottie local entry name");
  assertNoZip64Extra(archive.subarray(entry.localOffset + 30 + nameLength, dataOffset));
  if (localPath !== entry.path || flags !== entry.flags || method !== entry.method || crc !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw new Error(`dotLottie local and central metadata differ for ${entry.path}.`);
  }
  entry.dataOffset = dataOffset;
  return { start: entry.localOffset, end: dataOffset + entry.compressedSize };
}

function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.length < 22) throw new Error("dotLottie ZIP is truncated.");
  const start = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("dotLottie ZIP end record is missing.");
}

function validateEntryPath(path: string, limits: DotLottieLimits): void {
  if (!path || Buffer.byteLength(path, "utf8") > limits.maxPathBytes || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`dotLottie ZIP entry path is unsafe: ${JSON.stringify(path)}.`);
  }
  const parts = path.split("/");
  const depth = path.endsWith("/") ? parts.length - 1 : parts.length;
  if (depth > limits.maxPathDepth || parts.some((part, index) => index < depth && (part === "" || part === "." || part === ".."))) {
    throw new Error(`dotLottie ZIP entry path is unsafe: ${path}.`);
  }
}

function assertNoZip64Extra(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (extra.length - offset < 4) throw new Error("dotLottie ZIP extra field is truncated.");
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) throw new Error("dotLottie ZIP extra field exceeds its entry.");
    if (id === 0x0001) throw new Error("dotLottie ZIP64 extra fields are unsupported.");
    offset += 4 + size;
  }
}

function assertRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`dotLottie ${label} exceeds archive bounds.`);
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pathForFlags(archive: Buffer, offset: number, nameLength: number): string {
  try {
    return decodeDotLottieUtf8(archive.subarray(offset + 46, offset + 46 + nameLength), "dotLottie ZIP entry name");
  } catch {
    return "(invalid-name)";
  }
}
