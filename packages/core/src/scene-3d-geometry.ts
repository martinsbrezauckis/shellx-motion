import { createHash } from "node:crypto";
import type { MotionScene3DMeshGeometry } from "./scene-3d-types";

export const SCENE_3D_MESH_GEOMETRY_HASH_SCHEMA = "shellx-motion/scene3d-mesh-geometry@1" as const;
const GEOMETRY_HASH_MAGIC = 0x534d3344; // "SM3D"
const GEOMETRY_HASH_VERSION = 1;

/**
 * Hash the exact fixed binary payload sent to the scene3d vertex and index buffers.
 *
 * Positions and normals are interleaved as big-endian IEEE-754 float32 values, followed by
 * big-endian uint32 indices. The header prevents a vertex/index boundary ambiguity and keeps
 * this source-attestation format versioned independently from Motion JSON.
 */
export function scene3dMeshGeometrySha256(geometry: MotionScene3DMeshGeometry): string {
  const vertexCount = geometry.positions.length / 3;
  if (!Number.isInteger(vertexCount) || geometry.normals.length !== geometry.positions.length) {
    throw new Error("scene3d mesh geometry requires equal position and normal vec3 arrays.");
  }
  const byteLength = 16 + vertexCount * 24 + geometry.indices.length * 4;
  const bytes = Buffer.allocUnsafe(byteLength);
  bytes.writeUInt32BE(GEOMETRY_HASH_MAGIC, 0);
  bytes.writeUInt32BE(GEOMETRY_HASH_VERSION, 4);
  bytes.writeUInt32BE(vertexCount, 8);
  bytes.writeUInt32BE(geometry.indices.length, 12);
  let offset = 16;
  for (let index = 0; index < geometry.positions.length; index += 3) {
    for (const value of [geometry.positions[index], geometry.positions[index + 1], geometry.positions[index + 2], geometry.normals[index], geometry.normals[index + 1], geometry.normals[index + 2]]) {
      if (!Number.isFinite(value)) throw new Error("scene3d mesh geometry requires finite vertex values.");
      bytes.writeFloatBE(value, offset); offset += 4;
    }
  }
  for (const index of geometry.indices) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error("scene3d mesh geometry requires uint32 indices.");
    bytes.writeUInt32BE(index, offset); offset += 4;
  }
  return createHash("sha256").update(bytes).digest("hex");
}
