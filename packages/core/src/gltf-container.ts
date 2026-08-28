import { hashBuffer } from "./receipts";
import type { GltfSourceFormat, ParsedGltfContainer } from "./gltf-types";

export const MAX_GLTF_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_GLTF_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_GLTF_NORMALIZED_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_GLTF_BUFFER_BYTES = 12 * 1024 * 1024;
export const MAX_GLTF_BUFFERS = 4;
export const MAX_GLTF_ACCESSORS = 128;
export const MAX_GLTF_BUFFER_VIEWS = 128;
export const MAX_GLTF_NODES = 64;
export const MAX_GLTF_MESHES = 16;
export const MAX_GLTF_MATERIALS = 32;
export const MAX_GLTF_TEXTURES = 16;
export const MAX_GLTF_IMAGES = 16;

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const MAX_GLTF_JSON_DEPTH = 32;
const MAX_GLTF_JSON_STRUCTURAL_TOKENS = 50_000;

/** Parse a bounded glTF 2.0 JSON/data-URI document or GLB without resolving network/external paths. */
export function parseGltfContainer(bytes: Buffer, format: GltfSourceFormat): ParsedGltfContainer {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_GLTF_SOURCE_BYTES) {
    throw new Error(`glTF source must be between 1 and ${MAX_GLTF_SOURCE_BYTES} bytes.`);
  }
  const parsed = format === "glb" ? parseGlb(bytes) : { jsonBytes: bytes, binaryChunk: undefined };
  if (parsed.jsonBytes.byteLength > MAX_GLTF_JSON_BYTES) throw new Error(`glTF JSON exceeds ${MAX_GLTF_JSON_BYTES} bytes.`);
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(parsed.jsonBytes).replace(/[\u0000\u0020\t\r\n]+$/g, "");
  assertBoundedGltfJsonText(sourceText);
  let jsonValue: unknown;
  try { jsonValue = JSON.parse(sourceText); } catch { throw new Error("glTF JSON is invalid."); }
  const json = record(jsonValue, "glTF document");
  const asset = record(json.asset, "glTF asset");
  if (asset.version !== "2.0") throw new Error("glTF asset.version must be 2.0.");
  assertBoundedArray(json.buffers, MAX_GLTF_BUFFERS, "buffers");
  assertBoundedArray(json.bufferViews, MAX_GLTF_BUFFER_VIEWS, "bufferViews");
  assertBoundedArray(json.accessors, MAX_GLTF_ACCESSORS, "accessors");
  assertBoundedArray(json.nodes, MAX_GLTF_NODES, "nodes");
  assertBoundedArray(json.meshes, MAX_GLTF_MESHES, "meshes");
  assertBoundedArray(json.materials, MAX_GLTF_MATERIALS, "materials", true);
  assertBoundedArray(json.textures, MAX_GLTF_TEXTURES, "textures", true);
  assertBoundedArray(json.images, MAX_GLTF_IMAGES, "images", true);
  const buffers = readBuffers(json.buffers as unknown[], parsed.binaryChunk);
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  if (Buffer.byteLength(jsonText, "utf8") > MAX_GLTF_NORMALIZED_JSON_BYTES) {
    throw new Error(`Normalized glTF JSON exceeds ${MAX_GLTF_NORMALIZED_JSON_BYTES} bytes.`);
  }
  return {
    format,
    sourceSha256: hashBuffer(bytes),
    json,
    jsonText,
    buffers,
    bufferSha256: buffers.map(hashBuffer),
    byteLength: bytes.byteLength,
  };
}

/**
 * Reject nested or punctuation-heavy JSON before JSON.parse allocates its object graph.
 * Quoted content is deliberately skipped so structural characters in names and data URIs do
 * not count as JSON structure.
 */
