import { MAX_GLTF_IMAGES, MAX_GLTF_TEXTURES } from "./gltf-container";
import type { ParsedGltfContainer } from "./gltf-types";
import { hashBuffer } from "./receipts";
import {
  MAX_GLTF_IMAGE_BYTES,
  MAX_GLTF_IMAGE_BYTES_TOTAL,
  MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES,
  MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES_TOTAL,
  type GltfEmbeddedImage,
  type GltfImageMimeType,
} from "./gltf-material-types";
import { gltfArray as array, gltfInteger as integer, gltfRecord as record } from "./gltf-read";

export interface GltfTextureSource { readonly textureIndex: number; readonly image: GltfEmbeddedImage }

export function extractGltfImages(container: ParsedGltfContainer): readonly GltfEmbeddedImage[] {
  const values = array(container.json.images ?? [], "glTF images");
  if (values.length > MAX_GLTF_IMAGES) throw new Error(`glTF images must contain at most ${MAX_GLTF_IMAGES} entries.`);
  const candidates = values.map((value, imageIndex) => inspectImage(container, value, imageIndex));
  let snapshotByteLength = 0;
  let derivedRgbaByteLength = 0;
  for (const candidate of candidates) {
    snapshotByteLength += candidate.bytes.byteLength;
    if (snapshotByteLength > MAX_GLTF_IMAGE_BYTES_TOTAL) throw new Error(`glTF image snapshot bytes exceed ${MAX_GLTF_IMAGE_BYTES_TOTAL}.`);
    derivedRgbaByteLength += candidate.derivedRgbaByteLength;
    if (derivedRgbaByteLength > MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES_TOTAL) {
      throw new Error(`glTF image derived RGBA bytes exceed ${MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES_TOTAL}.`);
    }
  }
  return Object.freeze(candidates.map(ownedImage));
}

export function extractGltfTextureSources(container: ParsedGltfContainer, images: readonly GltfEmbeddedImage[]): readonly GltfTextureSource[] {
  const values = array(container.json.textures ?? [], "glTF textures");
  if (values.length > MAX_GLTF_TEXTURES) throw new Error(`glTF textures must contain at most ${MAX_GLTF_TEXTURES} entries.`);
  return Object.freeze(values.map((value, textureIndex) => {
    const texture = record(value, `glTF texture ${textureIndex}`);
    rejectUnknownKeys(texture, ["name", "source"], `glTF texture ${textureIndex}`);
    const imageIndex = integer(texture.source, `glTF texture ${textureIndex} source`, 0, images.length - 1);
    return Object.freeze({ textureIndex, image: images[imageIndex] });
  }));
}

function inspectImage(container: ParsedGltfContainer, value: unknown, imageIndex: number): ImageCandidate {
  const image = record(value, `glTF image ${imageIndex}`);
  rejectUnknownKeys(image, ["name", "uri", "bufferView", "mimeType"], `glTF image ${imageIndex}`);
  if (image.uri !== undefined && image.bufferView !== undefined) throw new Error(`glTF image ${imageIndex} must declare exactly one contained uri or bufferView source.`);
  const source = image.uri === undefined
    ? image.bufferView === undefined ? undefined : imageBufferView(container, image.bufferView, image.mimeType, imageIndex)
    : imageDataUri(image.uri, image.mimeType, imageIndex);
  if (!source) throw new Error(`glTF image ${imageIndex} must use a bounded embedded PNG or JPEG data URI or bufferView.`);
  const dimensions = imageDimensions(source.bytes, source.mimeType, imageIndex);
  const derivedRgbaByteLength = dimensions.width * dimensions.height * 4;
  if (!Number.isSafeInteger(derivedRgbaByteLength) || derivedRgbaByteLength > MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES) {
    throw new Error(`glTF image ${imageIndex} derived RGBA bytes exceed ${MAX_GLTF_IMAGE_DERIVED_RGBA_BYTES}.`);
  }
  return { imageIndex, mimeType: source.mimeType, width: dimensions.width, height: dimensions.height, derivedRgbaByteLength, bytes: source.bytes };
}

