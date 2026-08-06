import type { MotionScene3DMeshObject, MotionVec3 } from "./types";

export type GltfQuaternion = [number, number, number, number];
export interface GltfWorldTransform { position: MotionVec3; rotation: GltfQuaternion; scale: number }

export function identityGltfTransform(): GltfWorldTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
}

export function combineGltfTransform(parent: GltfWorldTransform, local: GltfWorldTransform): GltfWorldTransform {
  const scaledLocal = local.position.map((value) => value * parent.scale) as MotionVec3;
  const shifted = rotateGltfVector(parent.rotation, scaledLocal);
  return {
    position: parent.position.map((value, axis) => value + shifted[axis]) as MotionVec3,
    rotation: multiplyGltfQuaternion(parent.rotation, local.rotation),
    scale: parent.scale * local.scale,
  };
}

export function normalizeGltfQuaternion(value: GltfQuaternion, label: string): GltfQuaternion {
  const length = Math.hypot(...value);
  if (length < 0.000_001) throw new Error(`${label} must be non-zero.`);
  return value.map((item) => item / length) as GltfQuaternion;
}

export function gltfQuaternionToEuler(q: GltfQuaternion): MotionVec3 {
  const [x, y, z, w] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw].map((value) => value * 180 / Math.PI) as MotionVec3;
}

export function generatedGltfNormals(positions: number[], indices: number[]): number[] {
  const normals = Array.from({ length: positions.length }, () => 0);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = indices.slice(offset, offset + 3);
    const [a, b, c] = triangle.map((index) => positions.slice(index * 3, index * 3 + 3) as MotionVec3);
    const normal = cross(subtract(b, a), subtract(c, a));
    for (const index of triangle) {
      for (let axis = 0; axis < 3; axis += 1) normals[index * 3 + axis] += normal[axis];
    }
  }
  return normalizeGltfNormals(normals, positions.length / 3, positions.length / 3);
}

export function normalizeGltfNormals(values: number[], count: number, positionCount: number): number[] {
  if (count !== positionCount) throw new Error("glTF NORMAL accessor count must match POSITION count.");
  const normals: number[] = [];
  for (let offset = 0; offset < values.length; offset += 3) {
    normals.push(...normalize(values.slice(offset, offset + 3) as MotionVec3));
  }
  return normals;
}

export function gltfSceneBounds(objects: MotionScene3DMeshObject[]): {
  center: MotionVec3;
  camera: MotionVec3;
  near: number;
  far: number;
} {
  const points = objects.flatMap((object) => chunk3(object.geometry.positions).map((point) => {
    const rotation = eulerToQuaternion(object.rotationDeg);
    const scaled = point.map((value) => value * object.scale) as MotionVec3;
    const rotated = rotateGltfVector(rotation, scaled);
    return rotated.map((value, axis) => value + object.position[axis]) as MotionVec3;
  }));
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))) as MotionVec3;
  const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))) as MotionVec3;
  const center = min.map((value, axis) => (value + max[axis]) / 2) as MotionVec3;
  const radius = Math.max(0.25, ...max.map((value, axis) => (value - min[axis]) / 2));
  return {
    center,
    camera: [center[0] + radius * 2.4, center[1] + radius * 1.7, center[2] + radius * 3.2],
    near: Math.max(0.01, radius / 100),
    far: Math.min(10_000, radius * 20),
  };
}

function multiplyGltfQuaternion(a: GltfQuaternion, b: GltfQuaternion): GltfQuaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotateGltfVector(q: GltfQuaternion, value: MotionVec3): MotionVec3 {
  const vector: MotionVec3 = [q[0], q[1], q[2]];
  const uv = cross(vector, value);
  const uuv = cross(vector, uv);
  return value.map((item, axis) => item + 2 * (q[3] * uv[axis] + uuv[axis])) as MotionVec3;
}

function eulerToQuaternion(value: MotionVec3): GltfQuaternion {
  const [x, y, z] = value.map((item) => item * Math.PI / 360);
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function subtract(a: MotionVec3, b: MotionVec3): MotionVec3 {
  return a.map((value, axis) => value - b[axis]) as MotionVec3;
}

function cross(a: MotionVec3, b: MotionVec3): MotionVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: MotionVec3): MotionVec3 {
  const length = Math.hypot(...value);
  return length < 0.000_001 ? [0, 1, 0] : value.map((item) => item / length) as MotionVec3;
}

function chunk3(values: number[]): MotionVec3[] {
  return Array.from({ length: values.length / 3 }, (_value, index) => (
    values.slice(index * 3, index * 3 + 3) as MotionVec3
  ));
}