function assertBoundedGltfJsonText(sourceText: string): void {
  let structuralTokens = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < sourceText.length; index += 1) {
    const code = sourceText.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) {
      inString = true;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      structuralTokens += 1;
      depth += 1;
      if (depth > MAX_GLTF_JSON_DEPTH) {
        throw new Error(`glTF JSON exceeds the ${MAX_GLTF_JSON_DEPTH}-level pre-parse nesting limit.`);
      }
    } else if (code === 0x7d || code === 0x5d || code === 0x2c || code === 0x3a) {
      structuralTokens += 1;
      if (code === 0x7d || code === 0x5d) depth -= 1;
    }
    if (structuralTokens > MAX_GLTF_JSON_STRUCTURAL_TOKENS) {
      throw new Error(`glTF JSON exceeds the ${MAX_GLTF_JSON_STRUCTURAL_TOKENS}-token pre-parse structural limit.`);
    }
  }
}

function parseGlb(bytes: Buffer): { jsonBytes: Buffer; binaryChunk?: Buffer } {
  if (bytes.byteLength < 20) throw new Error("GLB header or JSON chunk is truncated.");
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error("GLB magic is invalid.");
  if (bytes.readUInt32LE(4) !== 2) throw new Error("GLB version must be 2.");
  if (bytes.readUInt32LE(8) !== bytes.byteLength) throw new Error("GLB declared length does not match source bytes.");
  let offset = 12;
  let jsonBytes: Buffer | undefined;
  let binaryChunk: Buffer | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("GLB chunk header is truncated.");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.byteLength) throw new Error("GLB chunk length is invalid.");
    const chunk = bytes.subarray(offset, offset + length);
    offset += length;
    if (type === GLB_JSON_CHUNK && !jsonBytes) jsonBytes = chunk;
    else if (type === GLB_BIN_CHUNK && !binaryChunk) binaryChunk = chunk;
    else throw new Error("GLB contains duplicate or unsupported chunks.");
  }
  if (!jsonBytes) throw new Error("GLB requires one JSON chunk.");
  return { jsonBytes, ...(binaryChunk ? { binaryChunk } : {}) };
}

function readBuffers(values: unknown[], binaryChunk?: Buffer): Buffer[] {
  if (values.length === 0) throw new Error("glTF requires at least one buffer.");
  return values.map((value, index) => {
    const descriptor = record(value, `glTF buffer ${index}`);
    const declaredLength = integer(descriptor.byteLength, `glTF buffer ${index}.byteLength`, 1, MAX_GLTF_BUFFER_BYTES);
    const uri = descriptor.uri;
    let bytes: Buffer;
    if (uri === undefined && index === 0 && binaryChunk) bytes = binaryChunk;
    else if (typeof uri === "string") bytes = decodeDataUri(uri, index);
    else throw new Error(`glTF buffer ${index} must use the GLB BIN chunk or an embedded base64 data URI.`);
    if (bytes.byteLength < declaredLength || bytes.byteLength > declaredLength + (binaryChunk === bytes ? 3 : 0)) {
      throw new Error(`glTF buffer ${index} byteLength does not match embedded bytes.`);
    }
    if (bytes.byteLength > MAX_GLTF_BUFFER_BYTES) throw new Error(`glTF buffer ${index} exceeds ${MAX_GLTF_BUFFER_BYTES} bytes.`);
    return bytes.subarray(0, declaredLength);
  });
}

function decodeDataUri(uri: string, index: number): Buffer {
  const match = /^data:(?:application\/octet-stream|application\/gltf-buffer);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match || match[1].length % 4 !== 0) throw new Error(`glTF buffer ${index} data URI is not bounded base64 binary.`);
  const bytes = Buffer.from(match[1], "base64");
  const canonical = bytes.toString("base64");
  if (canonical !== match[1]) throw new Error(`glTF buffer ${index} data URI is not canonical base64.`);
  return bytes;
}

function assertBoundedArray(value: unknown, max: number, label: string, optional = false): asserts value is unknown[] {
  if (optional && value === undefined) return;
  if (!Array.isArray(value) || value.length > max) throw new Error(`glTF ${label} must be an array with at most ${max} entries.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return Number(value);
}