interface ImageCandidate {
  imageIndex: number;
  mimeType: GltfImageMimeType;
  width: number;
  height: number;
  derivedRgbaByteLength: number;
  bytes: Buffer;
}

function ownedImage(candidate: ImageCandidate): GltfEmbeddedImage {
  const snapshot = Buffer.from(candidate.bytes);
  const image = {
    imageIndex: candidate.imageIndex,
    mimeType: candidate.mimeType,
    width: candidate.width,
    height: candidate.height,
    byteLength: snapshot.byteLength,
    derivedRgbaByteLength: candidate.derivedRgbaByteLength,
    sha256: hashBuffer(snapshot),
  };
  Object.defineProperty(image, "bytes", { enumerable: true, get: () => Buffer.from(snapshot) });
  return Object.freeze(image) as GltfEmbeddedImage;
}

function imageDataUri(value: unknown, declaredMimeType: unknown, imageIndex: number): { mimeType: GltfImageMimeType; bytes: Buffer } {
  if (typeof value !== "string") throw new Error(`glTF image ${imageIndex} uri must be a string.`);
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error(`glTF image ${imageIndex} must use a bounded embedded PNG or JPEG base64 data URI.`);
  const mimeType = match[1] as GltfImageMimeType;
  if (declaredMimeType !== undefined && declaredMimeType !== mimeType) throw new Error(`glTF image ${imageIndex} mimeType must match its embedded data URI.`);
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) throw new Error(`glTF image ${imageIndex} data URI is not canonical base64.`);
  return checkedImageBytes(bytes, mimeType, imageIndex);
}

function imageBufferView(container: ParsedGltfContainer, value: unknown, mimeTypeValue: unknown, imageIndex: number): { mimeType: GltfImageMimeType; bytes: Buffer } {
  const mimeType = imageMimeType(mimeTypeValue, imageIndex);
  const views = array(container.json.bufferViews, "glTF bufferViews");
  const viewIndex = integer(value, `glTF image ${imageIndex} bufferView`, 0, views.length - 1);
  const view = record(views[viewIndex], `glTF image ${imageIndex} bufferView`);
  rejectUnknownKeys(view, ["buffer", "byteOffset", "byteLength"], `glTF image ${imageIndex} bufferView`);
  const bufferIndex = integer(view.buffer, `glTF image ${imageIndex} bufferView buffer`, 0, container.buffers.length - 1);
  const buffer = container.buffers[bufferIndex];
  const byteOffset = view.byteOffset === undefined ? 0 : integer(view.byteOffset, `glTF image ${imageIndex} bufferView.byteOffset`, 0, buffer.byteLength);
  const byteLength = integer(view.byteLength, `glTF image ${imageIndex} bufferView.byteLength`, 1, Math.min(MAX_GLTF_IMAGE_BYTES, buffer.byteLength));
  if (byteOffset + byteLength > buffer.byteLength) throw new Error(`glTF image ${imageIndex} bufferView exceeds its bounded buffer.`);
  return checkedImageBytes(buffer.subarray(byteOffset, byteOffset + byteLength), mimeType, imageIndex);
}

function checkedImageBytes(bytes: Buffer, mimeType: GltfImageMimeType, imageIndex: number): { mimeType: GltfImageMimeType; bytes: Buffer } {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_GLTF_IMAGE_BYTES) throw new Error(`glTF image ${imageIndex} bytes must be between 1 and ${MAX_GLTF_IMAGE_BYTES}.`);
  return { mimeType, bytes };
}

function imageDimensions(bytes: Buffer, mimeType: GltfImageMimeType, imageIndex: number): { width: number; height: number } {
  return mimeType === "image/png" ? pngDimensions(bytes, imageIndex) : jpegDimensions(bytes, imageIndex);
}

