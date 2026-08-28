import { createHash } from "node:crypto";
import { freeze } from "./scene-recipe-data";
import type { GltfObjectRetainedRenderGeometry } from "./gltf-object-retained-render-types";

interface RetainedMeshGeometrySource {
  readonly id: string;
  readonly geometrySha256: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly geometry: Readonly<{ positions: readonly number[]; normals: readonly number[]; indices: readonly number[] }>;
}

export interface RetainedMeshCamera {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
}

/** Packs one already-admitted indexed mesh into the retained renderer's exact float32 ABI. */
export function compileRetainedMeshGeometry(source: RetainedMeshGeometrySource): GltfObjectRetainedRenderGeometry {
  const vertices: number[] = [];
  for (let index = 0; index < source.geometry.positions.length; index += 3) vertices.push(source.geometry.positions[index]!, source.geometry.positions[index + 1]!, source.geometry.positions[index + 2]!, source.geometry.normals[index]!, source.geometry.normals[index + 1]!, source.geometry.normals[index + 2]!);
  const vertexBuffer = retainedMeshFloatBytes(vertices), indexBuffer = retainedMeshIndexBytes(source.geometry.indices);
  return freeze({ id: source.id, geometrySha256: source.geometrySha256, vertexCount: source.vertexCount, indexCount: source.indexCount, vertices: freeze(vertices), indices: freeze([...source.geometry.indices]), vertexBufferSha256: sha256(vertexBuffer), indexBufferSha256: sha256(indexBuffer), vertexBufferBytes: vertexBuffer.byteLength, indexBufferBytes: indexBuffer.byteLength });
}

export function retainedMeshFloatBytes(values: readonly number[]): Buffer { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeFloatLE(value, index * 4)); return result; }
export function retainedMeshIndexBytes(values: readonly number[]): Buffer { const result = Buffer.alloc(values.length * 4); values.forEach((value, index) => result.writeUInt32LE(value, index * 4)); return result; }

export function retainedMeshColor(value: string): readonly [number, number, number, number] {
  return freeze([Number.parseInt(value.slice(1, 3), 16) / 255, Number.parseInt(value.slice(3, 5), 16) / 255, Number.parseInt(value.slice(5, 7), 16) / 255, 1].map(retainedMeshFloat)) as unknown as readonly [number, number, number, number];
}

export function retainedMeshViewProjection(camera: RetainedMeshCamera, viewport: Readonly<{ width: number; height: number }>): readonly number[] {
  return freeze(multiply(perspective(camera.fovDeg, viewport.width / viewport.height, camera.near, camera.far), lookAt(camera.position, camera.target)).map(retainedMeshFloat));
}

export function retainedMeshModelMatrixFromQuaternion(position: readonly [number, number, number], rotation: readonly [number, number, number, number]): readonly number[] {
  const [x, y, z, w] = rotation, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return freeze([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    position[0], position[1], position[2], 1,
  ].map(retainedMeshExactFloat));
}

/** Builds the retained column-major model ABI with explicit positive XYZ scale. */
export function retainedMeshModelMatrixFromQuaternionScale(position: readonly [number, number, number], rotation: readonly [number, number, number, number], scale: readonly [number, number, number]): readonly number[] {
  const [x, y, z, w] = rotation, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return freeze([
    (1 - 2 * (yy + zz)) * scale[0], (2 * (xy + wz)) * scale[0], (2 * (xz - wy)) * scale[0], 0,
    (2 * (xy - wz)) * scale[1], (1 - 2 * (xx + zz)) * scale[1], (2 * (yz + wx)) * scale[1], 0,
    (2 * (xz + wy)) * scale[2], (2 * (yz - wx)) * scale[2], (1 - 2 * (xx + yy)) * scale[2], 0,
    position[0], position[1], position[2], 1,
  ].map(retainedMeshExactFloat));
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function perspective(fovDeg: number, aspect: number, near: number, far: number): number[] { const f = 1 / Math.tan(fovDeg * Math.PI / 360), nf = 1 / (near - far), out = new Array<number>(16).fill(0); out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf; return out; }
function lookAt(eye: readonly number[], target: readonly number[]): number[] { const z = normalize(subtract(eye, target)), x = normalize(cross([0, 1, 0], z)), y = cross(z, x), out = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; out[0] = x[0]!; out[1] = y[0]!; out[2] = z[0]!; out[4] = x[1]!; out[5] = y[1]!; out[6] = z[1]!; out[8] = x[2]!; out[9] = y[2]!; out[10] = z[2]!; out[12] = -dot(x, eye); out[13] = -dot(y, eye); out[14] = -dot(z, eye); return out; }
function multiply(a: readonly number[], b: readonly number[]): number[] { const out = new Array<number>(16).fill(0); for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row]! * b[column * 4 + k]!; return out; }
function subtract(a: readonly number[], b: readonly number[]): number[] { return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; }
function cross(a: readonly number[], b: readonly number[]): number[] { return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]; }
function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function normalize(value: readonly number[]): number[] { const length = Math.hypot(...value) || 1; return value.map((entry) => entry / length); }
function retainedMeshFloat(value: number): number { const normalized = Math.abs(value) < 1e-7 ? 0 : Math.fround(value); return Object.is(normalized, -0) ? 0 : normalized; }
function retainedMeshExactFloat(value: number): number { const normalized = Math.fround(value); return Object.is(normalized, -0) ? 0 : normalized; }
