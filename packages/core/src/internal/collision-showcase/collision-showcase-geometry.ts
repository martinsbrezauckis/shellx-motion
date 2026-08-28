import { scene3dMeshGeometrySha256 } from "../../scene-3d-geometry";
import type { MotionScene3DMeshGeometry, MotionVec3 } from "../../types";

// 16 x 24 keeps the silhouette smooth at the proof camera distance while the duplicated Bingo
// geometry remains below the strict 8,192-vertex / 49,152-index Scene3D preview ceilings.
const LATITUDE_SEGMENTS = 16;
const LONGITUDE_SEGMENTS = 24;

export function sphereGeometry(radius = 1): MotionScene3DMeshGeometry {
  const positions: number[] = [0, radius, 0], normals: number[] = [0, 1, 0], indices: number[] = [];
  for (let latitude = 1; latitude < LATITUDE_SEGMENTS; latitude += 1) {
    const theta = Math.PI * latitude / LATITUDE_SEGMENTS;
    for (let longitude = 0; longitude < LONGITUDE_SEGMENTS; longitude += 1) {
      const phi = Math.PI * 2 * longitude / LONGITUDE_SEGMENTS;
      const normal: MotionVec3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      normals.push(...normal); positions.push(normal[0] * radius, normal[1] * radius, normal[2] * radius);
    }
  }
  const bottom = positions.length / 3; positions.push(0, -radius, 0); normals.push(0, -1, 0);
  const ring = (latitude: number, longitude: number): number => 1 + (latitude - 1) * LONGITUDE_SEGMENTS + longitude % LONGITUDE_SEGMENTS;
  for (let longitude = 0; longitude < LONGITUDE_SEGMENTS; longitude += 1) indices.push(0, ring(1, longitude + 1), ring(1, longitude));
  for (let latitude = 1; latitude < LATITUDE_SEGMENTS - 1; latitude += 1) {
    for (let longitude = 0; longitude < LONGITUDE_SEGMENTS; longitude += 1) {
      const a = ring(latitude, longitude), b = ring(latitude, longitude + 1), c = ring(latitude + 1, longitude), d = ring(latitude + 1, longitude + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let longitude = 0; longitude < LONGITUDE_SEGMENTS; longitude += 1) indices.push(bottom, ring(LATITUDE_SEGMENTS - 1, longitude), ring(LATITUDE_SEGMENTS - 1, longitude + 1));
  return { positions, normals, indices };
}

export function cuboidGeometry(half: MotionVec3, center: MotionVec3 = [0, 0, 0]): MotionScene3DMeshGeometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const x0 = center[0] - half[0], x1 = center[0] + half[0], y0 = center[1] - half[1], y1 = center[1] + half[1], z0 = center[2] - half[2], z1 = center[2] + half[2];
  const quad = (a: MotionVec3, b: MotionVec3, c: MotionVec3, d: MotionVec3, normal: MotionVec3): void => {
    const offset = positions.length / 3; positions.push(...a, ...b, ...c, ...d); normals.push(...normal, ...normal, ...normal, ...normal); indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  };
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1]); quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[0,0,-1]);
  quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],[0,1,0]); quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0]);
  quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[1,0,0]); quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0]);
  return { positions, normals, indices };
}

export function appendGeometry(left: MotionScene3DMeshGeometry, right: MotionScene3DMeshGeometry): MotionScene3DMeshGeometry {
  const offset = left.positions.length / 3;
  return { positions: [...left.positions, ...right.positions], normals: [...left.normals, ...right.normals], indices: [...left.indices, ...right.indices.map((index) => index + offset)] };
}

export function geometrySha256(geometry: MotionScene3DMeshGeometry): string { return scene3dMeshGeometrySha256(geometry); }
