export type GltfSourceFormat = "gltf" | "glb";

export interface ParsedGltfContainer {
  format: GltfSourceFormat;
  sourceSha256: string;
  json: Record<string, unknown>;
  jsonText: string;
  buffers: Buffer[];
  bufferSha256: string[];
  byteLength: number;
}

export interface GltfAccessorData {
  values: number[];
  count: number;
  componentCount: number;
}