function pngDimensions(bytes: Buffer, imageIndex: number): { width: number; height: number } {
  if (bytes.byteLength < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`glTF image ${imageIndex} PNG bytes are malformed.`);
  let offset = 8, width = 0, height = 0, sawHeader = false, sawData = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error(`glTF image ${imageIndex} PNG chunk is truncated.`);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error(`glTF image ${imageIndex} PNG must begin with one IHDR chunk.`);
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16], colorType = bytes[offset + 17];
      if (width === 0 || height === 0 || !validPngFormat(bitDepth, colorType) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(bytes[offset + 20])) throw new Error(`glTF image ${imageIndex} PNG header is unsupported or malformed.`);
      sawHeader = true;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Error(`glTF image ${imageIndex} APNG animation is not supported by the static texture contract.`);
    if (pngCrc32(bytes, offset + 4, length + 4) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error(`glTF image ${imageIndex} PNG chunk CRC is invalid.`);
    if (type === "IDAT") {
      if (length === 0) throw new Error(`glTF image ${imageIndex} PNG image data must not be empty.`);
      sawData = true;
    }
    else if (type === "IEND") {
      if (length !== 0 || !sawData || end !== bytes.byteLength) throw new Error(`glTF image ${imageIndex} PNG is missing image data or has trailing bytes.`);
      return { width, height };
    }
    offset = end;
  }
  throw new Error(`glTF image ${imageIndex} PNG is missing IEND.`);
}

function jpegDimensions(bytes: Buffer, imageIndex: number): { width: number; height: number } {
  if (bytes.byteLength < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) throw new Error(`glTF image ${imageIndex} JPEG bytes are malformed.`);
  let offset = 2; let dimensions: { width: number; height: number; components: number } | undefined;
  while (offset + 1 < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength - 2) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) throw new Error(`glTF image ${imageIndex} JPEG segment is truncated.`);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) throw new Error(`glTF image ${imageIndex} JPEG frame is unsupported.`);
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5), components = bytes[offset + 7];
      if (width === 0 || height === 0 || ![1, 3].includes(components)) throw new Error(`glTF image ${imageIndex} JPEG dimensions are malformed.`);
      dimensions = { width, height, components };
    }
    if (marker === 0xda) {
      if (!dimensions) throw new Error(`glTF image ${imageIndex} JPEG scan precedes its supported frame.`);
      const scanComponents = bytes[offset + 2];
      if (length !== 6 + 2 * scanComponents || scanComponents !== dimensions.components) {
        throw new Error(`glTF image ${imageIndex} JPEG scan is incomplete or unsupported.`);
      }
      return jpegScanDimensions(bytes, offset + length, dimensions, imageIndex);
    }
    offset += length;
  }
  throw new Error(`glTF image ${imageIndex} JPEG is missing a supported 8-bit frame.`);
}

function jpegScanDimensions(
  bytes: Buffer,
  offset: number,
  dimensions: { width: number; height: number },
  imageIndex: number,
): { width: number; height: number } {
  let entropyBytes = 0;
  for (let index = offset; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] !== 0xff) { entropyBytes += 1; continue; }
    const marker = bytes[index + 1];
    if (marker === 0x00 || marker >= 0xd0 && marker <= 0xd7) { entropyBytes += 1; index += 1; continue; }
    if (marker === 0xd9) {
      if (entropyBytes === 0 || index !== bytes.byteLength - 2) throw new Error(`glTF image ${imageIndex} JPEG scan is incomplete or has trailing bytes.`);
      return dimensions;
    }
    throw new Error(`glTF image ${imageIndex} JPEG multiple scans and embedded markers are not supported.`);
  }
  throw new Error(`glTF image ${imageIndex} JPEG scan is incomplete.`);
}

function imageMimeType(value: unknown, imageIndex: number): GltfImageMimeType {
  if (value === "image/png" || value === "image/jpeg") return value;
  throw new Error(`glTF image ${imageIndex} mimeType must be image/png or image/jpeg.`);
}

function validPngFormat(bitDepth: number, colorType: number): boolean {
  return colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth) || colorType === 2 && [8, 16].includes(bitDepth)
    || colorType === 3 && [1, 2, 4, 8].includes(bitDepth) || colorType === 4 && [8, 16].includes(bitDepth) || colorType === 6 && [8, 16].includes(bitDepth);
}

function pngCrc32(bytes: Buffer, offset: number, length: number): number {
  let crc = 0xffff_ffff;
  for (let index = offset; index < offset + length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`${label} contains unsupported ${unsupported}.`);
}
