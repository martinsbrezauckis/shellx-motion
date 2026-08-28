import { inflateSync } from "node:zlib";

export interface DecodedPngRgba {
  width: number;
  height: number;
  rgba: Buffer;
}

export interface DecodePngRgbaOptions {
  /** Optional caller-specific RGBA allocation ceiling, checked from IHDR before IDAT inflation. */
  readonly maxRgbaByteLength?: number;
}

/** Internal decoder ceiling shared with streaming preflight before a child process is spawned. */
export const MAX_MOTION_PNG_FRAME_DIMENSION = 3_840;
export const MAX_MOTION_PNG_FRAME_PIXELS = MAX_MOTION_PNG_FRAME_DIMENSION * 2_160;

const CRC_TABLE = createCrcTable();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Internal bounded PNG decoder shared by quality-manifest and streaming quality paths. */
export function decodePngRgba(png: Buffer, options: DecodePngRgbaOptions = {}): DecodedPngRgba {
  assertPngSignature(png);
  let offset = 8;
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
    if (crc32(Buffer.concat([typeBytes, data])) !== png.readUInt32BE(offset + 8 + length)) {
      throw new Error(`PNG chunk ${type} has invalid CRC.`);
    }
    offset = chunkEnd;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") break;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has invalid dimensions.");
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}.`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type: ${colorType}.`);
  if (interlaceMethod !== 0) throw new Error(`Unsupported PNG interlace method: ${interlaceMethod}.`);
  // Both dimensions and compressed IDAT input are attacker-controlled. A tiny PNG can declare a
  // 40 GB RGBA buffer, and zlib can inflate a modest compressed stream by roughly 1029:1. Motion
  // only renders through 4K, so reject oversized dimensions before allocation and cap inflation at
  // the exact scanline size declared by IHDR rather than trusting a second arbitrary ceiling.
  if (width > MAX_MOTION_PNG_FRAME_DIMENSION || height > MAX_MOTION_PNG_FRAME_DIMENSION || width * height > MAX_MOTION_PNG_FRAME_PIXELS) {
    throw new Error(`PNG dimensions ${width}x${height} exceed the ${MAX_MOTION_PNG_FRAME_PIXELS}-pixel frame budget (3840x2160). Refusing before allocating a pixel buffer.`);
  }
  const rgbaByteLength = width * height * 4;
  if (options.maxRgbaByteLength !== undefined && (!Number.isSafeInteger(options.maxRgbaByteLength) || options.maxRgbaByteLength < 1)) {
    throw new Error("PNG decoder maxRgbaByteLength must be a positive safe integer.");
  }
  if (options.maxRgbaByteLength !== undefined && rgbaByteLength > options.maxRgbaByteLength) {
    throw new Error(`PNG decoded RGBA byte ceiling ${options.maxRgbaByteLength} is exceeded by ${width}x${height} (${rgbaByteLength} bytes); refusing before IDAT inflation or pixel allocation.`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expectedInflatedBytes = (stride + 1) * height;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedInflatedBytes });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`PNG IDAT stream inflates past the ${expectedInflatedBytes} bytes its own IHDR declares (${width}x${height}): ${reason}`);
  }
  if (inflated.byteLength !== expectedInflatedBytes) {
    throw new Error(`PNG IDAT stream must inflate to exactly ${expectedInflatedBytes} bytes for its ${width}x${height} scanlines; received ${inflated.byteLength}.`);
  }

  const rgba = Buffer.alloc(rgbaByteLength);
  let sourceOffset = 0;
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = unfilterScanline(Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride)), previous, filter, channels);
    sourceOffset += stride;
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

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
}

function unfilterScanline(raw: Buffer, previous: Buffer, filter: number, bytesPerPixel: number): Buffer {
  const row = Buffer.alloc(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    if (filter === 0) row[index] = raw[index];
    else if (filter === 1) row[index] = (raw[index] + left) & 0xff;
    else if (filter === 2) row[index] = (raw[index] + up) & 0xff;
    else if (filter === 3) row[index] = (raw[index] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[index] = (raw[index] + paeth(left, up, upLeft)) & 0xff;
    else throw new Error(`Unsupported PNG filter: ${filter}.`);
  }
  return row;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function assertPngSignature(png: Buffer): void {
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("File is not a PNG image.");
  }
}
